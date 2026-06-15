#!/usr/bin/env node
/**
 * Score an EXTERNAL binding's conformance verdicts against the canonical Warp
 * manifest. This is the pluggable harness: it does not run your binding (it
 * cannot — your binding is in any language). It consumes the verdicts your
 * binding emits, in the documented adapter format, and reports X/Y agreement.
 *
 * Contract — your adapter emits a JSON array, one object per manifest fixture:
 *
 *   {
 *     "id":       "<fixture id, exactly as in manifest.json>",
 *     "kind":     "scene | transition-sequence | money-roundtrip | money-breakdown | state-catalog",
 *     "runnable": true | false,        // false = your binding has no API for this check
 *     "verdict":  "accept" | "reject", // your binding's overall verdict (omit/ignored if runnable:false)
 *     "rules":    ["I-1", ...],        // for a reject: the rule id(s) your binding fired
 *     "steps":    [true, false, ...]   // for transition-sequence: per-step validity, in order
 *   }
 *
 * "Agreement" is the SAME check the internal TS<->Python cross-check applies:
 *   - kind "transition-sequence": each step[i] === (fixture step i expects accept)
 *   - manifest expect "accept":   verdict === "accept"
 *   - manifest expect "reject":   verdict === "reject" AND rules includes the manifest rule
 * A fixture your binding marks runnable:false is reported as n/a (not a
 * disagreement) — it just means your binding does not implement that check yet.
 *
 * Usage:
 *   node conformance/tooling/score-adapter.mjs <verdicts.json>
 *   your-binding --emit-verdicts | node conformance/tooling/score-adapter.mjs   # stdin
 *
 * Exit 0  = every runnable fixture agrees with the canonical expectation.
 * Exit 1  = any disagreement, or your adapter omitted a fixture id.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, ".."); // conformance/
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

// --- read the adapter's verdicts (file arg or stdin) -----------------------
const arg = process.argv[2];
let raw;
if (arg && arg !== "-") {
  raw = readFileSync(arg, "utf8");
} else {
  raw = readFileSync(0, "utf8"); // stdin
}
let verdicts;
try {
  verdicts = JSON.parse(raw);
} catch (e) {
  console.error(`score-adapter: input is not valid JSON (${e.message}).`);
  process.exit(1);
}
if (!Array.isArray(verdicts)) {
  console.error("score-adapter: input must be a JSON array of verdict objects.");
  process.exit(1);
}
const byId = new Map(verdicts.map((v) => [v.id, v]));

// fixture step expectations come from the fixture file itself
const stepExpect = (entry, i) =>
  JSON.parse(readFileSync(join(ROOT, entry.path), "utf8")).payload.steps[i].expect;

const expectStr = (e) => (e.expect === "accept" ? "accept" : `reject:${e.rule}`);
function verdictStr(v) {
  if (!v) return "MISSING";
  if (v.runnable === false) return "n/a";
  if (v.kind === "transition-sequence")
    return `seq[${(v.steps || []).map((b) => (b ? "T" : "F")).join("")}]`;
  return v.verdict === "accept" ? "accept" : `reject:${(v.rules || []).join("+")}`;
}

let agreements = 0;
let disagreements = 0;
let missing = 0;
const naIds = [];
const rows = [];

for (const entry of manifest.fixtures) {
  const v = byId.get(entry.id);
  let agree;
  if (!v) {
    missing++;
    agree = "MISSING";
  } else if (v.runnable === false) {
    naIds.push(entry.id);
    agree = "n/a";
  } else {
    let ok;
    if (entry.kind === "transition-sequence") {
      const steps = v.steps || [];
      ok =
        steps.length >= 0 &&
        manifestStepsLength(entry) === steps.length &&
        steps.every((b, i) => b === (stepExpect(entry, i) === "accept"));
    } else if (entry.expect === "accept") {
      ok = v.verdict === "accept";
    } else {
      ok = v.verdict === "reject" && Array.isArray(v.rules) && v.rules.includes(entry.rule);
    }
    if (ok) {
      agreements++;
      agree = "YES";
    } else {
      disagreements++;
      agree = "NO";
    }
  }
  rows.push({ id: entry.id, expected: expectStr(entry), got: verdictStr(v), agree });
}

function manifestStepsLength(entry) {
  return JSON.parse(readFileSync(join(ROOT, entry.path), "utf8")).payload.steps.length;
}

// --- report ----------------------------------------------------------------
const w = (s, n) => String(s).padEnd(n);
console.log(w("fixture", 34) + w("expected", 22) + w("your binding", 20) + "agree");
console.log("-".repeat(82));
for (const r of rows) console.log(w(r.id, 34) + w(r.expected, 22) + w(r.got, 20) + r.agree);

const runnable = agreements + disagreements;
console.log("\n" + "=".repeat(60));
console.log(`schema                 : v${manifest.schema}`);
console.log(`fixtures total         : ${manifest.fixtures.length}`);
console.log(`runnable by your binding: ${runnable}`);
console.log(`agreements             : ${agreements}`);
console.log(`disagreements          : ${disagreements}`);
console.log(`n/a (not implemented)  : ${naIds.length}${naIds.length ? "  [" + naIds.join(", ") + "]" : ""}`);
if (missing) console.log(`MISSING from adapter   : ${missing}`);

if (disagreements > 0 || missing > 0) {
  console.log(
    `\n✗ Not conformant: ${disagreements} disagreement(s)${missing ? `, ${missing} missing fixture(s)` : ""}.`,
  );
  process.exit(1);
}
console.log(
  `\n✓ Your binding agrees with the Warp Commerce Model on ${agreements}/${runnable} runnable fixtures (schema v${manifest.schema}).` +
    (naIds.length ? ` ${naIds.length} fixture(s) not yet implemented.` : ""),
);
