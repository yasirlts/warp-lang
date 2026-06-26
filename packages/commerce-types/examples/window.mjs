// Cumulative windowing: cap aggregate refund behavior over a CONFIGURABLE moving
// window, generalizing the session's session-lifetime cumulative ledger. A burst
// of refunds can stay under both the point-in-time check (each refund alone is
// small) AND the lifetime total (which legitimately climbs toward the committed
// amount over time), yet still be a cluster a policy wants to stop. A windowed
// session adds that narrower cap on top of the session — events that fall outside
// the window age out, so headroom returns once the window scrolls past the burst.
//
//   npm install @warp-lang/commerce-types
//   node window.mjs
//
// Scope: per-session, in-memory reference window over one session's accepted
// refunds. Not a distributed/persistent aggregate store, not a cross-process rate
// limiter, not durable across restarts — see the README.
import { createWindowedSession, newCommitment, applyCommitmentPath, partyId } from "@warp-lang/commerce-types";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

// A Fulfilled order committed at 1000 MAD — a large LIFETIME ceiling, so the
// session's lifetime cumulative cap is not what bites in this scenario.
const order = applyCommitmentPath(
  newCommitment(buyer, seller, {
    offered: [],
    requested: [{ id: "value:order-total", form: { kind: "Money", money: { amount: 1000, currency: "MAD" } }, quantity: 1, state: { type: "Available" } }],
  }),
  { type: "Fulfilled" },
  seller,
);

const world = { commitments: [order], fulfillments: [], parties: [] };

// Window policy (CALLER config, not schema): no more than 150 MAD refunded across
// the last 3 refund events.
const ws = createWindowedSession(world, {
  window: { kind: "count", lastN: 3 },
  cap: { amount: 150, currency: "MAD" },
});

const refund = (amount, key) => ({
  commitment: order.id,
  to: { type: "Refunded", amount: { amount, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
  actor: seller,
  idempotencyKey: key,
});

console.log("=== A burst the point-in-time check misses ===");
// Each 60 is individually valid (60 <= 1000) and the lifetime sum stays far under
// the 1000 ceiling — only the WINDOW sees the cluster.
console.log("refund 60 (r1):", ws.propose(refund(60, "r1")).ok, "| in-window:", ws.windowState(order.id).inWindow.amount);
console.log("refund 60 (r2):", ws.propose(refund(60, "r2")).ok, "| in-window:", ws.windowState(order.id).inWindow.amount);

const third = ws.propose(refund(60, "r3")); // would reach 180 in-window > 150
console.log("refund 60 (r3):", third.ok, "(rejected — 180 > 150 cap)");
if (!third.ok) {
  console.log("  rule:", third.violations[0].rule);
  console.log("  why :", third.violations[0].message);
  console.log("  fix :", third.violations[0].fix);
}

console.log("\n=== Lifetime ledger and world are untouched by the rejection ===");
console.log("refunded so far (lifetime):", ws.refundedSoFar(order.id).amount, "(still 120, the rejected refund was not applied)");
console.log("commitment state:", ws.world.commitments[0].state.type, "(still Fulfilled)");

console.log("\n=== A time window: a burst inside the span, then aging out ===");
const tw = createWindowedSession(
  { commitments: [applyCommitmentPath(newCommitment(buyer, seller, { offered: [], requested: [{ id: "v2", form: { kind: "Money", money: { amount: 1000, currency: "MAD" } }, quantity: 1, state: { type: "Available" } }] }), { type: "Fulfilled" }, seller)], fulfillments: [], parties: [] },
  { window: { kind: "time", withinMs: 1000 }, cap: { amount: 150, currency: "MAD" } },
);
const o2 = tw.world.commitments[0];
const tr = (amount, key) => ({ commitment: o2.id, to: { type: "Refunded", amount: { amount, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor: seller, idempotencyKey: key });
const t0 = 1_000_000;
console.log("t+0ms    refund 100:", tw.propose(tr(100, "t1"), t0).ok, "| in-window:", tw.windowState(o2.id, t0).inWindow.amount);
const burst = tw.propose(tr(100, "t2"), t0 + 200); // 200 within 1000ms > 150
console.log("t+200ms  refund 100:", burst.ok, "(rejected — 200 > 150 within the 1000ms window)");
const aged = tw.propose(tr(100, "t3"), t0 + 1500); // first refund aged out
console.log("t+1500ms refund 100:", aged.ok, "(accepted — the t+0 refund aged out, headroom returned)");
console.log("in-window as of t+1500ms:", tw.windowState(o2.id, t0 + 1500).inWindow.amount, "(only the t+1500 refund remains)");
