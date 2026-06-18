#!/usr/bin/env node
/**
 * THE CROSS-CHECK — prove the TS, Python, Rust, and Go bindings agree on every
 * fixture.
 *
 * Runs crosscheck-ts.mjs, crosscheck-python.py, the crosscheck-rust binary, and
 * the crosscheck-go command (each emits per-fixture verdicts as JSON from its
 * real binding), aligns them with the manifest's expected outcome, and prints
 * the agreement table:
 *
 *     fixture | expected | TS | Python | Rust | Go | agree?
 *
 * A fixture "runnable in ALL FOUR" MUST get the same verdict from TS, Python,
 * Rust, and Go AND match the manifest's expectation. Any disagreement among the
 * four — or against the expectation — exits non-zero. Fixtures a binding
 * cannot run (state-catalog fixtures are structural — covered by the runner +
 * JSON Schema, and are n/a for ALL FOUR behavioral bindings) are marked n/a
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
// The Go emitter reads WARP_CONFORMANCE_DIR; run it from the Go module dir so
// `go run` resolves the module. /opt/homebrew/bin is prepended so the Go
// toolchain is on PATH in CI and locally.
const goJson = JSON.parse(
  execFileSync("go", ["run", "./cmd/crosscheck-go"], {
    encoding: "utf8",
    cwd: join(REPO_ROOT, "bindings", "go"),
    env: { ...process.env, WARP_CONFORMANCE_DIR: join(REPO_ROOT, "conformance"), PATH: "/opt/homebrew/bin:" + process.env.PATH },
  }),
);
const tsById = new Map(tsJson.map((r) => [r.id, r]));
const pyById = new Map(pyJson.map((r) => [r.id, r]));
const rsById = new Map(rsJson.map((r) => [r.id, r]));
const goById = new Map(goJson.map((r) => [r.id, r]));

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
  const go = goById.get(entry.id);
  const tsv = verdictStr(ts);
  const pyv = verdictStr(py);
  const rsv = verdictStr(rs);
  const gov = verdictStr(go);
  const allRunnable = ts.runnable && py.runnable && rs.runnable && go.runnable;

  let agree;
  if (allRunnable) {
    // all four bindings must agree with each other...
    const bindingsAgree = tsv === pyv && pyv === rsv && rsv === gov;
    // ...and each with the manifest expectation
    const expectedOk =
      matchesExpected(entry, ts) && matchesExpected(entry, py) && matchesExpected(entry, rs) && matchesExpected(entry, go);
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
  rows.push({ id: entry.id, expected: expectStr(entry), ts: tsv, py: pyv, rs: rsv, go: gov, agree });
}

// ---- print table ----
const w = (s, n) => String(s).padEnd(n);
console.log(w("fixture", 34) + w("expected", 20) + w("TS", 14) + w("Python", 14) + w("Rust", 14) + w("Go", 14) + "agree");
console.log("-".repeat(122));
for (const r of rows)
  console.log(w(r.id, 34) + w(r.expected, 20) + w(r.ts, 14) + w(r.py, 14) + w(r.rs, 14) + w(r.go, 14) + r.agree);

const runnableAll = rows.filter((r) => r.agree !== "n/a").length;
console.log("\n" + "=".repeat(60));
console.log(`runnable in ALL FOUR (TS, Python, Rust, Go) : ${runnableAll}`);
console.log(`agreements                                  : ${agreements}`);
console.log(`disagreements                               : ${disagreements}`);
const naRows = rows.filter((r) => r.agree === "n/a");
console.log(`n/a (structural — no behavioral API)        : ${naRows.length}  [${naRows.map((r) => r.id).join(", ")}]`);

if (disagreements > 0) {
  console.log("\n✗ TS, Python, Rust, and Go DISAGREE on a runnable fixture — must be resolved before merge.");
  process.exit(1);
}
console.log("\n✓ TS, Python, Rust, and Go AGREE on every fixture runnable in all four.");
