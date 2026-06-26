import { describe, expect, it } from "vitest";

import { createWindowedSession } from "../src/window.js";
import { commitmentVersion, type World } from "../src/guard.js";
import { newCommitment, partyId, valueId, type Value } from "../src/primitives.js";
import { applyCommitmentPath } from "../src/transitions.js";
import type { CommitmentState } from "../src/states.js";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

function moneyValue(amount: number, currency: string): Value {
  return { id: valueId(), form: { kind: "Money", money: { amount, currency } }, quantity: 1, state: { type: "Available" } };
}

/** A Fulfilled order committed at `amount` MAD (the large lifetime ceiling). */
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

const world = (...commitments: ReturnType<typeof fulfilledOrder>[]): World => ({
  commitments,
  fulfillments: [],
  parties: [],
});

describe("createWindowedSession — count window accumulates and caps", () => {
  it("caps a burst inside the last-N window that the point-in-time check misses", () => {
    // Lifetime ceiling is 1000 (so the lifetime cumulative check is NOT what bites);
    // the window cap is 150 across the last 3 refund events.
    const order = fulfilledOrder(1000);
    const ws = createWindowedSession(world(order), {
      window: { kind: "count", lastN: 3 },
      cap: { amount: 150, currency: "MAD" },
    });

    // Each 60 refund is individually valid (60 ≤ 1000) and the lifetime sum stays
    // far under 1000 — only the WINDOW catches the cluster.
    expect(ws.propose(refund(order.id, 60, "r1")).ok).toBe(true); // window 60
    expect(ws.propose(refund(order.id, 60, "r2")).ok).toBe(true); // window 120
    const third = ws.propose(refund(order.id, 60, "r3")); // window would be 180 > 150
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.violations[0]?.rule).toBe("I-1");
      expect(third.violations[0]?.message).toContain("180");
      expect(third.violations[0]?.message).toContain("150");
      const alt = (third.alternatives ?? []).find((a) => a.to === "Refunded");
      expect(alt?.bounded).toContain("30"); // 150 − 120 remaining in-window
    }
  });

  it("a rejected windowed refund does not advance the world or the lifetime ledger", () => {
    const order = fulfilledOrder(1000);
    const ws = createWindowedSession(world(order), {
      window: { kind: "count", lastN: 3 },
      cap: { amount: 150, currency: "MAD" },
    });
    ws.propose(refund(order.id, 60, "r1"));
    ws.propose(refund(order.id, 60, "r2"));
    expect(ws.refundedSoFar(order.id)?.amount).toBe(120);

    const rejected = ws.propose(refund(order.id, 60, "r3"));
    expect(rejected.ok).toBe(false);
    // unchanged — the rejected refund touched neither the window nor the inner session.
    expect(ws.refundedSoFar(order.id)?.amount).toBe(120);
    expect(ws.windowState(order.id).inWindow.amount).toBe(120);
    expect(ws.world.commitments[0]?.state.type).toBe("Fulfilled");
  });

  it("events outside the window age out so headroom returns", () => {
    // Window of the last 2 events, cap 150. Two 80s fill the window (160 > 150 would
    // reject), but with lastN=2 the third 80 ages the FIRST out: window becomes the
    // 2nd (80) + the new (80) = 160 — still over. Use lastN=2, cap 150, amounts that
    // demonstrate aging cleanly: 100, then 100 over cap at once, then after aging ok.
    const order = fulfilledOrder(1000);
    const ws = createWindowedSession(world(order), {
      window: { kind: "count", lastN: 2 },
      cap: { amount: 150, currency: "MAD" },
    });
    expect(ws.propose(refund(order.id, 100, "a1")).ok).toBe(true); // window [100] = 100
    // second 100 would make window [100,100] = 200 > 150 → reject
    expect(ws.propose(refund(order.id, 100, "a2")).ok).toBe(false);
    // a smaller second refund fits: window [100, 40] = 140 ≤ 150
    expect(ws.propose(refund(order.id, 40, "a3")).ok).toBe(true);
    expect(ws.windowState(order.id).inWindow.amount).toBe(140); // last 2: 100 + 40
    // a third refund of 40: lastN=2 ages the FIRST 100 out → window [40, 40] = 80 ≤ 150
    expect(ws.propose(refund(order.id, 40, "a4")).ok).toBe(true);
    expect(ws.windowState(order.id).inWindow.amount).toBe(80); // last 2: 40 + 40
  });
});

describe("createWindowedSession — time window ages out", () => {
  it("caps refunds inside a time span and frees headroom once they age out", () => {
    const order = fulfilledOrder(1000);
    const ws = createWindowedSession(world(order), {
      window: { kind: "time", withinMs: 1000 },
      cap: { amount: 150, currency: "MAD" },
    });
    const t0 = 1_000_000;
    expect(ws.propose(refund(order.id, 100, "t1"), t0).ok).toBe(true); // window 100
    // 200ms later, another 100 → window 200 > 150 within 1000ms → reject
    expect(ws.propose(refund(order.id, 100, "t2"), t0 + 200).ok).toBe(false);
    // 1500ms after t0, the first refund (at t0) is outside the 1000ms window → headroom back
    expect(ws.propose(refund(order.id, 100, "t3"), t0 + 1500).ok).toBe(true);
    // as of t0+1500, only the t3 refund is in-window
    expect(ws.windowState(order.id, t0 + 1500).inWindow.amount).toBe(100);
  });
});

describe("createWindowedSession — composes the session's existing behavior", () => {
  it("the lifetime cumulative cap still bites even when the window cap does not", () => {
    // Lifetime ceiling 200, window cap a generous 500 over the last 5 — so the WINDOW
    // never rejects; the inner session's lifetime over-refund check is what catches it.
    const order = fulfilledOrder(200);
    const ws = createWindowedSession(world(order), {
      window: { kind: "count", lastN: 5 },
      cap: { amount: 500, currency: "MAD" },
    });
    expect(ws.propose(refund(order.id, 80, "l1")).ok).toBe(true); // lifetime 80
    expect(ws.propose(refund(order.id, 80, "l2")).ok).toBe(true); // lifetime 160
    const third = ws.propose(refund(order.id, 80, "l3")); // lifetime 240 > 200
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.violations[0]?.rule).toBe("I-1");
  });

  it("idempotent replay does not double-count in the window", () => {
    const order = fulfilledOrder(1000);
    const ws = createWindowedSession(world(order), {
      window: { kind: "count", lastN: 3 },
      cap: { amount: 150, currency: "MAD" },
    });
    expect(ws.propose(refund(order.id, 100, "dup")).ok).toBe(true);
    // same key again → replay, must not add another 100 to the window
    const replay = ws.propose(refund(order.id, 100, "dup"));
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replay).toBe(true);
    expect(ws.windowState(order.id).inWindow.amount).toBe(100); // not 200
  });

  it("an optimistic-concurrency conflict is surfaced (delegated to the session)", () => {
    const order = fulfilledOrder(1000);
    const ws = createWindowedSession(world(order), {
      window: { kind: "count", lastN: 3 },
      cap: { amount: 500, currency: "MAD" },
    });
    // Stale version → the inner session rejects as a conflict, not the window.
    const stale = { ...refund(order.id, 50, "c1"), expectedVersion: "0:Planned" };
    const res = ws.propose(stale);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflict).toBe(true);
    // a current version is accepted
    const fresh = { ...refund(order.id, 50, "c2"), expectedVersion: commitmentVersion(order) };
    expect(ws.propose(fresh).ok).toBe(true);
  });

  it("an illegal transition (refund before fulfilment) is rejected by the session", () => {
    // A Created (not Fulfilled) order cannot be refunded — the transition table (I-2)
    // rejects it via the inner session, regardless of the window.
    const created = newCommitment(buyer, seller, { offered: [], requested: [moneyValue(200, "MAD")] });
    const ws = createWindowedSession(world(created as ReturnType<typeof fulfilledOrder>), {
      window: { kind: "count", lastN: 3 },
      cap: { amount: 150, currency: "MAD" },
    });
    const res = ws.propose(refund(created.id, 50, "x1"));
    expect(res.ok).toBe(false);
  });

  it("non-refund actions pass straight through to the session", () => {
    const order = applyCommitmentPath(
      newCommitment(buyer, seller, { offered: [], requested: [moneyValue(200, "MAD")] }),
      { type: "Accepted" },
      seller,
    );
    const ws = createWindowedSession(world(order), {
      window: { kind: "count", lastN: 3 },
      cap: { amount: 150, currency: "MAD" },
    });
    // Accepted → Active is a legal non-refund move; the window does not interfere.
    const res = ws.propose({ commitment: order.id, to: { type: "Active" }, actor: seller });
    expect(res.ok).toBe(true);
    expect(ws.world.commitments[0]?.state.type).toBe("Active");
  });
});
