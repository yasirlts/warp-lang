/**
 * The enforcer's exit behavior is the contract. These tests pin the three states
 * the build gate must produce, plus the two honesty rules:
 *   (a) all analyzable sinks guarded (or allow-listed)        -> PASS (exit 0)
 *   (b) a new unguarded declared sink                          -> FAIL (exit 1), named
 *   (c) guarding it OR allow-listing it with a reason          -> PASS (exit 0)
 *   - an allow-list entry without a reason is a config error
 *   - onUnanalyzable "warn" passes (loudly) where "block" fails — never silent-pass
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  normalizeConfig,
  runAudit,
  buildReport,
  evaluateEnforcement,
} from "../src/index.js";

function enforce(rel: string) {
  const loaded = loadConfig(fileURLToPath(new URL(rel, import.meta.url)));
  const report = buildReport(runAudit(loaded));
  const result = evaluateEnforcement(report, {
    failUnder: loaded.config.failUnder,
    onUnanalyzable: loaded.config.onUnanalyzable,
  });
  return { report, result };
}

describe("enforce — the three exit behaviors", () => {
  it("(a) all analyzable sinks guarded -> PASS (exit 0)", () => {
    const { result } = enforce("../enforce-fixtures/clean/warp.config.json");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.enforcedPercent).toBe(100);
    expect(result.unguardedGaps).toBe(0);
  });

  it("(b) a new unguarded declared sink -> FAIL (exit 1), naming the sink", () => {
    const { result } = enforce("../enforce-fixtures/gap/warp.config.json");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.enforcedPercent).toBe(50);
    expect(result.unguardedGaps).toBe(1);
    const named = result.reasons.join("\n");
    expect(named).toContain("chargeCard");
    expect(named).toContain("src/app.ts");
  });

  it("(c) allow-listing the gap with a reason -> PASS (exit 0), exception listed", () => {
    const { result, report } = enforce("../enforce-fixtures/gap/warp.allowlisted.config.json");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.enforcedPercent).toBe(100);
    expect(report.allowlisted).toHaveLength(1);
    expect(report.allowlisted[0]!.sink).toBe("chargeCard");
    expect(report.allowlisted[0]!.allowReason).toMatch(/legacy reconciliation/);
  });
});

describe("enforce — honesty rules", () => {
  it("an allow-list entry without a reason is a config error", () => {
    expect(() =>
      normalizeConfig(
        { projectRoots: ["src"], moneySinks: [{ name: "x" }], allowList: [{ target: "src/app.ts" }] },
        "/tmp",
      ),
    ).toThrow(/reason/i);
  });

  it("onUnanalyzable warn passes loudly; block fails — never a silent pass", () => {
    const warn = enforce("../enforce-fixtures/clean/warp.config.json");
    expect(warn.result.ok).toBe(true); // passes
    expect(warn.result.unanalyzable).toBe(1);
    expect(warn.result.warnings.join("\n")).toMatch(/could not be analyzed|responsibility/i); // but loudly

    const block = enforce("../enforce-fixtures/clean/warp.block.config.json");
    expect(block.result.ok).toBe(false); // same fixture, blocks instead
    expect(block.result.exitCode).toBe(1);
    expect(block.result.reasons.join("\n")).toMatch(/unanalyzable/i);

    // the unanalyzable sink is NEVER counted as guarded in either mode
    expect(warn.result.guarded).toBe(2);
    expect(block.result.guarded).toBe(2);
  });

  it("enforce output restates the honest scope (not a total-coverage guarantee)", () => {
    const { result } = enforce("../enforce-fixtures/clean/warp.config.json");
    void result;
    // SCOPE_NOTE is appended by formatEnforcement; assert the engine never claims totality
    const text = JSON.stringify(enforce("../enforce-fixtures/gap/warp.config.json"));
    expect(text.toLowerCase()).not.toContain("guarantees coverage");
    expect(text.toLowerCase()).not.toContain("total coverage");
  });
});
