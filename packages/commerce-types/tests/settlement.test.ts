import { describe, expect, it } from "vitest";
import {
  validateSettlement,
  createSettlementTracker,
  componentTotal,
  type MoneyBreakdown,
  type Money,
} from "../src/index.js";

// Multi-component settlement validation: a settlement decomposed into typed
// components (principal / tax / fees / shipping) must RECONCILE against the
// committed total in one currency (the money_breakdown_sum / I-1 rule), and a
// sequence of partial settlements must not cumulatively over-settle. This
// validates reconciliation only — it does NOT compute tax; component amounts are
// caller-supplied.

const committed: Money = { amount: 240, currency: "MAD" };

const bd = (total: MoneyBreakdown["total"], components: MoneyBreakdown["components"]): MoneyBreakdown => ({
  total,
  components,
});

describe("validateSettlement — single multi-component settlement reconciliation", () => {
  it("accepts a settlement whose components sum to the committed total", () => {
    const settlement = bd({ amount: 240, currency: "MAD" }, [
      { kind: "Base", amount: { amount: 200, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 30, currency: "MAD" } },
      { kind: "Shipping", amount: { amount: 10, currency: "MAD" } },
    ]);
    expect(validateSettlement(settlement, committed)).toEqual({ ok: true });
  });

  it("accepts a settlement with a negative Discount component that still reconciles", () => {
    // 200 (Base) − 10 (Discount) + 40 (Tax) + 10 (Shipping) = 240.
    const settlement = bd({ amount: 240, currency: "MAD" }, [
      { kind: "Base", amount: { amount: 200, currency: "MAD" } },
      { kind: "Discount", amount: { amount: -10, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 40, currency: "MAD" } },
      { kind: "Shipping", amount: { amount: 10, currency: "MAD" } },
    ]);
    expect(validateSettlement(settlement, committed).ok).toBe(true);
  });

  it("rejects a settlement whose components do not sum to the total (I-1)", () => {
    const settlement = bd({ amount: 240, currency: "MAD" }, [
      { kind: "Base", amount: { amount: 200, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 25, currency: "MAD" } }, // 235 ≠ 240
      { kind: "Shipping", amount: { amount: 10, currency: "MAD" } },
    ]);
    const res = validateSettlement(settlement, committed);
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.violations.length).toBeGreaterThanOrEqual(1);
      expect(res.violations[0]?.rule).toBe("I-1");
    }
  });

  it("rejects a settlement whose declared total differs from the committed amount (I-1)", () => {
    // Components sum to their own total (200), but that total ≠ committed 240.
    const settlement = bd({ amount: 200, currency: "MAD" }, [
      { kind: "Base", amount: { amount: 200, currency: "MAD" } },
    ]);
    const res = validateSettlement(settlement, committed);
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.violations[0]?.rule).toBe("I-1");
      expect(res.violations[0]?.message).toMatch(/committed/);
    }
  });

  it("rejects a settlement total denominated in a different currency from the commitment", () => {
    const settlement = bd({ amount: 240, currency: "EUR" }, [
      { kind: "Base", amount: { amount: 240, currency: "EUR" } },
    ]);
    const res = validateSettlement(settlement, committed);
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.violations[0]?.message).toMatch(/EUR|MAD/);
    }
  });

  it("rejects components in a mixed currency (single-currency clause)", () => {
    const settlement = bd({ amount: 240, currency: "MAD" }, [
      { kind: "Base", amount: { amount: 210, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 30, currency: "EUR" } },
    ]);
    const res = validateSettlement(settlement, committed);
    expect(res.ok).toBe(false);
  });

  it("reconciles the 0.1 + 0.2 = 0.3 case within minor-unit tolerance", () => {
    const settlement = bd({ amount: 0.3, currency: "MAD" }, [
      { kind: "Base", amount: { amount: 0.1, currency: "MAD" } },
      { kind: "Adjustment", amount: { amount: 0.2, currency: "MAD" } },
    ]);
    expect(validateSettlement(settlement, { amount: 0.3, currency: "MAD" }).ok).toBe(true);
  });
});

describe("componentTotal — totals (does not compute) one kind across lines", () => {
  it("sums multiple Tax lines and returns zero for an absent kind", () => {
    const settlement = bd({ amount: 240, currency: "MAD" }, [
      { kind: "Base", amount: { amount: 200, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 20, currency: "MAD" }, label: "VAT" },
      { kind: "Tax", amount: { amount: 20, currency: "MAD" }, label: "city tax" },
    ]);
    expect(componentTotal(settlement, "Tax")).toEqual({ amount: 40, currency: "MAD" });
    expect(componentTotal(settlement, "Shipping")).toEqual({ amount: 0, currency: "MAD" });
  });
});

describe("createSettlementTracker — cumulative partial settlement", () => {
  it("accepts reconciling installments that sum to the committed total", () => {
    const tracker = createSettlementTracker(committed);
    const a = tracker.settle(
      bd({ amount: 140, currency: "MAD" }, [
        { kind: "Base", amount: { amount: 120, currency: "MAD" } },
        { kind: "Tax", amount: { amount: 20, currency: "MAD" } },
      ]),
    );
    const b = tracker.settle(
      bd({ amount: 100, currency: "MAD" }, [
        { kind: "Base", amount: { amount: 90, currency: "MAD" } },
        { kind: "Shipping", amount: { amount: 10, currency: "MAD" } },
      ]),
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const p = tracker.progress();
    expect(p.settled).toEqual({ amount: 240, currency: "MAD" });
    expect(p.remaining).toEqual({ amount: 0, currency: "MAD" });
    expect(p.fullySettled).toBe(true);
    expect(p.count).toBe(2);
  });

  it("rejects a partial settlement that would cumulatively over-settle the total (I-1)", () => {
    const tracker = createSettlementTracker(committed);
    tracker.settle(bd({ amount: 200, currency: "MAD" }, [{ kind: "Base", amount: { amount: 200, currency: "MAD" } }]));
    // Cumulative would be 200 + 60 = 260 > 240, even though this step reconciles.
    const over = tracker.settle(
      bd({ amount: 60, currency: "MAD" }, [{ kind: "Base", amount: { amount: 60, currency: "MAD" } }]),
    );
    expect(over.ok).toBe(false);
    if (over.ok === false) {
      expect(over.violations[0]?.rule).toBe("I-1");
      expect(over.violations[0]?.message).toMatch(/260|committed/);
    }
    // The rejected step must NOT have advanced the ledger.
    expect(tracker.progress().settled).toEqual({ amount: 200, currency: "MAD" });
    expect(tracker.progress().remaining).toEqual({ amount: 40, currency: "MAD" });
  });

  it("rejects a partial settlement whose own components do not reconcile (I-1)", () => {
    const tracker = createSettlementTracker(committed);
    const bad = tracker.settle(
      bd({ amount: 100, currency: "MAD" }, [
        { kind: "Base", amount: { amount: 70, currency: "MAD" } }, // 70 ≠ 100
      ]),
    );
    expect(bad.ok).toBe(false);
    expect(tracker.progress().settled).toBeNull();
  });

  it("rejects a partial settlement in a different currency (currency mixing)", () => {
    const tracker = createSettlementTracker(committed);
    const bad = tracker.settle(
      bd({ amount: 100, currency: "EUR" }, [{ kind: "Base", amount: { amount: 100, currency: "EUR" } }]),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok === false) {
      expect(bad.violations[0]?.message).toMatch(/EUR|MAD/);
    }
  });

  it("accepts a final installment that reaches the total within minor-unit tolerance", () => {
    const tracker = createSettlementTracker({ amount: 0.3, currency: "MAD" });
    const a = tracker.settle(bd({ amount: 0.1, currency: "MAD" }, [{ kind: "Base", amount: { amount: 0.1, currency: "MAD" } }]));
    const b = tracker.settle(bd({ amount: 0.2, currency: "MAD" }, [{ kind: "Base", amount: { amount: 0.2, currency: "MAD" } }]));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(tracker.progress().fullySettled).toBe(true);
  });
});
