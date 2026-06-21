// The planning oracle: when the guard says "no", it also says "here are your
// valid moves." An agent reads the alternatives and picks a legal one, instead
// of blindly retrying.
//
//   npm install @warp-lang/commerce-types
//   node planning-oracle.mjs
//
import {
  guardAction, newCommitment, applyCommitmentPath, partyId, validTransitions,
} from "@warp-lang/commerce-types";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

// A real, shipped (Fulfilled) order committed at 200 MAD.
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
let world = { commitments: [shipped], fulfillments: [], parties: [] };

// The move set is a pure read of the model's transition table — no guessing.
console.log("Legal moves from Fulfilled:", validTransitions({ type: "Fulfilled" }));

// 1) The agent proposes an INVALID move: revert a shipped order to Accepted.
const proposed = { commitment: shipped.id, to: { type: "Accepted" }, actor: "support_agent" };
const verdict = guardAction(world, proposed);

if (verdict.ok === false) {
  console.log(`\nBLOCKED [${verdict.violations[0].rule}] ${verdict.violations[0].message}`);
  console.log("Alternatives the agent can choose from:");
  for (const alt of verdict.alternatives ?? []) {
    console.log(`  - ${alt.to} (${alt.label})${alt.bounded ? ` — bounded: ${alt.bounded}` : ""}`);
  }

  // 2) The agent picks a legal, UNbounded alternative and retries — guided, not blind.
  const choice = (verdict.alternatives ?? []).find((a) => a.bounded === undefined);
  console.log(`\nAgent picks: ${choice.to} (${choice.label})`);
  const retry = guardAction(world, { commitment: shipped.id, to: { type: choice.to }, actor: "support_agent" });
  console.log(`Retry accepted? ${retry.ok}`);
  if (retry.ok) world = retry.next;
}

// 3) Over-refund: a LEGAL transition (Fulfilled → Refunded) whose amount is the
//    problem. The oracle marks Refunded "bounded" — retry the SAME move with a
//    corrected amount, don't pick a different state.
const shipped2 = applyCommitmentPath(
  newCommitment(buyer, seller, { offered: [], requested: [{ id: "v2", form: { kind: "Money", money: { amount: 200, currency: "MAD" } }, quantity: 1, state: { type: "Available" } }] }),
  { type: "Fulfilled" },
  seller,
);
const world2 = { commitments: [shipped2], fulfillments: [], parties: [] };
const over = guardAction(world2, { commitment: shipped2.id, to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor: "support_agent" });
if (over.ok === false) {
  const refundAlt = (over.alternatives ?? []).find((a) => a.to === "Refunded");
  console.log(`\nBLOCKED [${over.violations[0].rule}] over-refund. Refunded is legal but bounded: ${refundAlt.bounded}`);
  // The agent corrects the amount to the committed 200 MAD and retries.
  const corrected = guardAction(world2, { commitment: shipped2.id, to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor: "support_agent" });
  console.log(`Corrected refund (200 MAD) accepted? ${corrected.ok}`);
}
