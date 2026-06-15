#!/usr/bin/env node
/**
 * Test the external-binding harness end to end, using the real TS binding as the
 * worked reference "external" binding:
 *
 *   crosscheck-ts.mjs (emit verdicts) -> score-adapter.mjs (score vs manifest)
 *
 * Asserts the harness reports a clean pass (exit 0, zero disagreements, every
 * runnable fixture agreeing). This keeps the documented worked example honest:
 * if the scorer or the contract ever drifts, this fails.
 *
 *   node conformance/tooling/test-score-adapter.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const PKG = join(REPO, "packages", "commerce-types");
const DIST = join(PKG, "dist", "index.js");

function fail(msg) {
  console.error(`test-score-adapter: FAIL — ${msg}`);
  process.exit(1);
}

// 0) Ensure the worked example's binding is built. The TS adapter (crosscheck-ts.mjs)
//    imports the package's compiled dist/, which is absent in a fresh checkout — so
//    build it here, as a guarded one-time step, rather than assuming an earlier
//    job did it. This is what lets the single documented command pass from a clean
//    clone. When dist/ already exists (e.g. CI built it), this is skipped.
if (!existsSync(DIST)) {
  console.log("test-score-adapter: TS binding not built — building @warp-lang/commerce-types (one-time)…");
  try {
    if (!existsSync(join(PKG, "node_modules"))) {
      execFileSync("npm", ["ci", "--include=dev"], { cwd: PKG, stdio: "inherit" });
    }
    execFileSync("npm", ["run", "build"], { cwd: PKG, stdio: "inherit" });
  } catch (e) {
    fail(
      `could not build the TS binding (need npm + network for devDeps). ` +
        `Build it manually with: (cd packages/commerce-types && npm ci && npm run build). ${e.message}`,
    );
  }
  if (!existsSync(DIST)) fail(`build did not produce ${DIST}`);
}

// 1) Real TS binding emits its per-fixture verdicts.
const verdicts = execFileSync("node", [join(HERE, "crosscheck-ts.mjs")], { encoding: "utf8" });

// 2) Score them through the pluggable harness.
let out;
try {
  out = execFileSync("node", [join(HERE, "score-adapter.mjs"), "-"], {
    input: verdicts,
    encoding: "utf8",
  });
} catch (e) {
  fail(`score-adapter exited non-zero:\n${e.stdout || ""}${e.stderr || ""}`);
}

// 3) Assert the harness reported a clean pass.
if (!/disagreements\s*:\s*0/.test(out)) fail(`expected zero disagreements:\n${out}`);
const m = out.match(/agrees with the Warp Commerce Model on (\d+)\/(\d+) runnable fixtures/);
if (!m) fail(`missing the conformance pass line:\n${out}`);
const [, agree, runnable] = m;
if (agree !== runnable) fail(`agreements ${agree} != runnable ${runnable}`);
if (Number(agree) < 1) fail("no runnable fixtures scored");

console.log(
  `test-score-adapter: PASS — worked example (TS binding) scores ${agree}/${runnable} via the harness, 0 disagreements.`,
);
