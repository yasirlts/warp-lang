/**
 * Build the coverage STATEMENT from an audit result.
 *
 * The percentage is computed over ANALYZABLE sinks only (covered / analyzable).
 * Unanalyzable sinks are reported in their own section and are NEVER added to the
 * numerator — folding them in (either as covered, or by dropping them to inflate
 * the rate) is the one thing this tool must never do.
 */
import type { AuditResult, Finding, SuppressedHit } from "./audit.js";

export interface CoverageSummary {
  detected: number; // every declared-sink site found (analyzable + unanalyzable)
  analyzable: number; // covered + unguarded
  covered: number;
  unguarded: number;
  unanalyzable: number; // counted SEPARATELY, never in the percentage
  suppressed: number; // removed via allowList (shown transparently)
  coveragePercent: number | null; // covered / analyzable; null when analyzable === 0
  filesScanned: number;
}

export interface CoverageReport {
  header: string;
  summary: CoverageSummary;
  covered: Finding[];
  unguarded: Finding[];
  unanalyzable: Finding[];
  suppressed: SuppressedHit[];
  disclaimer: string;
}

export const DISCLAIMER =
  "This is a structural coverage signal over the sinks you declared. 'Covered' means a " +
  "Warp guard entry runs on the path to the sink; it does not prove the guard validated " +
  "this write correctly. Sinks listed as unanalyzable are not counted as covered. Sinks " +
  "you did not declare are not measured. This audit measures coverage; it does not " +
  "guarantee safety, and partial coverage is the expected, honest result.";

export function buildReport(audit: AuditResult): CoverageReport {
  const covered = audit.findings.filter((f) => f.classification === "COVERED");
  const unguarded = audit.findings.filter((f) => f.classification === "UNGUARDED");
  const unanalyzable = audit.findings.filter((f) => f.classification === "UNANALYZABLE");
  const analyzable = covered.length + unguarded.length;
  const coveragePercent = analyzable === 0 ? null : Math.round((covered.length / analyzable) * 100);

  const summary: CoverageSummary = {
    detected: audit.findings.length,
    analyzable,
    covered: covered.length,
    unguarded: unguarded.length,
    unanalyzable: unanalyzable.length,
    suppressed: audit.suppressed.length,
    coveragePercent,
    filesScanned: audit.filesScanned,
  };

  const pct = coveragePercent === null ? "n/a" : `${coveragePercent}%`;
  const header =
    `Warp guards ${covered.length} of ${analyzable} analyzable declared money-sinks (${pct}). ` +
    `${unanalyzable.length} sink${unanalyzable.length === 1 ? "" : "s"} could not be analyzed ` +
    `(listed below) and ${unanalyzable.length === 1 ? "is" : "are"} NOT counted as covered. ` +
    `This is a structural coverage signal over declared sinks, not a proof of correctness or completeness.`;

  return { header, summary, covered, unguarded, unanalyzable, suppressed: audit.suppressed, disclaimer: DISCLAIMER };
}

function line(f: Finding): string {
  const where = `${f.file}:${f.line}:${f.column}`;
  return `  - ${where}  [${f.sink}]  ${f.reason}`;
}

/** Render the coverage statement as readable text. */
export function formatHuman(r: CoverageReport): string {
  const s = r.summary;
  const out: string[] = [];
  out.push("══ Warp coverage statement ═════════════════════════════════════════════");
  out.push(r.header);
  out.push("");
  out.push(
    `  files scanned: ${s.filesScanned}   detected sinks: ${s.detected}   ` +
      `analyzable: ${s.analyzable}   covered: ${s.covered}   unguarded: ${s.unguarded}`,
  );
  out.push(
    `  coverage (covered / analyzable): ${s.coveragePercent === null ? "n/a" : s.coveragePercent + "%"}`,
  );
  out.push(
    `  UNANALYZABLE (NOT counted in coverage): ${s.unanalyzable}` +
      (s.suppressed ? `    suppressed via allowList: ${s.suppressed}` : ""),
  );
  out.push("");

  out.push(`UNGUARDED — declared sinks with no guard on their path (${r.unguarded.length}):`);
  out.push(r.unguarded.length ? r.unguarded.map(line).join("\n") : "  (none)");
  out.push("");

  out.push(
    `UNDETECTED / UNANALYZABLE — sites that could not be statically analyzed, NOT counted as covered (${r.unanalyzable.length}):`,
  );
  out.push(r.unanalyzable.length ? r.unanalyzable.map(line).join("\n") : "  (none)");
  out.push("");

  out.push(`COVERED — a Warp guard runs on the path (structural signal only) (${r.covered.length}):`);
  out.push(r.covered.length ? r.covered.map(line).join("\n") : "  (none)");

  if (r.suppressed.length) {
    out.push("");
    out.push(`SUPPRESSED via allowList — excluded from the measured set, shown for transparency (${r.suppressed.length}):`);
    out.push(r.suppressed.map((h) => `  - ${h.file}:${h.line}  [${h.sink}]`).join("\n"));
  }

  out.push("");
  out.push("── note ────────────────────────────────────────────────────────────────");
  out.push(r.disclaimer);
  return out.join("\n");
}
