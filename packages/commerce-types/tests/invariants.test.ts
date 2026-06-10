import { describe, expect, it } from "vitest";
import {
  auditCommerce,
  checkI1ValueConservation,
  checkI2StateMonotonicity,
  checkI3CapacityVerification,
  checkI4TemporalIntegrity,
  checkI5IdentityPermanence,
  checkI6TreeConsistency,
  type Commitment,
  type CurrencyCode,
  type Fulfillment,
  type PartyCapacity,
  type Value,
  newCommitment,
  newFulfillment,
  partyId,
  unverifiedCapacity,
  valueId,
} from "../src/index.js";

const buyer = partyId("buyer");
const seller = partyId("seller");

function money(amount: number, currency: CurrencyCode): Value {
  return {
    id: valueId(),
    form: { kind: "Money", money: { amount, currency } },
    quantity: 1,
    state: { type: "Available" },
  };
}

function commitment(requested: Value[]): Commitment {
  const c = newCommitment(buyer, seller);
  return { ...c, subject: { offered: [], requested } };
}

describe("I-1 Value Conservation", () => {
  it("flags mixed currencies in one commitment", () => {
    const c = commitment([money(100, "MAD"), money(50, "EUR")]);
    expect(checkI1ValueConservation([c]).length).toBe(1);
  });
  it("passes single-currency commitments", () => {
    const c = commitment([money(100, "MAD"), money(50, "MAD")]);
    expect(checkI1ValueConservation([c])).toEqual([]);
  });
});

describe("I-2 State Monotonicity", () => {
  it("flags an invalid transition recorded in history", () => {
    const c = commitment([money(100, "MAD")]);
    c.history.push({ from: { type: "Fulfilled" }, to: { type: "Accepted" }, at: "2026-01-01T00:00:00.000Z", actor: buyer });
    expect(checkI2StateMonotonicity(c).length).toBe(1);
  });
  it("passes a valid history", () => {
    const c = commitment([money(100, "MAD")]);
    c.history.push({ from: { type: "Draft" }, to: { type: "Proposed" }, at: "2026-01-01T00:00:00.000Z", actor: buyer });
    expect(checkI2StateMonotonicity(c)).toEqual([]);
  });
});

describe("I-3 Capacity Verification", () => {
  const accepted = (): Commitment => ({ ...commitment([money(100, "MAD")]), state: { type: "Accepted" } });
  it("flags Accepted without buy capacity", () => {
    const cap: PartyCapacity = { ...unverifiedCapacity(), can_buy: false };
    expect(checkI3CapacityVerification(accepted(), cap).length).toBe(1);
  });
  it("passes when capacity verified", () => {
    const cap: PartyCapacity = { ...unverifiedCapacity(), can_buy: true };
    expect(checkI3CapacityVerification(accepted(), cap)).toEqual([]);
  });
});

describe("I-4 Temporal Integrity", () => {
  it("flags fulfillment starting before commitment Accepted", () => {
    const c = commitment([money(100, "MAD")]);
    c.history.push({ from: { type: "Proposed" }, to: { type: "Accepted" }, at: "2026-06-10T12:00:00.000Z", actor: seller });
    const f: Fulfillment = { ...newFulfillment(c.id), state: { type: "InProgress" }, started_at: "2026-06-10T09:00:00.000Z" };
    expect(checkI4TemporalIntegrity(c, [f]).length).toBe(1);
  });
  it("passes when fulfillment follows acceptance", () => {
    const c = commitment([money(100, "MAD")]);
    c.history.push({ from: { type: "Proposed" }, to: { type: "Accepted" }, at: "2026-06-10T09:00:00.000Z", actor: seller });
    const f: Fulfillment = { ...newFulfillment(c.id), state: { type: "InProgress" }, started_at: "2026-06-10T12:00:00.000Z" };
    expect(checkI4TemporalIntegrity(c, [f])).toEqual([]);
  });
});

describe("I-5 Identity Permanence", () => {
  it("flags a duplicate id", () => {
    expect(checkI5IdentityPermanence(["a", "a", "b"]).length).toBe(1);
  });
  it("passes unique ids", () => {
    expect(checkI5IdentityPermanence(["a", "b", "c"])).toEqual([]);
  });
});

describe("I-6 Commitment Tree Consistency", () => {
  it("flags children exceeding parent", () => {
    const parent = commitment([money(500, "MAD")]);
    const kids = [commitment([money(300, "MAD")]), commitment([money(300, "MAD")])];
    expect(checkI6TreeConsistency(parent, kids).length).toBe(1);
  });
  it("passes when children sum to parent", () => {
    const parent = commitment([money(500, "MAD")]);
    const kids = [commitment([money(250, "MAD")]), commitment([money(250, "MAD")])];
    expect(checkI6TreeConsistency(parent, kids)).toEqual([]);
  });
});

describe("auditCommerce", () => {
  it("aggregates violations across checks", () => {
    const c = commitment([money(100, "MAD"), money(5, "EUR")]); // I-1 mix
    const violations = auditCommerce([c], [], []);
    expect(violations.some((v) => v.invariant === "I-1")).toBe(true);
  });
  it("returns empty for a clean set", () => {
    const c = commitment([money(100, "MAD")]);
    expect(auditCommerce([c], [], [])).toEqual([]);
  });
});
