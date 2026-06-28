/**
 * The Boundary-A thesis, runnable: Warp computes the decision + the effects; the
 * HOST performs them. The engine (step/run) is a pure function — it never does
 * I/O. This mock host holds a world, feeds it events, receives effect
 * DESCRIPTORS, prints what it would execute (no real I/O), and persists the
 * returned world.
 *
 *   node examples/engine.mjs
 */
import { step, newCommitment, applyCommitmentPath, partyId, valueId } from "@warp-lang/commerce-types";

const seller = partyId("seller_1");
const buyer = partyId("buyer_1");

function order(amount, finalState) {
  const o = newCommitment(buyer, seller, {
    offered: [],
    requested: [
      { id: valueId("v"), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } },
    ],
  });
  return applyCommitmentPath(o, finalState, seller);
}

// The host's persisted state: a world of orders in various legal states.
const ordA = order(200, { type: "Fulfilled" }); // delivered → can refund
const ordP = order(100, { type: "PartiallyFulfilled", fulfilled_item_ids: ["a"], remaining_item_ids: ["b"] }); // → can fulfill
const ordPr = order(100, { type: "Proposed" }); // → can accept (settle)
const ordF = order(100, { type: "Fulfilled" }); // → can dispute (notify)
const ordD = order(100, { type: "Fulfilled" }); // → over-refund will be blocked
let world = { commitments: [ordA, ordP, ordPr, ordF, ordD], fulfillments: [], parties: [] };

const ev = (commitment, to) => ({ type: "action", action: { commitment, to, actor: seller } });
const events = [
  ev(ordA.id, { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-03-01T10:00:00.000Z" }), // refund
  ev(ordP.id, { type: "Fulfilled" }), // fulfill
  ev(ordPr.id, { type: "Accepted" }), // settle
  ev(ordF.id, { type: "Disputed", by: buyer, reason: "item arrived damaged", opened_at: "2026-03-01T10:00:00.000Z" }), // notify
  ev(ordD.id, { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-03-01T10:00:00.000Z" }), // BLOCKED: over-refund
];

const label = { type: "action" };
for (const [i, event] of events.entries()) {
  const before = world.commitments.find((c) => c.id === event.action.commitment)?.state.type;
  const result = step(world, event); // PURE: decide + describe; no I/O happens here
  console.log(`\n— event ${i + 1}: ${event.action.to.type} on ${event.action.commitment.slice(0, 8)}… (was ${before})`);
  if (result.verdict.ok) {
    world = result.world; // host persists the new world
    const after = world.commitments.find((c) => c.id === event.action.commitment)?.state.type;
    console.log(`  ✓ accepted — world advanced to '${after}'`);
    if (result.effects.length === 0) {
      console.log("  (no host effect for this transition)");
    } else {
      for (const e of result.effects) {
        console.log(`  HOST would execute → ${e.kind}  target=${e.target.slice(0, 8)}…  payload=${JSON.stringify(e.payload)}`);
      }
    }
  } else {
    const v = result.verdict.violations[0];
    console.log(`  ⛔ blocked [${v.rule}] ${v.message}`);
    console.log(`     fix: ${v.fix}`);
    console.log(`     world unchanged; effects emitted: ${result.effects.length}`);
  }
}

console.log("\nBoundary A: the engine decided each transition and DESCRIBED the host effects");
console.log("as data; this mock host performed them (here, by printing). Warp did no I/O.");
void label;
