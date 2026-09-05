#!/usr/bin/env node
/**
 * The rung-C deploy flow, end to end — run verbatim in CI.
 *
 *   1. build + PACK @warp-lang/commerce-types into a tarball (what npm would ship)
 *   2. install that tarball into examples/deploy-host/ (what an adopter's npm install does)
 *   3. compile examples/deploy-host/shop.warp → model.json with warpc
 *   4. run the host, which loads model.json and runs it through the packed library
 *
 * The point of steps 1–2 is that the host depends on a PACKAGE, not on this repo's
 * source tree. It has no path into packages/commerce-lang and no way to parse
 * `.warp`; it gets a library and a JSON file, which is exactly what deployment
 * means.
 *
 * HONEST NOTE ON "PUBLISHED". The host consumes a tarball built from this
 * repo, not the version currently on npm. That is not a convenience: the
 * published @warp-lang/commerce-types@1.5.0 predates `runModel` (added in rung
 * 4a) and therefore CANNOT run a composed model at all. Deploying against the
 * npm release needs a release that contains runModel. See docs/DEPLOYMENT.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = join(ROOT, "packages", "commerce-types");
const LANG = join(ROOT, "packages", "commerce-lang");
const HOST = join(ROOT, "examples", "deploy-host");
const TARBALL = join(TYPES, "warp-lang-commerce-types.tgz");

const step = (n, what) => console.log(`\n${"═".repeat(72)}\n${n}. ${what}\n${"═".repeat(72)}`);
const run = (cmd, args, cwd, opts = {}) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: opts.quiet ? "pipe" : "inherit", env: { ...process.env, ...opts.env } });

step(1, "Build and PACK the runtime library — what npm would ship");
run("npm", ["run", "build"], TYPES, { quiet: true, env: { NODE_ENV: "development" } });
const packed = run("npm", ["pack", "--silent"], TYPES, { quiet: true }).trim().split("\n").pop();
renameSync(join(TYPES, packed), TARBALL);
console.log(`   packed ${packed} → ${TARBALL.replace(ROOT + "/", "")}`);

step(2, "Install the tarball into the host — what an adopter's `npm install` does");
rmSync(join(HOST, "node_modules"), { recursive: true, force: true });
rmSync(join(HOST, "package-lock.json"), { force: true });
run("npm", ["install", "--silent", "--no-audit", "--no-fund"], HOST, { quiet: true });
const hostDeps = JSON.parse(readFileSync(join(HOST, "package.json"), "utf8")).dependencies;
console.log(`   host dependencies: ${JSON.stringify(hostDeps)}`);
if (!existsSync(join(HOST, "node_modules", "@warp-lang", "commerce-types"))) {
  console.error("   FAILED: the library was not installed into the host");
  process.exit(1);
}
console.log("   the host now has the LIBRARY installed — and nothing else from this repo");

step(3, "Compile the .warp system to a deployable artifact");
run("npm", ["run", "build"], LANG, { quiet: true, env: { NODE_ENV: "development" } });
run("node", [join(LANG, "bin", "warpc.mjs"), join(HOST, "shop.warp"), "-o", join(HOST, "model.json")], ROOT);
const artifact = readFileSync(join(HOST, "model.json"), "utf8");
console.log(`   model.json is ${artifact.length} bytes of plain JSON`);

// Determinism: compiling again must produce byte-identical output.
const again = run("node", [join(LANG, "bin", "warpc.mjs"), join(HOST, "shop.warp")], ROOT, { quiet: true });
if (again !== artifact) {
  console.error("   FAILED: the artifact is not deterministic — two compiles differ");
  process.exit(1);
}
console.log("   recompiling produces byte-identical output (deterministic)");

step(4, "Run the HOST — it loads the artifact and runs it via the library");
run("node", ["host.mjs", "model.json"], HOST);

step(5, "What just happened");
console.log(`
An authored .warp system left this repo as DATA and was run by code that has no
access to the compiler:

  shop.warp  ──warpc──▶  model.json  ──loaded by──▶  examples/deploy-host/host.mjs
                                                       imports @warp-lang/commerce-types
                                                       (installed from a tarball)

The host supplied its own world, its own events and its own clock, and acted on
the verdicts. It could not have parsed .warp if it wanted to — it never imported
the grammar. That is the boundary this rung is about, and tests/deploy.test.ts
checks it mechanically so a later edit cannot quietly undo it.
`);
