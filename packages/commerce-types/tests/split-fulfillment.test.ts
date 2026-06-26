import { describe, expect, it } from "vitest";

import { createSplitFulfillment } from "../src/split-fulfillment.js";
import { allocate } from "../src/money.js";
import { checkI6TreeConsistency } from "../src/invariants.js";
import { commitmentId, newCommitment, partyId, valueId, type Commitment, type Value } from "../src/primitives.js";
import { applyCommitmentPath } from "../src/transitions.js";

const buyer = partyId("buyer");
const seller = partyId("seller");

function money(amount: number, currency = "MAD"): Value {
  return { id: valueId(), form: { kind: "Money", money: { amount, currency } }, quantity: 1, state: { type: "Available" } };
}

function commit(id: string, amount: number, links: Partial<Pick<Commitment, "parent" | "children">> = {}): Commitment {
  const base = { ...newCommitment(buyer, seller, { offered: [], requested: [money(amount)] }), id: commitmentId(id), ...links };
  return applyCommitmentPath(base, { type: "Fulfilled" }, seller);
}

describe("createSplitFulfillment — cumulative fractional split bounded by I-1", () => {
  it("accepts a fractional split across children that conserves the parent, completing under I-6", () => {
    const parent = commit("order-1", 200, { children: [commitmentId("line-A"), commitmentId("line-B"), commitmentId("line-C")] });
    const split = createSplitFulfillment(parent);

    const a = split.allocate({ child: commit("line-A", 80, { parent: commitmentId("order-1") }) });
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.cumulative.amount).toBe(80);
      expect(a.remaining.amount).toBe(120);
      expect(a.complete).toBe(false);
    }

    const b = split.allocate({ child: commit("line-B", 70, { parent: commitmentId("order-1") }) });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.remaining.amount).toBe(50);

    const c = split.allocate({ child: commit("line-C", 50, { parent: commitmentId("order-1") }) });
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.cumulative.amount).toBe(200);
      expect(c.remaining.amount).toBe(0);
      expect(c.complete).toBe(true);
    }

    expect(split.allocatedSoFar().amount).toBe(200);
    // The completed tree reconciles under the unmodified F6 structural check.
    expect(checkI6TreeConsistency(parent, [...split.children]).length).toBe(0);
  });

  it("catches an over-split where each child is valid alone but the running sum exceeds the parent (I-1)", () => {
    const parent = commit("order-2", 200);
    const split = createSplitFulfillment(parent);

    expect(split.allocate({ child: commit("line-A", 80, { parent: commitmentId("order-2") }) }).ok).toBe(true);
    expect(split.allocate({ child: commit("line-B", 80, { parent: commitmentId("order-2") }) }).ok).toBe(true);

    // 80 + 80 + 80 = 240 > 200. The third child (80, valid alone) tips the sum over.
    const third = split.allocate({ child: commit("line-C", 80, { parent: commitmentId("order-2") }) });
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.violations[0]?.rule).toBe("I-1");
      expect(third.violations[0]?.message).toContain("over-allocates");
      expect(third.violations[0]?.fix).toContain("remaining 40");
    }
    // The rejected child was not recorded; the running total is unchanged.
    expect(split.allocatedSoFar().amount).toBe(160);
  });

  it("uses allocate() to produce exact fractional shares that conserve to the cent", () => {
    const parent = commit("order-3", 100);
    // A 3-way split of 100 by equal weights → 33.34 + 33.33 + 33.33 (exact).
    const shares = allocate({ amount: 100, currency: "MAD" }, [1, 1, 1]);
    expect(shares.reduce((s, m) => s + m.amount, 0)).toBeCloseTo(100, 10);

    const split = createSplitFulfillment(parent);
    const ids = ["line-A", "line-B", "line-C"];
    let last: ReturnType<typeof split.allocate> | undefined;
    for (let i = 0; i < shares.length; i++) {
      last = split.allocate({ child: commit(ids[i]!, shares[i]!.amount, { parent: commitmentId("order-3") }) });
      expect(last.ok).toBe(true);
    }
    expect(last && last.ok && last.complete).toBe(true);
    expect(split.allocatedSoFar().amount).toBeCloseTo(100, 10);
  });

  it("rejects a child in a different currency (no implicit FX)", () => {
    const parent = commit("order-4", 200);
    const split = createSplitFulfillment(parent);
    const eur = { ...newCommitment(buyer, seller, { offered: [], requested: [money(50, "EUR")] }), id: commitmentId("line-eur"), parent: commitmentId("order-4") };
    const res = split.allocate({ child: applyCommitmentPath(eur, { type: "Fulfilled" }, seller) });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.violations[0]?.rule).toBe("I-1");
      expect(res.violations[0]?.message).toContain("EUR");
    }
  });

  it("rejects allocation against a parent with no monetary commitment", () => {
    const parent = { ...newCommitment(buyer, seller, { offered: [], requested: [] }), id: commitmentId("order-5") };
    const split = createSplitFulfillment(parent);
    expect(split.committed).toBeNull();
    const res = split.allocate({ child: commit("line-A", 10, { parent: commitmentId("order-5") }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violations[0]?.rule).toBe("I-1");
  });

  it("accepts a child whose share exactly fills the remaining parent commitment", () => {
    const parent = commit("order-6", 99.99);
    const split = createSplitFulfillment(parent);
    expect(split.allocate({ child: commit("line-A", 49.99, { parent: commitmentId("order-6") }) }).ok).toBe(true);
    const last = split.allocate({ child: commit("line-B", 50.0, { parent: commitmentId("order-6") }) });
    expect(last.ok).toBe(true);
    if (last.ok) {
      expect(last.complete).toBe(true);
      expect(last.remaining.amount).toBe(0);
    }
  });
});
