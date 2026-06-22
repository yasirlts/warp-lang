// Session-level coherence: validate a SEQUENCE of agent actions, catching
// violations that only emerge across steps — most importantly a cumulative
// over-refund that single-action checks cannot see.
//
//   npm install @warp-lang/commerce-types
//   node agent-session.mjs
//
import {
  createSession, newCommitment, applyCommitmentPath, partyId,
} from "@warp-lang/commerce-types";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

// A shipped (Fulfilled) order committed at 200 MAD.
const order = applyCommitmentPath(
  newCommitment(buyer, seller, {
    offered: [],
    requested: [{ id: "value:order-total", form: { kind: "Money", money: { amount: 200, currency: "MAD" } }, quantity: 1, state: { type: "Available" } }],
  }),
  { type: "Fulfilled" },
  seller,
);

const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
// Each refund carries an idempotency key so these DISTINCT partial refunds are
// applied separately (a retry with the same key would be deduped — see
// examples/idempotency.mjs).
const refund = (amount, key) => ({ commitment: order.id, to: { type: "Refunded", amount: { amount, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor: "support_agent", idempotencyKey: key });

// The agent issues three partial refunds of 80 MAD. Each ALONE passes the
// point-in-time check (80 ≤ 200) — but they accumulate.
let n = 0;
for (const amount of [80, 80, 80]) {
  const verdict = session.propose(refund(amount, `r${n++}`));
  const sofar = session.refundedSoFar(order.id);
  if (verdict.ok) {
    console.log(`refund ${amount} MAD → accepted. refunded so far: ${sofar.amount} ${sofar.currency}`);
  } else {
    console.log(`\nrefund ${amount} MAD → BLOCKED [${verdict.violations[0].rule}]`);
    console.log(verdict.violations[0].message);
    console.log(`FIX: ${verdict.violations[0].fix}`);
    console.log(`bounded alternative: Refunded — ${verdict.alternatives[0].bounded}`);
    // The world did not advance: the refunded total is unchanged.
    console.log(`refunded so far (unchanged): ${sofar.amount} ${sofar.currency}`);
  }
}

// The agent reads the bounded guidance (40 MAD remaining) and refunds within it.
const corrected = session.propose(refund(40, "r-correct"));
const total = session.refundedSoFar(order.id);
console.log(`\ncorrected refund 40 MAD → ${corrected.ok ? "accepted" : "blocked"}. total refunded: ${total.amount} ${total.currency} (== committed 200; order is now ${session.world.commitments[0].state.type})`);
