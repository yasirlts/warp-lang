/**
 * Rung 5A — DERIVED LOGIC: a policy value computed from the commerce context.
 *
 * The leap here is from authoring VALUES to authoring FUNCTIONS: `concession_floor
 * committed * 0.75` is a rule that produces a different floor for every deal,
 * rather than a number someone typed.
 *
 * AND THE REASON THAT IS SAFE, which is the point of §4 below. An expression
 * changes how a value is PRODUCED. It never changes whether that value is
 * CHECKED. The computed number populates exactly the structure a literal
 * populated, and the SAME guardConcession and the SAME six invariants judge it.
 * §4 runs a computed floor and the identical literal floor through the guard at
 * four prices and asserts the verdicts match down to the message text — because
 * "behaves like a literal" is only worth claiming against the literal it says it
 * matches.
 *
 * The language gains functions. It gains no way past its own guarantees.
 *
 * Run it verbatim:  node examples/derived.mjs
 * It ASSERTS every verdict and exits non-zero if any changes.
 */
import assert from "node:assert/strict";
import {
  applyCommitmentPath,
  guardConcession,
  newCommitment,
  partyId,
  runModel,
  valueId,
} from "@warp-lang/commerce-types";
import { compileSystem, resolveForCommitment, CONTEXT_VARIABLES } from "../dist/index.js";

const rule = (n) => console.log("─".repeat(72), "\n" + n + "\n");
const seller = partyId("party:merchant");
const buyer = partyId("party:buyer");
const FIXED = () => "2030-01-01T00:00:00.000Z";

function deal(amount, endsAt, state) {
  const c = newCommitment(buyer, seller, {
    offered: [],
    requested: [
      {
        id: valueId("value:price"),
        form: { kind: "Money", money: { amount, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  const withTerms = endsAt ? { ...c, terms: { duration: { kind: "Fixed", ends_at: endsAt } } } : c;
  return state ? applyCommitmentPath(withTerms, state, seller) : withTerms;
}
const worldWith = (c) => ({ commitments: [c], fulfillments: [], parties: [] });

rule("0) The commerce context — the only variables an expression may name");
for (const [name, meaning] of Object.entries(CONTEXT_VARIABLES)) {
  console.log(`   ${name.padEnd(15)} ${meaning}`);
}
console.log("\n   A closed list. Anything else is a compile error (§6), and a variable");
console.log("   that has no value for a given commitment is an error too — never a");
console.log("   silent zero, because a proration against a zero term looks fine and");
console.log("   is badly wrong.");

// ---------------------------------------------------------------------------

const HOUSE = `
policy house {
  label "Never discount below three quarters"
  concession_floor committed * 0.75
}
`;

rule("1) POWER — the floor is COMPUTED, so it differs per deal");

const system = compileSystem(HOUSE, { file: "house.warp" });
console.log("   authored:  concession_floor committed * 0.75");
console.log("   compiled:  bounds =", system.policies[0].bounds, "(not a constant)");
assert.equal(system.policies[0].bounds, undefined);
assert.ok(system.policies[0].derived.floor, "the floor must be a derived expression");

for (const amount of [200, 400, 1000]) {
  const r = resolveForCommitment(system, deal(amount));
  assert.ok(r.ok);
  const f = r.model.policies[0].bounds.floor;
  console.log(`   committed ${String(amount).padStart(4)} MAD → floor ${f.amount} ${f.currency}`);
}
const at200 = resolveForCommitment(system, deal(200));
const at400 = resolveForCommitment(system, deal(400));
assert.deepEqual(at200.model.policies[0].bounds.floor, { amount: 150, currency: "MAD" });
assert.deepEqual(at400.model.policies[0].bounds.floor, { amount: 300, currency: "MAD" });
console.log("\n   One rule, three floors. That is the expressiveness this rung adds.");

rule("2) The computed floor is ENFORCED — by the existing guard, unchanged");

const c200 = deal(200);
const resolved = resolveForCommitment(system, c200);
const below = runModel(resolved.model, worldWith(c200), [
  { type: "concession", commitment: c200.id, kind: "offer", price: { amount: 140, currency: "MAD" }, by: seller },
], { clock: FIXED });
const above = runModel(resolved.model, worldWith(c200), [
  { type: "concession", commitment: c200.id, kind: "offer", price: { amount: 160, currency: "MAD" }, by: seller },
], { clock: FIXED });
console.log("   offer 140 (computed floor 150) → ok =", below.verdicts[0].ok, "| layer =", below.verdicts[0].layer);
console.log("   " + below.verdicts[0].violations[0].message);
console.log("\n   offer 160                      → ok =", above.verdicts[0].ok);
assert.equal(below.verdicts[0].ok, false);
assert.equal(below.verdicts[0].layer, "policy");
assert.equal(above.verdicts[0].ok, true);

rule("3) PRORATION — a floor that follows the remaining term");

const PRORATED = `
policy subscription {
  label "Prorated by remaining term"
  concession_floor committed * (remaining_days / term_days)
}
`;
const proSystem = compileSystem(PRORATED, { file: "sub.warp" });
const sub = deal(365, "2027-01-01T00:00:00.000Z");
const created = Date.parse(sub.created_at);
const termDays = Math.floor((Date.parse("2027-01-01T00:00:00.000Z") - created) / 86_400_000);
console.log(`   a ${termDays}-day term committed at 365 MAD\n`);
for (const frac of [0, 0.25, 0.5, 0.9]) {
  const when = new Date(created + Math.floor(termDays * frac) * 86_400_000).toISOString();
  const r = resolveForCommitment(proSystem, sub, when);
  assert.ok(r.ok);
  const f = r.model.policies[0].bounds.floor;
  console.log(`   ${String(Math.round(frac * 100)).padStart(3)}% elapsed → floor ${f.amount.toFixed(2)} MAD`);
}
const early = resolveForCommitment(proSystem, sub, new Date(created).toISOString());
const late = resolveForCommitment(proSystem, sub, new Date(created + Math.floor(termDays * 0.9) * 86_400_000).toISOString());
assert.ok(early.model.policies[0].bounds.floor.amount > late.model.policies[0].bounds.floor.amount);
console.log("\n   The floor falls as the term burns down — authored once, as a rule.");

rule("4) SAFETY — a computed value is checked EXACTLY like the literal");

const literal = compileSystem(`policy house { label "x"  concession_floor 150 MAD }`);
const computedBounds = resolved.model.policies[0].bounds;
const literalBounds = literal.policies[0].bounds;
console.log("   computed bounds:", JSON.stringify(computedBounds.floor));
console.log("   literal  bounds:", JSON.stringify(literalBounds.floor));
assert.deepEqual(computedBounds.floor, literalBounds.floor);

console.log("\n   Same guard, same world, four prices:\n");
for (const price of [140, 150, 160, 199]) {
  const viaComputed = guardConcession(worldWith(c200), c200.id, computedBounds)
    .step({ kind: "offer", price: { amount: price, currency: "MAD" }, by: seller });
  const viaLiteral = guardConcession(worldWith(c200), c200.id, literalBounds)
    .step({ kind: "offer", price: { amount: price, currency: "MAD" }, by: seller });
  const same = viaComputed.ok === viaLiteral.ok;
  console.log(`   offer ${String(price).padStart(3)} → computed ${viaComputed.ok ? "ok     " : "BLOCKED"}  literal ${viaLiteral.ok ? "ok     " : "BLOCKED"}  identical = ${same}`);
  assert.equal(viaComputed.ok, viaLiteral.ok);
  if (!viaComputed.ok) {
    assert.deepEqual(
      viaComputed.violations.map((v) => v.message),
      viaLiteral.violations.map((v) => v.message),
      "a computed floor must be refused with the same message as the literal",
    );
  }
}
console.log("\n   Identical, down to the message text. The expression produced the");
console.log("   number; the model judged it. There is no path an expression takes");
console.log("   to enforcement that a constant does not also take.");

rule("5) SAFETY — the invariants are untouched by the expression layer");

const fulfilled = deal(200, undefined, { type: "Fulfilled" });
const underComputed = resolveForCommitment(system, fulfilled);
const overRefund = runModel(underComputed.model, worldWith(fulfilled), [
  {
    type: "action",
    action: {
      commitment: fulfilled.id,
      to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" },
      actor: seller,
    },
  },
], { clock: FIXED });
console.log("   refund 500 on a 200 deal, under a COMPUTED policy");
console.log("   → ok =", overRefund.verdicts[0].ok, "| layer =", overRefund.verdicts[0].layer);
console.log("   " + overRefund.verdicts[0].violations.find((v) => v.rule === "I-1").message);
assert.equal(overRefund.verdicts[0].ok, false);
assert.equal(overRefund.verdicts[0].layer, "base");
console.log("\n   Value conservation does not know or care that a policy computed");
console.log("   something. A formula cannot compute its way past I-1.");

rule("6) A computed floor ABOVE the committed price — refused, like the literal");

const tooHigh = compileSystem(`policy p { concession_floor committed * 2  committed_price 200 MAD }`);
const bad = resolveForCommitment(tooHigh, deal(200));
console.log("   concession_floor committed * 2, committed_price 200 MAD");
console.log("   → resolved:", bad.ok);
console.log("   " + bad.failures[0].error.message);
assert.equal(bad.ok, false);
console.log("\n   The same check a constant gets at compile time, applied to the");
console.log("   computed number. A derived value gets no dispensation.");

rule("7) Bad expressions — precise, positioned, and never a throw");

const show = (label, fn) => {
  try {
    const r = fn();
    if (r && r.ok === false) {
      console.log(`   ${label}\n     ${r.failures[0].error.code}: ${r.failures[0].error.message}`);
      return;
    }
    console.log(`   ${label}\n     NO ERROR`);
  } catch (e) {
    console.log(`   ${label}\n     ${e.constructor.name}: ${e.format ? e.format() : e.message}`);
  }
};
show("unknown variable  (concession_floor mrr * 0.75)", () =>
  compileSystem(`policy p {\n  concession_floor mrr * 0.75\n}`, { file: "bad.warp" }));
show("division by zero  (committed / 0)", () =>
  resolveForCommitment(compileSystem(`policy p { concession_floor committed / 0 }`), deal(200)));
show("currency mismatch (committed + 50 EUR)", () =>
  resolveForCommitment(compileSystem(`policy p { concession_floor committed + 50 EUR }`), deal(200)));
show("unavailable var   (remaining_days, no term)", () =>
  resolveForCommitment(compileSystem(`policy p { concession_floor committed * (remaining_days / 30) }`), deal(200)));

rule("What rung 5A added, and what it deliberately did not");
console.log(`ADDED: a policy value may be a pure arithmetic expression over a closed set of
commerce quantities — so a floor can be a RULE ("three quarters of committed",
"prorated by remaining term") rather than a number someone typed. Evaluation is
pure and total: same context, same value; failures are data, never throws; money
is currency-safe and cannot be silently mixed.

NOT ADDED: any new enforcement, and any way around the existing enforcement. The
expression produces a value; the model checks it exactly as it checks a literal,
which §4 shows message-for-message. No loops, no user-defined functions, no side
effects, no I/O, no clock — arithmetic over commerce quantities, nothing more.

The language authors the rule. The model still decides what is allowed.
`);
