/**
 * Rung D — `check` reports what the real parser and compiler say, collected.
 * No linting of its own; every diagnostic here is one `warpc compile` would
 * have refused the file for (or, for a warning, one `warpc compile` would
 * refuse to serialize).
 */
import { describe, expect, it } from "vitest";
import { check, formatDiagnostics } from "../src/check.js";

const CLEAN = `
lifecycle l { state Draft  state Proposed  Draft -> Proposed }
profile p { states Draft, Proposed  value_forms Money }
policy h { applies_to p  concession_floor 150 MAD  committed_price 200 MAD }
`;

describe("check — clean and dirty", () => {
  it("a clean file has no diagnostics", () => {
    expect(check(CLEAN, { file: "ok.warp" })).toEqual([]);
  });

  it("a syntax error is reported once, positioned, and nothing else runs", () => {
    const d = check(`policy p {\n  tax_rates "MA" 0 0.1\n}`, { file: "s.warp" });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "error", code: "syntax", line: 2, column: 20, file: "s.warp" });
  });

  it("independent compile errors are ALL reported", () => {
    const d = check(`
      lifecycle l { state Draft  state Reversed  Draft -> Reversed }
      profile p { states Draft  value_forms Money }
      policy a { applies_to missing }
      policy c { assert I9 }
    `);
    expect(d.map((x) => x.code)).toEqual(["compile", "compile", "compile"]);
    expect(d[0]!.message).toContain("Unknown commitment state 'Reversed'");
    expect(d[1]!.message).toContain("applies_to profile 'missing'");
    expect(d[2]!.message).toContain("Unknown invariant 'I9'");
    // In source order.
    expect(d.map((x) => x.line)).toEqual([...d.map((x) => x.line)].sort((a, b) => a - b));
  });

  it("a broken profile is reported once, not again for every policy that uses it", () => {
    const d = check(`
      profile p { states Nope  value_forms Money }
      policy a { applies_to p }
      policy b { applies_to p }
    `);
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toContain("Unknown commitment state 'Nope'");
  });

  it("cross-declaration problems surface once the parts are individually sound", () => {
    const d = check(`
      profile a { states Draft  value_forms Money }
      profile b { states Draft  value_forms Money }
    `);
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toContain("declares 2 profiles");
  });

  it("a computed value is a WARNING, positioned at the field", () => {
    const d = check(`policy p {\n  concession_floor committed * 0.75\n}`, { file: "w.warp" });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "warning", code: "undeployable", line: 2, column: 3 });
    expect(d[0]!.message).toContain("warpc will refuse it");
  });

  it("each error class the language has, positioned", () => {
    const cases: [string, string][] = [
      [`lifecycle l { state Draft  Draft -> Nope  state Nope }`, "Unknown commitment state 'Nope'"],
      [`policy p { concession_floor 150 EUR  committed_price 200 MAD }`, "cross-currency"],
      [`policy p { concession_floor 300 MAD  committed_price 200 MAD }`, "above its"],
      [`policy p { forbid_states Disputed }`, "no 'applies_to'"],
      [`policy p { concession_floor mrr * 2 }`, "unknown variable 'mrr'"],
      [`composition c { label "x" }`, "declares no legs"],
      [`auction "a" { subject "v" seller "s" opens_at "t" closes_at "t" mechanism Nope state Open }`, "mechanism"],
    ];
    for (const [src, fragment] of cases) {
      const d = check(src);
      expect(d.length, src).toBeGreaterThan(0);
      expect(d[0]!.message, src).toContain(fragment);
      expect(d[0]!.line, src).toBeGreaterThan(0);
    }
  });

  it("formatDiagnostics prints the compiler convention", () => {
    const d = check(`policy p { assert I9 }`, { file: "x.warp" });
    expect(formatDiagnostics(d)).toMatch(/^x\.warp:1:\d+: error: Unknown invariant 'I9'/);
  });
});
