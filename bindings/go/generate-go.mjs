#!/usr/bin/env node
/**
 * generate-go.mjs — regenerate the warp-lang Go structural types from the
 * canonical schema spine (schema/structure/*.schema.json) and the transition
 * tables from schema/behavior/transitions.json.
 *
 * The schema (JSON Schema Draft 2020-12) is the language-neutral source of
 * truth; this generator is the Go binding. It is a faithful sibling of the
 * TypeScript generator (packages/commerce-types/scripts/generate-from-schema.mjs),
 * the Python generator (packages/commerce-types-py/scripts/generate_from_schema.py),
 * and the Rust generator (crates/warp-commerce-types/scripts/generate-rust.mjs):
 * the SAME structure-file order, the SAME BRANDS / open-CurrencyCode CONFIG
 * seams (the parts JSON Schema cannot carry, re-applied here by name), and the
 * transition tables synced VERBATIM from schema/behavior/transitions.json.
 *
 * It emits two files into the module:
 *
 *   generated/types_gen.go        — every $def as a Go type (package generated)
 *   generated/transitions_gen.go  — the commitment/intent/fulfillment transition
 *                                   tables, verbatim from behavior/transitions.json
 *
 * The hand-written runtime (transition validity incl. the Failed->Planned
 * recoverable special case, the six-invariant scene audit, money precision /
 * tolerance / breakdown-sum) is NOT generated — it lives in runtime.go and
 * consumes these generated types.
 *
 * ---------------------------------------------------------------------------
 * THE GO-SPECIFIC SEAM — tagged-union mapping
 * ---------------------------------------------------------------------------
 * Go has no sum types. The other bindings model a schema `oneOf` whose members
 * share a `type`/`kind` const discriminant as:
 *   - TS   : a discriminated union of object literals.
 *   - Rust : a serde internally-tagged enum (#[serde(tag = "...")]).
 *   - Py   : a discriminated pydantic union.
 * Go's idiomatic, deserialization-robust equivalent (chosen here) is a single
 * STRUCT per tagged union that carries:
 *   - the discriminant field (`Type string` / `Kind string`), PLUS
 *   - the UNION of every member's fields, resolved through $ref to the member
 *     $def's properties, deduped by field name. Every non-discriminant field is
 *     OPTIONAL (pointer for scalars/named-types, slice/omitempty for arrays) so
 *     that any one variant deserializes cleanly and absent fields stay zero.
 *   - if two members declare the same field name with DIFFERENT resolved Go
 *     types, that field falls back to `json.RawMessage`.
 * This compiles, `encoding/json`-deserializes every fixture variant, and keeps
 * the discriminant readable as a plain string (matching run.mjs's reliance on
 * `state.type` / `form.kind`). The two untagged unions (MoneyOrBreakdown,
 * CommerceObject) become `json.RawMessage` aliases — they have no shared
 * discriminant and are never destructured by the runtime.
 *
 * Usage:
 *   node bindings/go/generate-go.mjs          # write the generated files
 *   node bindings/go/generate-go.mjs --check  # exit 1 if on-disk output drifts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Run the emitted Go through `gofmt` so the committed generated files are
 * canonical under both this generator AND `gofmt -l` (CI runs the latter on
 * every file). gofmt ships with the Go toolchain. If it is not on PATH the raw
 * output is returned unchanged — the drift `--check` still compares
 * generator-to-disk faithfully.
 */
function gofmt(src) {
  for (const bin of ["gofmt", "/opt/homebrew/bin/gofmt"]) {
    try {
      return execFileSync(bin, [], { input: src, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch {
      /* try next */
    }
  }
  return src;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, "..", "..", "schema");
const STRUCTURE_DIR = join(SCHEMA_DIR, "structure");
const BEHAVIOR_DIR = join(SCHEMA_DIR, "behavior");
const OUT_DIR = join(HERE, "generated");

// ---------------------------------------------------------------------------
// CONFIG — the parts JSON Schema cannot carry, re-applied by NAME. These mirror
// the TS/Python/Rust generators' CONFIG blocks exactly — the deliberate,
// documented seams between the language-neutral schema and a binding.
// ---------------------------------------------------------------------------

/** Branded identifiers (Invariant 5). The schema carries them as plain strings;
 *  Go has no structural brands, so each becomes a documented `type X = string`. */
const BRANDS = new Set(["PartyID", "IntentID", "CommitmentID", "FulfillmentID", "ValueID"]);

/** CurrencyCode is an OPEN string in the schema (any ISO 4217 code plus Custom
 *  denominations like "PTS"). Go keeps it a plain `string` alias. The common set
 *  is documented for reference, exactly as the other generators re-apply it. */
const CURRENCY_LITERALS = [
  "MAD", "EUR", "USD", "GBP", "DZD", "TND", "AED", "SAR",
  "EGP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR",
];

/** Structure files, processed in this order. `index` is last: it only
 *  aggregates, so its alias $defs collide with names already emitted and are
 *  skipped — only its genuinely new `CommerceObject` union is kept. */
const STRUCTURE_FILES = [
  "money", "party", "value", "intent",
  "commitment", "fulfillment", "auxiliary", "index",
];

// The two untagged unions (no shared discriminant const across members).
const UNTAGGED_UNIONS = new Set(["MoneyOrBreakdown", "CommerceObject"]);

const PRIMITIVES = { string: "string", number: "float64", integer: "int64", boolean: "bool" };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function refName(ref) {
  const m = /#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  if (!m) throw new Error(`Unresolvable $ref: ${ref}`);
  return m[1];
}

function pascal(name) {
  return String(name)
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
}

/** Exported Go field name for a wire property (always capitalised; the wire
 *  name is preserved via the json tag). */
function goFieldName(name) {
  return pascal(name);
}

// ---------------------------------------------------------------------------
// generator
// ---------------------------------------------------------------------------

class Generator {
  constructor() {
    this.allDefs = new Map();   // name -> node (first wins across files)
    this.blocks = [];           // emitted top-level Go items (in order)
    this.emitted = new Set();   // top-level $def names already emitted
    this.auxClasses = [];       // generated inline types (struct/union/enum)
    this.auxNames = new Set();
  }

  load(name) {
    return JSON.parse(readFileSync(join(STRUCTURE_DIR, `${name}.schema.json`), "utf8"));
  }

  resolve(node) {
    if (node && node.$ref) return this.allDefs.get(refName(node.$ref)) || {};
    return node;
  }

  // Discriminant key of an (object) schema node, if it has a `type` or `kind`
  // property carrying a `const`.
  discriminantKey(node) {
    const obj = this.resolve(node);
    const props = (obj && obj.properties) || {};
    for (const key of ["type", "kind"]) {
      if (props[key] && "const" in props[key]) return key;
    }
    return null;
  }

  // The shared discriminant across all oneOf members, or null (untagged).
  commonDiscriminator(members) {
    const keys = members.map((m) => this.discriminantKey(m));
    if (keys.length && keys.every((k) => k !== null && k === keys[0])) return keys[0];
    return null;
  }

  // -- render a schema node to a Go type expression --
  // `boxable` (kept for parity with the Rust generator's cycle handling): in Go,
  // recursion is broken with pointers; we emit named refs in cycle position as
  // *T. `pointerizeCycle` controls that.
  renderType(node, hint, pointerizeCycle) {
    if (node.$ref) {
      const n = refName(node.$ref);
      if (pointerizeCycle && this.isCycleType(n)) return `*${n}`;
      return n;
    }
    if ("const" in node) {
      return "string";
    }
    if (node.enum && node.type !== "object") {
      if (node.enum.every((v) => typeof v === "string")) return this.emitStringEnum(hint, node.enum);
      const t = node.type || (typeof node.enum[0] === "number" && Number.isInteger(node.enum[0]) ? "integer" : "string");
      return PRIMITIVES[t] || "json.RawMessage";
    }
    if (node.oneOf) return this.renderUnion(node.oneOf, hint);
    const t = node.type;
    if (t === "array") {
      const item = this.renderType(node.items || {}, hint + "Item", false);
      return `[]${item}`;
    }
    if (t === "object" || node.properties) return this.emitInlineStruct(hint, node);
    if (t in PRIMITIVES) return PRIMITIVES[t];
    return "json.RawMessage";
  }

  // Types that participate in the one recursion cycle in the spine.
  isCycleType(name) {
    return name === "Value" || name === "ContingentValue" || name === "ValueForm";
  }

  // -- inline string enum (field-level `enum`) --
  emitStringEnum(name, values) {
    const typeName = pascal(name);
    if (this.auxNames.has(typeName) || this.emitted.has(typeName)) return typeName;
    this.auxNames.add(typeName);
    this.auxClasses.push(this.renderStringEnum(typeName, values));
    return typeName;
  }

  renderStringEnum(typeName, values) {
    const consts = values
      .map((v) => `\t${typeName}${pascal(String(v))} ${typeName} = ${JSON.stringify(String(v))}`)
      .join("\n");
    return `type ${typeName} string\n\nconst (\n${consts}\n)`;
  }

  // -- inline struct (anonymous object at a field) --
  emitInlineStruct(name, node) {
    const typeName = pascal(name);
    if (this.auxNames.has(typeName) || this.emitted.has(typeName)) return typeName;
    this.auxNames.add(typeName);
    this.auxClasses.push(this.renderStruct(typeName, node));
    return typeName;
  }

  // Field rendering shared by structs and union-merged structs. Returns
  // { fieldName, line } where line is a full Go struct field declaration.
  // `forceOptional` makes a normally-required field optional (used when merging
  // union members, where a field required by one variant is absent in another).
  renderField(pname, pnode, requiredSet, hint, forceOptional) {
    const isArray = pnode.type === "array";
    const isReq = requiredSet.has(pname) && !forceOptional;
    let ty = this.renderType(pnode, hint + pascal(pname), !isArray);
    let tag = `\`json:"${pname}`;
    if (isArray) {
      tag += `,omitempty"\``;
    } else if (!isReq) {
      // optional scalar/named field → pointer + omitempty so absence is zero.
      if (!ty.startsWith("*") && !ty.startsWith("[]")) ty = `*${ty}`;
      tag += `,omitempty"\``;
    } else {
      tag += `"\``;
    }
    return { fieldName: goFieldName(pname), line: `\t${goFieldName(pname)} ${ty} ${tag}`, ty };
  }

  // Render an object node as a Go struct. The discriminant const field, if any,
  // is DROPPED for inline objects only when this is a union member; a top-level
  // object keeps all its (non-const) fields.
  renderStruct(typeName, node) {
    const props = node.properties || {};
    const required = new Set(node.required || []);
    const lines = [];
    for (const [pname, pnode] of Object.entries(props)) {
      if ("const" in pnode) continue; // drop discriminant consts
      lines.push(this.renderField(pname, pnode, required, typeName, false).line);
    }
    const body = lines.length ? `\n${lines.join("\n")}\n` : "";
    return `type ${typeName} struct {${body}}`;
  }

  // -- union rendering (at a field position) --
  renderUnion(members, hint) {
    const typeName = pascal(hint);
    if (this.auxNames.has(typeName) || this.emitted.has(typeName)) return typeName;
    this.auxNames.add(typeName);
    this.auxClasses.push(this.renderUnionDef(typeName, members));
    return typeName;
  }

  renderUnionDef(typeName, members, forceUntagged = false) {
    const disc = forceUntagged ? null : this.commonDiscriminator(members);
    if (!disc) {
      // Untagged union — no shared discriminant. Modelled as raw JSON; the
      // runtime never destructures these (MoneyOrBreakdown / CommerceObject).
      return (
        `// ${typeName} is an untagged union (no shared discriminant); carried as\n` +
        `// raw JSON. The runtime never destructures it.\n` +
        `type ${typeName} = json.RawMessage`
      );
    }
    // Tagged union → one struct: discriminant field + the merged union of all
    // member fields (deduped; every non-discriminant field optional).
    const discField = goFieldName(disc);
    const merged = new Map(); // fieldName -> { line, ty }
    for (const m of members) {
      const obj = this.resolve(m);
      const props = obj.properties || {};
      const required = new Set(obj.required || []);
      for (const [pname, pnode] of Object.entries(props)) {
        if ("const" in pnode) continue; // discriminant consts dropped
        const f = this.renderField(pname, pnode, required, typeName, /*forceOptional*/ true);
        if (merged.has(f.fieldName)) {
          const prev = merged.get(f.fieldName);
          if (prev.ty !== f.ty) {
            // Same field name, different types across variants → raw JSON.
            merged.set(f.fieldName, {
              ty: "json.RawMessage",
              line: `\t${f.fieldName} json.RawMessage \`json:"${pname},omitempty"\``,
            });
          }
        } else {
          merged.set(f.fieldName, f);
        }
      }
    }
    const fieldLines = [`\t${discField} string \`json:"${disc}"\``];
    for (const f of merged.values()) fieldLines.push(f.line);
    return (
      `// ${typeName} is a tagged union over \`${disc}\`; the Go binding flattens\n` +
      `// all variant fields into one struct (see generator header).\n` +
      `type ${typeName} struct {\n${fieldLines.join("\n")}\n}`
    );
  }

  // -- top-level $def dispatch --
  emitDef(name, node) {
    if (BRANDS.has(name)) {
      this.blocks.push(
        `// ${name} is a branded identifier (Invariant 5); the brand is documentation only in Go.\n` +
          `type ${name} = string`,
      );
      return;
    }
    if (name === "CurrencyCode") {
      this.blocks.push(
        `// CurrencyCode is an OPEN string (any ISO 4217 code + Custom denominations like "PTS").\n` +
          `// Common set for reference: ${CURRENCY_LITERALS.join(", ")}\n` +
          `type CurrencyCode = string`,
      );
      return;
    }
    if (node.$ref) {
      const target = refName(node.$ref);
      if (target !== name) this.blocks.push(`type ${name} = ${target}`);
      return;
    }
    if (node.enum && node.type !== "object") {
      if (node.enum.every((v) => typeof v === "string")) {
        this.blocks.push(this.renderStringEnum(name, node.enum));
      } else {
        const t = node.type || "string";
        this.blocks.push(`type ${name} = ${PRIMITIVES[t] || "json.RawMessage"}`);
      }
      return;
    }
    if ("const" in node) {
      this.blocks.push(`type ${name} = string`);
      return;
    }
    if (node.oneOf) {
      this.blocks.push(this.renderUnionDef(name, node.oneOf, UNTAGGED_UNIONS.has(name)));
      return;
    }
    if (node.type === "object" || node.properties) {
      this.blocks.push(this.renderStruct(name, node));
      return;
    }
    if (node.type === "array") {
      const item = this.renderType(node.items || {}, name + "Item", false);
      this.blocks.push(`type ${name} = []${item}`);
      return;
    }
    if (node.type in PRIMITIVES) {
      this.blocks.push(`type ${name} = ${PRIMITIVES[node.type]}`);
      return;
    }
    this.blocks.push(`type ${name} = json.RawMessage`);
  }

  run(version) {
    const schemas = {};
    for (const f of STRUCTURE_FILES) schemas[f] = this.load(f);
    // populate allDefs (first definition wins, matching the other generators)
    for (const f of STRUCTURE_FILES) {
      for (const [n, node] of Object.entries(schemas[f].$defs || {})) {
        if (!this.allDefs.has(n)) this.allDefs.set(n, node);
      }
    }

    for (const f of STRUCTURE_FILES) {
      for (const [name, node] of Object.entries(schemas[f].$defs || {})) {
        if (this.emitted.has(name)) continue;
        if (node.$ref && refName(node.$ref) === name) continue; // bare passthrough alias
        this.emitDef(name, node);
        this.emitted.add(name);
      }
    }
    return this.renderModule(version);
  }

  renderModule(version) {
    const header =
      `// Code generated by bindings/go/generate-go.mjs from schema/structure/*.schema.json (v${version}). DO NOT EDIT.\n` +
      `// Run \`node bindings/go/generate-go.mjs\` to refresh;\n` +
      `// \`node bindings/go/generate-go.mjs --check\` (CI) fails if this file drifts.\n` +
      `package generated\n\n` +
      `import "encoding/json"\n\n` +
      `// SchemaVersion is the frozen schema version these types were generated from.\n` +
      `const SchemaVersion = ${JSON.stringify(version)}\n`;
    const parts = [header];
    if (this.auxClasses.length) {
      parts.push(`\n// --- generated helper types (inline objects / unions / enums) ---\n`);
      parts.push(this.auxClasses.join("\n\n"));
    }
    parts.push(`\n// --- named $defs ---\n`);
    parts.push(this.blocks.join("\n\n"));
    return parts.join("\n") + "\n";
  }
}

// ---------------------------------------------------------------------------
// transitions_gen.go (verbatim from behavior/transitions.json)
// ---------------------------------------------------------------------------

function buildTransitions(version) {
  const data = JSON.parse(readFileSync(join(BEHAVIOR_DIR, "transitions.json"), "utf8"));
  const header =
    `// Code generated by bindings/go/generate-go.mjs from schema/behavior/transitions.json (v${version}). DO NOT EDIT.\n` +
    `// Run \`node bindings/go/generate-go.mjs\` to refresh.\n` +
    `//\n` +
    `// The model's ${data.notes.commitment_count} valid commitment transitions across 11 states. Every other\n` +
    `// pair is rejected — this table IS the machine-readable form of Invariant 2.\n` +
    `// The Failed -> Planned fulfillment special case (recoverable only) is NOT in\n` +
    `// the table; it is applied in runtime.go per the schema's documented note.\n` +
    `package generated\n\n`;

  function renderTable(constName, table) {
    const lines = Object.entries(table).map(([from, tos]) => {
      const arr = tos.map((t) => JSON.stringify(t)).join(", ");
      return `\t${JSON.stringify(from)}: {${arr}},`;
    });
    return `var ${constName} = map[string][]string{\n` + lines.join("\n") + `\n}`;
  }

  return (
    header +
    renderTable("CommitmentTransitions", data.commitment) +
    "\n\n" +
    renderTable("IntentTransitions", data.intent) +
    "\n\n" +
    renderTable("FulfillmentTransitions", data.fulfillment) +
    "\n"
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const check = process.argv.includes("--check");
  const version = readFileSync(join(SCHEMA_DIR, "VERSION"), "utf8").trim();

  const outputs = [
    [join(OUT_DIR, "types_gen.go"), gofmt(new Generator().run(version))],
    [join(OUT_DIR, "transitions_gen.go"), gofmt(buildTransitions(version))],
  ];

  if (check) {
    let drift = false;
    for (const [path, content] of outputs) {
      const current = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (current !== content) {
        drift = true;
        console.error(`drift: ${path} is out of date with the schema.`);
      }
    }
    if (drift) {
      console.error("\nGenerated Go drifted from schema/. Run `node bindings/go/generate-go.mjs` and commit.");
      process.exit(1);
    }
    console.log("codegen: generated Go is in sync with schema/.");
    return;
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  for (const [path, content] of outputs) {
    writeFileSync(path, content);
    console.log(`wrote ${path}`);
  }
}

main();
