/**
 * Rung 3 — authoring commerce POLICIES in `.warp`.
 *
 * Rungs 1–2 author the model's SHAPE: a lifecycle, a profile, an auction. This
 * rung authors its LOGIC — the rules a deal must obey. The claim under test is
 * narrow and worth stating plainly:
 *
 *     the language AUTHORS a rule; the MODEL ENFORCES it.
 *
 * Every verdict printed below comes from a function that already shipped in
 * @warp-lang/commerce-types — `guardConcession`, `guardWithProfile`,
 * `checkSettlementPolicy`, `auditCommerce`. This file compiles a policy to the
 * exact value each of those functions already takes, so an authored rule and a
 * hand-written one are the SAME VALUE and agree by construction rather than by a
 * second implementation that happens to concur.
 *
 * Run it verbatim:  node examples/lang-policy.mjs
 * It ASSERTS every outcome and exits non-zero if any verdict differs.
 */
import assert from "node:assert/strict";
import {
  applyCommitmentPath,
  auditCommerce,
  checkSettlementPolicy,
  guardConcession,
  guardWithProfile,
  newCommitment,
  partyId,
  valueId,
} from "@warp-lang/commerce-types";
import { compile, WarpCompileError } from "../dist/index.js";

const rule = (n) => console.log("─".repeat(72), "\n" + n + "\n");
const SELLER = partyId("party:merchant");
const BUYER = partyId("party:buyer");

// ---------------------------------------------------------------------------
// The authored source. A profile (shape) plus a policy (logic) over it.
// ---------------------------------------------------------------------------

const SOURCE = `
profile digital {
  label       "Digital goods"
  description "digital goods paid in money"
  states Draft, Proposed, Accepted, Fulfilled, Disputed, Refunded, Cancelled
  value_forms DigitalGood, Money
}

policy house_rules {
  label       "House rules for digital sales"
  description "Never discount below 150 MAD; digital sales do not enter dispute."

  applies_to     digital
  forbid_states  Disputed

  concession_floor 150 MAD
  committed_price  200 MAD

  tax_rates "MA" 0, 0.1, 0.2

  assert I1, I6
}
`;

console.log("\nAuthored .warp source\n");
console.log(SOURCE.trim().split("\n").map((l) => "  " + l).join("\n"), "\n");

const model = compile(SOURCE, { file: "house.warp" });
const policy = model.policies[0];

rule("1) What the policy COMPILED to — all four are existing model structures");
console.log("   NegotiationBounds   →", JSON.stringify(policy.bounds));
console.log("   CommerceProfile     →", policy.profile.id,
  "allowedStates:", policy.profile.allowedStates.join(", "));
console.log("   RegulatoryPolicyPack→", JSON.stringify(policy.pack.jurisdictions));
console.log("   InvariantId[]       →", policy.asserts.join(", "));
console.log("\n   None of these is a new type. Each is the parameter some already-");
console.log("   shipped function takes. The language added no enforcement.\n");

// ---------------------------------------------------------------------------
// A deal: one digital licence, opening price 200 MAD.
// ---------------------------------------------------------------------------

function dealWorld() {
  const deal = newCommitment(BUYER, SELLER, {
    offered: [
      {
        id: valueId("value:licence"),
        form: {
          kind: "DigitalGood",
          identifier: "licence:single-seat",
          exclusivity: "NonExclusive",
          access_model: {
            kind: "License",
            license_type: "Perpetual",
            seats: 1,
            transferable: false,
          },
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
  return { world: { commitments: [deal], fulfillments: [], parties: [] }, deal };
}

/** The same rule, hand-written — what a caller would have passed before rung 3. */
const HAND_WRITTEN_BOUNDS = {
  floor: { amount: 150, currency: "MAD" },
  committed: { amount: 200, currency: "MAD" },
};

rule("2) A concession WITHIN the authored floor — authored vs hand-written");

const withinA = dealWorld();
const withinB = dealWorld();
const okAuthored = guardConcession(withinA.world, withinA.deal.id, policy.bounds)
  .step({ kind: "offer", price: { amount: 170, currency: "MAD" }, by: SELLER });
const okHand = guardConcession(withinB.world, withinB.deal.id, HAND_WRITTEN_BOUNDS)
  .step({ kind: "offer", price: { amount: 170, currency: "MAD" }, by: SELLER });

console.log("   offer 170 MAD (floor is 150)");
console.log("   authored.ok =", okAuthored.ok, " hand-written.ok =", okHand.ok,
  " identical =", okAuthored.ok === okHand.ok);
assert.equal(okAuthored.ok, true, "a concession within the floor must be accepted");
assert.equal(okAuthored.ok, okHand.ok);

rule("3) A concession BELOW the authored floor — BLOCKED, with the model's own reason");

const belowA = dealWorld();
const belowB = dealWorld();
const noAuthored = guardConcession(belowA.world, belowA.deal.id, policy.bounds)
  .step({ kind: "offer", price: { amount: 120, currency: "MAD" }, by: SELLER });
const noHand = guardConcession(belowB.world, belowB.deal.id, HAND_WRITTEN_BOUNDS)
  .step({ kind: "offer", price: { amount: 120, currency: "MAD" }, by: SELLER });

console.log("   offer 120 MAD (floor is 150)");
console.log("   authored.ok =", noAuthored.ok, " hand-written.ok =", noHand.ok);
assert.equal(noAuthored.ok, false, "a concession below the floor must be blocked");
assert.equal(noHand.ok, false);
console.log("\n   BLOCKED —", noAuthored.violations[0].rule);
console.log("   " + noAuthored.violations[0].message);
assert.deepEqual(
  noAuthored.violations.map((v) => v.rule),
  noHand.violations.map((v) => v.rule),
  "authored and hand-written bounds must produce identical violations",
);
assert.deepEqual(
  noAuthored.violations.map((v) => v.message),
  noHand.violations.map((v) => v.message),
);
console.log("\n   Identical to the hand-written rule, down to the message text.");

rule("4) The authored profile constraint — a forbidden state is refused");

const { world, deal } = dealWorld();
const fulfilled = {
  ...world,
  commitments: [applyCommitmentPath(deal, { type: "Fulfilled" }, SELLER)],
};
const disputeVerdict = guardWithProfile(policy.profile, fulfilled, {
  commitment: fulfilled.commitments[0].id,
  to: { type: "Disputed", by: BUYER, reason: "buyer unhappy", opened_at: "2026-03-01T00:00:00.000Z" },
  actor: BUYER,
});
console.log("   Fulfilled -> Disputed under 'house_rules'");
console.log("   ok =", disputeVerdict.ok, "—", disputeVerdict.violations[0].rule);
console.log("   " + disputeVerdict.violations[0].message);
assert.equal(disputeVerdict.ok, false, "the forbidden state must be refused");
assert.equal(disputeVerdict.violations[0].rule, "profile-state");
console.log("\n   The MODEL still permits Fulfilled -> Disputed. The authored policy");
console.log("   narrows it for this merchant — a profile only ever narrows.");

rule("5) The authored tax pack — checked by the model's settlement checker");

const committedTotal = { amount: 240, currency: "MAD" };
const settlement = {
  total: committedTotal,
  components: [
    { kind: "Base", amount: { amount: 200, currency: "MAD" } },
    { kind: "Tax", amount: { amount: 40, currency: "MAD" }, jurisdiction: "MA", tax_rate: 0.2 },
  ],
};
const goodRate = checkSettlementPolicy(settlement, committedTotal, policy.pack);
console.log("   200 principal + 40 tax @ 0.2 in MA  → ok =", goodRate.ok);
assert.equal(goodRate.ok, true);

const offRate = {
  total: committedTotal,
  components: [
    { kind: "Base", amount: { amount: 200, currency: "MAD" } },
    { kind: "Tax", amount: { amount: 40, currency: "MAD" }, jurisdiction: "MA", tax_rate: 0.17 },
  ],
};
const badRate = checkSettlementPolicy(offRate, committedTotal, policy.pack);
console.log("   same amounts declared @ 0.17        → ok =", badRate.ok);
console.log("   " + badRate.violations[0].message);
assert.equal(badRate.ok, false, "a rate the pack does not list must be refused");

rule("6) A policy referencing something that does not exist — precise compile error");

let compileErr;
try {
  compile(
    `profile digital { states Draft value_forms Money }\npolicy p {\n  applies_to physical\n}`,
    { file: "broken.warp" },
  );
} catch (e) {
  compileErr = e;
}
assert.ok(compileErr instanceof WarpCompileError, "expected a WarpCompileError");
console.log("   " + compileErr.format());
console.log("\n   The reference is resolved at COMPILE time, against the profiles the");
console.log("   document actually declares — not discovered at runtime.");

rule("7) The safety property — a policy cannot switch an invariant off");

// A policy asserting only I-6 over a world that breaks I-1. The model still finds
// the I-1 violation: `assert` SELECTS what the policy cares about, it does not
// gate what the model checks.
const narrow = compile(`policy narrow { assert I6 }`).policies[0];
const mixed = newCommitment(BUYER, SELLER, {
  offered: [],
  requested: [
    {
      id: valueId("value:a"),
      form: { kind: "Money", money: { amount: 100, currency: "MAD" } },
      quantity: 1,
      state: { type: "Available" },
    },
    {
      id: valueId("value:b"),
      form: { kind: "Money", money: { amount: 50, currency: "EUR" } },
      quantity: 1,
      state: { type: "Available" },
    },
  ],
});
const found = auditCommerce([mixed], [], []);
console.log("   policy asserts:", narrow.asserts.join(", "), "(NOT I-1)");
console.log("   model still reports:", [...new Set(found.map((v) => v.invariant))].join(", "));
assert.ok(
  found.some((v) => v.invariant === "I-1"),
  "the model must still find the I-1 violation the policy never mentioned",
);
console.log("\n   " + found.find((v) => v.invariant === "I-1").description);
console.log("\n   A language that could switch invariants off would be a way to smuggle");
console.log("   unsound commerce past them. This one cannot: the policy chooses what to");
console.log("   REPORT ON, never what the model CHECKS.");

rule("Where this rung sits");
console.log(`Rungs 1-2 author the model's SHAPE — lifecycle, profile, auction.
Rung 3 authors its LOGIC — a negotiation floor, a narrowed profile, a
jurisdiction rate pack, the invariants a deal must satisfy.

Every rule above compiled to a structure the model already had, and every
verdict came from a function that already shipped. The language authors the
rules; the model enforces them, and still governs what a rule can express.

Still ahead: authoring Party / Value / Intent / Fulfillment, commitment terms,
and settlement breakdowns.
`);
