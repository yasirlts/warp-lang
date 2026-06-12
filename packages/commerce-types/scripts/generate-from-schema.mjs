#!/usr/bin/env node
/**
 * generate-from-schema.mjs — regenerate the @warp-lang/commerce-types structural
 * types from the canonical schema spine (schema/structure/*.schema.json) and the
 * transition tables from schema/behavior/transitions.json.
 *
 * The schema (JSON Schema Draft 2020-12) is the language-neutral source of truth;
 * this generator is the TypeScript binding. It emits two files:
 *
 *   src/generated/types.generated.ts       — every $def, as a TS type
 *   src/generated/transitions.generated.ts — the commitment/intent/fulfillment
 *                                             transition tables, verbatim from
 *                                             behavior/transitions.json
 *
 * Two things JSON Schema cannot express are re-applied here, by NAME, from the
 * CONFIG block below — exactly as the schema READMEs delegate to "the TypeScript
 * generator":
 *   1. Identifier BRANDS (PartyID, CommitmentID, …) → `string & { __brand }`.
 *   2. CurrencyCode's literal-suggestion-plus-open-string form.
 *
 * Runtime helpers (Money math, transition functions, invariant checkers, the
 * platform adapters) are NOT generated — they live hand-written in src/ and
 * consume these generated types.
 *
 * Usage:
 *   node scripts/generate-from-schema.mjs          # write the generated files
 *   node scripts/generate-from-schema.mjs --check  # fail (exit 1) if on-disk
 *                                                  # output would drift
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, "..", "..", "..", "schema");
const STRUCTURE_DIR = join(SCHEMA_DIR, "structure");
const BEHAVIOR_DIR = join(SCHEMA_DIR, "behavior");
const OUT_DIR = join(HERE, "..", "src", "generated");

// ---------------------------------------------------------------------------
// CONFIG — the parts JSON Schema cannot carry, re-applied by name. Keep these
// EXACTLY matching the live package; they are the deliberate, documented seams
// between the language-neutral schema and the TypeScript binding.
// ---------------------------------------------------------------------------

/** Branded identifiers (Invariant 5). Schema carries them as plain strings. */
const BRANDS = new Set(["PartyID", "IntentID", "CommitmentID", "FulfillmentID", "ValueID"]);

/**
 * CurrencyCode is an OPEN string in the schema (it must admit any ISO 4217 code
 * plus CurrencyCode::Custom denominations like "PTS"). TypeScript keeps the
 * common set as literal suggestions for autocomplete while staying open via
 * `(string & {})`. This list is the literal-suggestion set — not derivable from
 * the schema's `examples`, re-applied here by the generator as the README says.
 */
const CURRENCY_LITERALS = [
  "MAD", "EUR", "USD", "GBP", "DZD", "TND", "AED", "SAR",
  "EGP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR",
];

/**
 * `<Union>["type"]` discriminant aliases the package exposes that the schema
 * does NOT carry as their own $def. (CommitmentStateType IS a schema $def, so it
 * is generated directly and omitted here to avoid a duplicate.)
 */
const DERIVED_TYPE_ALIASES = [
  ["IntentStateType", "IntentState"],
  ["FulfillmentStateType", "FulfillmentState"],
  ["PaymentTimingType", "PaymentTiming"],
];

/** Structure schema files, processed in this order. `index` is last: it only
 *  aggregates, so its alias $defs collide with names already emitted and are
 *  skipped — only its genuinely new `CommerceObject` union is kept. */
const STRUCTURE_FILES = [
  "money", "party", "value", "intent",
  "commitment", "fulfillment", "auxiliary", "index",
];

// ---------------------------------------------------------------------------
// Schema → TypeScript rendering
// ---------------------------------------------------------------------------

/** Resolve the trailing name of a `$ref` (same-file or cross-file). */
function refName(ref) {
  const m = /#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  if (!m) throw new Error(`Unresolvable $ref: ${ref}`);
  return m[1];
}

function literal(value) {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

const pad = (depth) => "  ".repeat(depth);

/**
 * Render a schema node to a TypeScript type expression. `depth` is the current
 * indentation level (for nested object/union pretty-printing).
 */
function renderNode(node, depth) {
  if (node.$ref) return refName(node.$ref);
  if (node.const !== undefined) return literal(node.const);
  if (node.enum) return node.enum.map(literal).join(" | ");
  if (node.oneOf) return renderUnion(node.oneOf, depth);

  const t = node.type;
  if (t === "object" || node.properties) return renderObject(node, depth);
  if (t === "array") {
    const item = node.items ? renderNode(node.items, depth) : "unknown";
    // Parenthesise union/object item types so `T[]` binds correctly.
    return /[|{}]/.test(item) ? `Array<${item}>` : `${item}[]`;
  }
  if (t === "string") return "string";
  if (t === "number" || t === "integer") return "number";
  if (t === "boolean") return "boolean";
  return "unknown";
}

/** Render a `oneOf` as a union, one member per line when multi-membered. */
function renderUnion(members, depth) {
  const rendered = members.map((m) => renderNode(m, depth));
  if (rendered.length === 1) return rendered[0];
  return "\n" + rendered.map((r) => `${pad(depth + 1)}| ${r}`).join("\n");
}

/** Render a JSON-Schema object node as a TS object type literal. */
function renderObject(node, depth) {
  const props = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const keys = Object.keys(props);
  if (keys.length === 0) return "Record<string, never>";
  const lines = keys.map((key) => {
    const opt = required.has(key) ? "" : "?";
    const value = renderNode(props[key], depth + 1);
    return `${pad(depth + 1)}${key}${opt}: ${value};`;
  });
  return `{\n${lines.join("\n")}\n${pad(depth)}}`;
}

/** Render a single top-level `$def` as `export type <Name> = …;`. */
function renderDef(name, node) {
  if (BRANDS.has(name)) {
    // Invariant 5 brand — JSON Schema carries it as a plain string.
    return `export type ${name} = string & { readonly __brand: ${JSON.stringify(name)} };`;
  }
  if (name === "CurrencyCode") {
    const lits = CURRENCY_LITERALS.map((c) => `\n  | ${JSON.stringify(c)}`).join("");
    // The `(string & {})` member keeps the type open while preserving the
    // literal suggestions above (a well-known TS idiom for open string unions).
    return `export type ${name} =${lits}\n  // eslint-disable-next-line @typescript-eslint/ban-types\n  | (string & {});`;
  }
  return `export type ${name} = ${renderNode(node, 0)};`;
}

// ---------------------------------------------------------------------------
// Build types.generated.ts
// ---------------------------------------------------------------------------

function loadStructure(name) {
  return JSON.parse(readFileSync(join(STRUCTURE_DIR, `${name}.schema.json`), "utf8"));
}

function buildTypes(version) {
  const blocks = [];
  const emitted = new Set();

  for (const file of STRUCTURE_FILES) {
    const schema = loadStructure(file);
    const defs = schema.$defs ?? {};
    const localBlocks = [];
    for (const [name, node] of Object.entries(defs)) {
      if (emitted.has(name)) continue; // already defined upstream (index aliases)
      // A bare passthrough alias to a same-named def elsewhere — skip it.
      if (node.$ref && refName(node.$ref) === name) continue;
      localBlocks.push(renderDef(name, node));
      emitted.add(name);
    }
    if (localBlocks.length > 0) {
      blocks.push(`// --- ${file}.schema.json ${"-".repeat(Math.max(0, 60 - file.length))}`);
      blocks.push(localBlocks.join("\n\n"));
    }
  }

  // Discriminant aliases the package exposes but the schema does not name.
  const aliases = DERIVED_TYPE_ALIASES.filter(([alias]) => !emitted.has(alias)).map(
    ([alias, base]) => `export type ${alias} = ${base}["type"];`,
  );
  if (aliases.length > 0) {
    blocks.push(`// --- derived discriminant aliases ${"-".repeat(43)}`);
    blocks.push(aliases.join("\n"));
  }

  const header = banner("schema/structure/*.schema.json", version);
  return (
    header +
    `\n/** The frozen schema version these types were generated from. */\n` +
    `export const SCHEMA_VERSION = ${JSON.stringify(version)};\n\n` +
    blocks.join("\n\n") +
    "\n"
  );
}

// ---------------------------------------------------------------------------
// Build transitions.generated.ts
// ---------------------------------------------------------------------------

function renderTable(name, keyType, table) {
  const lines = Object.entries(table).map(([from, tos]) => {
    const arr = tos.length === 0 ? "[]" : `[${tos.map((t) => JSON.stringify(t)).join(", ")}]`;
    return `  ${from}: ${arr},`;
  });
  return (
    `export const ${name}: Record<${keyType}, readonly ${keyType}[]> = {\n` +
    lines.join("\n") +
    `\n};`
  );
}

function buildTransitions(version) {
  const data = JSON.parse(readFileSync(join(BEHAVIOR_DIR, "transitions.json"), "utf8"));
  const header = banner("schema/behavior/transitions.json", version);
  return (
    header +
    `import type {\n` +
    `  CommitmentStateType,\n  IntentStateType,\n  FulfillmentStateType,\n` +
    `} from "./types.generated.js";\n\n` +
    `/**\n` +
    ` * The model's ${data.notes.commitment_count} valid commitment transitions across 11 states. Every other\n` +
    ` * pair is rejected — this table IS the machine-readable form of Invariant 2.\n` +
    ` * The Failed -> Planned fulfillment special case (recoverable only) is NOT in\n` +
    ` * the table; it is applied in transitions.ts per the schema's documented note.\n` +
    ` */\n` +
    renderTable("COMMITMENT_TRANSITIONS", "CommitmentStateType", data.commitment) +
    "\n\n" +
    renderTable("INTENT_TRANSITIONS", "IntentStateType", data.intent) +
    "\n\n" +
    renderTable("FULFILLMENT_TRANSITIONS", "FulfillmentStateType", data.fulfillment) +
    "\n"
  );
}

function banner(source, version) {
  return (
    `// @generated by scripts/generate-from-schema.mjs from ${source} (v${version}).\n` +
    `// DO NOT EDIT BY HAND. Run \`npm run generate\` to refresh; \`npm run codegen\`\n` +
    `// (CI) fails if this file drifts from the schema.\n\n`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const check = process.argv.includes("--check");
  const version = readFileSync(join(SCHEMA_DIR, "VERSION"), "utf8").trim();

  const outputs = [
    [join(OUT_DIR, "types.generated.ts"), buildTypes(version)],
    [join(OUT_DIR, "transitions.generated.ts"), buildTransitions(version)],
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
      console.error("\nGenerated types drifted from schema/. Run `npm run generate` and commit.");
      process.exit(1);
    }
    console.log("codegen: generated output is in sync with schema/.");
    return;
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  for (const [path, content] of outputs) {
    writeFileSync(path, content);
    console.log(`wrote ${path}`);
  }
}

main();
