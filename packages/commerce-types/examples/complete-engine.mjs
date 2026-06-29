/**
 * A small but COMPLETE commerce engine, authored as a Warp model + a mock host.
 *
 * The thesis, end-to-end: the commerce CORE is a pure (world, event) -> (world,
 * effects, verdict) function; the HOST performs I/O. Here the host holds the
 * world, feeds events to the engine, receives host-actionable effect DESCRIPTORS
 * (now with real payloads — amount to capture, items to ship, amount to return),
 * prints what it would do for each, and persists the returned world. Warp does no
 * I/O. This is an engine, not a language: there is no grammar, parser, or syntax —
 * just the model + the pure engine + a host.
 *
 *   node examples/complete-engine.mjs
 */
import { step, newCommitment, partyId, valueId } from "@warp-lang/commerce-types";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

function newOrder(amount, sku) {
  return newCommitment(buyer, seller, {
    offered: [{ id: valueId("good"), form: { kind: "PhysicalGood", sku, condition: "New" }, quantity: 1, state: { type: "Available" } }],
    requested: [{ id: valueId("pay"), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } }],
  });
}

// A fixed clock makes the run deterministic; equal timestamps are monotonic-valid (I-4).
const clock = () => "2026-06-29T10:00:00.000Z";
const ev = (commitment, to) => ({ type: "action", action: { commitment, to, actor: seller } });

// What the mock host would DO for each effect kind — reading the real payloads.
function perform(effect) {
  const p = effect.payload;
  switch (effect.kind) {
    case "settle":
      return `capture ${p.amount.amount} ${p.amount.currency}`;
    case "fulfill":
      return `ship [${p.items.map((i) => `${i.quantity}× ${i.description}`).join(", ") || "no itemised goods"}]`;
    case "refund":
      return `return ${p.amount.amount} ${p.amount.currency}`;
    case "cancel":
      return `void — ${p.reason} (by ${p.by})`;
    case "notify":
      return `escalate dispute — ${p.reason} (by ${p.by})`;
    default:
      return effect.kind;
  }
}

// The host's loop: feed one event, act on the effects, persist the world. (This is
// exactly what run() folds; stepping here lets the host narrate each beat.)
function feed(world, event) {
  const before = world.commitments.find((c) => c.id === event.action.commitment)?.state.type;
  const result = step(world, event, { clock }); // PURE: decide + describe; no I/O here
  console.log(`\n— ${before} → ${event.action.to.type}`);
  if (!result.verdict.ok) {
    const v = result.verdict.violations[0];
    console.log(`  ⛔ BLOCKED [${v.rule}] ${v.message}`);
    console.log(`     fix: ${v.fix}`);
    console.log(`     world unchanged; effects: ${result.effects.length}`);
    return world; // host persists nothing on a block
  }
  if (result.effects.length === 0) {
    console.log("  ✓ advanced (no host effect for this transition)");
  } else {
    for (const e of result.effects) console.log(`  ✓ advanced — HOST: ${perform(e)}  [${e.kind} on ${e.target.slice(0, 8)}…]`);
  }
  return result.world; // host persists the new world
}

console.log("=== Order A — full lifecycle: create → propose → accept → fulfill → refund ===");
const orderA = newOrder(200, "TEABOX-200");
let world = { commitments: [orderA], fulfillments: [], parties: [] };
const lifecycle = [
  ev(orderA.id, { type: "Proposed" }),
  ev(orderA.id, { type: "Accepted" }), // → settle 200 MAD
  ev(orderA.id, { type: "PartiallyFulfilled", fulfilled_item_ids: [], remaining_item_ids: ["good"] }),
  ev(orderA.id, { type: "Fulfilled" }), // → fulfill the offered PhysicalGood
  ev(orderA.id, { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-06-29T10:00:00.000Z" }), // → refund 200 MAD
];
for (const event of lifecycle) world = feed(world, event);

console.log("\n=== Order B — an over-refund is blocked (I-1), no effect, world unchanged ===");
let orderB = newOrder(100, "MUG-100");
world = { commitments: [orderB], fulfillments: [], parties: [] };
for (const to of [
  { type: "Proposed" },
  { type: "Accepted" },
  { type: "PartiallyFulfilled", fulfilled_item_ids: [], remaining_item_ids: ["good"] },
  { type: "Fulfilled" },
]) {
  world = feed(world, ev(orderB.id, to));
}
// committed only 100 MAD — a 500 MAD refund cannot be represented; I-1 blocks it.
world = feed(world, ev(orderB.id, { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-06-29T10:00:00.000Z" }));

console.log("\nThe whole flow was driven by events; the host acted only on descriptors with");
console.log("real payloads; the invalid refund was blocked with a legible verdict and no effect.");
console.log("A commerce engine authored as a Warp model — host does the I/O. Not a language.");
