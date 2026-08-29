/**
 * `runModel` — running a COMPLETE composed commerce model end-to-end (rung 4a).
 *
 * Before this, the engine's `step`/`run` enforced the BASE layer only: the
 * transition table and the six invariants, via `guardAction`. A profile was
 * enforced by `guardWithProfile`, a negotiation floor by `guardConcession`, a
 * regulatory pack by `checkSettlementPolicy` — separate functions a caller wired
 * together by hand. So you could author a profile and a policy and have the engine
 * ignore both.
 *
 * This example builds ONE model object — a profile plus a policy — and pushes a
 * sequence of events through ONE `runModel` call. Three different classes of
 * violation are refused by three different layers, all from that single call over
 * that single model. Nothing below hand-wires a check.
 *
 * The frame: this COMPOSES enforcement that already shipped. No new invariant, no
 * new state, no new transition, no schema change. Every refusal you see comes from
 * a function that existed before this module.
 *
 * Run it verbatim:  node examples/run-model.mjs
 * It ASSERTS every verdict and exits non-zero if any changes.
 */
import assert from "node:assert/strict";
import {
  applyCommitmentPath,
  newCommitment,
  partyId,
  run,
  runModel,
  valueId,
} from "../dist/index.js";

const rule = (n) => console.log("─".repeat(72), "\n" + n + "\n");
const seller = partyId("party:merchant");
const buyer = partyId("party:buyer");
// A fixed clock makes the whole run byte-for-byte deterministic.
const FIXED = () => "2030-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// The composed model — plain data. This is the "authored brain" shape.
// ---------------------------------------------------------------------------

const MODEL = {
  id: "house_rules",
  label: "House rules for digital sales",
  description: "Digital goods, no disputes, never discounted below 150 MAD.",

  // A profile: the model's own states, narrowed. Disputed is absent.
  profile: {
    id: "digital_strict",
    label: "Digital goods, no disputes",
    description: "digital goods paid in money",
    allowedStates: ["Draft", "Proposed", "Accepted", "Fulfilled", "Refunded", "Cancelled"],
    allowedValueForms: ["DigitalGood", "Money"],
  },

  // A policy: a negotiation floor and a jurisdiction rate pack.
  policies: [
    {
      id: "floor_and_vat",
      label: "Floor 150 MAD; MA VAT rates",
      bounds: {
        floor: { amount: 150, currency: "MAD" },
        committed: { amount: 200, currency: "MAD" },
      },
      pack: {
        id: "ma-vat",
        label: "MA VAT",
        description: "permitted MA tax rates",
        jurisdictions: [{ jurisdiction: "MA", rates: [0, 0.1, 0.2] }],
      },
      // Declared intent only — see the closing note on why this cannot be a gate.
      asserts: ["I-1"],
    },
  ],
};

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

console.log("\nThe composed model (plain data — one object):\n");
console.log("  profile:  ", MODEL.profile.id, "→ allows", MODEL.profile.allowedStates.join(", "));
console.log("  policy:   ", MODEL.policies[0].id,
  "→ floor", `${MODEL.policies[0].bounds.floor.amount} ${MODEL.policies[0].bounds.floor.currency}`,
  "| pack", MODEL.policies[0].pack.id);

rule("1) A valid event advances the world — BASE layer");

const draft = deal({ type: "Proposed" });
const okRun = runModel(MODEL, worldWith(draft), [
  { type: "action", action: { commitment: draft.id, to: { type: "Accepted" }, actor: seller } },
], { clock: FIXED });
console.log("   Proposed -> Accepted   ok =", okRun.verdicts[0].ok,
  " state =", okRun.world.commitments[0].state.type);
assert.equal(okRun.verdicts[0].ok, true);
assert.equal(okRun.world.commitments[0].state.type, "Accepted");

rule("2) A PROFILE violation — blocked through runModel, not a separate call");

const fulfilled = deal({ type: "Fulfilled" });
const profileRun = runModel(MODEL, worldWith(fulfilled), [
  {
    type: "action",
    action: {
      commitment: fulfilled.id,
      to: { type: "Disputed", by: buyer, reason: "unhappy", opened_at: "2030-02-01T00:00:00.000Z" },
      actor: buyer,
    },
  },
], { clock: FIXED });
const pv = profileRun.verdicts[0];
console.log("   Fulfilled -> Disputed  ok =", pv.ok, " layer =", pv.layer, " rule =", pv.violations[0].rule);
console.log("   " + pv.violations[0].message);
assert.equal(pv.ok, false);
assert.equal(pv.layer, "profile");
assert.equal(pv.violations[0].rule, "profile-state");
assert.equal(profileRun.world.commitments[0].state.type, "Fulfilled", "a block must not advance the world");
assert.deepEqual(profileRun.effects, [], "a block must emit no effects");
console.log("\n   The MODEL still permits Fulfilled -> Disputed. This merchant's");
console.log("   profile does not — and the engine applied it, not the caller.");

rule("3) A POLICY bound violation — a concession below the authored floor");

const negotiating = deal({ type: "Draft" });
const policyRun = runModel(MODEL, worldWith(negotiating), [
  { type: "concession", commitment: negotiating.id, kind: "offer", price: { amount: 120, currency: "MAD" }, by: seller },
], { clock: FIXED });
const yv = policyRun.verdicts[0];
console.log("   offer 120 MAD          ok =", yv.ok, " layer =", yv.layer, " policy =", yv.policy);
console.log("   " + yv.violations[0].message);
assert.equal(yv.ok, false);
assert.equal(yv.layer, "policy");
assert.equal(yv.policy, "floor_and_vat");
assert.equal(policyRun.world.commitments[0].state.type, "Draft");

rule("4) A BASE invariant violation — an over-refund is still I-1");

const refundable = deal({ type: "Fulfilled" });
const baseRun = runModel(MODEL, worldWith(refundable), [
  {
    type: "action",
    action: {
      commitment: refundable.id,
      to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" },
      actor: seller,
    },
  },
], { clock: FIXED });
const bv = baseRun.verdicts[0];
console.log("   refund 500 of 200      ok =", bv.ok, " layer =", bv.layer);
console.log("   " + bv.violations.find((v) => v.rule === "I-1").message);
assert.equal(bv.ok, false);
assert.equal(bv.layer, "base");
assert.ok(bv.violations.some((v) => v.rule === "I-1"));

rule("5) One sequence, one model, three layers");

const seq = deal({ type: "Draft" });
const all = runModel(MODEL, worldWith(seq), [
  { type: "concession", commitment: seq.id, kind: "offer", price: { amount: 120, currency: "MAD" }, by: seller },
  { type: "concession", commitment: seq.id, kind: "offer", price: { amount: 170, currency: "MAD" }, by: seller },
  { type: "action", action: { commitment: seq.id, to: { type: "Accepted" }, actor: seller } },
  {
    type: "action",
    action: {
      commitment: seq.id,
      to: { type: "Disputed", by: buyer, reason: "unhappy", opened_at: "2030-02-01T00:00:00.000Z" },
      actor: buyer,
    },
  },
], { clock: FIXED });
const shape = all.verdicts.map((v) => (v.ok ? "ok" : `blocked:${v.layer}`));
console.log("   concession 120 →", shape[0]);
console.log("   concession 170 →", shape[1]);
console.log("   accept         →", shape[2]);
console.log("   dispute        →", shape[3]);
console.log("\n   final state:", all.world.commitments[0].state.type);
assert.deepEqual(shape, ["blocked:policy", "ok", "ok", "blocked:profile"]);
assert.equal(all.world.commitments[0].state.type, "Accepted");
console.log("\n   Four events, three layers, ONE runModel call over ONE model object.");

rule("6) A settlement, checked against the policy's pack");

const settling = deal({ type: "Accepted" });
const committedTotal = { amount: 240, currency: "MAD" };
const mk = (rate) => ({
  type: "settlement",
  commitment: settling.id,
  committedTotal,
  settlement: {
    total: committedTotal,
    components: [
      { kind: "Base", amount: { amount: 200, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 40, currency: "MAD" }, jurisdiction: "MA", tax_rate: rate },
    ],
  },
});
const settleRun = runModel(MODEL, worldWith(settling), [mk(0.2), mk(0.17)], { clock: FIXED });
console.log("   tax @ 0.2  (permitted) → ok =", settleRun.verdicts[0].ok);
console.log("   tax @ 0.17 (not listed) → ok =", settleRun.verdicts[1].ok, " layer =", settleRun.verdicts[1].layer);
console.log("   " + settleRun.verdicts[1].violations[0].message);
assert.equal(settleRun.verdicts[0].ok, true);
assert.equal(settleRun.verdicts[1].ok, false);
assert.equal(settleRun.verdicts[1].layer, "policy");

rule("7) The composition is ADDITIVE — a bare model IS the base engine");

const bare = { id: "bare" };
const c = deal({ type: "Fulfilled" });
const events = [
  {
    type: "action",
    action: {
      commitment: c.id,
      to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" },
      actor: seller,
    },
  },
];
const viaBase = run(worldWith(c), events, { clock: FIXED });
const viaModel = runModel(bare, worldWith(c), events, { clock: FIXED });
console.log("   run()      →", viaBase.verdicts[0].ok, viaBase.world.commitments[0].state.type);
console.log("   runModel() →", viaModel.verdicts[0].ok, viaModel.world.commitments[0].state.type);
assert.equal(viaModel.verdicts[0].ok, viaBase.verdicts[0].ok);
assert.deepEqual(viaModel.effects, viaBase.effects);
assert.equal(
  JSON.stringify(viaModel.world.commitments[0].state),
  JSON.stringify(viaBase.world.commitments[0].state),
);
console.log("\n   A model with no profile and no policies adds nothing. Composition,");
console.log("   not a behaviour change.");

rule("8) Deterministic, and it mutates nothing");

const d = deal({ type: "Draft" });
const evs = [{ type: "concession", commitment: d.id, kind: "offer", price: { amount: 170, currency: "MAD" }, by: seller }];
const world = worldWith(d);
const snapshot = JSON.stringify(world);
const r1 = runModel(MODEL, world, evs, { clock: FIXED });
const r2 = runModel(MODEL, world, evs, { clock: FIXED });
console.log("   two identical runs byte-for-byte equal:", JSON.stringify(r1) === JSON.stringify(r2));
console.log("   input world unmutated:                 ", JSON.stringify(world) === snapshot);
assert.equal(JSON.stringify(r1), JSON.stringify(r2));
assert.equal(JSON.stringify(world), snapshot);

rule("What this rung is, and one thing it deliberately is not");
console.log(`runModel takes ONE model object and applies every layer it declares:
the base guard, the profile constraints, the negotiation bounds, the pack. All
three classes of refusal above came from the same call over the same model, and
every check that fired already shipped — none is reimplemented here.

What it is NOT: an assertion layer. A policy's \`asserts\` list is carried as
declared intent, not a gate, because guardAction ALREADY audits all six
invariants over the whole resulting world on every action. Asserting one cannot
strengthen that, and omitting one cannot weaken it. A layer that appeared to
enforce and enforced nothing would be worse than no layer at all.

This is the runtime a \`.warp\` system will target: the model object above is
exactly what an authored file compiles to.
`);
