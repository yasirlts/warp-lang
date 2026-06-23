// Multi-agent verification: several named agents act on a SHARED world. Each action
// is individually valid, but their COMBINED sequence violates an invariant — Warp
// catches it at the offending step and attributes it to the actor whose action tipped
// the shared world into violation.
//
//   npm install @warp-lang/commerce-types
//   node multi-agent.mjs
//
// Scope: shared-world invariant enforcement WITH attribution. The attribution is the
// action that tipped the world into violation — NOT collusion or intent detection.
import {
  createMultiAgentSession, newCommitment, applyCommitmentPath, partyId,
} from "@warp-lang/commerce-types";

const buyer = partyId("buyer");
const seller = partyId("seller");

// A shipped (Fulfilled) order committed at 200 MAD, shared by several agents.
const order = applyCommitmentPath(
  newCommitment(buyer, seller, {
    offered: [],
    requested: [{ id: "value:order-total", form: { kind: "Money", money: { amount: 200, currency: "MAD" } }, quantity: 1, state: { type: "Available" } }],
  }),
  { type: "Fulfilled" },
  seller,
);
const id = String(order.id);
const session = createMultiAgentSession({ commitments: [order], fulfillments: [], parties: [] });
const refund = (amount, actor, key) => ({ commitment: id, to: { type: "Refunded", amount: { amount, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor, idempotencyKey: key });

// 1) A finance-agent refunds 120 MAD for damaged items — valid on its own.
const a = session.propose(refund(120, "finance-agent", "fin-1"));
console.log(`finance-agent refunds 120 → ${a.ok ? "accepted" : "rejected"} (refunded so far: ${session.refundedSoFar(id).amount} MAD)`);

// 2) A support-agent, unaware, refunds 100 MAD goodwill — valid ON ITS OWN, but the
//    SHARED world now over-refunds (220 > 200). Caught and attributed to support-agent.
const b = session.propose(refund(100, "support-agent", "sup-1"));
if (b.ok === false) {
  console.log(`\nsupport-agent refunds 100 → BLOCKED [${b.violations[0].rule}]`);
  console.log(`  attribution: ${b.attribution}`);
  const refundAlt = (b.alternatives ?? []).find((x) => x.to === "Refunded");
  console.log(`  guidance: ${refundAlt?.bounded ?? b.violations[0].fix}`);
}

// 3) support-agent reads the remaining-refundable guidance and corrects to 80 MAD.
const c = session.propose(refund(80, "support-agent", "sup-2"));
console.log(`\nsupport-agent corrects to 80 → ${c.ok ? "accepted" : "rejected"}. total refunded: ${session.refundedSoFar(id).amount} MAD (order is now ${session.world.commitments[0].state.type})`);
console.log("who did what:", JSON.stringify(session.actorsSummary()));

// 4) A fully-valid multi-agent sequence on a fresh order: buyer-agent proposes,
//    seller-agent accepts, ops-agent activates — different actors, all valid.
const draft = newCommitment(buyer, seller);
const flow = createMultiAgentSession({ commitments: [draft], fulfillments: [], parties: [] });
const did = String(draft.id);
const p = flow.propose({ commitment: did, to: { type: "Proposed" }, actor: "buyer-agent" });
const acc = flow.propose({ commitment: did, to: { type: "Accepted" }, actor: "seller-agent" });
const act = flow.propose({ commitment: did, to: { type: "Active" }, actor: "ops-agent" });
console.log(`\nvalid multi-agent flow → proposed:${p.ok} accepted:${acc.ok} activated:${act.ok}. state: ${flow.world.commitments[0].state.type}; agents: ${JSON.stringify(flow.actorsSummary())}`);
