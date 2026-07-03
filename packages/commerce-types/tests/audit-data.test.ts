/**
 * Platform Auditor — Tier 2 (data audit). These tests pin the contract: clean
 * records are clean; a planted over-refund / currency-mixed settlement / illegal
 * history is caught on the RIGHT record with the right invariant; an unmappable
 * record is UNAUDITABLE and NEVER counted clean (the cardinal sin); and the counts
 * always sum (clean + withViolations = recordsAudited; unauditable is separate).
 */
import { describe, it, expect } from "vitest";
import { auditPlatformData, orderRecordToCommitment, type OrderRecord } from "../src/index.js";

const clean: OrderRecord = {
  id: "clean-1",
  committed: { amount: 200, currency: "MAD" },
  finalState: "Fulfilled",
  history: [
    { from: "Proposed", to: "Accepted" },
    { from: "Accepted", to: "PartiallyFulfilled" },
    { from: "PartiallyFulfilled", to: "Fulfilled" },
  ],
};
const fullRefund: OrderRecord = { id: "clean-2", committed: { amount: 150, currency: "MAD" }, refund: { amount: 150, currency: "MAD" } };
const overRefund: OrderRecord = { id: "bad-refund", committed: { amount: 200, currency: "MAD" }, refund: { amount: 250, currency: "MAD" } };
const mixedSettlement: OrderRecord = {
  id: "bad-settlement",
  committed: { amount: 300, currency: "MAD" },
  settlement: {
    total: { amount: 300, currency: "MAD" },
    components: [
      { kind: "Base", amount: { amount: 250, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 50, currency: "EUR" } },
    ],
  },
};
const illegalHistory: OrderRecord = {
  id: "bad-history",
  committed: { amount: 120, currency: "MAD" },
  history: [
    { from: "PartiallyFulfilled", to: "Fulfilled" },
    { from: "Fulfilled", to: "Accepted" }, // illegal
  ],
};
const unmappable = { id: "no-amount", note: "malformed" } as unknown as OrderRecord;

describe("auditPlatformData — clean records", () => {
  it("reports clean with no violations and no unauditable", () => {
    const r = auditPlatformData({ platform: "T", records: [clean, fullRefund] });
    expect(r.violations).toEqual([]);
    expect(r.unauditable).toEqual([]);
    expect(r.clean).toBe(2);
    expect(r.recordsAudited).toBe(2);
  });
});

describe("auditPlatformData — catches each violation on the right record", () => {
  it("over-refund → I-1 on that order, with the amounts in the detail", () => {
    const r = auditPlatformData({ platform: "T", records: [clean, overRefund] });
    const v = r.violations.find((x) => x.recordId === "bad-refund");
    expect(v?.rule).toBe("I-1");
    expect(v?.detail).toContain("250 MAD");
    expect(v?.detail).toContain("200 MAD");
    expect(r.clean).toBe(1); // only `clean`
  });

  it("currency-mixed settlement → I-1 on that order", () => {
    const r = auditPlatformData({ platform: "T", records: [mixedSettlement] });
    const v = r.violations.find((x) => x.recordId === "bad-settlement");
    expect(v?.rule).toBe("I-1");
    expect(v?.detail).toMatch(/currenc/i);
  });

  it("illegal state history → I-2 on that order", () => {
    const r = auditPlatformData({ platform: "T", records: [illegalHistory] });
    const v = r.violations.find((x) => x.recordId === "bad-history");
    expect(v?.rule).toBe("I-2");
    expect(v?.detail).toContain("Fulfilled → Accepted");
  });
});

describe("auditPlatformData — unauditable is NEVER counted clean (cardinal sin)", () => {
  it("lists the unmappable record separately; counts sum correctly", () => {
    const r = auditPlatformData({ platform: "T", records: [clean, overRefund, unmappable] });
    expect(r.unauditable.map((u) => u.recordId)).toEqual(["no-amount"]);
    expect(r.unauditable[0]!.why).toContain("committed");
    // the cardinal sin: unmappable is NOT folded into clean
    expect(r.clean).toBe(1); // only `clean`; the unmappable is not clean
    expect(r.recordsAudited).toBe(2); // clean + overRefund; NOT the unmappable
    // counts always reconcile
    const s = r.summary;
    expect(s.clean + s.withViolations).toBe(s.recordsAudited);
    expect(s.recordsAudited + s.unauditable).toBe(s.total);
    expect(s.total).toBe(3);
  });
});

describe("auditPlatformData — composes a custom inbound mapper", () => {
  it("uses a supplied toCommitment; a mapper that throws → unauditable", () => {
    // A trivial platform-native record + mapper (mirrors passing fromShopifyOrder).
    type Native = { orderId: string; total: number };
    const r = auditPlatformData<Native>({
      platform: "Native",
      records: [
        { orderId: "n-1", total: 100 },
        { orderId: "n-bad", total: -1 },
      ],
      getId: (rec) => rec.orderId,
      toCommitment: (rec) => {
        if (rec.total < 0) throw new Error("negative total");
        return orderRecordToCommitment({ id: rec.orderId, committed: { amount: rec.total, currency: "MAD" } });
      },
    });
    expect(r.clean).toBe(1);
    expect(r.unauditable).toEqual([{ recordId: "n-bad", why: "negative total" }]);
  });
});
