#!/usr/bin/env node
/**
 * THE CROSS-CHECK — prove the TS and Python bindings agree on every fixture.
 *
 * Runs crosscheck-ts.mjs and crosscheck-python.py (each emits per-fixture
 * verdicts as JSON from its real binding), aligns them with the manifest's
 * expected outcome, and prints the agreement table:
 *
 *     fixture | expected | TS | Python | agree?
 *
 * A fixture "runnable in both" MUST get the same verdict from TS and Python AND
 * match the manifest's expectation. Any disagreement exits non-zero. Fixtures a
 * binding cannot run (e.g. TS has no MoneyBreakdown checker; state-catalog is
 * structural) are marked n/a and are not disagreements — they are reported.
 *
 *   node conformance/tooling/crosscheck.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

const tsJson = JSON.parse(execFileSync("node", [join(HERE, "crosscheck-ts.mjs")], { encoding: "utf8" }));
const pyJson = JSON.parse(execFileSync("python3", [join(HERE, "crosscheck-python.py")], { encoding: "utf8" }));
const tsById = new Map(tsJson.map((r) => [r.id, r]));
const pyById = new Map(pyJson.map((r) => [r.id, r]));

const expectStr = (e) => (e.expect === "accept" ? "accept" : `reject:${e.rule}`);
function verdictStr(r) {
  if (!r.runnable) return "n/a";
  if (r.kind === "transition-sequence") return `seq[${r.steps.map((b) => (b ? "T" : "F")).join("")}]`;
  return r.verdict === "accept" ? "accept" : `reject:${r.rules.join("+")}`;
}

const rows = [];
let disagreements = 0;
let agreements = 0;

for (const entry of manifest.fixtures) {
  const ts = tsById.get(entry.id);
  const py = pyById.get(entry.id);
  const tsv = verdictStr(ts);
  const pyv = verdictStr(py);
  const bothRunnable = ts.runnable && py.runnable;

  let agree;
  if (bothRunnable) {
    agree = tsv === pyv;
    // also require agreement with the manifest expectation
    let matchesExpected;
    if (entry.kind === "transition-sequence") {
      matchesExpected = ts.steps.every((b, i) => b === (manifestStep(entry, i) === "accept"));
    } else if (entry.expect === "accept") {
      matchesExpected = ts.verdict === "accept";
    } else {
      matchesExpected = ts.verdict === "reject" && ts.rules.includes(entry.rule);
    }
    if (agree && matchesExpected) { agreements++; agree = "YES"; }
    else { disagreements++; agree = agree ? "NO(vs-expected)" : "NO"; }
  } else {
    agree = "n/a";
  }
  rows.push({ id: entry.id, expected: expectStr(entry), ts: tsv, py: pyv, agree });
}

// step expectation lookup needs the fixture; cache loads
function manifestStep(entry, i) {
  const fx = JSON.parse(readFileSync(join(ROOT, entry.path), "utf8"));
  return fx.payload.steps[i].expect;
}

// ---- print table ----
const w = (s, n) => String(s).padEnd(n);
console.log(w("fixture", 34) + w("expected", 22) + w("TS", 16) + w("Python", 16) + "agree");
console.log("-".repeat(94));
for (const r of rows) console.log(w(r.id, 34) + w(r.expected, 22) + w(r.ts, 16) + w(r.py, 16) + r.agree);

const runnableBoth = rows.filter((r) => r.agree === "YES" || r.agree === "NO" || r.agree === "NO(vs-expected)").length;
console.log("\n" + "=".repeat(60));
console.log(`runnable in BOTH TS & Python : ${runnableBoth}`);
console.log(`agreements                   : ${agreements}`);
console.log(`disagreements                : ${disagreements}`);
const naRows = rows.filter((r) => r.agree === "n/a");
console.log(`n/a (one binding lacks API)  : ${naRows.length}  [${naRows.map((r) => r.id).join(", ")}]`);

if (disagreements > 0) {
  console.log("\n✗ TS and Python DISAGREE on a runnable fixture — must be resolved before merge.");
  process.exit(1);
}
console.log("\n✓ TS and Python AGREE on every fixture runnable in both.");
