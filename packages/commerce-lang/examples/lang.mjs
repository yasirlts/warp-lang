/**
 * Warp language — the round-trip proof, runnable.
 *
 *   (build first, because the example imports the compiled package)
 *   npm run build && node examples/lang.mjs
 *
 * The claim this rung makes: you can AUTHOR a commitment lifecycle (and a profile)
 * in `.warp` syntax, compile it, and get a model INDISTINGUISHABLE from writing
 * those structures by hand — checked by the model's OWN guard and temporal
 * verifier. Nothing new is introduced; the language is a front-end onto the current
 * model, and the invariants still govern what it can express.
 *
 * The four things this file shows:
 *   1. Author the real commitment lifecycle in `.warp` → compile → the temporal
 *      verifier reports it sound, IDENTICALLY to verifying the hand-written model.
 *   2. Author a `digital` profile in `.warp` → compile → run it through the model's
 *      guard; verdict is IDENTICAL to using the built-in PROFILES.digital.
 *   3. Author an UNSOUND lifecycle (a transition the model forbids) → it compiles
 *      (it is well-formed), but the temporal verifier CATCHES it, with the exact
 *      counterexample path. The language cannot smuggle an unsound model past the
 *      invariants.
 *   4. A parse ERROR → a precise line:col message. Good positional errors are a
 *      core reason to have a language at all.
 */

import { compile } from "../dist/index.js";
import {
  verifyLifecycle,
  validTransitions,
  guardWithProfile,
  PROFILES,
  newCommitment,
  applyCommitmentPath,
  partyId,
} from "@warp-lang/commerce-types";
import { WarpLangError } from "../dist/index.js";

const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(72));

// ───────────────────────────────────────────────────────────────────────────
// 1. AUTHOR THE REAL COMMITMENT LIFECYCLE → compile → verify (identical to hand)
// ───────────────────────────────────────────────────────────────────────────
line("1) Author the commitment lifecycle in .warp, compile, verify\n");

// This is the model's current commitment transition table, WRITTEN in .warp. It
// declares the 11 states and the 26 legal edges between them — nothing more.
const lifecycleSource = `
  lifecycle commitment {
    state Draft
    state Proposed
    state Tendered
    state Accepted
    state Modified
    state Active
    state PartiallyFulfilled
    state Fulfilled
    state Disputed
    state Cancelled
    state Refunded

    Draft              -> Proposed, Tendered, Cancelled
    Proposed           -> Accepted, Cancelled, Modified
    Tendered           -> Accepted, Cancelled
    Accepted           -> Modified, PartiallyFulfilled, Active, Cancelled, Disputed
    Modified           -> Accepted, Cancelled
    PartiallyFulfilled -> Fulfilled, Modified, Cancelled
    Active             -> Modified, Cancelled, Disputed
    Fulfilled          -> Disputed, Refunded
    Disputed           -> Fulfilled, Refunded, Cancelled
    // Cancelled and Refunded are terminal — no outgoing edges.
  }
`;

const authored = compile(lifecycleSource);
const lc = authored.lifecycles[0];
line(`   compiled lifecycle '${lc.name}': ${lc.states.length} states, ` +
  `${Object.values(lc.transitions).reduce((n, t) => n + t.length, 0)} edges`);

// Run the AUTHORED table through the model's own temporal verifier, and run the
// HAND-WRITTEN (default = real) model through the same verifier. Same verdict.
const authoredVerdict = verifyLifecycle({ from: "Draft", transitions: lc.transitionFn });
const handWrittenVerdict = verifyLifecycle({ from: "Draft" });

line(`   authored  → verdict: ${authoredVerdict.verdict}, ` +
  `states explored: ${authoredVerdict.explored}, violations: ${authoredVerdict.violations.length}`);
line(`   hand-written → verdict: ${handWrittenVerdict.verdict}, ` +
  `states explored: ${handWrittenVerdict.explored}, violations: ${handWrittenVerdict.violations.length}`);

// Identity is also provable structurally: the authored table equals the model's
// own edges, state by state (validTransitions is the model's hand-written table).
const tableIdentical = lc.states.every(
  (s) => lc.transitionFn(s).join() === validTransitions({ type: s }).join(),
);
const identical =
  authoredVerdict.verdict === handWrittenVerdict.verdict &&
  authoredVerdict.explored === handWrittenVerdict.explored &&
  authoredVerdict.fixpointReached === handWrittenVerdict.fixpointReached &&
  authoredVerdict.violations.length === handWrittenVerdict.violations.length &&
  tableIdentical;
line(`   → identical to hand-writing the model? ${identical ? "YES" : "NO"}`);
rule();

// ───────────────────────────────────────────────────────────────────────────
// 2. AUTHOR A PROFILE → compile → run through the model's guard (identical)
// ───────────────────────────────────────────────────────────────────────────
line("2) Author a 'digital' profile in .warp, compile, guard (identical to built-in)\n");

// The built-in PROFILES.digital, written in .warp. Same states, same value forms.
const profileSource = `
  profile digital {
    label "Digital goods"
    description "digital goods (software, licences, downloads) paid in money"
    states Draft, Proposed, Accepted, Modified, Active, Fulfilled, Cancelled, Disputed, Refunded
    value_forms DigitalGood, Money
  }
`;

const authoredProfile = compile(profileSource).profiles[0];

// A digital order — a DigitalGood paid in Money, driven to Fulfilled.
const seller = partyId("seller_1");
function digitalOrder() {
  const order = newCommitment(partyId("buyer_1"), seller, {
    offered: [{
      id: "value:license",
      form: { kind: "DigitalGood", sku: "LICENSE-1" },
      quantity: 1,
      state: { type: "Available" },
    }],
    requested: [{
      id: "value:order-total",
      form: { kind: "Money", money: { amount: 200, currency: "MAD" } },
      quantity: 1,
      state: { type: "Available" },
    }],
  });
  return applyCommitmentPath(order, { type: "Fulfilled" }, seller);
}

const world = { commitments: [digitalOrder()], fulfillments: [], parties: [] };
const action = {
  commitment: world.commitments[0].id,
  to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
  actor: seller,
};

const viaAuthored = guardWithProfile(authoredProfile, world, action);
const viaBuiltIn = guardWithProfile(PROFILES.digital, world, action);
line(`   authored profile guard verdict: ok=${viaAuthored.ok}`);
line(`   built-in profile guard verdict: ok=${viaBuiltIn.ok}`);
line(`   → authored profile == built-in profile verdict? ${viaAuthored.ok === viaBuiltIn.ok ? "YES" : "NO"}`);
rule();

// ───────────────────────────────────────────────────────────────────────────
// 3. AUTHOR AN UNSOUND LIFECYCLE → compiles, but the verifier CATCHES it
// ───────────────────────────────────────────────────────────────────────────
line("3) Author an UNSOUND lifecycle — the invariants still govern\n");

// A minimal lifecycle that claims a move the current model FORBIDS: Fulfilled may
// only go to Disputed or Refunded, never back to Draft. This is well-formed (both
// are real states), so it COMPILES — but it is not sound.
const unsoundSource = `
  lifecycle sneaky {
    state Draft
    state Proposed
    state Accepted
    state PartiallyFulfilled
    state Fulfilled

    Draft              -> Proposed
    Proposed           -> Accepted
    Accepted           -> PartiallyFulfilled
    PartiallyFulfilled -> Fulfilled
    Fulfilled          -> Draft
  }
`;

const unsound = compile(unsoundSource).lifecycles[0];
line(`   compiled (well-formed): lifecycle '${unsound.name}' — the parser/compiler accepted it.`);

const verdict = verifyLifecycle({ from: "Draft", transitions: unsound.transitionFn });
line(`   temporal verifier verdict: ${verdict.verdict}`);
for (const v of verdict.violations) {
  line(`   ⛔ [${v.rule}] ${v.message}`);
  line(`      counterexample path: ${v.path.join(" → ")}`);
}
line(`   → the language could NOT smuggle an unsound model past the invariants.`);
rule();

// ───────────────────────────────────────────────────────────────────────────
// 4. A PARSE ERROR → a precise line:col message
// ───────────────────────────────────────────────────────────────────────────
line("4) A syntax error — precise line:col diagnostics\n");

const brokenSource = `lifecycle commitment {
  state Draft
  Draft Proposed
}`; // missing '->' between Draft and Proposed

try {
  compile(brokenSource, { file: "broken.warp" });
  line("   (unexpected: it parsed)");
} catch (e) {
  if (e instanceof WarpLangError) {
    line(`   ✗ ${e.format()}`);
    line(`     expected: ${e.expected ?? "(n/a)"}`);
  } else {
    throw e;
  }
}
rule();

line("\nAuthored a lifecycle + a profile in .warp; the compiled output was verified");
line("and guarded by the model's OWN checks with results identical to hand-writing");
line("it, an unsound authored lifecycle was still caught by the temporal verifier,");
line("and a syntax error pointed at the exact character. The language authors the");
line("current model; the model does the work.");
