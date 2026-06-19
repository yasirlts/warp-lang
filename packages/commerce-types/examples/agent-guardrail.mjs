// Putting an AI agent near money? Validate its actions BEFORE they execute.
//
//   npm install @warp-lang/commerce-types
//   node agent-guardrail.mjs
//
import {
  guardAction, newCommitment, applyCommitmentPath, partyId,
} from "@warp-lang/commerce-types";

// A real, shipped (Fulfilled) order in your system.
const buyer = partyId("buyer_1");
const seller = partyId("seller_1");
const shipped = applyCommitmentPath(newCommitment(buyer, seller), { type: "Fulfilled" }, seller);
const world = { commitments: [shipped], fulfillments: [], parties: [] };

// NIGHTMARE: the agent "helpfully" reverts a shipped order back to Accepted.
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

// SAFE: a refund of a shipped order is a valid move — the guard approves it.
const refund = guardAction(world, {
  commitment: shipped.id,
  to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
  actor: "support_agent",
});
console.log(`refund approved? ${refund.ok}`);
