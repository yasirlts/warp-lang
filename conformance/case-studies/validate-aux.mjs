#!/usr/bin/env node
/**
 * conformance/case-studies/validate-aux.mjs — auxiliary-record coverage for the
 * case-study corpus.
 *
 * The canonical conformance runner (conformance/runner/run.mjs) judges `scene`
 * fixtures: parties, commitments, fulfillments (+ the I-1..I-6 audit). It has no
 * fixture `kind` for the standalone AUXILIARY records — AuctionProcess (incl. the
 * v0.3 ScoredSelection mechanism), AwardProtest, ResolutionProcess,
 * EntitlementConsumption — even though those records ARE fully defined in the
 * canonical schema (schema/structure/auxiliary.schema.json).
 *
 * Several case-study domains (auction-family, government-procurement, gifting,
 * api-metering) reference those records in their narrative. This script proves
 * the records VALIDATE against the canonical schema — using the same
 * cross-file $ref-resolving JSON-Schema-2020-12 subset validator the runner uses,
 * pointed at the canonical files themselves. It is provenance tooling (like
 * conformance/tooling/build.mjs), not part of the shipped scene runner.
 *
 * A future v1.1 conformance enhancement (BACKLOG B-3) is to add an "object" kind
 * to the main runner so these are folded into `node conformance/runner/run.mjs`.
 *
 *   node conformance/case-studies/validate-aux.mjs   # exit 0 = all valid
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_STRUCT = join(HERE, "..", "..", "schema", "structure");

const structDocs = new Map();
for (const f of readdirSync(SCHEMA_STRUCT).filter((x) => x.endsWith(".json"))) {
  structDocs.set(f, JSON.parse(readFileSync(join(SCHEMA_STRUCT, f), "utf8")));
}

function resolvePointer(doc, frag) {
  if (!frag || frag === "/") return doc;
  const parts = frag.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = doc;
  for (const part of parts) { if (cur && typeof cur === "object" && part in cur) cur = cur[part]; else return undefined; }
  return cur;
}
function validate(inst, schema, file, path, errs) {
  if (schema === true) return;
  if (typeof schema !== "object" || schema === null) return;
  if ("$ref" in schema) {
    const [base, frag = ""] = schema.$ref.split("#");
    const targetFile = base === "" ? file : base;
    const targetDoc = structDocs.get(targetFile);
    if (!targetDoc) { errs.push(`${path}: $ref unknown file ${targetFile}`); return; }
    const resolved = resolvePointer(targetDoc, frag);
    if (resolved === undefined) { errs.push(`${path}: $ref ${frag} not found in ${targetFile}`); return; }
    validate(inst, resolved, targetFile, path, errs); return;
  }
  if ("const" in schema && JSON.stringify(inst) !== JSON.stringify(schema.const)) errs.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if ("enum" in schema && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(inst))) errs.push(`${path}: ${JSON.stringify(inst)} not in enum`);
  if ("type" in schema) {
    const t = schema.type;
    const ok = t === "object" ? inst && typeof inst === "object" && !Array.isArray(inst) : t === "array" ? Array.isArray(inst) : t === "string" ? typeof inst === "string" : t === "integer" ? Number.isInteger(inst) : t === "number" ? typeof inst === "number" : t === "boolean" ? typeof inst === "boolean" : t === "null" ? inst === null : true;
    if (!ok) { errs.push(`${path}: expected type ${t}, got ${Array.isArray(inst) ? "array" : typeof inst}`); return; }
  }
  if ("oneOf" in schema) {
    let m = 0, last = [];
    for (const sub of schema.oneOf) { const e = []; validate(inst, sub, file, path, e); if (e.length === 0) m++; else last = e; }
    if (m !== 1) errs.push(`${path}: matched ${m} oneOf branches (need 1)${m === 0 ? " :: " + last.join("; ") : ""}`);
  }
  if (inst && typeof inst === "object" && !Array.isArray(inst)) {
    const props = schema.properties || {};
    if (Array.isArray(schema.required)) for (const r of schema.required) if (!(r in inst)) errs.push(`${path}: missing required '${r}'`);
    for (const [k, v] of Object.entries(inst)) {
      if (k in props) validate(v, props[k], file, `${path}/${k}`, errs);
      else if (schema.additionalProperties === false) errs.push(`${path}: additional property '${k}' not allowed`);
    }
  }
  if (Array.isArray(inst)) {
    if ("minItems" in schema && inst.length < schema.minItems) errs.push(`${path}: < minItems ${schema.minItems}`);
    if (schema.items) inst.forEach((it, i) => validate(it, schema.items, file, `${path}[${i}]`, errs));
  }
}
function check(name, file, defName, inst) {
  const schema = resolvePointer(structDocs.get(file), `/$defs/${defName}`);
  const errs = [];
  validate(inst, schema, file, defName, errs);
  return { name, defName, ok: errs.length === 0, errs };
}

const AUX = "auxiliary.schema.json";

// AuctionProcess — English (auction-family).
const auctionEnglish = {
  id: "auction:painting", subject: "value:painting", seller: "party:auc-seller",
  mechanism: { kind: "English", reserve_price: { amount: 8000, currency: "MAD" }, increment: { amount: 500, currency: "MAD" } },
  tendered_commitments: ["commitment:bid-a", "commitment:bid-b"],
  opens_at: "2026-03-10T08:00:00.000Z", closes_at: "2026-03-10T20:00:00.000Z",
  state: { type: "Closed", winning_commitment: "commitment:bid-b", winning_price: { amount: 12000, currency: "MAD" }, reason: "NormalClose" },
};
// AuctionProcess — ScoredSelection (government-procurement) — D's headline "gap", present in canonical.
const auctionScored = {
  id: "auction:mdt-2026", subject: "value:it-deploy", seller: "party:ministry",
  mechanism: {
    kind: "ScoredSelection",
    criteria: [
      { name: "technical", weight: 0.5, max_points: 50 },
      { name: "price", weight: 0.3, max_points: 30 },
      { name: "local_content", weight: 0.2, max_points: 20 },
    ],
    minimum_threshold: 65,
    evaluation_committee: ["party:ministry"],
    publication_required: true,
  },
  tendered_commitments: ["commitment:bid-a", "commitment:bid-c"],
  opens_at: "2026-03-10T08:00:00.000Z", closes_at: "2026-03-10T18:00:00.000Z",
  state: { type: "Closed", winning_commitment: "commitment:bid-a", winning_price: { amount: 9000000, currency: "MAD" }, reason: "AwardProtestUpheld" },
};
// AwardProtest — Upheld / ReEvaluation (government-procurement).
const awardProtest = {
  id: "protest:001", filed_by: "party:supplier-a", against: "commitment:bid-c", auction_process: "auction:mdt-2026",
  grounds: ["scoring miscalculation on technical criterion"], filed_at: "2026-03-10T19:00:00.000Z", deadline_for_response: "2026-03-12T19:00:00.000Z",
  reviewing_body: "procurement-review-board", state: { type: "Upheld", remedy: "ReEvaluation" },
};
// ResolutionProcess — gifting stock-failure substitute.
const resolution = {
  id: "resolution:gift-2", parent_commitment: "commitment:gift-2", unresolved_item: "value:gift-2",
  original_value: { amount: 300, currency: "MAD" },
  candidates: [{ id: "cand:1", proposed_by: "party:vendor2", substitute_description: "Pashmina shawl (equivalent)", fulfilling_party: "party:vendor2", price_delta: { amount: 0, currency: "MAD" }, new_total: { amount: 300, currency: "MAD" }, original_window: "2026-03-12", new_window: "2026-03-13", state: "Accepted" }],
  state: { type: "Resolved", outcome: "SubstituteAccepted", candidate_id: "cand:1" }, deadline: "2026-03-11T00:00:00.000Z",
};
// EntitlementConsumption — api-metering overage trigger.
const entitlement = {
  id: "consume:june", commitment: "commitment:api-plan", entitlement: "api-calls",
  consumed_this_event: 35000, total_consumed_this_period: 135000, total_allowed_this_period: 100000,
  period_start: "2026-03-01T00:00:00.000Z", period_end: "2026-03-31T23:59:59.000Z", timestamp: "2026-03-31T23:59:59.000Z", overage: true,
};

const results = [
  check("AuctionProcess (English) — auction-family", AUX, "AuctionProcess", auctionEnglish),
  check("AuctionProcess (ScoredSelection) — government-procurement", AUX, "AuctionProcess", auctionScored),
  check("AwardProtest (Upheld/ReEvaluation) — government-procurement", AUX, "AwardProtest", awardProtest),
  check("ResolutionProcess (substitute accepted) — gifting", AUX, "ResolutionProcess", resolution),
  check("EntitlementConsumption (overage) — api-metering", AUX, "EntitlementConsumption", entitlement),
];

let fail = 0;
for (const r of results) {
  if (r.ok) console.log(`  ok    ${r.name}  [${r.defName}]`);
  else { fail++; console.log(`  FAIL  ${r.name}  [${r.defName}]`); r.errs.forEach((e) => console.log(`        ${e}`)); }
}
console.log(`\nauxiliary-record coverage vs CANONICAL schema — ${results.length - fail}/${results.length} valid.`);
if (fail > 0) process.exit(1);
console.log("AUX CONFORMANT ✓");
