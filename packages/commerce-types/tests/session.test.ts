import { describe, expect, it } from "vitest";

import { createSession } from "../src/session.js";
import type { World } from "../src/guard.js";
import { newCommitment, partyId, valueId, type Value } from "../src/primitives.js";
import { applyCommitmentPath } from "../src/transitions.js";
import type { CommitmentState } from "../src/states.js";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

function moneyValue(amount: number, currency: string): Value {
  return { id: valueId(), form: { kind: "Money", money: { amount, currency } }, quantity: 1, state: { type: "Available" } };
}

/** A Fulfilled order committed at `amount` MAD. */
function fulfilledOrder(amount: number) {
  return applyCommitmentPath(
    newCommitment(buyer, seller, { offered: [], requested: [moneyValue(amount, "MAD")] }),
    { type: "Fulfilled" },
    seller,
  );
}

function refund(
  commitment: string,
  amount: number,
  idempotencyKey?: string,
): { commitment: string; to: CommitmentState; actor: string; idempotencyKey?: string } {
  return {
    commitment,
    to: { type: "Refunded", amount: { amount, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
    actor: seller,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

describe("createSession — cumulative over-refund (the cross-step gap)", () => {
  it("catches 3×80 against a 200 order at the third refund (each alone passes)", () => {
    const order = fulfilledOrder(200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });

    // Three DISTINCT partial refunds — distinct keys so they accumulate (a retry
    // with the same key would instead be deduped; see the idempotency tests).
    expect(session.propose(refund(order.id, 80, "r1")).ok).toBe(true); // 80 ≤ 200
    expect(session.propose(refund(order.id, 80, "r2")).ok).toBe(true); // 160 ≤ 200
    const third = session.propose(refund(order.id, 80, "r3")); // 240 > 200 — cumulative
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.violations[0]?.rule).toBe("I-1");
      // the message names the running total vs committed.
      expect(third.violations[0]?.message).toContain("240");
      expect(third.violations[0]?.message).toContain("200");
      // planning-oracle: a bounded Refunded alternative names the remaining refundable.
      const refundAlt = (third.alternatives ?? []).find((a) => a.to === "Refunded");
      expect(refundAlt?.bounded).toContain("40");
    }
  });

  it("does NOT advance the ledger or world on a rejected refund", () => {
    const order = fulfilledOrder(200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    session.propose(refund(order.id, 80, "r1"));
    session.propose(refund(order.id, 80, "r2"));
    const before = session.refundedSoFar(order.id);
    expect(before?.amount).toBe(160);

    const rejected = session.propose(refund(order.id, 80, "r3"));
    expect(rejected.ok).toBe(false);
    // unchanged: the rejected refund is not counted.
    expect(session.refundedSoFar(order.id)?.amount).toBe(160);
    expect(session.world.commitments[0]?.state.type).toBe("Fulfilled");
  });

  it("the point-in-time guard would NOT catch this — proving the session adds coverage", () => {
    // Each individual 80 refund, viewed alone against a 200 order, is valid.
    // The session is what accumulates; a single check cannot see the sum.
    const order = fulfilledOrder(200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    // Two accepted (cumulative 160 ≤ 200), the third rejected (240 > 200).
    const verdicts = [80, 80, 80].map((a, i) => session.propose(refund(order.id, a, `r${i}`)).ok);
    expect(verdicts).toEqual([true, true, false]);
  });
});

describe("createSession — valid sessions complete", () => {
  it("a single full refund (200 of 200) is accepted and moves the order to Refunded", () => {
    const order = fulfilledOrder(200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    const v = session.propose(refund(order.id, 200));
    expect(v.ok).toBe(true);
    expect(session.world.commitments[0]?.state.type).toBe("Refunded");
    expect(session.refundedSoFar(order.id)?.amount).toBe(200);
  });

  it("partial refunds that sum exactly to committed (120 + 80) complete the order", () => {
    const order = fulfilledOrder(200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    expect(session.propose(refund(order.id, 120)).ok).toBe(true);
    expect(session.world.commitments[0]?.state.type).toBe("Fulfilled"); // partial — stays Fulfilled
    expect(session.propose(refund(order.id, 80)).ok).toBe(true); // reaches 200
    expect(session.world.commitments[0]?.state.type).toBe("Refunded"); // full — now Refunded
  });
});

describe("createSession — ordering (refund before capture)", () => {
  it("rejects a refund on an order that was never fulfilled, with the legal alternatives", () => {
    const draft = newCommitment(buyer, seller, { offered: [], requested: [moneyValue(200, "MAD")] });
    const session = createSession({ commitments: [draft], fulfillments: [], parties: [] });
    const v = session.propose(refund(draft.id, 50));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      // Refunded is not reachable from Draft — composes guardAction's transition check.
      expect(v.violations[0]?.rule).toBe("I-2");
      // planning oracle: the legal moves from Draft, NOT a refund.
      const tos = (v.alternatives ?? []).map((a) => a.to);
      expect(tos).toEqual(["Proposed", "Tendered", "Cancelled"]);
    }
    // world unchanged.
    expect(session.world.commitments[0]?.state.type).toBe("Draft");
  });
});

describe("createSession — non-refund actions compose guardAction", () => {
  it("advances the world on an accepted non-refund move, and not on a rejected one", () => {
    const draft = newCommitment(buyer, seller);
    const world: World = { commitments: [draft], fulfillments: [], parties: [] };
    const session = createSession(world);

    const ok = session.propose({ commitment: draft.id, to: { type: "Proposed" }, actor: buyer });
    expect(ok.ok).toBe(true);
    expect(session.world.commitments[0]?.state.type).toBe("Proposed");

    // an invalid move does not advance the world.
    const bad = session.propose({ commitment: draft.id, to: { type: "Fulfilled" }, actor: buyer });
    expect(bad.ok).toBe(false);
    expect(session.world.commitments[0]?.state.type).toBe("Proposed");
  });
});

describe("createSession — idempotency & replay-safety", () => {
  it("a same-key retry is a no-op reporting the original outcome (no double refund)", () => {
    const order = fulfilledOrder(200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });

    const first = session.propose(refund(order.id, 50, "rk-1"));
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.replay).not.toBe(true); // first application, not a replay
    expect(session.refundedSoFar(order.id)?.amount).toBe(50);

    const retry = session.propose(refund(order.id, 50, "rk-1"));
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.replay).toBe(true); // recognized as a replay
    // the headline: the retry did NOT refund again.
    expect(session.refundedSoFar(order.id)?.amount).toBe(50);
  });

  it("a new key applies normally", () => {
    const order = fulfilledOrder(200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    session.propose(refund(order.id, 50, "rk-1"));
    const second = session.propose(refund(order.id, 30, "rk-2"));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.replay).not.toBe(true);
    expect(session.refundedSoFar(order.id)?.amount).toBe(80);
  });

  it("distinct refunds still accumulate; the same refund retried does NOT inflate the tally", () => {
    const order = fulfilledOrder(200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    // Two distinct 80s accumulate to 160…
    expect(session.propose(refund(order.id, 80, "a")).ok).toBe(true);
    expect(session.propose(refund(order.id, 80, "b")).ok).toBe(true);
    expect(session.refundedSoFar(order.id)?.amount).toBe(160);
    // …retrying the first (same key "a") is a replay — the tally stays 160, NOT 240.
    const replay = session.propose(refund(order.id, 80, "a"));
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replay).toBe(true);
    expect(session.refundedSoFar(order.id)?.amount).toBe(160);
  });

  it("derived-fingerprint fallback dedups an identical keyless retry", () => {
    const order = fulfilledOrder(200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    const first = session.propose(refund(order.id, 40)); // no key
    expect(first.ok).toBe(true);
    const retry = session.propose(refund(order.id, 40)); // identical, no key → same fingerprint
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.replay).toBe(true);
    expect(session.refundedSoFar(order.id)?.amount).toBe(40); // counted once
  });

  it("a replay does not advance the world", () => {
    const order = fulfilledOrder(200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    // Full refund moves the order to Refunded.
    session.propose(refund(order.id, 200, "full"));
    expect(session.world.commitments[0]?.state.type).toBe("Refunded");
    const worldBefore = session.world;
    // Retrying the full refund is a replay — same world object, no re-transition.
    const replay = session.propose(refund(order.id, 200, "full"));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.replay).toBe(true);
      expect(replay.next).toBe(worldBefore);
    }
  });
});
