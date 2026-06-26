import { describe, expect, it } from "vitest";
import {
  checkSettlementPolicy,
  SAMPLE_VAT_PACK,
  type Money,
  type MoneyBreakdown,
  type RegulatoryPolicyPack,
} from "../src/index.js";

// Regulatory policy packs as DATA over validateSettlement. A VAT pack lists, per
// jurisdiction, the tax_rate values its Tax components may declare. checkSettlementPolicy
// first delegates to validateSettlement (the money_breakdown_sum / I-1 reconciliation),
// then checks each caller-supplied Tax component against the pack's permitted rates and
// that its amount equals rate × base. It validates reconciliation against caller-supplied
// rates; it is NOT a tax calculator and does not compute tax law.

const committed = (amount: number): Money => ({ amount, currency: "MAD" });

const bd = (total: MoneyBreakdown["total"], components: MoneyBreakdown["components"]): MoneyBreakdown => ({
  total,
  components,
});

describe("checkSettlementPolicy — reconciliation delegation", () => {
  it("accepts a settlement that reconciles with a permitted, internally-consistent rate", () => {
    const s = bd(committed(240), [
      { kind: "Base", amount: committed(200), label: "principal" },
      { kind: "Tax", amount: committed(40), jurisdiction: "MA", tax_rate: 0.2 }, // 0.2 × 200 = 40
    ]);
    expect(checkSettlementPolicy(s, committed(240), SAMPLE_VAT_PACK)).toEqual({ ok: true });
  });

  it("delegates reconciliation to validateSettlement: non-summing components are caught first", () => {
    // 200 + 30 = 230 ≠ 240 committed — fails I-1 before the rate check is reached.
    const s = bd(committed(240), [
      { kind: "Base", amount: committed(200) },
      { kind: "Tax", amount: committed(30), jurisdiction: "MA", tax_rate: 0.2 },
    ]);
    const r = checkSettlementPolicy(s, committed(240), SAMPLE_VAT_PACK);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.violations[0]?.rule).toBe("I-1");
  });

  it("delegates the single-currency clause to validateSettlement", () => {
    const s: MoneyBreakdown = {
      total: committed(240),
      components: [
        { kind: "Base", amount: committed(200) },
        { kind: "Tax", amount: { amount: 40, currency: "EUR" }, jurisdiction: "MA", tax_rate: 0.2 },
      ],
    };
    const r = checkSettlementPolicy(s, committed(240), SAMPLE_VAT_PACK);
    expect(r.ok).toBe(false);
  });
});

describe("checkSettlementPolicy — pack rate check", () => {
  it("rejects a tax_rate the pack does not permit for the jurisdiction", () => {
    // 0.25 reconciles (0.25 × 200 = 50, total 250) but is not a permitted MA rate.
    const s = bd(committed(250), [
      { kind: "Base", amount: committed(200) },
      { kind: "Tax", amount: committed(50), jurisdiction: "MA", tax_rate: 0.25 },
    ]);
    const r = checkSettlementPolicy(s, committed(250), SAMPLE_VAT_PACK);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.violations[0]?.rule).toBe("sample-vat/tax-rate");
  });

  it("rejects a tax amount that does not equal rate × base", () => {
    // Permitted rate 0.2, but amount 30 ≠ 0.2 × 200 (40). Total still reconciles (230).
    const s = bd(committed(230), [
      { kind: "Base", amount: committed(200) },
      { kind: "Tax", amount: committed(30), jurisdiction: "MA", tax_rate: 0.2 },
    ]);
    const r = checkSettlementPolicy(s, committed(230), SAMPLE_VAT_PACK);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.violations[0]?.rule).toBe("sample-vat/tax-reconcile");
  });

  it("rejects a jurisdiction the pack does not cover", () => {
    // "US" reconciles but is not in the sample pack.
    const s = bd(committed(220), [
      { kind: "Base", amount: committed(200) },
      { kind: "Tax", amount: committed(20), jurisdiction: "US", tax_rate: 0.1 },
    ]);
    const r = checkSettlementPolicy(s, committed(220), SAMPLE_VAT_PACK);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.violations[0]?.rule).toBe("sample-vat/jurisdiction");
  });

  it("rejects a Tax component missing jurisdiction or tax_rate", () => {
    const s = bd(committed(240), [
      { kind: "Base", amount: committed(200) },
      { kind: "Tax", amount: committed(40) }, // no jurisdiction / tax_rate
    ]);
    const r = checkSettlementPolicy(s, committed(240), SAMPLE_VAT_PACK);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.violations[0]?.rule).toBe("sample-vat/tax-rate");
  });

  it("treats Discount lines as reducing the taxable base", () => {
    // base = 200 - 50 (discount) = 150; tax 0.2 × 150 = 30; total 200 - 50 + 30 = 180.
    const s = bd(committed(180), [
      { kind: "Base", amount: committed(200) },
      { kind: "Discount", amount: committed(-50) },
      { kind: "Tax", amount: committed(30), jurisdiction: "MA", tax_rate: 0.2 },
    ]);
    expect(checkSettlementPolicy(s, committed(180), SAMPLE_VAT_PACK)).toEqual({ ok: true });
  });

  it("accepts a zero-rated tax line (0 permitted for FR)", () => {
    const s = bd(committed(200), [
      { kind: "Base", amount: committed(200) },
      { kind: "Tax", amount: committed(0), jurisdiction: "FR", tax_rate: 0 },
    ]);
    expect(checkSettlementPolicy(s, committed(200), SAMPLE_VAT_PACK)).toEqual({ ok: true });
  });

  it("uses minor-unit tolerance for the rate × base arithmetic", () => {
    // base 99.99, rate 0.2 → 19.998; declared 20.00 is within half-a-cent tolerance.
    const s: MoneyBreakdown = {
      total: { amount: 119.99, currency: "MAD" },
      components: [
        { kind: "Base", amount: { amount: 99.99, currency: "MAD" } },
        { kind: "Tax", amount: { amount: 20.0, currency: "MAD" }, jurisdiction: "MA", tax_rate: 0.2 },
      ],
    };
    expect(checkSettlementPolicy(s, { amount: 119.99, currency: "MAD" }, SAMPLE_VAT_PACK)).toEqual({
      ok: true,
    });
  });
});

describe("checkSettlementPolicy — caller-supplied pack data", () => {
  it("honours a caller's own pack, not a hardcoded table", () => {
    const customPack: RegulatoryPolicyPack = {
      id: "my-vat",
      label: "Custom",
      description: "caller-supplied",
      jurisdictions: [{ jurisdiction: "ES", rates: [0.21] }],
    };
    const s = bd(committed(242), [
      { kind: "Base", amount: committed(200) },
      { kind: "Tax", amount: committed(42), jurisdiction: "ES", tax_rate: 0.21 }, // 0.21 × 200 = 42
    ]);
    expect(checkSettlementPolicy(s, committed(242), customPack)).toEqual({ ok: true });
  });
});
