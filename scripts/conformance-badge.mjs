#!/usr/bin/env node
/**
 * conformance-badge — produce a pass/fail conformance badge for the Warp
 * Commerce Model, derived from the LIVE conformance tooling.
 *
 * What it does:
 *   1. Runs the existing reference runner  (conformance/runner/run.mjs) and
 *      parses its "X/Y fixtures passed" summary.
 *   2. Optionally runs the four-way cross-check (conformance/tooling/crosscheck.mjs)
 *      and parses its agreements / disagreements summary. The cross-check needs
 *      the TS, Python, Rust, and Go bindings built; if any toolchain is missing
 *      it is reported as "skipped" rather than failing the badge for the runner.
 *   3. Emits a shields.io-style markdown badge snippet AND a small JSON badge
 *      descriptor (the shields.io "endpoint" shape) to stdout, and writes them
 *      to disk when --out is given.
 *
 * It does NOT modify the conformance suite or the schema — it only invokes the
 * existing scripts and reads their stdout. The counts are DERIVED from that
 * output, never hardcoded.
 *
 * Usage:
 *   node scripts/conformance-badge.mjs                 # runner only, print badge
 *   node scripts/conformance-badge.mjs --crosscheck    # also run the 4-way check
 *   node scripts/conformance-badge.mjs --out badges    # write badge.md + badge.json
 *   node scripts/conformance-badge.mjs --json          # print only the JSON descriptor
 *
 * Exit code: 0 when conformant (all fixtures passed, and — if --crosscheck was
 * requested and ran — zero disagreements); 1 otherwise.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const RUNNER = join(REPO, "conformance", "runner", "run.mjs");
const CROSSCHECK = join(REPO, "conformance", "tooling", "crosscheck.mjs");

const args = process.argv.slice(2);
const WANT_CROSSCHECK = args.includes("--crosscheck");
const JSON_ONLY = args.includes("--json");
const outIdx = args.indexOf("--out");
const OUT_DIR = outIdx !== -1 ? args[outIdx + 1] : null;

// --- helpers ----------------------------------------------------------------

// Run a node script, capturing stdout even on non-zero exit. We must inspect the
// output to know WHY it failed, so we don't let execFileSync throw the output away.
function runNode(scriptPath, env) {
  try {
    const stdout = execFileSync("node", [scriptPath], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, ...(env || {}) },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout };
  } catch (e) {
    return {
      ok: false,
      code: typeof e.status === "number" ? e.status : 1,
      stdout: (e.stdout || "").toString() + (e.stderr || "").toString(),
    };
  }
}

// --- 1. runner --------------------------------------------------------------
// Parse the canonical summary line:
//   "Warp conformance v1.0.0 vs CANONICAL schema — 54/54 fixtures passed."
function parseRunner(stdout) {
  const m = stdout.match(/(\d+)\s*\/\s*(\d+)\s+fixtures passed/i);
  if (!m) return null;
  const passed = Number(m[1]);
  const total = Number(m[2]);
  const ver = stdout.match(/conformance\s+v([\d.]+)/i);
  return { passed, total, version: ver ? ver[1] : null };
}

// --- 2. cross-check ---------------------------------------------------------
// Parse the cross-check summary block:
//   runnable in ALL FOUR (TS, Python, Rust, Go) : 48
//   agreements                                  : 48
//   disagreements                               : 0
function parseCrosscheck(stdout) {
  const num = (re) => {
    const m = stdout.match(re);
    return m ? Number(m[1]) : null;
  };
  const runnable = num(/runnable in ALL FOUR[^\n:]*:\s*(\d+)/i);
  const agreements = num(/agreements\s*:\s*(\d+)/i);
  const disagreements = num(/disagreements\s*:\s*(\d+)/i);
  if (runnable === null || agreements === null || disagreements === null) return null;
  return { runnable, agreements, disagreements };
}

// --- badge construction -----------------------------------------------------

function shieldsUrl(label, message, color) {
  const enc = (s) => encodeURIComponent(String(s).replace(/-/g, "--").replace(/_/g, "__"));
  return `https://img.shields.io/badge/${enc(label)}-${enc(message)}-${color}`;
}

function buildBadge(runner, crosscheck) {
  const passed = runner.passed === runner.total && runner.total > 0;
  const ccOk = !crosscheck || crosscheck.disagreements === 0;
  const conformant = passed && ccOk;

  const verSuffix = runner.version ? ` (schema v${runner.version})` : "";
  const message = `${runner.passed}/${runner.total} conformant${verSuffix}`;
  const color = conformant ? "success" : "critical";
  const url = shieldsUrl("conformance", message, color);

  const markdown = `[![Conformance](${url})](conformance/)`;
  // shields.io "endpoint" JSON shape, plus our own derived fields for tooling.
  const descriptor = {
    schemaVersion: 1,
    label: "conformance",
    message,
    color,
    // Derived, machine-readable detail — not part of the shields contract,
    // but useful for a maintainer's board.
    warp: {
      conformant,
      runner: { passed: runner.passed, total: runner.total, schema_version: runner.version },
      crosscheck: crosscheck
        ? {
            runnable_in_all_four: crosscheck.runnable,
            agreements: crosscheck.agreements,
            disagreements: crosscheck.disagreements,
          }
        : "skipped",
      generated_at: new Date().toISOString(),
    },
  };
  return { conformant, markdown, descriptor, url };
}

// --- main -------------------------------------------------------------------

const runnerRes = runNode(RUNNER);
const runner = parseRunner(runnerRes.stdout);
if (!runner) {
  process.stderr.write("conformance-badge: could not parse runner output. Raw output follows:\n");
  process.stderr.write(runnerRes.stdout + "\n");
  process.exit(1);
}
// A non-zero runner exit means a fixture mismatched; reflect that in passed/total
// (the runner already prints the true counts even on failure).

let crosscheck = null;
let crosscheckNote = null;
if (WANT_CROSSCHECK) {
  // The cross-check shells out to python3/cargo/go and imports the built TS
  // binding. Forward PYTHONPATH if the Python package is used from source.
  const ccRes = runNode(CROSSCHECK);
  crosscheck = parseCrosscheck(ccRes.stdout);
  if (!crosscheck) {
    crosscheckNote =
      "cross-check did not produce a parseable summary (a binding toolchain " +
      "may be missing — TS build, python3, cargo, or go). Badge reflects the " +
      "runner only; run the cross-check job in CI for the four-way guarantee.";
  }
}

const badge = buildBadge(runner, crosscheck);

if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(badge.descriptor, null, 2) + "\n");
} else {
  process.stdout.write("Conformance badge (derived from the live runner):\n\n");
  process.stdout.write(`  runner      : ${runner.passed}/${runner.total} fixtures passed`);
  process.stdout.write(runner.version ? `  (schema v${runner.version})\n` : "\n");
  if (WANT_CROSSCHECK) {
    if (crosscheck) {
      process.stdout.write(
        `  cross-check : ${crosscheck.agreements} agreements, ${crosscheck.disagreements} disagreements ` +
          `(${crosscheck.runnable} runnable in all four bindings)\n`,
      );
    } else {
      process.stdout.write(`  cross-check : skipped — ${crosscheckNote}\n`);
    }
  }
  process.stdout.write(`  verdict     : ${badge.conformant ? "CONFORMANT" : "NOT CONFORMANT"}\n\n`);
  process.stdout.write("Markdown snippet:\n\n");
  process.stdout.write("  " + badge.markdown + "\n\n");
  process.stdout.write("JSON descriptor (shields.io endpoint shape):\n\n");
  process.stdout.write(JSON.stringify(badge.descriptor, null, 2) + "\n");
}

if (OUT_DIR) {
  const dir = isAbsolute(OUT_DIR) ? OUT_DIR : resolve(REPO, OUT_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "conformance-badge.md"), badge.markdown + "\n");
  writeFileSync(join(dir, "conformance-badge.json"), JSON.stringify(badge.descriptor, null, 2) + "\n");
  if (!JSON_ONLY) process.stderr.write(`\nWrote ${join(dir, "conformance-badge.md")} and ${join(dir, "conformance-badge.json")}\n`);
}

process.exit(badge.conformant ? 0 : 1);
