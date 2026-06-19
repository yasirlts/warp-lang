// Putting an AI agent near money? Validate its actions BEFORE they execute.
//
//   npm install @warp-lang/commerce-types
//   node agent-guardrail.mjs
//
import {
  guardAction, newCommitment, applyCommitmentPath, partyId,
} from "@warp-lang/commerce-types";

// A real, shipped (Fulfilled) order in your system — committed at 200 MAD.
const buyer = partyId("buyer_1");
const seller = partyId("seller_1");
const order = newCommitment(buyer, seller, {
  offered: [],
  requested: [{
    id: "value:order-total",
    form: { kind: "Money", money: { amount: 200, currency: "MAD" } },
    quantity: 1,
    state: { type: "Available" },
  }],
});
const shipped = applyCommitmentPath(order, { type: "Fulfilled" }, seller);
const world = { commitments: [shipped], fulfillments: [], parties: [] };

// NIGHTMARE 1: the agent "helpfully" reverts a shipped order back to Accepted.
// The guard rejects it BEFORE anything executes — with the reason and the fix.
const reverted = guardAction(world, {
  commitment: shipped.id,
  to: { type: "Accepted" },
  actor: "support_agent",
});
if (reverted.ok === false) {
  const v = reverted.violations[0];
  console.log(`BLOCKED [${v.rule}] ${v.message}`);
  console.log(`FIX: ${v.fix}`);
}

// NIGHTMARE 2: the agent refunds 500 MAD against a 200 MAD order. Refunding more
// than was captured creates value from nothing — the guard blocks it citing I-1.
const overRefund = guardAction(world, {
  commitment: shipped.id,
  to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
  actor: "support_agent",
});
if (overRefund.ok === false) {
  const v = overRefund.violations.find((x) => x.rule === "I-1");
  console.log(`BLOCKED [${v.rule}] ${v.message}`);
  console.log(`FIX: ${v.fix}`);
}

// SAFE: a refund of at most the committed amount is a valid move — approved.
const refund = guardAction(world, {
  commitment: shipped.id,
  to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
  actor: "support_agent",
});
console.log(`refund (200 MAD) approved? ${refund.ok}`);
