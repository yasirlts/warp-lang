/**
 * Bundles a snapshot of the frozen transition table into this package so the
 * published CLI works STANDALONE — without the repo present. It copies the repo's
 * source-of-truth (schema/behavior/transitions.json) to a package-root snapshot
 * the renderer reads at runtime. Run in-repo at build time (`prebuild`); the
 * published tarball ships the snapshot via the package "files" list.
 *
 *   node scripts/bundle-schema.mjs
 */
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // packages/commerce-viz/scripts
const root = join(here, ".."); // packages/commerce-viz
const src = join(root, "..", "..", "schema", "behavior", "transitions.json"); // repo source of truth
const dest = join(root, "transitions.snapshot.json");

if (!existsSync(src)) {
  console.error(`bundle-schema: source not found at ${src} (run inside the repo).`);
  process.exit(1);
}
copyFileSync(src, dest);
console.log("bundle-schema: wrote transitions.snapshot.json from the frozen schema");
