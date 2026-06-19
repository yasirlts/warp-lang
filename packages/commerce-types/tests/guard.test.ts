import { describe, expect, it } from "vitest";

import { guardAction, guardObject, type World } from "../src/guard.js";
import { auditCommerce } from "../src/invariants.js";
import {
  individual,
  newCommitment,
  partyId,
  valueId,
  type Commitment,
  type Party,
  type Value,
} from "../src/primitives.js";
import { applyCommitmentPath, isValidCommitmentTransition } from "../src/transitions.js";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");
const locale = { language: "en", currency: "MAD", jurisdiction: "MA" } as const;

function moneyValue(amount: number, currency: string): Value {
  return {
    id: valueId(),
    form: { kind: "Money", money: { amount, currency } },
    quantity: 1,
    state: { type: "Available" },
  };
}

describe("guardAction — valid moves", () => {
  it("approves a valid transition and returns the resulting world + history", () => {
    const draft = newCommitment(buyer, seller);
    const world: World = { commitments: [draft], fulfillments: [], parties: [] };

    const verdict = guardAction(world, { commitment: draft.id, to: { type: "Proposed" }, actor: buyer });

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      const moved = verdict.next.commitments[0] as Commitment;
      expect(moved.state.type).toBe("Proposed");
      const last = moved.history[moved.history.length - 1];
      expect(last?.from.type).toBe("Draft");
      expect(last?.to.type).toBe("Proposed");
    }
  });

  it("approves a refund of a Fulfilled order (a valid reversal edge)", () => {
    const shipped = applyCommitmentPath(newCommitment(buyer, seller), { type: "Fulfilled" }, seller);
    const world: World = { commitments: [shipped], fulfillments: [], parties: [] };
    const verdict = guardAction(world, {
      commitment: shipped.id,
      to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
      actor: seller,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("guardAction — rejections (composed, not reinvented)", () => {
  it("rejects an invalid edge (reverting a shipped order) citing I-2", () => {
    const shipped = applyCommitmentPath(newCommitment(buyer, seller), { type: "Fulfilled" }, seller);
    const world: World = { commitments: [shipped], fulfillments: [], parties: [] };

    const verdict = guardAction(world, { commitment: shipped.id, to: { type: "Accepted" }, actor: seller });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations[0]?.rule).toBe("I-2");
      expect(verdict.violations[0]?.fix.length).toBeGreaterThan(0);
    }
    // The guard's verdict must MATCH the underlying transition logic directly.
    expect(isValidCommitmentTransition(shipped.state, { type: "Accepted" })).toBe(false);
  });

  it("rejects a valid edge that produces an invariant violation (Accept without capacity) citing I-3", () => {
    // Proposed -> Accepted IS a valid edge, but the initiator's capacity is
    // unverified (can_buy = false), so the resulting world fails I-3.
    const proposed = applyCommitmentPath(newCommitment(buyer, seller), { type: "Proposed" }, buyer);
    const buyerParty: Party = individual(buyer, locale); // unverifiedCapacity → can_buy = false
    const world: World = { commitments: [proposed], fulfillments: [], parties: [buyerParty] };

    // edge is valid…
    expect(isValidCommitmentTransition(proposed.state, { type: "Accepted" })).toBe(true);

    const verdict = guardAction(world, { commitment: proposed.id, to: { type: "Accepted" }, actor: buyer });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === "I-3")).toBe(true);
    }

    // …and the guard's verdict matches auditCommerce run directly on the resulting world.
    const accepted = { ...proposed, state: { type: "Accepted" as const }, history: proposed.history };
    const direct = auditCommerce([accepted], [], [buyerParty]).map((v) => v.invariant);
    expect(direct).toContain("I-3");
  });

  it("rejects an action targeting a commitment not in the world", () => {
    const draft = newCommitment(buyer, seller);
    const world: World = { commitments: [draft], fulfillments: [], parties: [] };
    const verdict = guardAction(world, { commitment: "does_not_exist", to: { type: "Proposed" }, actor: buyer });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations[0]?.rule).toBe("unknown-commitment");
  });
});

describe("guardObject — thin layer over auditCommerce", () => {
  it("approves a clean world", () => {
    const c = newCommitment(buyer, seller, { offered: [], requested: [moneyValue(200, "MAD")] });
    const verdict = guardObject([c], [], []);
    expect(verdict.ok).toBe(true);
    // matches auditCommerce directly
    expect(auditCommerce([c], [], [])).toHaveLength(0);
  });

  it("rejects a mixed-currency world citing I-1, matching auditCommerce", () => {
    const dirty = newCommitment(buyer, seller, {
      offered: [],
      requested: [moneyValue(200, "MAD"), moneyValue(30, "EUR")],
    });
    const verdict = guardObject([dirty], [], []);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.some((v) => v.rule === "I-1")).toBe(true);
    // the guard is composition, not a divergent path:
    expect(auditCommerce([dirty], [], []).map((v) => v.invariant)).toContain("I-1");
  });
});
