import { describe, expect, it } from "vitest";
import {
  CurrencyMismatchError,
  checkI1MoneyBreakdownSum,
  validateMoneyBreakdown,
  verifyMoneyBreakdown,
  type MoneyBreakdown,
} from "../src/index.js";

// Mirrors the Python MoneyBreakdown tests (test_bug_fixes.py) and the four
// money-breakdown conformance fixtures. Enforces the canonical
// `money_breakdown_sum` rule: single currency + components sum to total within
// minor-unit tolerance (a Discount carries a negative amount and subtracts).

const breakdown = (total: MoneyBreakdown["total"], components: MoneyBreakdown["components"]): MoneyBreakdown => ({
  total,
  components,
});

describe("MoneyBreakdown sum (money_breakdown_sum, I-1 extension)", () => {
  it("accepts a breakdown whose components sum to the total (negative Discount)", () => {
    // Base 90 − Discount 10 + Tax 20 = 100 MAD.
    const bd = breakdown({ amount: 100, currency: "MAD" }, [
      { kind: "Base", amount: { amount: 90, currency: "MAD" } },
      { kind: "Discount", amount: { amount: -10, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 20, currency: "MAD" } },
    ]);
    expect(() => validateMoneyBreakdown(bd)).not.toThrow();
    expect(checkI1MoneyBreakdownSum(bd)).toEqual([]);
  });

  it("rejects a sum mismatch (80 + 30 ≠ 100)", () => {
    const bd = breakdown({ amount: 100, currency: "MAD" }, [
      { kind: "Base", amount: { amount: 80, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 30, currency: "MAD" } },
    ]);
    expect(() => validateMoneyBreakdown(bd)).toThrow(/money_breakdown_sum/);
    const violations = checkI1MoneyBreakdownSum(bd);
    expect(violations.length).toBe(1);
    expect(violations[0]?.invariant).toBe("I-1");
  });

  it("rejects a component in a different currency (single-currency clause)", () => {
    const bd = breakdown({ amount: 100, currency: "MAD" }, [
      { kind: "Base", amount: { amount: 100, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 0, currency: "USD" } },
    ]);
    expect(() => validateMoneyBreakdown(bd)).toThrow(CurrencyMismatchError);
    expect(checkI1MoneyBreakdownSum(bd).length).toBe(1);
  });

  it("accepts the 0.1 + 0.2 = 0.3 case within minor-unit tolerance", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754, but reconciles to 0.3 MAD.
    const bd = breakdown({ amount: 0.3, currency: "MAD" }, [
      { kind: "Base", amount: { amount: 0.1, currency: "MAD" } },
      { kind: "Adjustment", amount: { amount: 0.2, currency: "MAD" } },
    ]);
    expect(() => validateMoneyBreakdown(bd)).not.toThrow();
    expect(checkI1MoneyBreakdownSum(bd)).toEqual([]);
  });

  it("exposes the rule under the verifyMoneyBreakdown alias", () => {
    expect(verifyMoneyBreakdown).toBe(checkI1MoneyBreakdownSum);
  });
});
