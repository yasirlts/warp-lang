/**
 * Auction-resolution integrity (rung 4c).
 *
 * The first describe block is the one that justifies this module existing: it
 * pins that the six invariants do NOT catch an unsound auction resolution. If
 * those two tests ever start failing — if `auditCommerce` grows to catch a
 * dangling loser or a double award — then this layer is redundant and should be
 * reconsidered rather than kept out of habit.
 *
 * The rest check that the layer enforces real rules through `runModel`, that a
 * sound resolution (the auction-family case study's shape) passes, and that a
 * model with no auction is byte-for-byte what it was before.
 */
import { describe, it, expect } from "vitest";
import {
  applyCommitmentPath,
  auditCommerce,
  newCommitment,
  partyId,
  valueId,
} from "../src/index.js";
import { checkAuctionResolution } from "../src/auction-integrity.js";
import { runModel, stepModel, type CommerceModel } from "../src/model.js";
import { run, type CommerceEvent } from "../src/engine.js";
import type {
  AuctionProcess,
  Commitment,
  CommitmentID,
  CommitmentState,
  World,
} from "../src/index.js";

const SELLER = partyId("party:auc-seller");
const BIDDER_A = partyId("party:bidder-a");
const BIDDER_B = partyId("party:bidder-b");
const CLOSES = "2026-03-10T20:00:00.000Z";
const FIXED = () => "2030-01-01T00:00:00.000Z";

/**
 * A bid: a commitment that went through `Tendered` carrying its offer, then on to
 * `state`. Routing through Tendered matters — `applyCommitmentPath` would
 * otherwise reach Accepted via Proposed, and a commitment that was never Tendered
 * is not a bid at all.
 */
function bid(bidder: ReturnType<typeof partyId>, amount: number, state: CommitmentState): Commitment {
  const c = newCommitment(bidder, SELLER, {
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
  const asTender = applyCommitmentPath(
    c,
    { type: "Tendered", offer_amount: amount, offer_currency: "MAD", closes_at: CLOSES },
    SELLER,
  );
  return applyCommitmentPath(asTender, state, SELLER);
}

const tendered = (amount: number, supersededBy?: string): CommitmentState =>
  supersededBy === undefined
    ? { type: "Tendered", offer_amount: amount, offer_currency: "MAD", closes_at: CLOSES }
    : {
        type: "Tendered",
        offer_amount: amount,
        offer_currency: "MAD",
        closes_at: CLOSES,
        // `superseded_by` is a branded CommitmentID; these are real ids carried
        // as strings, so the brand is re-applied rather than re-derived.
        superseded_by: supersededBy as CommitmentID,
      };

const worldOf = (...cs: Commitment[]): World => ({ commitments: cs, fulfillments: [], parties: [] });

/** The auction record, parameterised by which commitments it collected and who won. */
function auctionFor(
  ids: string[],
  winner?: string,
  winningPrice?: { amount: number; currency: string },
): AuctionProcess {
  const closed =
    winner === undefined
      ? ({ type: "Open" } as AuctionProcess["state"])
      : ({
          type: "Closed",
          winning_commitment: winner,
          ...(winningPrice ? { winning_price: winningPrice } : {}),
          reason: "NormalClose",
        } as AuctionProcess["state"]);
  return {
    id: "auction:painting",
    subject: "value:painting",
    seller: "party:auc-seller",
    mechanism: {
      kind: "English",
      reserve_price: { amount: 8000, currency: "MAD" },
      increment: { amount: 500, currency: "MAD" },
    },
    tendered_commitments: ids,
    opens_at: "2026-03-10T08:00:00.000Z",
    closes_at: CLOSES,
    state: closed,
  } as AuctionProcess;
}

// ---------------------------------------------------------------------------
// 0. Why this layer exists at all
// ---------------------------------------------------------------------------

describe("the six invariants do NOT catch an unsound auction resolution", () => {
  it("a dangling losing bid is invariant-clean", () => {
    const winner = bid(BIDDER_B, 12000, { type: "Accepted" });
    const dangling = bid(BIDDER_A, 10000, tendered(10000));
    // Zero violations: I-1..I-6 have nothing to say about an abandoned tender.
    expect(auditCommerce([winner, dangling], [], [])).toEqual([]);
  });

  it("a double award is invariant-clean", () => {
    const a = bid(BIDDER_A, 10000, { type: "Accepted" });
    const b = bid(BIDDER_B, 12000, { type: "Accepted" });
    expect(auditCommerce([a, b], [], [])).toEqual([]);
  });

  it("but the auction layer refuses both", () => {
    const winner = bid(BIDDER_B, 12000, { type: "Accepted" });
    const dangling = bid(BIDDER_A, 10000, tendered(10000));
    const auction = auctionFor([winner.id as string, dangling.id as string], winner.id as string);
    const v = checkAuctionResolution(auction, worldOf(winner, dangling));
    expect(v.map((x) => x.rule)).toEqual(["auction-loser-unreleased"]);
  });
});

// ---------------------------------------------------------------------------
// 1. The rules
// ---------------------------------------------------------------------------

describe("checkAuctionResolution — each rule, on its own", () => {
  it("an unresolved auction is not an unsound auction", () => {
    const a = bid(BIDDER_A, 10000, tendered(10000));
    const b = bid(BIDDER_B, 12000, tendered(12000));
    const auction = auctionFor([a.id as string, b.id as string]);
    expect(checkAuctionResolution(auction, worldOf(a, b))).toEqual([]);
  });

  it("the sound resolution (the case study's shape) passes", () => {
    // Winner Tendered -> Accepted -> ... -> Fulfilled; loser superseded then Cancelled.
    const winner = bid(BIDDER_B, 12000, { type: "Fulfilled" });
    const loser = bid(BIDDER_A, 10000, { type: "Cancelled", by: SELLER, reason: "Outbid", at: CLOSES });
    const auction = auctionFor(
      [loser.id as string, winner.id as string],
      winner.id as string,
      { amount: 12000, currency: "MAD" },
    );
    expect(checkAuctionResolution(auction, worldOf(winner, loser))).toEqual([]);
  });

  it("a loser still Tendered but superseded_by the winner counts as released", () => {
    const winner = bid(BIDDER_B, 12000, { type: "Accepted" });
    const outbid = bid(BIDDER_A, 10000, tendered(10000, winner.id as string));
    const auction = auctionFor([outbid.id as string, winner.id as string], winner.id as string);
    expect(checkAuctionResolution(auction, worldOf(winner, outbid))).toEqual([]);
  });

  it("awarding a commitment the auction never collected is refused", () => {
    const outsider = bid(BIDDER_A, 99000, { type: "Accepted" });
    const collected = bid(BIDDER_B, 12000, { type: "Cancelled", by: SELLER, reason: "Outbid", at: CLOSES });
    // The auction collected only `collected`; `outsider` never bid.
    const auction = auctionFor([collected.id as string, outsider.id as string].slice(0, 1));
    const v = checkAuctionResolution(auction, worldOf(outsider, collected));
    expect(v).toEqual([]); // outsider is not in tendered_commitments, so not "present"
    // Now include it in the set but name a different winner:
    const auction2 = auctionFor(
      [collected.id as string, outsider.id as string],
      collected.id as string,
    );
    const v2 = checkAuctionResolution(auction2, worldOf(outsider, collected));
    expect(v2.map((x) => x.rule)).toContain("auction-award-membership");
    expect(v2[0]!.message).toContain("disagree about who won");
  });

  it("two awarded bids are refused as a double award", () => {
    const a = bid(BIDDER_A, 10000, { type: "Accepted" });
    const b = bid(BIDDER_B, 12000, { type: "Accepted" });
    const auction = auctionFor([a.id as string, b.id as string], b.id as string);
    const v = checkAuctionResolution(auction, worldOf(a, b));
    expect(v.map((x) => x.rule)).toContain("auction-single-award");
  });

  it("a clearing price above the winner's own bid is refused", () => {
    const winner = bid(BIDDER_B, 12000, { type: "Accepted" });
    const loser = bid(BIDDER_A, 10000, { type: "Cancelled", by: SELLER, reason: "Outbid", at: CLOSES });
    const auction = auctionFor(
      [loser.id as string, winner.id as string],
      winner.id as string,
      { amount: 15000, currency: "MAD" },
    );
    const v = checkAuctionResolution(auction, worldOf(winner, loser));
    expect(v.map((x) => x.rule)).toContain("auction-price-exceeds-bid");
  });

  it("a clearing price BELOW the bid is sound — a Vickrey auction pays the second price", () => {
    const winner = bid(BIDDER_B, 12000, { type: "Accepted" });
    const loser = bid(BIDDER_A, 10000, { type: "Cancelled", by: SELLER, reason: "Outbid", at: CLOSES });
    const auction = auctionFor(
      [loser.id as string, winner.id as string],
      winner.id as string,
      { amount: 10000, currency: "MAD" },
    );
    expect(checkAuctionResolution(auction, worldOf(winner, loser))).toEqual([]);
  });

  it("a clearing price in another currency is refused", () => {
    const winner = bid(BIDDER_B, 12000, { type: "Accepted" });
    const loser = bid(BIDDER_A, 10000, { type: "Cancelled", by: SELLER, reason: "Outbid", at: CLOSES });
    const auction = auctionFor(
      [loser.id as string, winner.id as string],
      winner.id as string,
      { amount: 12000, currency: "EUR" },
    );
    const v = checkAuctionResolution(auction, worldOf(winner, loser));
    expect(v.map((x) => x.rule)).toContain("auction-price-currency");
  });
});

// ---------------------------------------------------------------------------
// 2. Through runModel — the layer in the composed run
// ---------------------------------------------------------------------------

describe("runModel — the auction layer refuses an unsound resolution", () => {
  it("awarding a bid while a loser dangles is blocked at the auction layer", () => {
    const winner = bid(BIDDER_B, 12000, tendered(12000));
    const dangling = bid(BIDDER_A, 10000, tendered(10000));
    const model: CommerceModel = {
      id: "m",
      auction: auctionFor([dangling.id as string, winner.id as string], winner.id as string),
    };
    const r = runModel(model, worldOf(winner, dangling), [
      { type: "action", action: { commitment: winner.id, to: { type: "Accepted" }, actor: SELLER } },
    ], { clock: FIXED });

    expect(r.verdicts[0]!.ok).toBe(false);
    expect(r.verdicts[0]!.layer).toBe("auction");
    expect(r.verdicts[0]!.violations![0]!.rule).toBe("auction-loser-unreleased");
    // Blocked means blocked: the winner did not advance.
    expect(r.world.commitments[0]!.state.type).toBe("Tendered");
    expect(r.effects).toEqual([]);
  });

  it("releasing the loser first, then awarding, is allowed", () => {
    const winner = bid(BIDDER_B, 12000, tendered(12000));
    const loser = bid(BIDDER_A, 10000, tendered(10000));
    const model: CommerceModel = {
      id: "m",
      auction: auctionFor([loser.id as string, winner.id as string], winner.id as string, {
        amount: 12000,
        currency: "MAD",
      }),
    };
    const r = runModel(model, worldOf(winner, loser), [
      {
        type: "action",
        action: {
          commitment: loser.id,
          to: { type: "Cancelled", by: SELLER, reason: "Outbid", at: "2030-02-01T00:00:00.000Z" },
          actor: SELLER,
        },
      },
      { type: "action", action: { commitment: winner.id, to: { type: "Accepted" }, actor: SELLER } },
    ], { clock: FIXED });

    expect(r.verdicts.map((v) => v.ok)).toEqual([true, true]);
    expect(r.world.commitments.find((c) => c.id === winner.id)!.state.type).toBe("Accepted");
  });

  it("a second award is blocked as a double award", () => {
    const a = bid(BIDDER_A, 10000, tendered(10000, "commitment:other"));
    const b = bid(BIDDER_B, 12000, { type: "Accepted" });
    const model: CommerceModel = {
      id: "m",
      auction: auctionFor([a.id as string, b.id as string], b.id as string),
    };
    const r = runModel(model, worldOf(a, b), [
      { type: "action", action: { commitment: a.id, to: { type: "Accepted" }, actor: SELLER } },
    ], { clock: FIXED });
    expect(r.verdicts[0]!.ok).toBe(false);
    expect(r.verdicts[0]!.layer).toBe("auction");
    expect(r.verdicts[0]!.violations!.map((v) => v.rule)).toContain("auction-single-award");
  });

  it("an unsoundness that was already there does not block an unrelated event", () => {
    // The world starts with a dangling loser and an awarded winner — already
    // unsound. A later, unrelated move must not be refused for a state it did
    // not cause, or the world would be permanently stuck.
    const winner = bid(BIDDER_B, 12000, { type: "Accepted" });
    const dangling = bid(BIDDER_A, 10000, tendered(10000));
    const model: CommerceModel = {
      id: "m",
      auction: auctionFor([dangling.id as string, winner.id as string], winner.id as string),
    };
    const r = stepModel(model, worldOf(winner, dangling), {
      type: "action",
      action: { commitment: winner.id, to: { type: "PartiallyFulfilled", fulfilled_item_ids: ["a"], remaining_item_ids: ["b"] }, actor: SELLER },
    }, { clock: FIXED });
    expect(r.verdict.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Additive — a model with no auction is unchanged
// ---------------------------------------------------------------------------

describe("runModel — a model with no auction behaves exactly as before", () => {
  it("matches `run` byte-for-byte", () => {
    const c = bid(BIDDER_B, 200, { type: "Fulfilled" });
    const events: CommerceEvent[] = [
      {
        type: "action",
        action: {
          commitment: c.id,
          to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" },
          actor: SELLER,
        },
      },
    ];
    const base = run(worldOf(c), events, { clock: FIXED });
    const composed = runModel({ id: "bare" }, worldOf(c), events, { clock: FIXED });
    expect(composed.verdicts.map((v) => v.ok)).toEqual(base.verdicts.map((v) => v.ok));
    expect(composed.effects).toEqual(base.effects);
    expect(composed.world.commitments[0]!.state).toEqual(base.world.commitments[0]!.state);
  });

  it("is deterministic and mutates nothing with an auction present", () => {
    const winner = bid(BIDDER_B, 12000, tendered(12000));
    const loser = bid(BIDDER_A, 10000, tendered(10000, winner.id as string));
    const model: CommerceModel = {
      id: "m",
      auction: auctionFor([loser.id as string, winner.id as string], winner.id as string),
    };
    const world = worldOf(winner, loser);
    const snapshot = JSON.stringify(world);
    const events: CommerceEvent[] = [
      { type: "action", action: { commitment: winner.id, to: { type: "Accepted" }, actor: SELLER } },
    ];
    const a = runModel(model, world, events, { clock: FIXED });
    const b = runModel(model, world, events, { clock: FIXED });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(world)).toBe(snapshot);
  });
});
