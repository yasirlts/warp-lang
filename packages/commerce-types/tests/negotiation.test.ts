import { describe, expect, it } from "vitest";

import { guardConcession, negotiate, type ConcessionStep, type NegotiationBounds } from "../src/negotiation.js";
import type { World } from "../src/guard.js";
import { newCommitment, partyId, valueId, type Commitment, type Value } from "../src/primitives.js";

const seller = partyId("seller_1");
const buyer = partyId("buyer_1");

function MAD(amount: number) {
  return { amount, currency: "MAD" };
}

function priced(amount: number): Value {
  return { id: valueId(), form: { kind: "Money", money: MAD(amount) }, quantity: 1, state: { type: "Available" } };
}

/** A Draft deal commitment carrying an opening list price. */
function deal(listPrice = 200): Commitment {
  return newCommitment(seller, buyer, { offered: [], requested: [priced(listPrice)] });
}

function world(c: Commitment): World {
  return { commitments: [c], fulfillments: [], parties: [] };
}

const floor150: NegotiationBounds = { floor: MAD(150) };

describe("guardConcession — over-discount breaks I-1 (the concession budget)", () => {
  it("blocks a counter below the floor with rule + message + fix + bounded alternative", () => {
    const d = deal(200);
    const neg = guardConcession(world(d), d.id, floor150);

    expect(neg.step({ kind: "offer", price: MAD(200), by: seller }).ok).toBe(true);
    expect(neg.step({ kind: "counter", price: MAD(170), by: buyer }).ok).toBe(true); // 30 ≤ 50 budget

    const over = neg.step({ kind: "counter", price: MAD(120), by: buyer }); // 80 > 50 budget
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.violations[0]?.rule).toBe("I-1");
      // the message names the give-back and the budget.
      expect(over.violations[0]?.message).toContain("80");
      expect(over.violations[0]?.message).toContain("50");
      // the fix names the floor.
      expect(over.violations[0]?.fix).toContain("150");
      // planning-oracle: a bounded alternative names the floor and the budget.
      const alt = (over.alternatives ?? []).find((a) => a.to === "Modified");
      expect(alt?.bounded).toContain("150");
      expect(alt?.bounded).toContain("50");
    }
  });

  it("does not advance the world or the standing price on a rejected concession", () => {
    const d = deal(200);
    const neg = guardConcession(world(d), d.id, floor150);
    neg.step({ kind: "offer", price: MAD(200), by: seller });
    neg.step({ kind: "counter", price: MAD(170), by: buyer });

    const before = neg.world.commitments[0]?.state.type;
    const rejected = neg.step({ kind: "counter", price: MAD(120), by: buyer });
    expect(rejected.ok).toBe(false);
    // state unchanged, standing price unchanged, concession unchanged.
    expect(neg.world.commitments[0]?.state.type).toBe(before);
    expect(neg.standingPrice().amount).toBe(170);
    expect(neg.concededSoFar().amount).toBe(30);
  });

  it("accepts a concession exactly at the floor (the full budget, not over it)", () => {
    const d = deal(200);
    const neg = guardConcession(world(d), d.id, floor150);
    neg.step({ kind: "offer", price: MAD(200), by: seller });
    const atFloor = neg.step({ kind: "counter", price: MAD(150), by: buyer }); // discount 50 == budget 50
    expect(atFloor.ok).toBe(true);
    if (atFloor.ok) expect(atFloor.concededSoFar.amount).toBe(50);
  });
});

describe("guardConcession — illegal state moves are rejected by the guard (I-2)", () => {
  it("blocks accept before any offer (Draft → Accepted) with legal alternatives", () => {
    const d = deal(200);
    const neg = guardConcession(world(d), d.id, floor150);

    const illegal = neg.step({ kind: "accept", by: seller }); // no discount, pure state rejection
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) {
      expect(illegal.violations[0]?.rule).toBe("I-2");
      const alts = (illegal.alternatives ?? []).map((a) => a.to);
      expect(alts).toContain("Proposed");
      expect(alts).not.toContain("Accepted");
    }
  });
});

describe("negotiate — a valid sequence completes; a bad one stops at the rejected step", () => {
  it("completes offer → counter → accept within budget and reports the conceded total", () => {
    const d = deal(200);
    const steps: ConcessionStep[] = [
      { kind: "offer", price: MAD(200), by: seller },
      { kind: "counter", price: MAD(160), by: buyer }, // 40 ≤ 50 budget
      { kind: "accept", by: seller },
    ];
    const out = negotiate(world(d), d.id, floor150, steps);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.world.commitments[0]?.state.type).toBe("Accepted");
      expect(out.concededTotal.amount).toBe(40);
      expect(out.results.every((r) => r.ok)).toBe(true);
    }
  });

  it("stops at the first over-discount step and surfaces it as rejected", () => {
    const d = deal(200);
    const steps: ConcessionStep[] = [
      { kind: "offer", price: MAD(200), by: seller },
      { kind: "counter", price: MAD(100), by: buyer }, // 100 > 50 budget — blocked
      { kind: "accept", by: seller }, // never reached
    ];
    const out = negotiate(world(d), d.id, floor150, steps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.rejected.step).toBe(1);
      expect(out.rejected.kind).toBe("counter");
      if (!out.rejected.ok) expect(out.rejected.violations[0]?.rule).toBe("I-1");
      // the world stopped at the offer (Proposed), it did not reach Accepted.
      expect(out.world.commitments[0]?.state.type).toBe("Proposed");
    }
  });
});

describe("guardConcession — bounds and currency guards", () => {
  it("uses bounds.committed over the subject when supplied", () => {
    const d = deal(200);
    // Explicit committed of 100 with a floor of 90 → budget 10.
    const neg = guardConcession(world(d), d.id, { floor: MAD(90), committed: MAD(100) });
    neg.step({ kind: "offer", price: MAD(100), by: seller });
    const over = neg.step({ kind: "counter", price: MAD(80), by: buyer }); // discount 20 > 10
    expect(over.ok).toBe(false);
  });

  it("rejects a concession quoted in a different currency (I-1)", () => {
    const d = deal(200);
    const neg = guardConcession(world(d), d.id, floor150);
    neg.step({ kind: "offer", price: MAD(200), by: seller });
    const mixed = neg.step({ kind: "counter", price: { amount: 170, currency: "EUR" }, by: buyer });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.violations[0]?.rule).toBe("I-1");
  });

  it("throws when the commitment is absent from the world", () => {
    const d = deal(200);
    expect(() => guardConcession(world(d), "missing-id", floor150)).toThrow(/no commitment/);
  });

  it("throws when the floor is above the committed amount", () => {
    const d = deal(200);
    expect(() => guardConcession(world(d), d.id, { floor: MAD(250) })).toThrow(/floor/);
  });
});
