/**
 * Rung 5B — authoring a WEB of related commitments.
 *
 * A marketplace order is not one commitment. It is a parent the buyer pays,
 * splitting into a seller payout and a platform commission. `.warp` can now
 * author that SHAPE, and the split compiles to the model's own `parent` /
 * `children` tree.
 *
 * THE DIVISION THIS RUNG RESTS ON, and the thing to check first: the LANGUAGE
 * authors the structure; the MODEL enforces the coherence. §4 authors a
 * composition whose legs deliberately over-sum the parent. It COMPILES. It
 * BUILDS. And then `checkI6TreeConsistency` — which knows nothing about
 * compositions — refuses it. That is the design: one implementation of value
 * conservation, in the model, rather than a second copy in the compiler that has
 * to be kept in step with it.
 *
 * `packages/commerce-types` has ZERO DIFF in this rung. The tree a composition
 * builds is ordinary commitments, which is precisely why the existing checks
 * apply to it unchanged.
 *
 * Run it verbatim:  node examples/composed.mjs
 * It ASSERTS every outcome and exits non-zero if any changes.
 */
import assert from "node:assert/strict";
import {
  applyCommitmentPath,
  auditCommerce,
  checkI6TreeConsistency,
  createSession,
  newCommitment,
  partyId,
  valueId,
} from "@warp-lang/commerce-types";
import { buildComposition, compileSystem } from "../dist/index.js";

const rule = (n) => console.log("─".repeat(72), "\n" + n + "\n");
const seller = partyId("party:seller");
const buyer = partyId("party:buyer");
const platform = partyId("party:platform");
const amountOf = (c) => c.subject.requested[0].form.money.amount;

function order(total, state) {
  const c = newCommitment(buyer, seller, {
    offered: [],
    requested: [
      {
        id: valueId("value:order"),
        form: { kind: "Money", money: { amount: total, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  return state ? applyCommitmentPath(c, state, seller) : c;
}

const SOURCE = `
composition marketplace_order {
  label       "Marketplace order"
  description "A buyer's order splits into a seller payout and a platform commission."

  leg payout     { amount committed - 70 MAD }
  leg commission { amount 70 MAD }
}
`;

console.log("\nThe authored composition\n");
console.log(SOURCE.trim().split("\n").map((l) => "  " + l).join("\n"), "\n");

const system = compileSystem(SOURCE, { file: "marketplace.warp" });
const composition = system.compositions[0];

rule("1) What it authored — the SHAPE of a split, not particular commitments");

console.log("   composition:", composition.id);
for (const leg of composition.legs) {
  console.log(`   leg ${leg.name.padEnd(11)} amount = ${JSON.stringify(leg.amount.kind)}`);
}
console.log("\n   No party ids, no totals, no order numbers. Those are runtime data");
console.log("   the host supplies — exactly as events are (rung 4). A .warp file");
console.log("   with real orders baked in would be a fixture, not a system.");

rule("2) Instantiated against a real order — the model's own parent/children tree");

const parent430 = order(430);
const built = buildComposition(composition, parent430, {
  legs: { commission: { counterparty: platform } },
});
assert.ok(built.ok);
console.log("   parent:", amountOf(built.parent), "MAD");
for (const c of built.children) {
  console.log(`     └─ ${amountOf(c)} MAD   parent-linked: ${c.parent === parent430.id}`);
}
console.log("   parent.children:", built.parent.children.length, "ids");
assert.deepEqual(built.children.map(amountOf), [360, 70]);
assert.ok(built.children.every((c) => c.parent === parent430.id));
console.log("\n   430 = 360 + 70 — the marketplace shape from the case-study corpus.");
console.log("   These are ORDINARY commitments. No new structure was introduced.");

rule("3) The split follows the order — one authored rule, many trees");

for (const total of [430, 1070, 5070]) {
  const b = buildComposition(composition, order(total));
  assert.ok(b.ok);
  console.log(`   order ${String(total).padStart(4)} MAD → payout ${String(amountOf(b.children[0])).padStart(4)} + commission ${amountOf(b.children[1])}`);
}

rule("4) The DIVISION — an incoherent split compiles, and the MODEL refuses it");

const greedySrc = `
composition greedy {
  leg a { amount committed * 0.7 }
  leg b { amount committed * 0.7 }
}
`;
const greedy = compileSystem(greedySrc).compositions[0];
console.log("   authored: two legs of 0.7 each — 140% of the parent\n");
const greedyBuilt = buildComposition(greedy, order(100));
console.log("   compiles: yes");
console.log("   builds:  ", greedyBuilt.ok);
assert.equal(greedyBuilt.ok, true, "the compiler must NOT re-derive I-6");

const violations = checkI6TreeConsistency(greedyBuilt.parent, greedyBuilt.children);
console.log("\n   checkI6TreeConsistency →", violations.length, "violation");
console.log("   " + violations[0].description);
console.log("   fix: " + violations[0].fix);
assert.equal(violations.length, 1);
assert.equal(violations[0].invariant, "I-6");

const audited = auditCommerce([greedyBuilt.parent, ...greedyBuilt.children], [], []);
assert.ok(audited.some((v) => v.invariant === "I-6"));
console.log("\n   The compiler did not check the sum, deliberately. Conservation has");
console.log("   ONE implementation, in the model; a second copy in the language");
console.log("   would be one more thing to keep in step, for no gain.");

rule("5) Mixed currencies across legs — also the model's call");

const mixed = compileSystem(`
  composition c {
    leg a { amount 50 MAD }
    leg b { amount 50 EUR }
  }
`).compositions[0];
const mixedBuilt = buildComposition(mixed, order(100));
assert.ok(mixedBuilt.ok);
const mixedV = checkI6TreeConsistency(mixedBuilt.parent, mixedBuilt.children);
console.log("   " + mixedV[0].description);
assert.ok(mixedV[0].description.includes("mixed currencies"));

rule("6) The session's per-tree ledger governs the authored tree too");

const fulfil = (c) => applyCommitmentPath(c, { type: "Fulfilled" }, seller);
const world = {
  commitments: [fulfil(built.parent), ...built.children.map(fulfil)],
  fulfillments: [],
  parties: [],
};
const payoutLeg = world.commitments[1];
const session = createSession(world);
const refund = (amount, at) =>
  session.propose({
    commitment: payoutLeg.id,
    to: { type: "Refunded", amount: { amount, currency: "MAD" }, at },
    actor: seller,
  });

const first = refund(300, "2030-02-01T00:00:00.000Z");
console.log("   refund 300 of the 360 payout leg → ok =", first.ok);
assert.equal(first.ok, true);

const second = refund(200, "2030-02-02T00:00:00.000Z");
console.log("   refund a further 200            → ok =", second.ok);
console.log("   " + second.violations[0].message);
assert.equal(second.ok, false);
assert.equal(second.violations[0].rule, "I-1");
console.log("\n   The cumulative cap is the session's, applied to a tree the");
console.log("   language authored. Nothing here was taught about compositions.");

rule("What rung 5B added, and the limit it keeps");
console.log(`ADDED: .warp authors a COMPOSITION — the legs a commitment splits into, and how
each leg's amount is computed from the parent (reusing rung 5A's expressions and
its closed context, which needed no new variable to express a split). It
compiles to the model's own parent/children tree.

NOT ADDED: any coherence checking. I-6 and the session's per-tree ledger already
enforce that, and they judge an authored tree exactly as they judge a hand-built
one — §4 and §6 show both refusing one. commerce-types has zero diff.

THE LIMIT, honestly: this authors a TREE — one parent, its children — because
that is what the model's parent/children fields express and what I-6 and the
session ledger check. Arbitrary cross-order graphs (a leg belonging to two
parents, cycles) are not authorable, because the model does not represent them
and inventing syntax for a structure nothing enforces would be authoring fiction.
`);
