/**
 * Warp language — the market-making round-trip, runnable.
 *
 *   (build first, because the example imports the compiled package)
 *   npm run build && node examples/lang-auction.mjs
 *
 * The claim this rung makes: the FULL current model can be authored in `.warp` —
 * including the market-making constructs (the `Tendered` commitment state and the
 * `AuctionProcess` auxiliary record) — and what compiles out is INDISTINGUISHABLE
 * from writing those structures by hand, as judged by the model's OWN guard and
 * temporal verifier. The language adds no semantics; the invariants govern.
 *
 * The five things this file shows:
 *   1. Author a market-making lifecycle (Draft → Tendered → Accepted → …) in
 *      `.warp` → compile → the temporal verifier explores it to a FIXPOINT and
 *      reports it sound, with every edge one the model itself permits.
 *   2. Author an auction → compile → an `AuctionProcess` identical to the
 *      hand-written record, the `Tendered` state of each open offer, and the
 *      `UnderAuction` value state the subject carries while the auction is open.
 *   3. Run an authored tender through the model's GUARD and get verdicts identical
 *      to the hand-written tender — on a legal move and on an illegal one.
 *   4. Author an UNSOUND market-making lifecycle (Tendered → Fulfilled, which skips
 *      the commitment) → it compiles, because it is well-formed — and the temporal
 *      verifier CATCHES it with the exact counterexample path.
 *   5. A parse ERROR → a precise line:col message pointing at the offending char.
 */

import { compile, WarpLangError } from "../dist/index.js";
import {
  verifyLifecycle,
  validTransitions,
  guardAction,
  newCommitment,
  applyCommitmentPath,
  partyId,
} from "@warp-lang/commerce-types";

const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(72));
const show = (o) => line(JSON.stringify(o, null, 2).split("\n").map((l) => "    " + l).join("\n"));

const OPENS = "2026-03-01T09:00:00.000Z";
const CLOSES = "2026-03-07T17:00:00.000Z";

// ───────────────────────────────────────────────────────────────────────────
// 1. AUTHOR A MARKET-MAKING LIFECYCLE → compile → verify
// ───────────────────────────────────────────────────────────────────────────
line("1) Author a market-making lifecycle in .warp, compile, verify\n");

// The market-making path through the model: an offer is TENDERED (an open offer
// whose counterparty a mechanism will determine), the auction picks the winner,
// and the winning commitment is accepted and fulfilled.
const lifecycleSource = `
  lifecycle marketmaking {
    state Draft
    state Tendered
    state Accepted
    state PartiallyFulfilled
    state Fulfilled
    state Cancelled

    Draft              -> Tendered, Cancelled
    Tendered           -> Accepted, Cancelled
    Accepted           -> PartiallyFulfilled, Cancelled
    PartiallyFulfilled -> Fulfilled, Cancelled
  }
`;

const lifecycle = compile(lifecycleSource).lifecycles[0];
line(`   authored lifecycle '${lifecycle.name}' with ${lifecycle.states.length} states`);

// Every authored edge is checked against the model's OWN table — the compiler did
// not decide this, `validTransitions` did.
let everyEdgeReal = true;
for (const s of lifecycle.states) {
  const model = validTransitions({ type: s });
  for (const t of lifecycle.transitionFn(s)) if (!model.includes(t)) everyEdgeReal = false;
}
line(`   every authored edge is one the model permits: ${everyEdgeReal}`);

const verdict = verifyLifecycle({ from: "Draft", transitions: lifecycle.transitionFn });
line(`   temporal verifier: verdict=${verdict.verdict}, explored=${verdict.explored}, ` +
  `fixpoint=${verdict.fixpointReached}, violations=${verdict.violations.length}`);
rule();

// ───────────────────────────────────────────────────────────────────────────
// 2. AUTHOR AN AUCTION → compile → the model's auxiliary record
// ───────────────────────────────────────────────────────────────────────────
line("\n2) Author an auction in .warp → the model's AuctionProcess\n");

// An English auction for a spectrum block, with two open offers. `auction` authors
// a REFERENCE to the model's existing auxiliary coordination record — it does not
// reinvent one. AuctionProcess is not a sixth primitive.
const auctionSource = `
  auction "auction:spectrum-2026-a" {
    subject   "value:spectrum-block-a"
    seller    "party:regulator"
    opens_at  "${OPENS}"
    closes_at "${CLOSES}"

    mechanism English {
      reserve_price 1000000 MAD
      increment       50000 MAD
    }

    tender "commitment:bid-nortel" { offer 1050000 MAD  closes_at "${CLOSES}" }
    tender "commitment:bid-atlas"  { offer 1100000 MAD  closes_at "${CLOSES}" }

    state Closed {
      reason        NormalClose
      winner        "commitment:bid-atlas"
      winning_price 1100000 MAD
    }
  }
`;

const auction = compile(auctionSource).auctions[0];
line("   compiled AuctionProcess (the model's auxiliary record):");
show(auction.process);
line("\n   each tender lowered to the model's Tendered commitment state:");
show(auction.tenders.map((t) => ({ commitment: t.commitment, state: t.state })));

// The subject's value state is the model's UnderAuction — but only while the
// auction is OPEN. This one has closed, so its subject is no longer under auction.
line(`\n   subject value state (auction is Closed): ${JSON.stringify(auction.subjectState)}`);
const openAuction = compile(`
  auction "auction:open-lot" {
    subject "value:lot-7" seller "party:house"
    opens_at "${OPENS}" closes_at "${CLOSES}"
    mechanism Vickrey { reserve_price 500 EUR }
    state Open
  }
`).auctions[0];
line("   the same subject while the auction is OPEN:");
show(openAuction.subjectState);
rule();

// ───────────────────────────────────────────────────────────────────────────
// 3. THE ROUND TRIP — an authored tender vs a hand-written one, through the guard
// ───────────────────────────────────────────────────────────────────────────
line("\n3) Authored tender vs hand-written tender — identical guard verdicts\n");

const seller = partyId("party:regulator");
const authoredTender = auction.tenders[1].state; // the winning bid, from .warp

// The same state, hand-written. If these differ, everything below is meaningless.
const handWrittenTender = {
  type: "Tendered",
  offer_amount: 1100000,
  offer_currency: "MAD",
  closes_at: CLOSES,
};
line(`   authored state === hand-written state: ` +
  `${JSON.stringify(authoredTender) === JSON.stringify(handWrittenTender)}`);

const worldIn = (state) => ({
  commitments: [applyCommitmentPath(newCommitment(partyId("party:atlas"), seller), state, seller)],
  fulfillments: [],
  parties: [],
});
const move = (world, to) =>
  guardAction(world, { commitment: world.commitments[0].id, to, actor: seller });

// A LEGAL move: the auction closed, so the winning tender is accepted.
const legalA = move(worldIn(authoredTender), { type: "Accepted" });
const legalB = move(worldIn(handWrittenTender), { type: "Accepted" });
line(`   Tendered -> Accepted   authored.ok=${legalA.ok}  hand-written.ok=${legalB.ok}  ` +
  `identical=${legalA.ok === legalB.ok}`);

// An ILLEGAL move: you cannot jump from an open offer straight to Fulfilled.
const badA = move(worldIn(authoredTender), { type: "Fulfilled" });
const badB = move(worldIn(handWrittenTender), { type: "Fulfilled" });
line(`   Tendered -> Fulfilled  authored.ok=${badA.ok}  hand-written.ok=${badB.ok}  ` +
  `identical=${badA.ok === badB.ok}`);
if (!badA.ok) {
  line(`   rejected by ${badA.violations.map((v) => v.rule).join(", ")} — ` +
    `${badA.violations[0].message}`);
  line(`   the model's planning oracle offers: ` +
    `${(badA.alternatives ?? []).map((a) => a.to ?? a).join(", ")}`);
}
rule();

// ───────────────────────────────────────────────────────────────────────────
// 4. AN UNSOUND AUTHORED MODEL STILL CANNOT GET PAST THE INVARIANTS
// ───────────────────────────────────────────────────────────────────────────
line("\n4) Author an UNSOUND market-making lifecycle — the verifier catches it\n");

// Tendered -> Fulfilled skips the commitment entirely. Both states are REAL, so
// the document is well-formed and COMPILES. Well-formed is not sound.
const rigged = compile(`
  lifecycle rigged {
    state Draft
    state Tendered
    state Fulfilled
    Draft    -> Tendered
    Tendered -> Fulfilled
  }
`).lifecycles[0];
line("   it compiled (it is well-formed — every state is a real model state)");

const caught = verifyLifecycle({ from: "Draft", transitions: rigged.transitionFn });
line(`   temporal verifier: verdict=${caught.verdict}`);
for (const v of caught.violations) {
  line(`   ${v.rule}: ${v.path.join(" → ")}`);
  line(`        ${v.message}`);
}
line("\n   The language cannot smuggle an unsound model past the invariants.");
rule();

// ───────────────────────────────────────────────────────────────────────────
// 5. A PARSE ERROR POINTS AT THE EXACT CHARACTER
// ───────────────────────────────────────────────────────────────────────────
line("\n5) A syntax error points at the exact character\n");

// A money amount with no currency code — Invariant 1 says an amount alone is
// meaningless, and the grammar cannot express one.
const broken = `auction "a" {
  mechanism English { reserve_price 100 }
}`;
try {
  compile(broken, { file: "broken.warp" });
  line("   (unexpected: it parsed)");
} catch (e) {
  if (!(e instanceof WarpLangError)) throw e;
  line(`   ${e.format()}`);
  line(`   expected: ${e.expected}`);
  const offending = broken.split("\n")[e.line - 1];
  line(`\n   ${offending}`);
  line(`   ${" ".repeat(e.column - 1)}^`);
}
rule();

line("\nAuthored the whole commitment lifecycle — including market-making — and every");
line("verdict came from the model's own verifier and guard, not from the language.");
