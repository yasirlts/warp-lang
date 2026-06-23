import { describe, expect, it } from "vitest";

import { createSession } from "../src/session.js";
import { commitmentVersion, type World } from "../src/guard.js";
import { checkI6TreeConsistency } from "../src/invariants.js";
import { commitmentId, newCommitment, partyId, valueId, type Commitment, type Value } from "../src/primitives.js";
import { applyCommitmentPath } from "../src/transitions.js";

const buyer = partyId("buyer");
const seller = partyId("seller");

function moneyValue(amount: number): Value {
  return { id: valueId(), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } };
}

/** A Fulfilled commitment with id/amount and optional parent/children links. */
function commit(id: string, amount: number, links: Partial<Pick<Commitment, "parent" | "children">> = {}): Commitment {
  const base = { ...newCommitment(buyer, seller, { offered: [], requested: [moneyValue(amount)] }), id: commitmentId(id), ...links };
  return applyCommitmentPath(base, { type: "Fulfilled" }, seller);
}

/** A parent (200) with two 100-children that reconcile via I-6. */
function tree(parentId = "order-1"): Commitment[] {
  const a = `${parentId}-A`;
  const b = `${parentId}-B`;
  return [
    commit(parentId, 200, { children: [commitmentId(a), commitmentId(b)] }),
    commit(a, 100, { parent: commitmentId(parentId) }),
    commit(b, 100, { parent: commitmentId(parentId) }),
  ];
}

function refund(commitment: string, amount: number, key: string) {
  return { commitment, to: { type: "Refunded" as const, amount: { amount, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor: seller, idempotencyKey: key };
}

describe("createSession — multi-object coherence (per-tree cumulative)", () => {
  it("catches a cumulative over-refund spread across the tree (the gap)", () => {
    const [parent, a, b] = tree();
    expect(checkI6TreeConsistency(parent!, [a!, b!])).toHaveLength(0); // I-6 reconciles
    const session = createSession({ commitments: [parent!, a!, b!], fulfillments: [], parties: [] });

    expect(session.propose(refund("order-1-A", 80, "a")).ok).toBe(true); // child ≤ 100
    expect(session.propose(refund("order-1-B", 80, "b")).ok).toBe(true); // child ≤ 100
    const over = session.propose(refund("order-1", 80, "p")); // parent ≤ 200, but tree → 240
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.violations[0]?.rule).toBe("I-1");
      expect(over.violations[0]?.message).toContain("tree");
      expect(over.violations[0]?.message).toContain("240");
      expect(over.violations[0]?.message).toContain("200");
      const alt = (over.alternatives ?? []).find((x) => x.to === "Refunded");
      expect(alt?.bounded).toContain("40"); // remaining across the tree
    }
  });

  it("each child refund is individually valid (≤ its own committed) yet the tree caps the sum", () => {
    const [parent, a, b] = tree();
    const session = createSession({ commitments: [parent!, a!, b!], fulfillments: [], parties: [] });
    // child refunds within their own committed (100) are fine…
    expect(session.propose(refund("order-1-A", 100, "a")).ok).toBe(true);
    expect(session.propose(refund("order-1-B", 100, "b")).ok).toBe(true);
    // …but the tree is now fully refunded; any further refund anywhere in it is capped.
    const more = session.propose(refund("order-1", 1, "p"));
    expect(more.ok).toBe(false);
  });

  it("a child over-refund is still caught per-commitment (per-child cap intact)", () => {
    const [parent, a, b] = tree();
    const session = createSession({ commitments: [parent!, a!, b!], fulfillments: [], parties: [] });
    // child-A committed 100; refunding 150 against it exceeds the CHILD itself.
    const over = session.propose(refund("order-1-A", 150, "a"));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.violations[0]?.rule).toBe("I-1");
  });

  it("single-commitment (no tree) behaviour is unchanged", () => {
    const standalone = commit("solo", 200); // no parent, no children
    const session = createSession({ commitments: [standalone], fulfillments: [], parties: [] });
    expect(session.propose(refund("solo", 120, "a")).ok).toBe(true);
    const over = session.propose(refund("solo", 100, "b")); // 220 > 200 — per-commitment
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.violations[0]?.rule).toBe("I-1");
      // standalone message is the per-commitment form (not the tree form).
      expect(over.violations[0]?.message).not.toContain("tree");
    }
  });

  it("a valid tree of refunds within the parent completes", () => {
    const [parent, a, b] = tree();
    const session = createSession({ commitments: [parent!, a!, b!], fulfillments: [], parties: [] });
    expect(session.propose(refund("order-1-A", 100, "a")).ok).toBe(true);
    expect(session.propose(refund("order-1-B", 100, "b")).ok).toBe(true);
    // both children fully refunded; the tree total (200) equals the parent committed.
  });

  it("F4 replay across the tree dedups (tree ledger not double-counted)", () => {
    const [parent, a, b] = tree();
    const session = createSession({ commitments: [parent!, a!, b!], fulfillments: [], parties: [] });
    expect(session.propose(refund("order-1-A", 80, "k")).ok).toBe(true);
    const replay = session.propose(refund("order-1-A", 80, "k")); // same key
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replay).toBe(true);
    // tree not double-counted: a further 120 still fits (80 + 120 = 200).
    expect(session.propose(refund("order-1-B", 120, "b")).ok).toBe(false); // child-B committed only 100
    expect(session.propose(refund("order-1-B", 100, "b2")).ok).toBe(true); // 80 + 100 = 180 ≤ 200
  });

  it("F3 conflict on a child still works (stale version)", () => {
    const acceptedChild = applyCommitmentPath({ ...newCommitment(buyer, seller, { offered: [], requested: [moneyValue(100)] }), id: commitmentId("c-1"), parent: commitmentId("p-1") }, { type: "Accepted" }, seller);
    const parent = commit("p-1", 200, { children: [commitmentId("c-1"), commitmentId("c-2")] });
    const sibling = commit("c-2", 100, { parent: commitmentId("p-1") });
    const session = createSession({ commitments: [parent, acceptedChild, sibling], fulfillments: [], parties: [] });
    const planned = commitmentVersion(session.world.commitments.find((c) => (c.id as string) === "c-1")!);
    // advance the child…
    expect(session.propose({ commitment: "c-1", to: { type: "Active" }, actor: seller, expectedVersion: planned, idempotencyKey: "x" }).ok).toBe(true);
    // …a stale-version action on the same child conflicts.
    const stale = session.propose({ commitment: "c-1", to: { type: "Disputed", by: buyer, reason: "x", opened_at: "2026-03-01T00:00:00.000Z" }, actor: buyer, expectedVersion: planned, idempotencyKey: "y" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.conflict).toBe(true);
  });
});
