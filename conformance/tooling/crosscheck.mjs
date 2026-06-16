#!/usr/bin/env node
/**
 * THE CROSS-CHECK — prove the TS, Python, and Rust bindings agree on every
 * fixture.
 *
 * Runs crosscheck-ts.mjs, crosscheck-python.py, and the crosscheck-rust binary
 * (each emits per-fixture verdicts as JSON from its real binding), aligns them
 * with the manifest's expected outcome, and prints the agreement table:
 *
 *     fixture | expected | TS | Python | Rust | agree?
 *
 * A fixture "runnable in ALL THREE" MUST get the same verdict from TS, Python,
 * and Rust AND match the manifest's expectation. Any disagreement among the
 * three — or against the expectation — exits non-zero. Fixtures a binding
 * cannot run (state-catalog fixtures are structural — covered by the runner +
 * JSON Schema, and are n/a for ALL THREE behavioral bindings) are marked n/a
 * and are reported, not counted as disagreements.
 *
 *   node conformance/tooling/crosscheck.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REPO_ROOT = join(HERE, "..", "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

const tsJson = JSON.parse(execFileSync("node", [join(HERE, "crosscheck-ts.mjs")], { encoding: "utf8" }));
const pyJson = JSON.parse(execFileSync("python3", [join(HERE, "crosscheck-python.py")], { encoding: "utf8" }));
// The Rust emitter resolves conformance paths relative to its CWD — invoke it
// from the repo root so `conformance/manifest.json` resolves.
const rsJson = JSON.parse(
  execFileSync("cargo", ["run", "-q", "-p", "warp-commerce-types", "--bin", "crosscheck-rust"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  }),
);
const tsById = new Map(tsJson.map((r) => [r.id, r]));
const pyById = new Map(pyJson.map((r) => [r.id, r]));
const rsById = new Map(rsJson.map((r) => [r.id, r]));

const expectStr = (e) => (e.expect === "accept" ? "accept" : `reject:${e.rule}`);
function verdictStr(r) {
  if (!r.runnable) return "n/a";
  if (r.kind === "transition-sequence") return `seq[${r.steps.map((b) => (b ? "T" : "F")).join("")}]`;
  return r.verdict === "accept" ? "accept" : `reject:${r.rules.join("+")}`;
}

// step expectation lookup needs the fixture; cache loads
const fxCache = new Map();
function loadFx(entry) {
  if (!fxCache.has(entry.id)) fxCache.set(entry.id, JSON.parse(readFileSync(join(ROOT, entry.path), "utf8")));
  return fxCache.get(entry.id);
}
function manifestStep(entry, i) {
  return loadFx(entry).payload.steps[i].expect;
}

// Does a single binding's verdict match the manifest's expectation?
function matchesExpected(entry, r) {
  if (entry.kind === "transition-sequence") {
    return r.steps.every((b, i) => b === (manifestStep(entry, i) === "accept"));
  }
  if (entry.expect === "accept") return r.verdict === "accept";
  return r.verdict === "reject" && r.rules.includes(entry.rule);
}

const rows = [];
let disagreements = 0;
let agreements = 0;

for (const entry of manifest.fixtures) {
  const ts = tsById.get(entry.id);
  const py = pyById.get(entry.id);
  const rs = rsById.get(entry.id);
  const tsv = verdictStr(ts);
  const pyv = verdictStr(py);
  const rsv = verdictStr(rs);
  const allRunnable = ts.runnable && py.runnable && rs.runnable;

  let agree;
  if (allRunnable) {
    // all three bindings must agree with each other...
    const bindingsAgree = tsv === pyv && pyv === rsv;
    // ...and each with the manifest expectation
    const expectedOk = matchesExpected(entry, ts) && matchesExpected(entry, py) && matchesExpected(entry, rs);
    if (bindingsAgree && expectedOk) {
      agreements++;
      agree = "YES";
    } else {
      disagreements++;
      agree = bindingsAgree ? "NO(vs-expected)" : "NO";
    }
  } else {
    agree = "n/a";
  }
  rows.push({ id: entry.id, expected: expectStr(entry), ts: tsv, py: pyv, rs: rsv, agree });
}

// ---- print table ----
const w = (s, n) => String(s).padEnd(n);
console.log(w("fixture", 34) + w("expected", 20) + w("TS", 14) + w("Python", 14) + w("Rust", 14) + "agree");
console.log("-".repeat(108));
for (const r of rows) console.log(w(r.id, 34) + w(r.expected, 20) + w(r.ts, 14) + w(r.py, 14) + w(r.rs, 14) + r.agree);

const runnableAll = rows.filter((r) => r.agree !== "n/a").length;
console.log("\n" + "=".repeat(60));
console.log(`runnable in ALL THREE (TS, Python, Rust) : ${runnableAll}`);
console.log(`agreements                               : ${agreements}`);
console.log(`disagreements                            : ${disagreements}`);
const naRows = rows.filter((r) => r.agree === "n/a");
console.log(`n/a (structural — no behavioral API)     : ${naRows.length}  [${naRows.map((r) => r.id).join(", ")}]`);

if (disagreements > 0) {
  console.log("\n✗ TS, Python, and Rust DISAGREE on a runnable fixture — must be resolved before merge.");
  process.exit(1);
}
console.log("\n✓ TS, Python, and Rust AGREE on every fixture runnable in all three.");
