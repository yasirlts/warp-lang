import { describe, expect, it } from "vitest";

import { commitmentVersion, guardAction, guardObject, type World } from "../src/guard.js";
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
import { applyCommitmentPath, isValidCommitmentTransition, validTransitions } from "../src/transitions.js";

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

  it("rejects an over-refund (refund exceeds the committed amount) citing I-1", () => {
    // The visceral unsafe action: an agent refunds MORE than was ever captured.
    // Fulfilled→Refunded IS a valid edge, but refunding 500 MAD against a 200 MAD
    // commitment creates value from nothing — the resulting world fails I-1's
    // amount-conservation clause. The guard catches it for free via composition.
    const order = newCommitment(buyer, seller, { offered: [], requested: [moneyValue(200, "MAD")] });
    const shipped = applyCommitmentPath(order, { type: "Fulfilled" }, seller);
    const world: World = { commitments: [shipped], fulfillments: [], parties: [] };

    // the edge itself is valid…
    expect(
      isValidCommitmentTransition(shipped.state, {
        type: "Refunded",
        amount: { amount: 500, currency: "MAD" },
        at: "2026-02-01T00:00:00.000Z",
      }),
    ).toBe(true);

    const verdict = guardAction(world, {
      commitment: shipped.id,
      to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
      actor: seller,
    });

    // …but the resulting world over-refunds, so the guard rejects citing I-1.
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === "I-1")).toBe(true);
      expect(verdict.violations.find((v) => v.rule === "I-1")?.fix.length).toBeGreaterThan(0);
    }
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

  it("rejects an over-refunded world citing I-1, matching auditCommerce", () => {
    const shipped = applyCommitmentPath(
      newCommitment(buyer, seller, { offered: [], requested: [moneyValue(200, "MAD")] }),
      { type: "Fulfilled" },
      seller,
    );
    const overRefunded: Commitment = {
      ...shipped,
      state: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
    };
    const verdict = guardObject([overRefunded], [], []);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.some((v) => v.rule === "I-1")).toBe(true);
    // composition, not a divergent path:
    expect(auditCommerce([overRefunded], [], []).map((v) => v.invariant)).toContain("I-1");
  });
});

describe("guardAction — planning oracle (alternatives on rejection)", () => {
  it("an invalid transition returns the legal moves from the current state", () => {
    const shipped = applyCommitmentPath(newCommitment(buyer, seller), { type: "Fulfilled" }, seller);
    const world: World = { commitments: [shipped], fulfillments: [], parties: [] };

    const verdict = guardAction(world, { commitment: shipped.id, to: { type: "Accepted" }, actor: seller });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations[0]?.rule).toBe("I-2");
      // alternatives are EXACTLY the table's legal moves from Fulfilled.
      const tos = (verdict.alternatives ?? []).map((a) => a.to);
      expect(tos).toEqual(validTransitions({ type: "Fulfilled" }));
      expect(tos).toEqual(["Disputed", "Refunded"]);
      // each carries a short label; none of these is bounded (the move itself is clean).
      expect(verdict.alternatives?.every((a) => a.label.length > 0)).toBe(true);
      expect(verdict.alternatives?.every((a) => a.bounded === undefined)).toBe(true);
      // the human summary in fix echoes the structured list.
      expect(verdict.violations[0]?.fix).toContain("Disputed");
    }
  });

  it("an agent can pick a returned alternative and the retry succeeds", () => {
    const shipped = applyCommitmentPath(newCommitment(buyer, seller), { type: "Fulfilled" }, seller);
    const world: World = { commitments: [shipped], fulfillments: [], parties: [] };

    const rejected = guardAction(world, { commitment: shipped.id, to: { type: "Accepted" }, actor: seller });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      const choice = (rejected.alternatives ?? []).find((a) => a.bounded === undefined);
      expect(choice).toBeDefined();
      if (choice) {
        const retry = guardAction(world, { commitment: shipped.id, to: { type: choice.to } as never, actor: seller });
        expect(retry.ok).toBe(true);
      }
    }
  });

  it("over-refund frames Refunded as reachable-but-bounded, not a clean alternative", () => {
    const order = newCommitment(buyer, seller, { offered: [], requested: [moneyValue(200, "MAD")] });
    const shipped = applyCommitmentPath(order, { type: "Fulfilled" }, seller);
    const world: World = { commitments: [shipped], fulfillments: [], parties: [] };

    const verdict = guardAction(world, {
      commitment: shipped.id,
      to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
      actor: seller,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === "I-1")).toBe(true);
      const refundAlt = (verdict.alternatives ?? []).find((a) => a.to === "Refunded");
      const disputeAlt = (verdict.alternatives ?? []).find((a) => a.to === "Disputed");
      // Refunded IS a legal transition — but bounded by the amount that just failed.
      expect(refundAlt?.bounded).toBeDefined();
      expect(refundAlt?.bounded).toContain("at most");
      // Disputed is a different legal move and is NOT falsely marked bounded.
      expect(disputeAlt?.bounded).toBeUndefined();
    }
  });

  it("a terminal-state action returns no alternatives (the table row is empty)", () => {
    const refunded = applyCommitmentPath(
      newCommitment(buyer, seller),
      { type: "Refunded", amount: { amount: 0, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
      seller,
    );
    const world: World = { commitments: [refunded], fulfillments: [], parties: [] };

    const verdict = guardAction(world, { commitment: refunded.id, to: { type: "Disputed", by: seller, reason: "x", opened_at: "2026-03-01T00:00:00.000Z" }, actor: seller });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations[0]?.rule).toBe("I-2");
      expect(verdict.alternatives).toEqual([]);
      expect(validTransitions({ type: "Refunded", amount: { amount: 0, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" })).toEqual([]);
    }
  });

  it("is backward-compatible: a rejection still carries violations (alternatives is additive)", () => {
    const shipped = applyCommitmentPath(newCommitment(buyer, seller), { type: "Fulfilled" }, seller);
    const world: World = { commitments: [shipped], fulfillments: [], parties: [] };
    const verdict = guardAction(world, { commitment: shipped.id, to: { type: "Accepted" }, actor: seller });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.length).toBeGreaterThan(0);
  });
});

describe("guardAction — optimistic-conflict (expectedVersion)", () => {
  it("commitmentVersion advances when the commitment's state/history changes", () => {
    const accepted = applyCommitmentPath(newCommitment(buyer, seller), { type: "Accepted" }, seller);
    const v1 = commitmentVersion(accepted);
    const world: World = { commitments: [accepted], fulfillments: [], parties: [] };
    const moved = guardAction(world, { commitment: accepted.id, to: { type: "Active" }, actor: seller });
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      const v2 = commitmentVersion(moved.next.commitments[0]!);
      expect(v2).not.toBe(v1);
    }
  });

  it("a matching expectedVersion applies; a stale one is a CONFLICT (not applied)", () => {
    const accepted = applyCommitmentPath(newCommitment(buyer, seller), { type: "Accepted" }, seller);
    const world: World = { commitments: [accepted], fulfillments: [], parties: [] };
    const current = commitmentVersion(accepted);

    // matching version → applies
    expect(guardAction(world, { commitment: accepted.id, to: { type: "Active" }, actor: seller, expectedVersion: current }).ok).toBe(true);

    // stale version → conflict
    const stale = guardAction(world, { commitment: accepted.id, to: { type: "Active" }, actor: seller, expectedVersion: "0:Draft" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.conflict).toBe(true);
      expect(stale.expected).toBe("0:Draft");
      expect(stale.actual).toBe(current);
      expect(stale.violations[0]?.rule).toBe("version-conflict");
    }
  });

  it("no expectedVersion is backward-compatible", () => {
    const accepted = applyCommitmentPath(newCommitment(buyer, seller), { type: "Accepted" }, seller);
    const world: World = { commitments: [accepted], fulfillments: [], parties: [] };
    expect(guardAction(world, { commitment: accepted.id, to: { type: "Active" }, actor: seller }).ok).toBe(true);
  });
});
