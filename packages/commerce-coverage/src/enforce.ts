/**
 * The enforcer — turn the coverage statement into a build gate.
 *
 * It reuses the audit engine (no forked logic) and decides pass/fail over
 * ENFORCEABLE sinks: declared, analyzable, and not allow-listed. At the default
 * threshold (100%) the build fails if any such sink is unguarded. Allow-listed
 * sinks are accepted exceptions (each with a reason, listed). Unanalyzable sinks
 * are never silently passed: in "warn" mode they pass the build but are printed
 * loudly as the adopter's responsibility; in "block" mode they fail it.
 *
 * Honest scope, restated on every run: this prevents NEW unguarded declared,
 * analyzable money-paths from shipping. It cannot see — and so cannot enforce —
 * undeclared, dynamic, or otherwise unanalyzable writes. It is not a guarantee of
 * total coverage.
 */
import type { CoverageReport } from "./report.js";

export interface EnforcementOptions {
  failUnder: number; // minimum guarded % of enforceable sinks to pass
  onUnanalyzable: "warn" | "block";
}

export interface EnforcementResult {
  ok: boolean;
  exitCode: number; // 0 pass, 1 fail
  failUnder: number;
  /** guarded % over enforceable sinks (analyzable minus allow-listed); null when none. */
  enforcedPercent: number | null;
  enforceableSinks: number;
  guarded: number;
  unguardedGaps: number;
  allowlisted: number;
  unanalyzable: number;
  onUnanalyzable: "warn" | "block";
  reasons: string[]; // why it failed (empty when ok)
  warnings: string[]; // loud, non-fatal warnings (e.g. unanalyzable in warn mode)
}

export const SCOPE_NOTE =
  "Scope: this prevents new unguarded declared, analyzable money-sinks from shipping. " +
  "It cannot see undeclared, dynamic, or unanalyzable writes, so it is not a guarantee of " +
  "total coverage — those remain your responsibility.";

export function evaluateEnforcement(report: CoverageReport, opts: EnforcementOptions): EnforcementResult {
  const guarded = report.summary.covered;
  const unguardedGaps = report.summary.unguardedGaps;
  const allowlisted = report.summary.allowlisted;
  const unanalyzable = report.summary.unanalyzable;
  const enforceableSinks = guarded + unguardedGaps; // analyzable minus allow-listed

  const enforcedPercent = enforceableSinks === 0 ? null : Math.round((guarded / enforceableSinks) * 100);
  const belowThreshold = enforcedPercent !== null && enforcedPercent < opts.failUnder;
  const unanalyzableBlocks = opts.onUnanalyzable === "block" && unanalyzable > 0;

  const reasons: string[] = [];
  if (belowThreshold) {
    reasons.push(
      `guarded ${enforcedPercent}% of enforceable sinks, below the required ${opts.failUnder}% ` +
        `(${unguardedGaps} unguarded declared sink${unguardedGaps === 1 ? "" : "s"}):`,
    );
    for (const f of report.unguarded) reasons.push(`  unguarded: ${f.file}:${f.line} [${f.sink}] — ${f.reason}`);
  }
  if (unanalyzableBlocks) {
    reasons.push(
      `onUnanalyzable="block" and ${unanalyzable} sink${unanalyzable === 1 ? "" : "s"} could not be analyzed:`,
    );
    for (const f of report.unanalyzable) reasons.push(`  unanalyzable: ${f.file}:${f.line} [${f.sink}] — ${f.reason}`);
  }

  const warnings: string[] = [];
  if (opts.onUnanalyzable === "warn" && unanalyzable > 0) {
    warnings.push(
      `${unanalyzable} declared sink${unanalyzable === 1 ? "" : "s"} could not be analyzed — Warp cannot see ` +
        `${unanalyzable === 1 ? "it" : "them"}; guarding ${unanalyzable === 1 ? "it" : "them"} is your responsibility (not counted as covered):`,
    );
    for (const f of report.unanalyzable) warnings.push(`  unanalyzable: ${f.file}:${f.line} [${f.sink}]`);
  }

  const ok = !belowThreshold && !unanalyzableBlocks;
  return {
    ok,
    exitCode: ok ? 0 : 1,
    failUnder: opts.failUnder,
    enforcedPercent,
    enforceableSinks,
    guarded,
    unguardedGaps,
    allowlisted,
    unanalyzable,
    onUnanalyzable: opts.onUnanalyzable,
    reasons,
    warnings,
  };
}

/** Render the enforcement verdict for the CLI. */
export function formatEnforcement(result: EnforcementResult, report: CoverageReport): string {
  const out: string[] = [];
  out.push(result.ok ? "PASS — warp-coverage enforce" : "FAIL — warp-coverage enforce");
  out.push(report.header);
  out.push(
    `  enforceable (analyzable − allow-listed): ${result.enforceableSinks}   guarded: ${result.guarded}   ` +
      `unguarded gaps: ${result.unguardedGaps}   allow-listed: ${result.allowlisted}   ` +
      `unanalyzable: ${result.unanalyzable} (${result.onUnanalyzable})`,
  );
  out.push(
    `  guarded ${result.enforcedPercent === null ? "n/a" : result.enforcedPercent + "%"} of enforceable, ` +
      `threshold failUnder=${result.failUnder}%`,
  );

  if (result.reasons.length) {
    out.push("");
    out.push("FAIL because:");
    for (const r of result.reasons) out.push("  " + r);
  }
  if (result.warnings.length) {
    out.push("");
    out.push("WARNINGS (not fatal, but your responsibility):");
    for (const w of result.warnings) out.push("  " + w);
  }
  if (report.allowlisted.length) {
    out.push("");
    out.push("ACCEPTED exceptions (allow-listed, reasoned):");
    for (const f of report.allowlisted) out.push(`  - ${f.file}:${f.line} [${f.sink}] — ${f.allowReason}`);
  }
  out.push("");
  out.push("── note ────────────────────────────────────────────────────────────────");
  out.push(SCOPE_NOTE);
  return out.join("\n");
}
