/**
 * Rung 4c — an authored auction that RUNS.
 *
 * Rung 4 closed with an honest gap: a `.warp` auction compiled, but the engine
 * had no auction layer, so it was inert data. This closes it. `compileSystem`
 * puts the authored `AuctionProcess` on `model.auction`, and `runModel` checks
 * every event's resulting world for RESOLUTION SOUNDNESS.
 *
 * WHY THE LAYER IS NOT A RUBBER STAMP — the thing worth checking first. The six
 * invariants do not catch an unsound auction. §1 below runs `auditCommerce` over
 * a world where the winner is Accepted and a losing bidder is left dangling in
 * `Tendered`, and over a world with TWO winners. Both return ZERO violations.
 * Both are unsound. That is why this layer exists, and it is the reason to
 * believe it is doing work rather than nodding along.
 *
 * WHAT IT DOES NOT JUDGE. Whether a mechanism produced a *good* price. A Vickrey
 * auction clearing below the winning bid is sound and passes (§6). Only the rule
 * that holds regardless of mechanism is enforced: you cannot be charged more than
 * you bid.
 *
 * Run it verbatim:  node examples/auction-run.mjs
 * It ASSERTS every verdict and exits non-zero if any changes.
 */
import assert from "node:assert/strict";
import {
  applyCommitmentPath,
  auditCommerce,
  newCommitment,
  partyId,
  runModel,
  valueId,
} from "@warp-lang/commerce-types";
import { compileSystem } from "../dist/index.js";

const rule = (n) => console.log("─".repeat(72), "\n" + n + "\n");
const seller = partyId("party:auc-seller");
const bidderA = partyId("party:bidder-a");
const bidderB = partyId("party:bidder-b");
const CLOSES = "2026-03-10T20:00:00.000Z";
const FIXED = () => "2030-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Two bids, built the way a real bid is built: through Tendered.
// ---------------------------------------------------------------------------

function bid(who, amount, finalState) {
  const c = newCommitment(who, seller, {
    offered: [],
    requested: [
      {
        id: valueId(`value:bid-${amount}`),
        form: { kind: "Money", money: { amount, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  const tender = applyCommitmentPath(
    c,
    { type: "Tendered", offer_amount: amount, offer_currency: "MAD", closes_at: CLOSES },
    seller,
  );
  return finalState ? applyCommitmentPath(tender, finalState, seller) : tender;
}
const worldOf = (...cs) => ({ commitments: cs, fulfillments: [], parties: [] });

rule("1) Why this layer exists — the six invariants do NOT catch an unsound auction");

const awarded = bid(bidderB, 12000, { type: "Accepted" });
const dangling = bid(bidderA, 10000);
console.log("   world: winner Accepted, loser left dangling in Tendered");
console.log("   auditCommerce violations:", auditCommerce([awarded, dangling], [], []).length);
assert.equal(auditCommerce([awarded, dangling], [], []).length, 0);

const twoWinners = [bid(bidderA, 10000, { type: "Accepted" }), bid(bidderB, 12000, { type: "Accepted" })];
console.log("   world: TWO awarded bids from one auction");
console.log("   auditCommerce violations:", auditCommerce(twoWinners, [], []).length);
assert.equal(auditCommerce(twoWinners, [], []).length, 0);
console.log("\n   Zero, both times. Both worlds are unsound. The invariants have");
console.log("   nothing to say about an abandoned tender or a double award, which");
console.log("   is precisely the gap this layer fills — it is not restating I-1..I-6.");

// ---------------------------------------------------------------------------
// The authored system.
// ---------------------------------------------------------------------------

const loserBid = bid(bidderA, 10000);
const winnerBid = bid(bidderB, 12000);

const SOURCE = `
profile auction_house {
  label       "Auction house"
  description "art sold at auction, paid in money"
  states Draft, Tendered, Accepted, PartiallyFulfilled, Fulfilled, Cancelled, Refunded
  value_forms PhysicalGood, Money
}

auction "auction:painting" {
  subject   "value:painting"
  seller    "party:auc-seller"
  opens_at  "2026-03-10T08:00:00.000Z"
  closes_at "${CLOSES}"

  mechanism English {
    reserve_price 8000 MAD
    increment      500 MAD
  }

  tender "${loserBid.id}"  { offer 10000 MAD  closes_at "${CLOSES}" }
  tender "${winnerBid.id}" { offer 12000 MAD  closes_at "${CLOSES}" }

  state Closed {
    reason        NormalClose
    winner        "${winnerBid.id}"
    winning_price 12000 MAD
  }
}
`;

const { model } = compileSystem(SOURCE, { file: "auction.warp" });

rule("2) The authored auction is now ON the model — it runs, it is not inert data");

console.log("   model.auction.id:      ", model.auction.id);
console.log("   mechanism:             ", model.auction.mechanism.kind);
console.log("   tendered_commitments:  ", model.auction.tendered_commitments.length, "bids");
console.log("   declared winner:       ", model.auction.state.winning_commitment.slice(0, 8) + "…");
console.log("   winning_price:         ", `${model.auction.state.winning_price.amount} ${model.auction.state.winning_price.currency}`);
assert.ok(model.auction, "the authored auction must be on the model");

rule("3) UNSOUND — award the winner while the loser still dangles");

const award = (c) => ({ type: "action", action: { commitment: c.id, to: { type: "Accepted" }, actor: seller } });
const premature = runModel(model, worldOf(winnerBid, loserBid), [award(winnerBid)], { clock: FIXED });
const pv = premature.verdicts[0];
console.log("   accept the winning bid → ok =", pv.ok, "| layer =", pv.layer, "| rule =", pv.violations[0].rule);
console.log("   " + pv.violations[0].message);
console.log("   fix: " + pv.violations[0].fix);
assert.equal(pv.ok, false);
assert.equal(pv.layer, "auction");
assert.equal(pv.violations[0].rule, "auction-loser-unreleased");
assert.equal(premature.world.commitments[0].state.type, "Tendered", "a block must not advance the world");

rule("4) SOUND — release the loser first, then award");

const release = {
  type: "action",
  action: {
    commitment: loserBid.id,
    to: { type: "Cancelled", by: seller, reason: "Outbid", at: "2030-02-01T00:00:00.000Z" },
    actor: seller,
  },
};
const sound = runModel(model, worldOf(winnerBid, loserBid), [release, award(winnerBid)], { clock: FIXED });
console.log("   cancel the losing bid  → ok =", sound.verdicts[0].ok);
console.log("   accept the winning bid → ok =", sound.verdicts[1].ok);
const finalWinner = sound.world.commitments.find((c) => c.id === winnerBid.id);
console.log("   winner final state:", finalWinner.state.type);
assert.deepEqual(sound.verdicts.map((v) => v.ok), [true, true]);
assert.equal(finalWinner.state.type, "Accepted");
console.log("\n   This is the auction-family case study's shape: winner");
console.log("   Tendered → Accepted, loser Tendered → Cancelled.");

rule("5) UNSOUND — a second award (the subject promised twice)");

const alreadyWon = bid(bidderB, 12000, { type: "Accepted" });
const otherBid = bid(bidderA, 10000);
const doubleModel = compileSystem(
  SOURCE.replaceAll(loserBid.id, otherBid.id).replaceAll(winnerBid.id, alreadyWon.id),
  { file: "auction.warp" },
).model;
const doubleAward = runModel(doubleModel, worldOf(alreadyWon, otherBid), [award(otherBid)], { clock: FIXED });
const dv = doubleAward.verdicts[0];
console.log("   accept a SECOND bid → ok =", dv.ok, "| layer =", dv.layer);
console.log("   " + dv.violations.find((v) => v.rule === "auction-single-award").message);
assert.equal(dv.ok, false);
assert.equal(dv.layer, "auction");
assert.ok(dv.violations.some((v) => v.rule === "auction-single-award"));

rule("6) SOUND — a clearing price BELOW the winning bid (Vickrey pays second price)");

const vickreyLoser = bid(bidderA, 10000);
const vickreyWinner = bid(bidderB, 12000);
const vickrey = compileSystem(
  SOURCE.replaceAll(loserBid.id, vickreyLoser.id)
    .replaceAll(winnerBid.id, vickreyWinner.id)
    .replace("winning_price 12000 MAD", "winning_price 10000 MAD"),
  { file: "auction.warp" },
).model;
const vRun = runModel(vickrey, worldOf(vickreyWinner, vickreyLoser), [
  {
    type: "action",
    action: {
      commitment: vickreyLoser.id,
      to: { type: "Cancelled", by: seller, reason: "Outbid", at: "2030-02-01T00:00:00.000Z" },
      actor: seller,
    },
  },
  award(vickreyWinner),
], { clock: FIXED });
console.log("   bid 12000, clears at 10000 → ok =", vRun.verdicts[1].ok);
assert.equal(vRun.verdicts[1].ok, true);
console.log("\n   Sound. Whether a mechanism SHOULD clear below the bid is the");
console.log("   mechanism's business, not integrity. Only the reverse is refused:");

rule("7) UNSOUND — a clearing price ABOVE the winning bid");

const overLoser = bid(bidderA, 10000);
const overWinner = bid(bidderB, 12000);
const overpriced = compileSystem(
  SOURCE.replaceAll(loserBid.id, overLoser.id)
    .replaceAll(winnerBid.id, overWinner.id)
    .replace("winning_price 12000 MAD", "winning_price 15000 MAD"),
  { file: "auction.warp" },
).model;
const oRun = runModel(overpriced, worldOf(overWinner, overLoser), [
  {
    type: "action",
    action: {
      commitment: overLoser.id,
      to: { type: "Cancelled", by: seller, reason: "Outbid", at: "2030-02-01T00:00:00.000Z" },
      actor: seller,
    },
  },
  award(overWinner),
], { clock: FIXED });
const ov = oRun.verdicts[1];
console.log("   bid 12000, clears at 15000 → ok =", ov.ok, "| rule =", ov.violations[0].rule);
console.log("   " + ov.violations[0].message);
assert.equal(ov.ok, false);
assert.equal(ov.violations[0].rule, "auction-price-exceeds-bid");

rule("What rung 4c closed, and what it did not");
console.log(`An authored .warp auction now RUNS: compileSystem puts it on the model and
runModel's auction layer checks its resolution on every event. The gap rung 4
reported honestly — "auctions compile but don't run" — is closed.

The layer enforces real soundness, shown both ways above: an unsound resolution
is refused with the specific rule, a sound one advances, and §1 shows the six
invariants catching neither of the unsound cases. It is not a rubber stamp.

What it is NOT: a seventh invariant, a schema change, or a judge of whether a
mechanism priced well. It is a data-driven check over an auxiliary record the
schema already defines — the same category as a profile or a policy pack.
`);
