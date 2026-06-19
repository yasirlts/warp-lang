#!/usr/bin/env node
/**
 * Warp conformance reference runner — ZERO dependencies (node: built-ins only).
 *
 * Validates every conformance fixture against the CANONICAL Warp Commerce Model
 * schema on main:
 *   - structure : schema/structure/*.schema.json  (JSON Schema 2020-12)
 *   - behavior  : schema/behavior/transitions.json (the legal transition edges)
 *   - invariants: the six invariants + the money_breakdown_sum expression of I-1,
 *                 implemented per schema/behavior/invariants.json reference impls.
 *
 * `ajv` is not vendored in this repo, so the runner carries a small, self-contained
 * JSON Schema 2020-12 validator covering exactly the keyword subset the canonical
 * schemas use ($ref/$defs, type, properties, required, additionalProperties, enum,
 * const, oneOf, items, minItems, minLength, maxLength, minimum, maximum). It
 * resolves cross-file $refs by filename against schema/structure — i.e. it
 * validates against the canonical files themselves, not a copy.
 *
 *   node conformance/runner/run.mjs            # run all fixtures
 *   node conformance/runner/run.mjs --verbose  # print every fixture line
 *
 * Exit 0 = every fixture matched its expected outcome; 1 = any mismatch.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");            // conformance/
const REPO = join(ROOT, "..");            // repo root
const SCHEMA_STRUCT = join(REPO, "schema", "structure");
const SCHEMA_BEHAVIOR = join(REPO, "schema", "behavior");
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

// ===========================================================================
// Load canonical schema files
// ===========================================================================
const structDocs = new Map(); // filename -> parsed schema
for (const f of readdirSync(SCHEMA_STRUCT).filter((x) => x.endsWith(".json"))) {
  structDocs.set(f, JSON.parse(readFileSync(join(SCHEMA_STRUCT, f), "utf8")));
}
const transitionsTable = JSON.parse(readFileSync(join(SCHEMA_BEHAVIOR, "transitions.json"), "utf8"));

// ===========================================================================
// Self-contained JSON Schema 2020-12 validator (subset used by the schema)
// ===========================================================================
function resolvePointer(doc, frag) {
  if (!frag || frag === "" || frag === "/") return doc;
  const parts = frag.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = doc;
  for (const part of parts) {
    if (cur && typeof cur === "object" && part in cur) cur = cur[part];
    else return undefined;
  }
  return cur;
}

// Validate `inst` against `schema` (which lives in `file`). Pushes "path: msg"
// strings into `errs`.
function validate(inst, schema, file, path, errs) {
  if (schema === true) return;
  if (schema === false) { errs.push(`${path}: schema is false`); return; }
  if (typeof schema !== "object" || schema === null) return;

  if ("$ref" in schema) {
    const [base, frag = ""] = schema.$ref.split("#");
    const targetFile = base === "" ? file : base;
    const targetDoc = structDocs.get(targetFile);
    if (!targetDoc) { errs.push(`${path}: $ref unknown file ${targetFile}`); return; }
    const resolved = resolvePointer(targetDoc, frag);
    if (resolved === undefined) { errs.push(`${path}: $ref pointer ${frag} not found in ${targetFile}`); return; }
    validate(inst, resolved, targetFile, path, errs);
    return;
  }

  if ("const" in schema) {
    if (JSON.stringify(inst) !== JSON.stringify(schema.const)) errs.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if ("enum" in schema) {
    if (!schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(inst))) errs.push(`${path}: ${JSON.stringify(inst)} not in enum`);
  }

  if ("type" in schema) {
    const t = schema.type;
    const ok =
      t === "object" ? inst && typeof inst === "object" && !Array.isArray(inst) :
      t === "array" ? Array.isArray(inst) :
      t === "string" ? typeof inst === "string" :
      t === "integer" ? typeof inst === "number" && Number.isInteger(inst) :
      t === "number" ? typeof inst === "number" :
      t === "boolean" ? typeof inst === "boolean" :
      t === "null" ? inst === null : true;
    if (!ok) { errs.push(`${path}: expected type ${t}, got ${Array.isArray(inst) ? "array" : typeof inst}`); return; }
  }

  if ("oneOf" in schema) {
    let matches = 0;
    let lastErrs = [];
    for (const sub of schema.oneOf) {
      const subErrs = [];
      validate(inst, sub, file, path, subErrs);
      if (subErrs.length === 0) matches++;
      else lastErrs = subErrs;
    }
    if (matches !== 1) errs.push(`${path}: matched ${matches} oneOf branches (need exactly 1)${matches === 0 ? " :: " + lastErrs.join("; ") : ""}`);
  }

  if (inst && typeof inst === "object" && !Array.isArray(inst)) {
    const props = schema.properties || {};
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) if (!(r in inst)) errs.push(`${path}: missing required '${r}'`);
    }
    for (const [k, v] of Object.entries(inst)) {
      if (k in props) validate(v, props[k], file, `${path}/${k}`, errs);
      else if (schema.additionalProperties === false) errs.push(`${path}: additional property '${k}' not allowed`);
    }
  }

  if (Array.isArray(inst)) {
    if ("minItems" in schema && inst.length < schema.minItems) errs.push(`${path}: fewer than minItems ${schema.minItems}`);
    if (schema.items) inst.forEach((it, i) => validate(it, schema.items, file, `${path}[${i}]`, errs));
  }

  if (typeof inst === "string") {
    if ("minLength" in schema && inst.length < schema.minLength) errs.push(`${path}: shorter than minLength ${schema.minLength}`);
    if ("maxLength" in schema && inst.length > schema.maxLength) errs.push(`${path}: longer than maxLength ${schema.maxLength}`);
  }
  if (typeof inst === "number") {
    if ("minimum" in schema && inst < schema.minimum) errs.push(`${path}: below minimum ${schema.minimum}`);
    if ("maximum" in schema && inst > schema.maximum) errs.push(`${path}: above maximum ${schema.maximum}`);
  }
}

/** Validate `inst` against `file#/$defs/Name`. Returns array of error strings. */
function validateRef(inst, file, defName) {
  const doc = structDocs.get(file);
  const schema = resolvePointer(doc, `/$defs/${defName}`);
  if (schema === undefined) return [`unknown $def ${file}#/$defs/${defName}`];
  const errs = [];
  validate(inst, schema, file, defName, errs);
  return errs;
}

const PRIMITIVE_REF = {
  CommitmentState: ["commitment.schema.json", "CommitmentState"],
  FulfillmentState: ["fulfillment.schema.json", "FulfillmentState"],
  IntentState: ["intent.schema.json", "IntentState"],
  ValueState: ["value.schema.json", "ValueState"],
  ValueForm: ["value.schema.json", "ValueForm"],
  Party: ["party.schema.json", "Party"],
};

// ===========================================================================
// Behavior: money precision + the six invariants + money_breakdown_sum
// ===========================================================================
const ZERO_DECIMAL = new Set(["JPY","KRW","VND","CLP","ISK","XAF","XOF","XPF","BIF","DJF","GNF","KMF","MGA","PYG","RWF","UGX","VUV"]);
const THREE_DECIMAL = new Set(["TND","BHD","KWD","OMR","JOD"]);
const currencyDecimals = (c) => { const u = String(c).toUpperCase(); return ZERO_DECIMAL.has(u) ? 0 : THREE_DECIMAL.has(u) ? 3 : 2; };
const moneyEquals = (a, b, c) => Math.abs(a - b) < 0.5 * Math.pow(10, -currencyDecimals(c));

// transition validity from schema/behavior/transitions.json
function isValidTransition(primitive, from, to) {
  const table = transitionsTable[primitive];
  if (primitive === "fulfillment" && from.type === "Failed") {
    // Documented special case (notes.fulfillment_failed_recovery): Failed -> Planned
    // is valid iff recoverable === true; all other Failed -> X are rejected.
    return to.type === "Planned" ? from.recoverable === true : false;
  }
  return (table[from.type] || []).includes(to.type);
}

function moneyOf(v) { return v && v.form && v.form.kind === "Money" ? v.form.money : null; }
function sumMoney(values) {
  const cur = new Set();
  let amount = 0;
  for (const v of values) { const m = moneyOf(v); if (m) { cur.add(m.currency); amount += m.amount; } }
  const list = [...cur];
  if (list.length === 0) return { total: null, mixed: false };
  return { total: { amount, currency: list[0] }, mixed: list.length > 1 };
}
const ACCEPTED_OR_LATER = new Set(["Accepted","Active","Modified","PartiallyFulfilled","Fulfilled","Disputed","Refunded"]);
const reachedAccepted = (c) => ACCEPTED_OR_LATER.has(c.state.type) || c.history.some((h) => h.to.type === "Accepted");
const acceptedAt = (c) => { const e = c.history.find((h) => h.to.type === "Accepted"); return e ? e.at : null; };

function auditScene(scene) {
  const { commitments, fulfillments, parties } = scene;
  const out = [];
  const capByParty = new Map(parties.map((p) => [p.id, p.capacity]));
  const byId = new Map(commitments.map((c) => [c.id, c]));
  // I-1 no_currency_mixing
  for (const c of commitments) if (sumMoney([...c.subject.offered, ...c.subject.requested]).mixed) out.push("I-1");
  // I-1 amount conservation (over-refund): a Refunded commitment's refund amount
  // must not exceed the original committed amount, in the same currency. Value is
  // conserved — you cannot refund more than was committed. (Same-currency only; a
  // cross-currency refund is a separate concern and not flagged here.)
  for (const c of commitments) {
    if (c.state.type === "Refunded" && c.state.amount) {
      const orig = sumMoney(c.subject.requested).total;
      const r = c.state.amount;
      if (orig && r.currency === orig.currency && r.amount > orig.amount && !moneyEquals(r.amount, orig.amount, r.currency)) {
        out.push("I-1");
      }
    }
  }
  for (const c of commitments) {
    // I-2 commitment transition table + timestamp monotonicity
    for (const h of c.history) if (!isValidTransition("commitment", h.from, h.to)) out.push("I-2");
    for (let i = 1; i < c.history.length; i++) if (Date.parse(c.history[i].at) < Date.parse(c.history[i - 1].at)) out.push("I-2");
    // I-3 capacity before Accepted
    const cap = capByParty.get(c.parties.initiator);
    if (cap && reachedAccepted(c) && !cap.can_buy) out.push("I-3");
    // I-4 fulfillment after accepted
    const acc = acceptedAt(c);
    for (const f of fulfillments.filter((x) => x.commitment === c.id)) {
      const executed = f.state.type === "InProgress" || f.state.type === "Completed";
      if (executed && acc === null) out.push("I-4");
      else if (f.started_at && acc && Date.parse(f.started_at) < Date.parse(acc)) out.push("I-4");
    }
    // I-6 tree sum
    if (c.children.length > 0) {
      const kids = c.children.map((id) => byId.get(id)).filter(Boolean);
      if (kids.length > 0) {
        const parentSum = sumMoney(c.subject.requested);
        if (parentSum.total !== null) {
          let childAmt = 0;
          const cur = new Set([parentSum.total.currency]);
          for (const k of kids) { const s = sumMoney(k.subject.requested); if (s.total) { cur.add(s.total.currency); childAmt += s.total.amount; } }
          if (cur.size > 1) out.push("I-6");
          else if (!moneyEquals(childAmt, parentSum.total.amount, parentSum.total.currency)) out.push("I-6");
        }
      }
    }
  }
  // I-5 identity permanence
  const ids = [...commitments.map((c) => c.id), ...fulfillments.map((f) => f.id), ...parties.map((p) => p.id)];
  const seen = new Set(), dup = new Set();
  for (const id of ids) { if (seen.has(id)) dup.add(id); seen.add(id); }
  if (dup.size > 0) out.push("I-5");
  return [...new Set(out)];
}

// money_breakdown_sum (expression of I-1): single currency + sum within tolerance.
function breakdownRule(b) {
  const cur = b.total.currency;
  for (const c of b.components) if (c.amount.currency !== cur) return "money_breakdown_sum";
  const sum = b.components.reduce((s, c) => s + c.amount.amount, 0);
  if (!moneyEquals(sum, b.total.amount, cur)) return "money_breakdown_sum";
  return null;
}

// ===========================================================================
// Fixture execution
// ===========================================================================
function runScene(fx) {
  const s = fx.payload;
  const struct = [];
  s.parties.forEach((p, i) => struct.push(...validateRef(p, "party.schema.json", "Party").map((e) => `parties[${i}] ${e}`)));
  s.commitments.forEach((c, i) => struct.push(...validateRef(c, "commitment.schema.json", "Commitment").map((e) => `commitments[${i}] ${e}`)));
  s.fulfillments.forEach((f, i) => struct.push(...validateRef(f, "fulfillment.schema.json", "Fulfillment").map((e) => `fulfillments[${i}] ${e}`)));
  if (struct.length) return { accepted: false, rules: ["STRUCT"], detail: struct };
  const violations = auditScene(s);
  return { accepted: violations.length === 0, rules: violations, detail: violations };
}

function runStateCatalog(fx) {
  const ref = PRIMITIVE_REF[fx.payload.primitive];
  if (!ref) return { accepted: false, rules: ["STRUCT"], detail: [`unknown primitive ${fx.payload.primitive}`] };
  const detail = [];
  for (const inst of fx.payload.instances) {
    const errs = validateRef(inst.value, ref[0], ref[1]);
    if (errs.length) detail.push(`${inst.label}: ${errs.join("; ")}`);
  }
  return { accepted: detail.length === 0, rules: detail.length ? ["STRUCT"] : [], detail };
}

function runTransitionSequence(fx) {
  let cur = fx.payload.initial;
  const detail = [];
  let ok = true;
  fx.payload.steps.forEach((step, i) => {
    const valid = isValidTransition(fx.payload.primitive, cur, step.to);
    const want = step.expect === "accept";
    if (valid !== want) { ok = false; detail.push(`step ${i} ${cur.type}->${step.to.type}: got ${valid}, expected ${want}`); }
    if (step.expect === "reject" && step.rule && step.rule !== "I-2") { ok = false; detail.push(`step ${i}: declared ${step.rule}, transition rejections are I-2`); }
    if (valid) cur = step.to;
  });
  return { accepted: ok, rules: ok ? [] : ["SEQUENCE"], detail };
}

function runMoneyBreakdown(fx) {
  const b = fx.payload;
  const struct = validateRef(b, "money.schema.json", "MoneyBreakdown");
  if (struct.length) return { accepted: false, rules: ["STRUCT"], detail: struct };
  const rule = breakdownRule(b);
  return { accepted: rule === null, rules: rule ? [rule] : [], detail: rule ? [`money_breakdown_sum violated`] : [] };
}

function runMoneyRoundtrip(fx) {
  const detail = [];
  for (const c of fx.payload.cases) {
    const factor = Math.pow(10, currencyDecimals(c.currency));
    const decimal = c.minor_amount / factor;
    const back = Math.round(decimal * factor);
    if (decimal !== c.decimal_amount) detail.push(`${c.currency} ${c.minor_amount} -> ${decimal} (expected ${c.decimal_amount})`);
    if (back !== c.minor_amount) detail.push(`${c.currency} ${decimal} -> ${back} minor (expected ${c.minor_amount})`);
  }
  return { accepted: detail.length === 0, rules: detail.length ? ["ROUNDTRIP"] : [], detail };
}

function runFixture(fx) {
  switch (fx.kind) {
    case "scene": return runScene(fx);
    case "state-catalog": return runStateCatalog(fx);
    case "transition-sequence": return runTransitionSequence(fx);
    case "money-breakdown": return runMoneyBreakdown(fx);
    case "money-roundtrip": return runMoneyRoundtrip(fx);
    default: return { accepted: false, rules: ["UNKNOWN-KIND"], detail: [`unknown kind ${fx.kind}`] };
  }
}

// ===========================================================================
// Driver
// ===========================================================================
const loadJSON = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

function main() {
  const manifest = loadJSON("manifest.json");
  if (manifest.schema !== "1.0.0") { console.error(`runner targets schema 1.0.0, manifest is ${manifest.schema}`); process.exit(1); }
  let pass = 0, fail = 0;
  const failures = [];

  for (const entry of manifest.fixtures) {
    const fx = loadJSON(entry.path);
    const result = runFixture(fx);
    let ok = true, why = "";

    if (entry.expect === "accept") {
      ok = result.accepted === true;
      if (!ok) why = `expected ACCEPT, got REJECT [${result.rules.join(", ")}] :: ${result.detail.join(" | ")}`;
    } else {
      ok = result.accepted === false;
      if (!ok) why = `expected REJECT (${entry.rule || "?"}), got ACCEPT`;
      else if (entry.rule && !result.rules.includes(entry.rule)) { ok = false; why = `expected rejection by ${entry.rule}, got [${result.rules.join(", ")}]`; }
      if (ok && entry.expected) {
        const side = loadJSON(entry.expected);
        if (side.rule !== entry.rule || side.fixture !== entry.id) { ok = false; why = `sidecar ${entry.expected} disagrees (rule ${side.rule} vs ${entry.rule})`; }
      }
    }

    if (ok) { pass++; if (VERBOSE) console.log(`  PASS  ${entry.id}  [${entry.kind}] expect=${entry.expect}${entry.rule ? " " + entry.rule : ""}`); }
    else { fail++; failures.push({ id: entry.id, why }); console.log(`  FAIL  ${entry.id}  ${why}`); }
  }

  console.log(`\nWarp conformance v${manifest.schema} vs CANONICAL schema — ${pass}/${manifest.fixtures.length} fixtures passed.`);
  if (fail > 0) { console.log(`${fail} FAILED.`); process.exit(1); }
  console.log("CONFORMANT ✓");
}

main();
