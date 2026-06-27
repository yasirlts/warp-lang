/**
 * The sample fixture IS the test. The toy app declares 5 analyzable money-sinks
 * (3 guarded, 2 unguarded) plus 1 indirectly-reached sink. The audit must report
 * 3/5 = 60%, name the 2 gaps, and list the 1 unanalyzable sink SEPARATELY — never
 * folding it into the coverage number. The last test pins that honesty property.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadConfig, runAudit, buildReport } from "../src/index.js";

const CONFIG = fileURLToPath(new URL("../sample/warp-coverage.config.json", import.meta.url));

function audit() {
  return buildReport(runAudit(loadConfig(CONFIG)));
}

describe("coverage audit — sample fixture", () => {
  it("reports 3 of 5 analyzable covered = 60%", () => {
    const r = audit();
    expect(r.summary.covered).toBe(3);
    expect(r.summary.analyzable).toBe(5);
    expect(r.summary.unguarded).toBe(2);
    expect(r.summary.coveragePercent).toBe(60);
    expect(r.header).toContain("3 of 5");
    expect(r.header).toContain("60%");
  });

  it("names the 2 unguarded gaps correctly", () => {
    const r = audit();
    const gaps = r.unguarded.map((f) => `${f.sink}@${f.file}`).sort();
    expect(gaps).toEqual(["chargeCard@src/app.ts", "postLedger@src/app.ts"]);
    // each gap carries a file:line and a reason
    for (const f of r.unguarded) {
      expect(f.line).toBeGreaterThan(0);
      expect(f.reason.length).toBeGreaterThan(0);
      expect(f.classification).toBe("UNGUARDED");
    }
  });

  it("lists the 1 unanalyzable sink SEPARATELY (in the undetected section)", () => {
    const r = audit();
    expect(r.summary.unanalyzable).toBe(1);
    expect(r.unanalyzable).toHaveLength(1);
    const u = r.unanalyzable[0]!;
    expect(u.sink).toBe("postLedger");
    expect(u.kind).toBe("indirect");
    expect(u.classification).toBe("UNANALYZABLE");
    // it must NOT appear among covered sinks
    expect(r.covered.some((f) => f.line === u.line && f.file === u.file)).toBe(false);
  });

  it("HONESTY PROPERTY: the unanalyzable sink never inflates coverage", () => {
    const r = audit();
    // detected = analyzable + unanalyzable; the % denominator is analyzable ONLY
    expect(r.summary.detected).toBe(r.summary.analyzable + r.summary.unanalyzable);
    expect(r.summary.detected).toBe(6);
    expect(r.summary.coveragePercent).toBe(Math.round((r.summary.covered / r.summary.analyzable) * 100));
    // if the unanalyzable sink were (wrongly) counted as covered, it would read 4/6 = 67%.
    const inflated = Math.round(((r.summary.covered + r.summary.unanalyzable) / r.summary.detected) * 100);
    expect(inflated).toBe(67);
    expect(r.summary.coveragePercent).not.toBe(inflated);
    expect(r.summary.coveragePercent).toBe(60);
    // header states the unanalyzable count is NOT counted as covered
    expect(r.header).toContain("NOT counted as covered");
  });

  it("classifies covered sinks as a structural signal, naming the guard on the path", () => {
    const r = audit();
    expect(r.covered).toHaveLength(3);
    const guards = r.covered.map((f) => f.guardedBy).sort();
    expect(guards).toEqual(["guardAction", "guardObject", "guardWithProfile"]);
  });

  it("never emits a total/complete/guaranteed-safe coverage claim", () => {
    const r = audit();
    const text = (JSON.stringify(r) + r.header + r.disclaimer).toLowerCase();
    // these phrases may appear ONLY in negated form; assert no positive overclaim
    expect(text).not.toContain("total coverage");
    expect(text).not.toContain("complete coverage");
    expect(text).not.toContain("guarantees safety");
    expect(text).not.toContain("fully covered");
    expect(text).not.toContain("proves correct");
  });
});
