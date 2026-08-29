/**
 * Rung 4 — a whole commerce system authored in `.warp`, run by the engine.
 *
 *   compileSystem(source) -> CommerceModel -> runModel(model, world, hostEvents)
 *
 * Nothing between those three steps is hand-wired. The `.warp` file below IS the
 * system: its lifecycle, its profile, its policy. The host supplies the events —
 * that is the I/O, and it is deliberately NOT authorable in `.warp`, because a
 * file with its own events baked in is a test fixture, not a system definition.
 *
 * Three things this example is careful NOT to imply, each a real property of the
 * engine rather than a limitation of the language:
 *
 *   1. The authored `assert I1` does NOT make the engine check I-1. It already
 *      checks all six invariants on every action. The assert records what the
 *      author cared about; removing it changes no verdict (§6 below).
 *   2. The authored lifecycle does NOT govern which moves are legal. It is
 *      recorded on the model for provenance; the table that decides is the
 *      model's own, inside guardAction (§7).
 *   3. guardAction audits the WHOLE world. A pre-existing violation anywhere
 *      blocks every event, including one aimed at a different, healthy
 *      commitment. There is no per-commitment isolation here.
 *
 * Run it verbatim:  node examples/system.mjs
 * It ASSERTS every verdict and exits non-zero if any changes.
 */
import assert from "node:assert/strict";
import {
  applyCommitmentPath,
  newCommitment,
  partyId,
  runModel,
  valueId,
} from "@warp-lang/commerce-types";
import { compileSystem } from "../dist/index.js";

const rule = (n) => console.log("─".repeat(72), "\n" + n + "\n");
const seller = partyId("party:merchant");
const buyer = partyId("party:buyer");
const FIXED = () => "2030-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// The system, authored in .warp. This is the whole standing model.
// ---------------------------------------------------------------------------

const SOURCE = `
lifecycle sales {
  state Draft
  state Proposed
  state Accepted
  state Fulfilled
  state Disputed
  state Refunded
  state Cancelled

  Draft     -> Proposed, Cancelled
  Proposed  -> Accepted, Cancelled
  Accepted  -> Fulfilled, Cancelled, Disputed
  Fulfilled -> Disputed, Refunded
  Disputed  -> Fulfilled, Refunded, Cancelled
}

profile digital {
  label       "Digital goods"
  description "digital goods paid in money"
  states Draft, Proposed, Accepted, Fulfilled, Refunded, Cancelled
  value_forms DigitalGood, Money
}

policy house_rules {
  label       "House rules"
  description "Never below 150 MAD; MA VAT rates only."
  applies_to  digital
  concession_floor 150 MAD
  committed_price  200 MAD
  tax_rates "MA" 0, 0.1, 0.2
  assert I1
}
`;

console.log("\nThe authored system (shop.warp)\n");
console.log(SOURCE.trim().split("\n").map((l) => "  " + l).join("\n"), "\n");

const system = compileSystem(SOURCE, { file: "shop.warp" });
const model = system.model;

rule("1) What the file compiled to — one CommerceModel, the engine's input");

console.log("   id:         ", model.id);
console.log("   transitions:", Object.keys(model.transitions).length, "states (provenance — see §7)");
console.log("   profile:    ", model.profile.id, "→", model.profile.allowedStates.join(", "));
console.log("   policies:   ", model.policies.map((p) => p.id).join(", "));
console.log("     bounds:   ", JSON.stringify(model.policies[0].bounds));
console.log("     pack:     ", model.policies[0].pack.jurisdictions.map((j) => j.jurisdiction).join(", "));
console.log("     asserts:  ", model.policies[0].asserts.join(", "), "(declared intent — see §6)");
console.log("\n   No glue: compileSystem produced this, runModel takes it as-is.");

// ---------------------------------------------------------------------------
// A deal, and the host's events.
// ---------------------------------------------------------------------------

function deal(state) {
  const c = newCommitment(buyer, seller, {
    offered: [
      {
        id: valueId("value:licence"),
        form: {
          kind: "DigitalGood",
          identifier: "licence:single-seat",
          exclusivity: "NonExclusive",
          access_model: { kind: "License", license_type: "Perpetual", seats: 1, transferable: false },
        },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
    requested: [
      {
        id: valueId("value:price"),
        form: { kind: "Money", money: { amount: 200, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  return applyCommitmentPath(c, state, seller);
}
const worldWith = (c) => ({ commitments: [c], fulfillments: [], parties: [] });
const act = (c, to, actor = seller) => ({ type: "action", action: { commitment: c.id, to, actor } });

rule("2) The host feeds a sequence of events through the authored system");

const c = deal({ type: "Draft" });
const hostEvents = [
  { type: "concession", commitment: c.id, kind: "offer", price: { amount: 120, currency: "MAD" }, by: seller },
  { type: "concession", commitment: c.id, kind: "offer", price: { amount: 170, currency: "MAD" }, by: seller },
  act(c, { type: "Accepted" }),
  act(c, { type: "Disputed", by: buyer, reason: "unhappy", opened_at: "2030-02-01T00:00:00.000Z" }, buyer),
];

const runResult = runModel(model, worldWith(c), hostEvents, { clock: FIXED });
const label = ["offer 120 MAD", "offer 170 MAD", "accept", "raise dispute"];
runResult.verdicts.forEach((v, i) => {
  const outcome = v.ok ? "ok" : `BLOCKED at the ${v.layer} layer${v.policy ? ` (policy '${v.policy}')` : ""}`;
  console.log(`   ${label[i].padEnd(16)} → ${outcome}`);
});
console.log("\n   final state:", runResult.world.commitments[0].state.type);
assert.deepEqual(
  runResult.verdicts.map((v) => (v.ok ? "ok" : v.layer)),
  ["policy", "ok", "ok", "profile"],
);
assert.equal(runResult.world.commitments[0].state.type, "Accepted");

rule("3) The POLICY block, in full — the authored floor, enforced by the engine");

console.log("   " + runResult.verdicts[0].violations[0].message);
assert.equal(runResult.verdicts[0].violations[0].rule, "I-1");

rule("4) The PROFILE block, in full — the authored profile, enforced by the engine");

console.log("   " + runResult.verdicts[3].violations[0].message);
assert.equal(runResult.verdicts[3].violations[0].rule, "profile-state");

rule("5) A BASE invariant still governs — an over-refund is I-1");

const fulfilled = deal({ type: "Fulfilled" });
const over = runModel(model, worldWith(fulfilled), [
  act(fulfilled, { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" }),
], { clock: FIXED });
console.log("   refund 500 of 200 → BLOCKED at the", over.verdicts[0].layer, "layer");
console.log("   " + over.verdicts[0].violations.find((v) => v.rule === "I-1").message);
assert.equal(over.verdicts[0].ok, false);
assert.equal(over.verdicts[0].layer, "base");

rule("6) HONESTY — the authored `assert I1` is documentation, not a gate");

const withoutAssert = compileSystem(SOURCE.replace("  assert I1\n", ""), { file: "shop.warp" }).model;
const overRefund = act(fulfilled, {
  type: "Refunded",
  amount: { amount: 500, currency: "MAD" },
  at: "2030-02-01T00:00:00.000Z",
});
const a = runModel(model, worldWith(fulfilled), [overRefund], { clock: FIXED });
const b = runModel(withoutAssert, worldWith(fulfilled), [overRefund], { clock: FIXED });
console.log("   with    `assert I1` → blocked:", !a.verdicts[0].ok, "at", a.verdicts[0].layer);
console.log("   without `assert I1` → blocked:", !b.verdicts[0].ok, "at", b.verdicts[0].layer);
assert.equal(a.verdicts[0].ok, b.verdicts[0].ok);
assert.deepEqual(a.verdicts[0].violations, b.verdicts[0].violations);
console.log("\n   Identical. guardAction audits all six invariants on every action,");
console.log("   so asserting I-1 cannot strengthen that and omitting it cannot");
console.log("   weaken it. The assert records what the author cared about.");

rule("7) HONESTY — the authored lifecycle is provenance, it does not govern");

const wishful = compileSystem(`
  lifecycle wishful {
    state Draft
    state Fulfilled
    Draft -> Fulfilled
  }
`).model;
console.log("   authored table claims: Draft ->", wishful.transitions["Draft"].join(", "));
const draft = deal({ type: "Draft" });
const leap = runModel(wishful, worldWith(draft), [act(draft, { type: "Fulfilled" })], { clock: FIXED });
console.log("   engine verdict:        BLOCKED at the", leap.verdicts[0].layer, "layer —",
  leap.verdicts[0].violations[0].rule);
console.log("   " + leap.verdicts[0].violations[0].message);
assert.equal(leap.verdicts[0].ok, false);
assert.ok(leap.verdicts[0].violations.some((v) => v.rule === "I-2"));
console.log("\n   An authored lifecycle lands in model.transitions for the record and");
console.log("   for verifyLifecycle. The table that decides a move is the model's");
console.log("   own, inside guardAction — authoring one cannot widen it.");

rule("8) HONESTY — the audit is world-wide, not per-commitment");

const healthy = deal({ type: "Proposed" });
const mixed = newCommitment(buyer, seller, {
  offered: [],
  requested: [
    { id: valueId("value:a"), form: { kind: "Money", money: { amount: 100, currency: "MAD" } }, quantity: 1, state: { type: "Available" } },
    { id: valueId("value:b"), form: { kind: "Money", money: { amount: 50, currency: "EUR" } }, quantity: 1, state: { type: "Available" } },
  ],
});
const twoCommitments = { commitments: [healthy, mixed], fulfillments: [], parties: [] };
const crossed = runModel(model, twoCommitments, [act(healthy, { type: "Accepted" })], { clock: FIXED });
console.log("   event targets the HEALTHY commitment → ok =", crossed.verdicts[0].ok);
console.log("   " + crossed.verdicts[0].violations[0].message);
assert.equal(crossed.verdicts[0].ok, false);
console.log("\n   A second commitment mixes currencies, so the world violates I-1 and");
console.log("   every event is refused — including this one, which never touched it.");
console.log("   Worth knowing before assuming per-commitment isolation.");

rule("Where rung 4 lands");
console.log(`A .warp file authored the SYSTEM — a lifecycle, a profile, a policy — and
compileSystem gathered it into one CommerceModel. The host supplied the EVENTS,
and runModel ran them against that model: a policy block, a profile block, and a
base invariant block, all from the authored system with nothing hand-wired.

The language produces the model. The engine runs it. The host does the I/O.

Events are deliberately not authorable: a file with its events baked in would be
a fixture, not a system. And three things the language does not do — make the
engine check an invariant, govern which moves are legal, or isolate a commitment
from the world's audit — are shown above rather than claimed away.
`);
