#!/usr/bin/env python3
"""Generate Pydantic v2 models from the canonical Warp Commerce schema.

Reads ``schema/structure/*.schema.json`` (the language-neutral source of truth,
shared with the TypeScript ``@warp-lang/commerce-types`` package) and emits
``src/warp_commerce_types/_models.py`` — one Pydantic ``BaseModel`` per object
type and a discriminated ``Annotated[Union[...], Field(discriminator=...)]`` per
tagged-union type, keyed on the ``"type"`` / ``"kind"`` discriminator exactly as
the schema declares it.

Run from anywhere:  ``python scripts/generate_from_schema.py``

The grammar this consumes is documented in ``schema/README.md``.
"""
from __future__ import annotations

import json
import keyword
from pathlib import Path
from typing import Any, Dict, List, Tuple

# --- paths -----------------------------------------------------------------

HERE = Path(__file__).resolve()
PKG_ROOT = HERE.parents[1]                       # packages/commerce-types-py
REPO_ROOT = HERE.parents[3]                      # warp-lang
SCHEMA_DIR = REPO_ROOT / "schema"
STRUCTURE_DIR = SCHEMA_DIR / "structure"
OUT_FILE = PKG_ROOT / "src" / "warp_commerce_types" / "_models.py"

PRIMITIVES = {
    "string": "str",
    "number": "float",
    "integer": "int",
    "boolean": "bool",
    "datetime": "str",   # ISO-8601 string, as in the TS binding
    "any": "Any",
}

MISSING = object()


# --- type-expression rendering ---------------------------------------------

def lit_repr(value: Any) -> str:
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, str):
        return '"%s"' % value
    return str(value)


def render_te(te: Any) -> str:
    """Render a type-expression to a Python type string."""
    if isinstance(te, str):
        return PRIMITIVES.get(te, te)  # primitive, else a definition reference
    if isinstance(te, dict):
        if "array" in te:
            return "List[%s]" % render_te(te["array"])
        if "optional" in te:
            return "Optional[%s]" % render_te(te["optional"])
        if "literal" in te:
            return "Literal[%s]" % lit_repr(te["literal"])
        if "enum" in te:
            return "Literal[%s]" % ", ".join(lit_repr(v) for v in te["enum"])
        if "ref" in te:
            return te["ref"]
        if "union" in te:
            members = ", ".join(render_te(m) for m in te["union"])
            inner = members if len(te["union"]) == 1 else "Union[%s]" % members
            if te.get("discriminator"):
                return 'Annotated[%s, Field(discriminator="%s")]' % (inner, te["discriminator"])
            return inner
    raise ValueError("cannot render type-expression: %r" % (te,))


def single_literal(te: Any) -> Any:
    """If ``te`` pins exactly one literal value, return it, else MISSING."""
    if isinstance(te, dict):
        if "literal" in te:
            return te["literal"]
        if "enum" in te and len(te["enum"]) == 1:
            return te["enum"][0]
    return MISSING


# --- field / class emission -------------------------------------------------

def emit_field(name: str, spec: Any) -> str:
    """Return the source line for one model field."""
    if isinstance(spec, dict) and "t" in spec:
        te = spec["t"]
        optional = spec.get("optional", False)
        default = spec.get("default", MISSING)
    else:
        te, optional, default = spec, False, MISSING

    type_str = render_te(te)
    if optional:
        type_str = "Optional[%s]" % type_str

    py_name = name + "_" if keyword.iskeyword(name) else name
    alias = name if py_name != name else None

    # A field pinned to a single literal gets that literal as its default.
    if default is MISSING and not optional:
        lit = single_literal(te)
        if lit is not MISSING:
            default = lit

    field_args: List[str] = []
    rhs = MISSING
    if default == "list":
        field_args.append("default_factory=list")
    elif optional and default is MISSING:
        rhs = "None"
    elif default is not MISSING:
        rhs = lit_repr(default) if isinstance(default, (str, bool, int, float)) else repr(default)

    if alias is not None:
        field_args.append('alias="%s"' % alias)

    if field_args:
        # Field(...) form. A required field with only an alias uses Field(alias=...).
        if rhs is not MISSING and "default_factory" not in " ".join(field_args):
            field_args.insert(0, "default=%s" % rhs)
        return "    %s: %s = Field(%s)" % (py_name, type_str, ", ".join(field_args))
    if rhs is not MISSING:
        return "    %s: %s = %s" % (py_name, type_str, rhs)
    return "    %s: %s" % (py_name, type_str)


def emit_class(
    class_name: str,
    fields: Dict[str, Any],
    doc: str | None = None,
    discriminator: str | None = None,
    tag: str | None = None,
    validator: str | None = None,
) -> str:
    lines = ["class %s(BaseModel):" % class_name]
    if doc:
        lines.append('    """%s"""' % doc)
    lines.append("    model_config = ConfigDict(populate_by_name=True)")
    if discriminator and tag is not None:
        lines.append('    %s: Literal["%s"] = "%s"' % (discriminator, tag, tag))
    for fname, fspec in fields.items():
        lines.append(emit_field(fname, fspec))
    if validator == "money_breakdown_sum":
        lines += [
            '    @model_validator(mode="after")',
            "    def _validate_breakdown_sum(self) -> \"%s\":" % class_name,
            "        from .money import validate_money_breakdown",
            "        validate_money_breakdown(self)",
            "        return self",
        ]
    if len(lines) == 2:  # only header + config (no fields) — still valid
        pass
    return "\n".join(lines) + "\n"


# --- driver -----------------------------------------------------------------

def load_definitions() -> List[Tuple[str, dict, str]]:
    out: List[Tuple[str, dict, str]] = []
    seen: Dict[str, str] = {}
    for path in sorted(STRUCTURE_DIR.glob("*.schema.json")):
        doc = json.loads(path.read_text())
        module = doc.get("module", path.stem)
        for name, definition in doc.get("definitions", {}).items():
            if name in seen:
                raise ValueError("duplicate definition %r in %s and %s" % (name, seen[name], module))
            seen[name] = module
            out.append((name, definition, module))
    return out


def generate() -> str:
    defs = load_definitions()

    class_blocks: List[str] = []        # all BaseModel classes (pass 1)
    value_blocks: List[str] = []        # newtype / enum / alias / union assignments (pass 2)
    model_names: List[str] = []         # classes to model_rebuild()
    exported: List[str] = []

    for name, d, module in defs:
        kind = d["def"]
        exported.append(name)

        if kind == "newtype":
            base = PRIMITIVES.get(d.get("base", "string"), "str")
            doc = (" # %s" % d["doc"]) if d.get("doc") else ""
            value_blocks.append("%s = %s%s" % (name, base, doc))

        elif kind == "enum":
            value_blocks.append("%s = Literal[%s]" % (name, ", ".join(lit_repr(v) for v in d["values"])))

        elif kind == "alias":
            value_blocks.append("%s = %s" % (name, render_te(d["of"])))

        elif kind == "object":
            class_blocks.append(
                emit_class(name, d.get("fields", {}), doc=d.get("doc"), validator=d.get("validator"))
            )
            model_names.append(name)

        elif kind == "union":
            disc = d.get("discriminator")
            members: List[str] = []
            for variant in d["variants"]:
                if "ref" in variant:
                    members.append(variant["ref"])
                    continue
                tag = variant["tag"]
                member_name = "%s%s" % (name, tag)
                class_blocks.append(
                    emit_class(
                        member_name,
                        variant.get("fields", {}),
                        doc=variant.get("doc"),
                        discriminator=disc,
                        tag=tag,
                    )
                )
                model_names.append(member_name)
                members.append(member_name)
            joined = "Union[%s]" % ", ".join(members) if len(members) > 1 else members[0]
            if disc:
                value_blocks.append('%s = Annotated[%s, Field(discriminator="%s")]' % (name, joined, disc))
            else:
                value_blocks.append("%s = %s" % (name, joined))
        else:
            raise ValueError("unknown def kind %r for %s" % (kind, name))

    version = (SCHEMA_DIR / "VERSION").read_text().strip()
    header = '''"""GENERATED FILE — do not edit by hand.

Pydantic v2 models for the Warp Commerce Model, generated from the canonical
schema (schema/structure/*.schema.json) v{version} by
scripts/generate_from_schema.py. Edit the schema and regenerate; never edit
this file directly.
"""
from __future__ import annotations

from typing import Annotated, Any, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "{version}"
'''.format(version=version)

    parts = [header, ""]
    parts.append("# --- structural models (objects + tagged-union members) ---\n")
    parts.append("\n\n".join(class_blocks))
    parts.append("\n\n# --- aliases, enums, branded ids, and discriminated unions ---\n")
    parts.append("\n".join(value_blocks))
    parts.append("\n\n# --- resolve forward references ---")
    parts.append("for _model in (%s,):" % ", ".join(model_names))
    parts.append("    _model.model_rebuild()")
    parts.append("")
    parts.append("__all__ = [")
    for n in exported:
        parts.append('    "%s",' % n)
    parts.append('    "SCHEMA_VERSION",')
    parts.append("]")
    parts.append("")
    return "\n".join(parts)


def sync_behavior() -> None:
    """Copy the canonical behavior data into the package so an installed wheel
    is self-contained. The canonical files in schema/behavior remain the single
    source; this is a build-time mirror, regenerated every run."""
    data_dir = PKG_ROOT / "src" / "warp_commerce_types" / "schema_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    for rel in ("behavior/transitions.json", "behavior/invariants.json", "VERSION"):
        src = SCHEMA_DIR / rel
        dst = data_dir / Path(rel).name
        dst.write_text(src.read_text())
        print("synced %s" % dst.relative_to(REPO_ROOT))


def main() -> None:
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(generate())
    print("wrote %s" % OUT_FILE.relative_to(REPO_ROOT))
    sync_behavior()


if __name__ == "__main__":
    main()
