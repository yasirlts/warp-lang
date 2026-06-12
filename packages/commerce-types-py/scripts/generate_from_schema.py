#!/usr/bin/env python3
"""Generate Pydantic v2 models from the CANONICAL Warp Commerce schema spine.

Reads the canonical JSON Schema (Draft 2020-12) under ``schema/structure/*.schema.json``
— the language-neutral source of truth shared with the TypeScript
``@warp-lang/commerce-types`` binding — and emits
``src/warp_commerce_types/_models.py``: one Pydantic ``BaseModel`` per object
``$def`` and a discriminated ``Annotated[Union[...], Field(discriminator=...)]``
per ``oneOf`` tagged union, keyed on the ``"type"`` / ``"kind"`` discriminant
exactly as the canonical schema declares it.

This mirrors the TypeScript generator
(``packages/commerce-types/scripts/generate-from-schema.mjs``): the same
structure-file order, the same BRANDS / open-CurrencyCode / derived-type-alias
CONFIG seams (the parts JSON Schema cannot carry, re-applied here by name), and
the transition tables synced verbatim from ``schema/behavior/transitions.json``.

Run from anywhere:  ``python scripts/generate_from_schema.py``
"""
from __future__ import annotations

import json
import keyword
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

# --- paths -----------------------------------------------------------------

HERE = Path(__file__).resolve()
PKG_ROOT = HERE.parents[1]                       # packages/commerce-types-py
REPO_ROOT = HERE.parents[3]                      # warp-lang
SCHEMA_DIR = REPO_ROOT / "schema"
STRUCTURE_DIR = SCHEMA_DIR / "structure"
OUT_FILE = PKG_ROOT / "src" / "warp_commerce_types" / "_models.py"

# ---------------------------------------------------------------------------
# CONFIG — the parts JSON Schema cannot carry, re-applied by NAME (the same
# documented seams the TypeScript generator uses). Keep matching A's
# generate-from-schema.mjs CONFIG block.
# ---------------------------------------------------------------------------

# Branded identifiers (Invariant 5). The schema carries them as plain strings; TS
# re-applies `string & { __brand }`. Python has no structural brands, so a branded
# id is a documented `str` alias.
BRANDS = {"PartyID", "IntentID", "CommitmentID", "FulfillmentID", "ValueID"}

# CurrencyCode is an OPEN string in the schema (any ISO 4217 code plus Custom
# denominations like "PTS"). TS keeps a literal-suggestion set via `(string & {})`;
# Python keeps it a plain `str`. This list documents the common set, exactly as A
# re-applies it (not derivable from the schema).
CURRENCY_LITERALS = [
    "MAD", "EUR", "USD", "GBP", "DZD", "TND", "AED", "SAR",
    "EGP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR",
]

# `<Union>["type"]` discriminant aliases the package exposes that the schema does
# NOT carry as their own $def (CommitmentStateType IS a schema $def, generated
# directly, so it is omitted here). Emitted as Literal[...] of the union's tags.
DERIVED_TYPE_ALIASES = [
    ("IntentStateType", "IntentState"),
    ("FulfillmentStateType", "FulfillmentState"),
    ("PaymentTimingType", "PaymentTiming"),
]

# Validators JSON Schema cannot express, re-applied by name on the named model.
# MoneyBreakdown's component-sum rule (money_breakdown_sum, behavior/invariants.json)
# is enforced by a model_validator calling the hand-written runtime.
VALIDATORS = {"MoneyBreakdown": "money_breakdown_sum"}

# Structure files, processed in this order. `index` is last: it only aggregates,
# so its alias $defs collide with names already emitted and are skipped — only its
# genuinely new `CommerceObject` union is kept.
STRUCTURE_FILES = ["money", "party", "value", "intent", "commitment", "fulfillment", "auxiliary", "index"]

PRIMITIVES = {"string": "str", "number": "float", "integer": "int", "boolean": "bool"}

MISSING = object()


# --- helpers ---------------------------------------------------------------

def pascal(name: str) -> str:
    return "".join(part[:1].upper() + part[1:] for part in re.split(r"[_\-\s]+", str(name)) if part)


def ref_name(ref: str) -> str:
    m = re.search(r"#/\$defs/([A-Za-z0-9_]+)$", ref)
    if not m:
        raise ValueError("Unresolvable $ref: %s" % ref)
    return m.group(1)


def lit_repr(value: Any) -> str:
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, str):
        return '"%s"' % value
    return str(value)


def const_of(node: dict) -> Any:
    if isinstance(node, dict) and "const" in node:
        return node["const"]
    return MISSING


# --- generator -------------------------------------------------------------

class Generator:
    def __init__(self) -> None:
        self.class_blocks: List[str] = []
        self.value_blocks: List[str] = []
        self.model_names: List[str] = []
        self.exported: List[str] = []
        self.emitted_classes: set = set()
        self.union_tags: Dict[str, List[Any]] = {}
        self.all_defs: Dict[str, dict] = {}

    def resolve(self, node: dict) -> dict:
        if isinstance(node, dict) and "$ref" in node:
            return self.all_defs.get(ref_name(node["$ref"]), {})
        return node

    def discriminant_key(self, member: dict) -> Optional[str]:
        obj = self.resolve(member)
        props = obj.get("properties", {}) if isinstance(obj, dict) else {}
        for key in ("type", "kind"):
            if key in props and "const" in props[key]:
                return key
        return None

    def common_discriminator(self, members: List[dict]) -> Optional[str]:
        keys = [self.discriminant_key(m) for m in members]
        if keys and all(k is not None and k == keys[0] for k in keys):
            return keys[0]
        return None

    # -- type-expression rendering --
    def render_type(self, node: dict, hint: str) -> str:
        if "$ref" in node:
            return ref_name(node["$ref"])
        if "const" in node:
            return "Literal[%s]" % lit_repr(node["const"])
        if "enum" in node and node.get("type") != "object":
            return "Literal[%s]" % ", ".join(lit_repr(v) for v in node["enum"])
        if "oneOf" in node:
            return self.render_union(node["oneOf"], hint)
        t = node.get("type")
        if t == "array":
            return "List[%s]" % self.render_type(node.get("items", {}), hint + "Item")
        if t == "object" or "properties" in node:
            return self.emit_object_class(hint, node)
        if t in PRIMITIVES:
            return PRIMITIVES[t]
        return "Any"

    def render_union(self, members: List[dict], hint: str) -> str:
        disc = self.common_discriminator(members)
        rendered: List[str] = []
        for i, m in enumerate(members):
            if "$ref" in m:
                rendered.append(ref_name(m["$ref"]))
            elif "const" in m:
                rendered.append("Literal[%s]" % lit_repr(m["const"]))
            elif m.get("type") == "object" or "properties" in m:
                tag = m.get("properties", {}).get(disc, {}).get("const") if disc else None
                if tag is None:
                    for key in ("type", "kind"):
                        if "const" in m.get("properties", {}).get(key, {}):
                            tag = m["properties"][key]["const"]
                suffix = pascal(tag) if tag is not None else "Member%d" % i
                rendered.append(self.emit_object_class(hint + suffix, m, discriminator=disc))
            else:
                rendered.append(self.render_type(m, hint + "Member%d" % i))
        if len(rendered) == 1:
            return rendered[0]
        inner = "Union[%s]" % ", ".join(rendered)
        return 'Annotated[%s, Field(discriminator="%s")]' % (inner, disc) if disc else inner

    # -- object class emission --
    def emit_object_class(self, class_name: str, node: dict, discriminator: Optional[str] = None) -> str:
        if class_name in self.emitted_classes:
            return class_name
        self.emitted_classes.add(class_name)
        self.model_names.append(class_name)

        props: Dict[str, Any] = node.get("properties", {})
        required = set(node.get("required", []))
        lines = ["class %s(BaseModel):" % class_name]
        doc = node.get("description")
        if doc:
            lines.append('    """%s"""' % doc.replace("\\", "\\\\").replace('"""', "'''"))
        lines.append("    model_config = ConfigDict(populate_by_name=True)")
        for pname, pnode in props.items():
            lines.append(self.emit_field(pname, pnode, required, class_name))
        if VALIDATORS.get(class_name) == "money_breakdown_sum":
            lines += [
                '    @model_validator(mode="after")',
                '    def _validate_breakdown_sum(self) -> "%s":' % class_name,
                "        from .money import validate_money_breakdown",
                "        validate_money_breakdown(self)",
                "        return self",
            ]
        self.class_blocks.append("\n".join(lines) + "\n")
        return class_name

    def emit_field(self, name: str, node: dict, required: set, owner: str) -> str:
        is_required = name in required
        is_array = node.get("type") == "array"
        const_val = const_of(node)
        type_str = self.render_type(node, owner + pascal(name))
        if not is_required and not is_array:
            type_str = "Optional[%s]" % type_str

        py_name = name + "_" if keyword.iskeyword(name) else name
        alias = name if py_name != name else None

        field_args: List[str] = []
        rhs = MISSING
        if is_array:
            field_args.append("default_factory=list")
        elif const_val is not MISSING:
            rhs = lit_repr(const_val)              # pin discriminant default for ergonomics
        elif not is_required:
            rhs = "None"

        if alias is not None:
            field_args.append('alias="%s"' % alias)

        if field_args:
            if rhs is not MISSING and not any(a.startswith("default_factory") for a in field_args):
                field_args.insert(0, "default=%s" % rhs)
            return "    %s: %s = Field(%s)" % (py_name, type_str, ", ".join(field_args))
        if rhs is not MISSING:
            return "    %s: %s = %s" % (py_name, type_str, rhs)
        return "    %s: %s" % (py_name, type_str)

    # -- top-level $def dispatch --
    def emit_def(self, name: str, node: dict) -> None:
        if name in BRANDS:
            self.value_blocks.append("%s = str  # branded identifier (Invariant 5); brand is documentation only" % name)
            return
        if name == "CurrencyCode":
            self.value_blocks.append(
                "# CurrencyCode is an OPEN string (any ISO 4217 code + Custom denominations like 'PTS').\n"
                "# Common set for reference: %s\nCurrencyCode = str" % ", ".join(CURRENCY_LITERALS)
            )
            return
        if "$ref" in node:
            target = ref_name(node["$ref"])
            if target != name:
                self.value_blocks.append("%s = %s" % (name, target))
            return
        if "enum" in node and node.get("type") != "object":
            self.value_blocks.append("%s = Literal[%s]" % (name, ", ".join(lit_repr(v) for v in node["enum"])))
            return
        if "const" in node:
            self.value_blocks.append("%s = Literal[%s]" % (name, lit_repr(node["const"])))
            return
        if "oneOf" in node:
            members = node["oneOf"]
            disc = self.common_discriminator(members)
            rendered: List[str] = []
            tags: List[Any] = []
            for i, m in enumerate(members):
                if "$ref" in m:
                    rendered.append(ref_name(m["$ref"]))
                    obj = self.resolve(m)
                    if disc and disc in obj.get("properties", {}):
                        tags.append(obj["properties"][disc].get("const"))
                elif "const" in m:
                    rendered.append("Literal[%s]" % lit_repr(m["const"]))
                    tags.append(m["const"])
                elif m.get("type") == "object" or "properties" in m:
                    tag = m.get("properties", {}).get(disc, {}).get("const") if disc else None
                    suffix = pascal(tag) if tag is not None else "Member%d" % i
                    rendered.append(self.emit_object_class(name + suffix, m, discriminator=disc))
                    tags.append(tag)
                else:
                    rendered.append(self.render_type(m, name + "Member%d" % i))
            self.union_tags[name] = [t for t in tags if t is not None]
            inner = "Union[%s]" % ", ".join(rendered) if len(rendered) > 1 else rendered[0]
            if disc:
                self.value_blocks.append('%s = Annotated[%s, Field(discriminator="%s")]' % (name, inner, disc))
            else:
                self.value_blocks.append("%s = %s" % (name, inner))
            return
        if node.get("type") == "object" or "properties" in node:
            self.emit_object_class(name, node)
            return
        if node.get("type") == "array":
            self.value_blocks.append("%s = List[%s]" % (name, self.render_type(node.get("items", {}), name + "Item")))
            return
        if node.get("type") in PRIMITIVES:
            self.value_blocks.append("%s = %s" % (name, PRIMITIVES[node["type"]]))
            return
        self.value_blocks.append("%s = Any" % name)

    # -- driver --
    def run(self) -> str:
        schemas = {f: json.loads((STRUCTURE_DIR / ("%s.schema.json" % f)).read_text()) for f in STRUCTURE_FILES}
        for f in STRUCTURE_FILES:
            for n, node in schemas[f].get("$defs", {}).items():
                self.all_defs.setdefault(n, node)

        emitted_names: set = set()
        for f in STRUCTURE_FILES:
            for name, node in schemas[f].get("$defs", {}).items():
                if name in emitted_names:
                    continue
                if "$ref" in node and ref_name(node["$ref"]) == name:
                    continue  # bare passthrough alias (index aggregation)
                self.emit_def(name, node)
                emitted_names.add(name)
                if name not in self.exported:
                    self.exported.append(name)

        for alias, base in DERIVED_TYPE_ALIASES:
            if alias in emitted_names:
                continue
            tags = self.union_tags.get(base, [])
            if tags:
                self.value_blocks.append("%s = Literal[%s]" % (alias, ", ".join(lit_repr(t) for t in tags)))
                self.exported.append(alias)

        return self.render_module()

    def render_module(self) -> str:
        version = (SCHEMA_DIR / "VERSION").read_text().strip()
        header = (
            '"""GENERATED FILE — do not edit by hand.\n\n'
            "Pydantic v2 models for the Warp Commerce Model, generated from the CANONICAL\n"
            "schema spine (schema/structure/*.schema.json, JSON Schema Draft 2020-12) v%s\n"
            "by scripts/generate_from_schema.py. Edit the schema and regenerate; never edit\n"
            "this file directly.\n"
            '"""\n'
            "from __future__ import annotations\n\n"
            "from typing import Annotated, Any, List, Literal, Optional, Union\n\n"
            "from pydantic import BaseModel, ConfigDict, Field, model_validator\n\n"
            'SCHEMA_VERSION = "%s"\n' % (version, version)
        )
        parts = [header, "\n# --- structural models (objects + tagged-union members) ---\n"]
        parts.append("\n\n".join(self.class_blocks))
        parts.append("\n\n# --- branded ids, enums, aliases, and discriminated unions ---\n")
        parts.append("\n".join(self.value_blocks))
        parts.append("\n\n# --- resolve forward references ---")
        parts.append("for _model in (%s,):" % ", ".join(self.model_names))
        parts.append("    _model.model_rebuild()")
        parts.append("")
        parts.append("__all__ = [")
        for n in self.exported:
            parts.append('    "%s",' % n)
        parts.append('    "SCHEMA_VERSION",')
        parts.append("]")
        parts.append("")
        return "\n".join(parts)


def sync_behavior() -> None:
    """Copy the canonical behavior data into the package so an installed wheel is
    self-contained. The canonical files in schema/behavior remain the single
    source; this is a build-time mirror, regenerated every run."""
    data_dir = PKG_ROOT / "src" / "warp_commerce_types" / "schema_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    for rel in ("behavior/transitions.json", "behavior/invariants.json", "VERSION"):
        (data_dir / Path(rel).name).write_text((SCHEMA_DIR / rel).read_text())
        print("synced %s" % (data_dir / Path(rel).name).relative_to(REPO_ROOT))


def main() -> None:
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(Generator().run())
    print("wrote %s" % OUT_FILE.relative_to(REPO_ROOT))
    sync_behavior()


if __name__ == "__main__":
    main()
