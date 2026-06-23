import { describe, expect, it } from "vitest";

import { createMultiAgentSession } from "../src/multi-agent.js";
import { commitmentVersion } from "../src/guard.js";
import { newCommitment, partyId, valueId, type Value } from "../src/primitives.js";
import { applyCommitmentPath } from "../src/transitions.js";

const buyer = partyId("buyer");
const seller = partyId("seller");

function moneyValue(amount: number): Value {
  return { id: valueId(), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } };
}

function fulfilledOrder(amount: number) {
  return applyCommitmentPath(newCommitment(buyer, seller, { offered: [], requested: [moneyValue(amount)] }), { type: "Fulfilled" }, seller);
}

function refund(commitment: string, amount: number, actor: string, key: string) {
  return { commitment, to: { type: "Refunded" as const, amount: { amount, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor, idempotencyKey: key };
}

describe("createMultiAgentSession — shared-world enforcement with attribution", () => {
  it("catches a cumulative violation across DIFFERENT actors, attributed to the tipping actor", () => {
    const order = fulfilledOrder(200);
    const id = String(order.id);
    const session = createMultiAgentSession({ commitments: [order], fulfillments: [], parties: [] });

    expect(session.propose(refund(id, 80, "agent-A", "a")).ok).toBe(true);
    expect(session.propose(refund(id, 80, "agent-B", "b")).ok).toBe(true);
    const third = session.propose(refund(id, 80, "agent-C", "c"));
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.violations[0]?.rule).toBe("I-1");
      // attribution names the tipping actor (agent-C), applied after the others.
      expect(third.actor).toBe("agent-C");
      expect(third.attribution).toContain("agent-C");
      expect(third.attribution).toContain("agent-A");
      expect(third.attribution).toContain("agent-B");
      expect(third.attribution).not.toContain("conspir"); // NOT collusion
    }
    // the world did not advance past the two accepted refunds.
    expect(session.refundedSoFar(id)?.amount).toBe(160);
  });

  it("attributes to the right actor regardless of which one tips it", () => {
    const order = fulfilledOrder(200);
    const id = String(order.id);
    const session = createMultiAgentSession({ commitments: [order], fulfillments: [], parties: [] });
    session.propose(refund(id, 120, "finance-agent", "f"));
    const tip = session.propose(refund(id, 100, "support-agent", "s")); // 220 > 200
    expect(tip.ok).toBe(false);
    if (!tip.ok) {
      expect(tip.actor).toBe("support-agent");
      expect(tip.attribution).toContain("finance-agent"); // the accumulated context
    }
  });

  it("a single-actor session behaves identically (attribution is additive)", () => {
    const order = fulfilledOrder(200);
    const id = String(order.id);
    const session = createMultiAgentSession({ commitments: [order], fulfillments: [], parties: [] });
    // Same actor does all three — still caught at the third (attribution just names that actor).
    expect(session.propose(refund(id, 80, "solo", "a")).ok).toBe(true);
    expect(session.propose(refund(id, 80, "solo", "b")).ok).toBe(true);
    const third = session.propose(refund(id, 80, "solo", "c"));
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.actor).toBe("solo");
      expect(third.attribution).toContain("no prior actions"); // no OTHER actors
    }
  });

  it("a valid multi-agent sequence completes, with a per-actor summary", () => {
    const draft = newCommitment(buyer, seller);
    const id = String(draft.id);
    const session = createMultiAgentSession({ commitments: [draft], fulfillments: [], parties: [] });
    expect(session.propose({ commitment: id, to: { type: "Proposed" }, actor: "buyer-agent" }).ok).toBe(true);
    expect(session.propose({ commitment: id, to: { type: "Accepted" }, actor: "seller-agent" }).ok).toBe(true);
    expect(session.propose({ commitment: id, to: { type: "Active" }, actor: "ops-agent" }).ok).toBe(true);
    expect(session.world.commitments[0]?.state.type).toBe("Active");
    expect(session.actorsSummary()).toEqual({ "buyer-agent": 1, "seller-agent": 1, "ops-agent": 1 });
    expect(session.log.map((r) => r.actor)).toEqual(["buyer-agent", "seller-agent", "ops-agent"]);
  });

  it("an F3 stale-version conflict between two agents is attributed to the late actor", () => {
    const order = applyCommitmentPath(newCommitment(buyer, seller), { type: "Accepted" }, seller);
    const id = String(order.id);
    const session = createMultiAgentSession({ commitments: [order], fulfillments: [], parties: [] });
    const planned = commitmentVersion(session.world.commitments[0]!);

    // agent-A advances the commitment.
    expect(session.propose({ commitment: id, to: { type: "Active" }, actor: "agent-A", expectedVersion: planned, idempotencyKey: "A" }).ok).toBe(true);
    // agent-B planned against the stale version → conflict, attributed to agent-B.
    const b = session.propose({ commitment: id, to: { type: "Disputed", by: buyer, reason: "x", opened_at: "2026-03-01T00:00:00.000Z" }, actor: "agent-B", expectedVersion: planned, idempotencyKey: "B" });
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.conflict).toBe(true);
      expect(b.actor).toBe("agent-B");
      expect(b.attribution).toContain("conflict");
    }
  });

  it("an F4 replay by the same actor is a replay and is not double-logged", () => {
    const order = fulfilledOrder(200);
    const id = String(order.id);
    const session = createMultiAgentSession({ commitments: [order], fulfillments: [], parties: [] });
    const first = session.propose(refund(id, 50, "agent-A", "k"));
    expect(first.ok).toBe(true);
    const retry = session.propose(refund(id, 50, "agent-A", "k"));
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.replay).toBe(true);
    // logged once (the replay applied nothing new); refunded once.
    expect(session.actorsSummary()).toEqual({ "agent-A": 1 });
    expect(session.refundedSoFar(id)?.amount).toBe(50);
  });
});
