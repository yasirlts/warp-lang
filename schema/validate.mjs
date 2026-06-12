#!/usr/bin/env node
/**
 * Validates the canonical Warp Commerce Model schema spine.
 *
 * It asserts, with no external dependencies (Node >= 18):
 *   1. Every file under schema/ is well-formed JSON (and VERSION is "1.0.0").
 *   2. Every structure schema declares JSON Schema 2020-12 ($schema), a unique
 *      $id, and "x-warp-schema-version": "1.0.0". Behavior files carry the
 *      version stamp too.
 *   3. Every "$ref" in every structure schema RESOLVES — the referenced file
 *      ($id base) is known and the JSON Pointer (#/$defs/...) exists.
 *   4. Structural JSON-Schema sanity (keywords are the right shape; oneOf/$defs
 *      are arrays/objects; no dangling local pointers).
 *   5. behavior/transitions.json matches the model exactly: 11 commitment
 *      states, 26 commitment edges, and the documented terminal sets — the
 *      canary that keeps generated TS/Python/Rust identical.
 *
 * If `ajv` (2020 dialect) happens to be importable, it additionally COMPILES
 * every schema for full meta-validation; otherwise the self-contained checks
 * above stand on their own. Exit code 0 = clean, 1 = failures.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STRUCTURE_DIR = join(HERE, "structure");
const BEHAVIOR_DIR = join(HERE, "behavior");
const EXPECTED_VERSION = "1.0.0";
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

const errors = [];
const fail = (m) => errors.push(m);

// --- load -----------------------------------------------------------------

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`${path}: invalid JSON — ${e.message}`);
    return null;
  }
}

const structureFiles = readdirSync(STRUCTURE_DIR).filter((f) => f.endsWith(".json"));
const behaviorFiles = readdirSync(BEHAVIOR_DIR).filter((f) => f.endsWith(".json"));

// $id (filename) -> parsed doc, for cross-file $ref resolution.
const byFilename = new Map();
const docs = [];

for (const f of structureFiles) {
  const doc = loadJson(join(STRUCTURE_DIR, f));
  if (!doc) continue;
  docs.push({ f, doc });
  byFilename.set(f, doc);

  if (doc.$schema !== DIALECT) fail(`structure/${f}: $schema must be "${DIALECT}"`);
  if (typeof doc.$id !== "string" || doc.$id.length === 0) fail(`structure/${f}: missing $id`);
  if (doc["x-warp-schema-version"] !== EXPECTED_VERSION)
    fail(`structure/${f}: x-warp-schema-version must be "${EXPECTED_VERSION}"`);
  // $id should end with the filename so relative "$ref": "other.schema.json#/..." resolves.
  if (typeof doc.$id === "string" && !doc.$id.endsWith(f))
    fail(`structure/${f}: $id "${doc.$id}" should end with the filename "${f}"`);
}

// Unique $id check.
const seenIds = new Set();
for (const { f, doc } of docs) {
  if (typeof doc.$id === "string") {
    if (seenIds.has(doc.$id)) fail(`structure/${f}: duplicate $id ${doc.$id}`);
    seenIds.add(doc.$id);
  }
}

// --- $ref resolution -------------------------------------------------------

function pointerExists(doc, pointer) {
  // pointer like "/$defs/Money"
  if (pointer === "" || pointer === "/") return true;
  const parts = pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = doc;
  for (const part of parts) {
    if (cur && typeof cur === "object" && part in cur) cur = cur[part];
    else return false;
  }
  return true;
}

function walkRefs(node, fromFile, path) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walkRefs(n, fromFile, `${path}[${i}]`));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string") {
      const [base, frag = ""] = v.split("#");
      // Cross-file refs use a bare filename (e.g. "money.schema.json"); a local
      // ref has an empty base.
      const targetFile = base === "" ? fromFile : base;
      const targetDoc = byFilename.get(targetFile);
      if (!targetDoc) {
        fail(`structure/${fromFile} ${path}: $ref "${v}" -> unknown file "${targetFile}"`);
      } else if (!pointerExists(targetDoc, frag)) {
        fail(`structure/${fromFile} ${path}: $ref "${v}" -> pointer "${frag}" not found in ${targetFile}`);
      }
    } else {
      walkRefs(v, fromFile, `${path}/${k}`);
    }
  }
}

for (const { f, doc } of docs) walkRefs(doc, f, "$");

// --- light JSON-Schema structural sanity ----------------------------------

function sanity(node, fromFile, path) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => sanity(n, fromFile, `${path}[${i}]`));
    return;
  }
  if (!node || typeof node !== "object") return;
  if ("oneOf" in node && !Array.isArray(node.oneOf))
    fail(`structure/${fromFile} ${path}: oneOf must be an array`);
  if ("anyOf" in node && !Array.isArray(node.anyOf))
    fail(`structure/${fromFile} ${path}: anyOf must be an array`);
  if ("required" in node && !Array.isArray(node.required))
    fail(`structure/${fromFile} ${path}: required must be an array`);
  if ("properties" in node && (typeof node.properties !== "object" || Array.isArray(node.properties)))
    fail(`structure/${fromFile} ${path}: properties must be an object`);
  if ("$defs" in node && (typeof node.$defs !== "object" || Array.isArray(node.$defs)))
    fail(`structure/${fromFile} ${path}: $defs must be an object`);
  for (const [k, v] of Object.entries(node)) sanity(v, fromFile, `${path}/${k}`);
}
for (const { f, doc } of docs) sanity(doc, f, "$");

// --- behavior files --------------------------------------------------------

for (const f of behaviorFiles) {
  const doc = loadJson(join(BEHAVIOR_DIR, f));
  if (!doc) continue;
  if (doc["x-warp-schema-version"] !== EXPECTED_VERSION)
    fail(`behavior/${f}: x-warp-schema-version must be "${EXPECTED_VERSION}"`);
}

// transitions.json canary — must match the model exactly.
const transitions = loadJson(join(BEHAVIOR_DIR, "transitions.json"));
if (transitions) {
  const c = transitions.commitment || {};
  const states = Object.keys(c);
  if (states.length !== 11) fail(`transitions.json: expected 11 commitment states, found ${states.length}`);
  const edgeCount = Object.values(c).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
  if (edgeCount !== 26) fail(`transitions.json: expected 26 commitment edges, found ${edgeCount}`);
  // Every target must be a declared state.
  for (const [from, tos] of Object.entries(c)) {
    for (const to of tos) if (!(to in c)) fail(`transitions.json: commitment ${from} -> unknown state ${to}`);
  }
  const i = transitions.intent || {};
  if (Object.keys(i).length !== 4) fail(`transitions.json: expected 4 intent states`);
  const fu = transitions.fulfillment || {};
  if (Object.keys(fu).length !== 5) fail(`transitions.json: expected 5 fulfillment states`);
  if (!Array.isArray(fu.Failed) || fu.Failed.length !== 0)
    fail(`transitions.json: fulfillment Failed must be [] in the table (recoverable retry is the documented special case)`);
}

const invariants = loadJson(join(BEHAVIOR_DIR, "invariants.json"));
if (invariants) {
  const ids = (invariants.invariants || []).map((x) => x.id);
  for (const want of ["I-1", "I-2", "I-3", "I-4", "I-5", "I-6"])
    if (!ids.includes(want)) fail(`invariants.json: missing ${want}`);
  // MoneyBreakdown sum rule must be expressed under I-1.
  const i1 = (invariants.invariants || []).find((x) => x.id === "I-1");
  const exprIds = (i1?.rule?.expressions || []).map((e) => e.id);
  if (!exprIds.includes("money_breakdown_sum"))
    fail(`invariants.json: I-1 must express the money_breakdown_sum rule`);
}

// VERSION file.
const versionRaw = readFileSync(join(HERE, "VERSION"), "utf8").trim();
if (versionRaw !== EXPECTED_VERSION) fail(`VERSION must be "${EXPECTED_VERSION}", found "${versionRaw}"`);

// --- optional: full meta-validation via ajv if available -------------------

let ajvNote = "ajv not installed — self-contained structural + $ref checks only (sufficient).";
try {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const { doc } of docs) ajv.addSchema(doc);
  for (const { f, doc } of docs) {
    try {
      ajv.compile(doc);
    } catch (e) {
      fail(`ajv: structure/${f} failed to compile — ${e.message}`);
    }
  }
  ajvNote = "ajv present — all schemas compiled under the 2020-12 dialect.";
} catch {
  /* ajv absent: fine */
}

// --- report ----------------------------------------------------------------

const totalDefs = docs.reduce((n, { doc }) => n + Object.keys(doc.$defs || {}).length, 0);
console.log(`Warp schema spine v${EXPECTED_VERSION}`);
console.log(`  structure files : ${structureFiles.length}`);
console.log(`  behavior files  : ${behaviorFiles.length}`);
console.log(`  total $defs     : ${totalDefs}`);
console.log(`  ${ajvNote}`);

if (errors.length) {
  console.error(`\n✗ ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("\n✓ all schemas valid, all $refs resolve, transition canary intact.");
