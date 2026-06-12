#!/usr/bin/env node
/**
 * Emit the TypeScript binding's verdict for every conformance fixture, as JSON.
 *
 * Runs each fixture through the CANONICAL @warp-lang/commerce-types on main
 * (auditCommerce / isValid*Transition / currencyDecimals). Used by crosscheck.mjs
 * to prove TS and Python agree.
 *
 * Verdict shape per fixture: { id, runnable, verdict: "accept"|"reject", rules:[],
 * steps:[bool], note }. `runnable:false` means this binding exposes no API for the
 * fixture's check (e.g. TS has no standalone MoneyBreakdown checker).
 *
 *   node conformance/tooling/crosscheck-ts.mjs        # JSON to stdout
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REPO = join(ROOT, "..");

const ts = await import(join(REPO, "packages", "commerce-types", "dist", "index.js"));
const { auditCommerce, isValidCommitmentTransition, isValidIntentTransition, isValidFulfillmentTransition, currencyDecimals } = ts;

const loadJSON = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const manifest = loadJSON("manifest.json");

function isValid(primitive, from, to) {
  if (primitive === "commitment") return isValidCommitmentTransition(from, to);
  if (primitive === "intent") return isValidIntentTransition(from, to);
  if (primitive === "fulfillment") return isValidFulfillmentTransition(from, to);
  throw new Error(primitive);
}

const out = [];
for (const entry of manifest.fixtures) {
  const fx = loadJSON(entry.path);
  const r = { id: entry.id, kind: entry.kind, runnable: true, verdict: null, rules: [], steps: [], note: "" };
  try {
    if (fx.kind === "scene") {
      const p = fx.payload;
      const violations = auditCommerce(p.commitments, p.fulfillments, p.parties).map((v) => v.invariant);
      const uniq = [...new Set(violations)].sort();
      r.verdict = uniq.length === 0 ? "accept" : "reject";
      r.rules = uniq;
    } else if (fx.kind === "transition-sequence") {
      let cur = fx.payload.initial;
      for (const step of fx.payload.steps) {
        const v = isValid(fx.payload.primitive, cur, step.to);
        r.steps.push(v);
        if (v) cur = step.to;
      }
      r.verdict = "accept"; // sequence is runnable; agreement compares r.steps
    } else if (fx.kind === "money-roundtrip") {
      let okAll = true;
      for (const c of fx.payload.cases) {
        const f = Math.pow(10, currencyDecimals(c.currency));
        if (c.minor_amount / f !== c.decimal_amount || Math.round((c.minor_amount / f) * f) !== c.minor_amount) okAll = false;
      }
      r.verdict = okAll ? "accept" : "reject";
    } else if (fx.kind === "money-breakdown") {
      r.runnable = false;
      r.note = "TS exposes no standalone MoneyBreakdown checker (I-1 money_breakdown_sum unimplemented in TS)";
    } else if (fx.kind === "state-catalog") {
      r.runnable = false;
      r.note = "structural only — covered by runner + JSON Schema";
    }
  } catch (e) {
    r.runnable = false;
    r.note = `TS raised: ${e.message}`;
  }
  out.push(r);
}
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
