#!/usr/bin/env node
/**
 * generate-rust.mjs — regenerate the warp-commerce-types Rust structural types
 * from the canonical schema spine (schema/structure/*.schema.json) and the
 * transition tables from schema/behavior/transitions.json.
 *
 * The schema (JSON Schema Draft 2020-12) is the language-neutral source of
 * truth; this generator is the Rust binding. It is a faithful sibling of the
 * TypeScript generator (packages/commerce-types/scripts/generate-from-schema.mjs)
 * and the Python generator (packages/commerce-types-py/scripts/generate_from_schema.py):
 * the SAME structure-file order, the SAME BRANDS / open-CurrencyCode CONFIG
 * seams (the parts JSON Schema cannot carry, re-applied here by name), and the
 * transition tables synced VERBATIM from schema/behavior/transitions.json.
 *
 * It emits two files into the crate:
 *
 *   src/generated/types.rs        — every $def as a serde-derived Rust type
 *   src/generated/transitions.rs  — the commitment/intent/fulfillment transition
 *                                   tables, verbatim from behavior/transitions.json
 *
 * The hand-written runtime (transition validity incl. the Failed->Planned
 * recoverable special case, the six-invariant scene audit, money precision /
 * tolerance / breakdown-sum) is NOT generated — it lives in src/runtime.rs and
 * consumes these generated types.
 *
 * Usage:
 *   node scripts/generate-rust.mjs          # write the generated files
 *   node scripts/generate-rust.mjs --check  # exit 1 if on-disk output drifts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Run the emitted Rust through `rustfmt` so the committed generated files are
 * canonical under both this generator AND `cargo fmt --check` (CI runs the
 * latter on every file). rustfmt ships with the stable toolchain. If it is not
 * on PATH the raw output is returned unchanged — the drift `--check` still
 * compares generator-to-disk faithfully.
 */
function rustfmt(src) {
  try {
    return execFileSync("rustfmt", ["--edition", "2021", "--emit", "stdout", "--quiet"], {
      input: src,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return src;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, "..", "..", "..", "schema");
const STRUCTURE_DIR = join(SCHEMA_DIR, "structure");
const BEHAVIOR_DIR = join(SCHEMA_DIR, "behavior");
const OUT_DIR = join(HERE, "..", "src", "generated");

// ---------------------------------------------------------------------------
// CONFIG — the parts JSON Schema cannot carry, re-applied by NAME. These mirror
// the TS/Python generators' CONFIG blocks exactly — the deliberate, documented
// seams between the language-neutral schema and a binding.
// ---------------------------------------------------------------------------

/** Branded identifiers (Invariant 5). The schema carries them as plain strings;
 *  Rust has no structural brands, so each becomes a documented `type X = String`. */
const BRANDS = new Set(["PartyID", "IntentID", "CommitmentID", "FulfillmentID", "ValueID"]);

/** CurrencyCode is an OPEN string in the schema (any ISO 4217 code plus Custom
 *  denominations like "PTS"). TS keeps literal suggestions via `(string & {})`;
 *  Rust keeps it a plain `String` alias. The common set is documented for
 *  reference, exactly as the other generators re-apply it (not derivable). */
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

const PRIMITIVES = { string: "String", number: "f64", integer: "i64", boolean: "bool" };
const RUST_KEYWORDS = new Set([
  "as","break","const","continue","crate","dyn","else","enum","extern","false","fn","for","if",
  "impl","in","let","loop","match","mod","move","mut","pub","ref","return","self","Self","static",
  "struct","super","trait","true","type","unsafe","use","where","while","async","await","box",
  "abstract","become","do","final","macro","override","priv","typeof","unsized","virtual","yield","try",
]);

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

function safeFieldName(name) {
  return RUST_KEYWORDS.has(name) ? `r#${name}` : name;
}

// ---------------------------------------------------------------------------
// generator
// ---------------------------------------------------------------------------

class Generator {
  constructor() {
    this.allDefs = new Map();        // name -> node (first wins across files)
    this.blocks = [];                // emitted top-level Rust items (in order)
    this.emitted = new Set();        // top-level $def names already emitted
    this.auxClasses = [];            // generated inline structs (struct variants etc.)
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

  // -- render a schema node to a Rust type expression --
  renderType(node, hint, boxable) {
    if (node.$ref) {
      const n = refName(node.$ref);
      // Box a by-value named (non-Vec) field that participates in a type cycle,
      // to keep the struct finitely sized. Value<->ContingentValue is the only
      // cycle in the spine; Box the named non-primitive ref here.
      if (boxable && this.isCycleType(n)) return `Box<${n}>`;
      return n;
    }
    if ("const" in node) {
      // A bare const used as a value type — model as String (rare; discriminant
      // consts are dropped before we get here).
      return "String";
    }
    if (node.enum && node.type !== "object") {
      // An enum of non-string scalars (e.g. integer `days: [30,60,90]`) has no
      // valid Rust identifier per variant; model it as its scalar primitive —
      // serde accepts any value of that primitive and the runner does the
      // structural enum check. A string enum gets a dedicated Rust enum.
      if (node.enum.every((v) => typeof v === "string")) return this.emitStringEnum(hint, node.enum);
      const t = node.type || (typeof node.enum[0] === "number" && Number.isInteger(node.enum[0]) ? "integer" : "string");
      return PRIMITIVES[t] || "serde_json::Value";
    }
    if (node.oneOf) return this.renderUnion(node.oneOf, hint);
    const t = node.type;
    if (t === "array") {
      const item = this.renderType(node.items || {}, hint + "Item", false);
      return `Vec<${item}>`;
    }
    if (t === "object" || node.properties) return this.emitInlineStruct(hint, node);
    if (t in PRIMITIVES) return PRIMITIVES[t];
    return "serde_json::Value";
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
    const variants = values.map((v) => {
      const variant = pascal(String(v));
      return `    #[serde(rename = ${JSON.stringify(String(v))})]\n    ${variant},`;
    });
    return (
      `#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]\n` +
      `pub enum ${typeName} {\n${variants.join("\n")}\n}`
    );
  }

  // -- inline struct (anonymous object at a field) --
  emitInlineStruct(name, node) {
    const typeName = pascal(name);
    if (this.auxNames.has(typeName) || this.emitted.has(typeName)) return typeName;
    this.auxNames.add(typeName);
    this.auxClasses.push(this.renderStruct(typeName, node));
    return typeName;
  }

  // Render an object node as a Rust struct (the discriminant const field, if
  // any, is DROPPED — serde internally-tagged enums strip the tag before
  // deserializing the variant, and serde ignores unknown fields on input).
  renderStruct(typeName, node) {
    const props = node.properties || {};
    const required = new Set(node.required || []);
    const fieldLines = [];
    for (const [pname, pnode] of Object.entries(props)) {
      if ("const" in pnode) continue; // drop discriminant consts
      const isArray = pnode.type === "array";
      const isReq = required.has(pname);
      let ty = this.renderType(pnode, typeName + pascal(pname), !isArray);
      const attrs = [];
      if (isArray) {
        attrs.push(`#[serde(default)]`);
      } else if (!isReq) {
        ty = `Option<${ty}>`;
        attrs.push(`#[serde(default, skip_serializing_if = "Option::is_none")]`);
      }
      const rustName = safeFieldName(pname);
      if (rustName !== pname) {
        attrs.unshift(`#[serde(rename = ${JSON.stringify(pname)})]`);
      }
      const attrStr = attrs.length ? "    " + attrs.join("\n    ") + "\n" : "";
      fieldLines.push(`${attrStr}    pub ${rustName}: ${ty},`);
    }
    const body = fieldLines.length ? `\n${fieldLines.join("\n")}\n` : "\n";
    return (
      `#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]\n` +
      `pub struct ${typeName} {${body}}`
    );
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
      // untagged union
      const variants = members.map((m, i) => {
        const inner = this.renderType(m, typeName + `Member${i}`, false);
        return `    ${this.variantNameForUntagged(m, inner, i)}(${inner}),`;
      });
      return (
        `#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]\n` +
        `#[serde(untagged)]\n` +
        `pub enum ${typeName} {\n${variants.join("\n")}\n}`
      );
    }
    // tagged union
    const variants = members.map((m, i) => {
      const obj = this.resolve(m);
      const tag = obj.properties && obj.properties[disc] && obj.properties[disc].const;
      const variantName = tag != null ? pascal(String(tag)) : `Member${i}`;
      if (m.$ref) {
        const inner = refName(m.$ref);
        return `    ${variantName}(${inner}),`;
      }
      // inline object member → struct variant with fields inlined (disc dropped)
      const fieldLines = this.inlineVariantFields(obj, typeName + variantName);
      if (fieldLines.length === 0) return `    ${variantName},`;
      return `    ${variantName} {\n${fieldLines.join("\n")}\n    },`;
    });
    return (
      `#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]\n` +
      `#[serde(tag = ${JSON.stringify(disc)})]\n` +
      `pub enum ${typeName} {\n${variants.join("\n")}\n}`
    );
  }

  variantNameForUntagged(m, inner, i) {
    if (m.$ref) return refName(m.$ref);
    // derive a name from the rendered inner type
    return /^[A-Z][A-Za-z0-9]*$/.test(inner) ? inner : `Member${i}`;
  }

  // Fields of an inline tagged-union struct variant (disc const dropped).
  inlineVariantFields(node, hint) {
    const props = node.properties || {};
    const required = new Set(node.required || []);
    const lines = [];
    for (const [pname, pnode] of Object.entries(props)) {
      if ("const" in pnode) continue;
      const isArray = pnode.type === "array";
      const isReq = required.has(pname);
      let ty = this.renderType(pnode, hint + pascal(pname), !isArray);
      const attrs = [];
      if (isArray) {
        attrs.push(`#[serde(default)]`);
      } else if (!isReq) {
        ty = `Option<${ty}>`;
        attrs.push(`#[serde(default, skip_serializing_if = "Option::is_none")]`);
      }
      const rustName = safeFieldName(pname);
      if (rustName !== pname) attrs.unshift(`#[serde(rename = ${JSON.stringify(pname)})]`);
      const attrStr = attrs.length ? "        " + attrs.join("\n        ") + "\n" : "";
      lines.push(`${attrStr}        ${rustName}: ${ty},`);
    }
    return lines;
  }

  // -- top-level $def dispatch --
  emitDef(name, node) {
    if (BRANDS.has(name)) {
      this.blocks.push(
        `/// Branded identifier (Invariant 5); the brand is documentation only in Rust.\n` +
          `pub type ${name} = String;`,
      );
      return;
    }
    if (name === "CurrencyCode") {
      this.blocks.push(
        `/// CurrencyCode is an OPEN string (any ISO 4217 code + Custom denominations like "PTS").\n` +
          `/// Common set for reference: ${CURRENCY_LITERALS.join(", ")}\n` +
          `pub type CurrencyCode = String;`,
      );
      return;
    }
    if (node.$ref) {
      const target = refName(node.$ref);
      if (target !== name) this.blocks.push(`pub type ${name} = ${target};`);
      return;
    }
    if (node.enum && node.type !== "object") {
      if (node.enum.every((v) => typeof v === "string")) {
        this.blocks.push(this.renderStringEnum(name, node.enum));
      } else {
        const t = node.type || "string";
        this.blocks.push(`pub type ${name} = ${PRIMITIVES[t] || "serde_json::Value"};`);
      }
      return;
    }
    if ("const" in node) {
      this.blocks.push(`pub type ${name} = String;`);
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
      this.blocks.push(`pub type ${name} = Vec<${item}>;`);
      return;
    }
    if (node.type in PRIMITIVES) {
      this.blocks.push(`pub type ${name} = ${PRIMITIVES[node.type]};`);
      return;
    }
    this.blocks.push(`pub type ${name} = serde_json::Value;`);
  }

  run(version) {
    const schemas = {};
    for (const f of STRUCTURE_FILES) schemas[f] = this.load(f);
    // populate allDefs (first definition wins, matching the Python generator)
    for (const f of STRUCTURE_FILES) {
      for (const [n, node] of Object.entries(schemas[f].$defs || {})) {
        if (!this.allDefs.has(n)) this.allDefs.set(n, node);
      }
    }

    const fileHeaders = [];
    for (const f of STRUCTURE_FILES) {
      const before = this.blocks.length;
      const auxBefore = this.auxClasses.length;
      for (const [name, node] of Object.entries(schemas[f].$defs || {})) {
        if (this.emitted.has(name)) continue;
        if (node.$ref && refName(node.$ref) === name) continue; // bare passthrough alias
        this.emitDef(name, node);
        this.emitted.add(name);
      }
      if (this.blocks.length > before || this.auxClasses.length > auxBefore) {
        fileHeaders.push({ file: f, at: before, auxAt: auxBefore });
      }
    }
    return this.renderModule(version);
  }

  renderModule(version) {
    const header =
      `// @generated by scripts/generate-rust.mjs from schema/structure/*.schema.json (v${version}).\n` +
      `// DO NOT EDIT BY HAND. Run \`node scripts/generate-rust.mjs\` to refresh;\n` +
      `// \`node scripts/generate-rust.mjs --check\` (CI) fails if this file drifts.\n` +
      `#![allow(clippy::large_enum_variant)]\n\n` +
      `/// The frozen schema version these types were generated from.\n` +
      `pub const SCHEMA_VERSION: &str = ${JSON.stringify(version)};\n`;
    // aux (inline) classes first so they are defined before use is irrelevant in
    // Rust (order-independent), but emit them in a stable section.
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
// transitions.rs (verbatim from behavior/transitions.json)
// ---------------------------------------------------------------------------

function buildTransitions(version) {
  const data = JSON.parse(readFileSync(join(BEHAVIOR_DIR, "transitions.json"), "utf8"));
  const header =
    `// @generated by scripts/generate-rust.mjs from schema/behavior/transitions.json (v${version}).\n` +
    `// DO NOT EDIT BY HAND. Run \`node scripts/generate-rust.mjs\` to refresh.\n` +
    `//\n` +
    `// The model's ${data.notes.commitment_count} valid commitment transitions across 11 states. Every other\n` +
    `// pair is rejected — this table IS the machine-readable form of Invariant 2.\n` +
    `// The Failed -> Planned fulfillment special case (recoverable only) is NOT in\n` +
    `// the table; it is applied in runtime.rs per the schema's documented note.\n\n`;

  function renderTable(constName, table) {
    const lines = Object.entries(table).map(([from, tos]) => {
      const arr = tos.map((t) => JSON.stringify(t)).join(", ");
      return `    (${JSON.stringify(from)}, &[${arr}]),`;
    });
    return (
      `pub const ${constName}: &[(&str, &[&str])] = &[\n` +
      lines.join("\n") +
      `\n];`
    );
  }

  return (
    header +
    renderTable("COMMITMENT_TRANSITIONS", data.commitment) +
    "\n\n" +
    renderTable("INTENT_TRANSITIONS", data.intent) +
    "\n\n" +
    renderTable("FULFILLMENT_TRANSITIONS", data.fulfillment) +
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
    [join(OUT_DIR, "types.rs"), rustfmt(new Generator().run(version))],
    [join(OUT_DIR, "transitions.rs"), rustfmt(buildTransitions(version))],
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
      console.error("\nGenerated Rust drifted from schema/. Run `node scripts/generate-rust.mjs` and commit.");
      process.exit(1);
    }
    console.log("codegen: generated Rust is in sync with schema/.");
    return;
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  for (const [path, content] of outputs) {
    writeFileSync(path, content);
    console.log(`wrote ${path}`);
  }
}

main();
