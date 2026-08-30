/**
 * Auction-resolution integrity (rung 4c) — the checks that decide whether an
 * auction was RESOLVED soundly, as opposed to merely being a well-formed record.
 *
 * WHY THIS MODULE EXISTS, STATED PRECISELY. The six invariants do not catch an
 * unsound auction resolution. That is not an opinion; it is demonstrated, and
 * `tests/auction-integrity.test.ts` pins it: a world where the winner is Accepted
 * and a losing bidder is left dangling in `Tendered` returns ZERO violations from
 * `auditCommerce`, and so does a world where TWO commitments from the same
 * auction are both Accepted. Both worlds are invariant-clean and both are
 * unsound. So this is new integrity content, not a re-expression of I-1..I-6.
 *
 * WHAT IT IS NOT. It is not a seventh invariant and it does not touch the schema.
 * It is a data-driven consistency check over an auxiliary record — the same
 * category as `guardWithProfile` (a profile's allowed states) and
 * `checkSettlementPolicy` (a pack's permitted rates), both of which `runModel`
 * already composes as layers. `AuctionProcess` is an auxiliary coordination
 * record the schema already defines, not a sixth primitive.
 *
 * WHAT IT DELIBERATELY DOES NOT JUDGE. Whether a mechanism produced a *good*
 * price. That a Vickrey auction clears at the second price, or that an English
 * auction's increments were sensible, is the mechanism's business, not integrity.
 * The price rule here is only the one that holds regardless of mechanism: a
 * winner may not be charged MORE than they offered.
 *
 * The rules, each expressed over structures the model already has — commitment
 * states, the `Tendered` payload's `superseded_by`, and `Money`:
 *
 *   auction-award-membership   an awarded commitment is in `tendered_commitments`
 *                              and is the one the record names as winner
 *   auction-single-award       at most one tendered commitment is awarded
 *   auction-loser-unreleased   every non-winning tendered commitment is released:
 *                              Cancelled, or still Tendered with `superseded_by`
 *                              set (the model's own word for "outbid")
 *   auction-price-currency     the clearing price is in the winner's currency
 *   auction-price-exceeds-bid  the clearing price does not exceed the winner's
 *                              own offer
 *
 * Purity: a pure function of (auction, world). No I/O, no mutation, never throws.
 */
import type { AuctionProcess } from "./auction.js";
import type { GuardViolation, World } from "./guard.js";
import type { Commitment } from "./primitives.js";
import type { CommitmentState } from "./states.js";

/** The rules this module can report. Stable strings — they appear in verdicts. */
export type AuctionRule =
  | "auction-award-membership"
  | "auction-single-award"
  | "auction-loser-unreleased"
  | "auction-price-currency"
  | "auction-price-exceeds-bid";

/**
 * States that mean "this bid won and the deal is live". A tendered commitment
 * that has moved to any of these has been AWARDED. `Cancelled` is a release, not
 * an award; `Tendered` is still open.
 */
const AWARDED: readonly CommitmentState["type"][] = [
  "Accepted",
  "Modified",
  "Active",
  "PartiallyFulfilled",
  "Fulfilled",
  "Disputed",
  "Refunded",
];

/** The `Tendered` offer a commitment made, read from its history (or its state). */
function tenderedOffer(c: Commitment): { amount: number; currency: string } | null {
  if (c.state.type === "Tendered") {
    return { amount: c.state.offer_amount, currency: c.state.offer_currency };
  }
  for (const h of c.history) {
    const to = h.to as CommitmentState | undefined;
    if (to && to.type === "Tendered") return { amount: to.offer_amount, currency: to.offer_currency };
  }
  return null;
}

/** True if this commitment is still an open, unreleased tender. */
function isDanglingTender(c: Commitment): boolean {
  return c.state.type === "Tendered" && c.state.superseded_by === undefined;
}

/** True if the commitment reached a state that means it won. */
function isAwarded(c: Commitment): boolean {
  return AWARDED.includes(c.state.type);
}

/**
 * Check an auction's resolution against the world.
 *
 * Returns `[]` while the auction is unresolved — no tendered commitment has been
 * awarded yet — because an auction in progress is not an unsound auction. The
 * resolution rules apply from the moment a bid is awarded.
 *
 * Every violation names its rule, what is wrong, and what would fix it, in the
 * same shape the guard uses, so a caller handles one kind of object.
 */
export function checkAuctionResolution(auction: AuctionProcess, world: World): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const tenderedIds = auction.tendered_commitments as readonly string[];
  const byId = new Map<string, Commitment>(
    world.commitments.map((c) => [c.id as string, c]),
  );

  const present = tenderedIds
    .map((id) => byId.get(id))
    .filter((c): c is Commitment => c !== undefined);
  const awarded = present.filter(isAwarded);

  // An auction nobody has won yet is simply in progress.
  if (awarded.length === 0) return violations;

  // --- auction-single-award -------------------------------------------------
  if (awarded.length > 1) {
    violations.push({
      rule: "auction-single-award",
      message:
        `Auction '${auction.id}' has ${awarded.length} awarded commitments ` +
        `(${awarded.map((c) => c.id as string).join(", ")}), but an auction awards its subject once. ` +
        `Two live winners means the subject was promised twice.`,
      fix:
        `Award exactly one tendered commitment and release the rest — Cancelled, or Tendered with ` +
        `'superseded_by' set to the winner.`,
    });
  }

  const declaredWinner =
    auction.state.type === "Closed" ? (auction.state.winning_commitment as string | undefined) : undefined;

  // --- auction-award-membership --------------------------------------------
  for (const c of awarded) {
    const id = c.id as string;
    if (!tenderedIds.includes(id)) {
      violations.push({
        rule: "auction-award-membership",
        message:
          `Commitment '${id}' was awarded under auction '${auction.id}', but it is not one of the ` +
          `auction's tendered commitments (${tenderedIds.join(", ") || "none"}). An auction can only ` +
          `award a bid it actually collected.`,
        fix:
          `Award one of the tendered commitments, or add '${id}' to the auction's ` +
          `tendered_commitments if it really did bid.`,
      });
    } else if (declaredWinner !== undefined && id !== declaredWinner) {
      violations.push({
        rule: "auction-award-membership",
        message:
          `Auction '${auction.id}' names '${declaredWinner}' as its winner, but '${id}' was the ` +
          `commitment awarded. The record and the world disagree about who won.`,
        fix:
          `Award '${declaredWinner}', or correct the auction record's winning_commitment to '${id}' ` +
          `if the award is the one that stands.`,
      });
    }
  }

  // --- auction-loser-unreleased --------------------------------------------
  const winnerIds = new Set(awarded.map((c) => c.id as string));
  for (const c of present) {
    if (winnerIds.has(c.id as string)) continue;
    if (isDanglingTender(c)) {
      violations.push({
        rule: "auction-loser-unreleased",
        message:
          `Auction '${auction.id}' awarded a bid, but '${c.id as string}' is still an open Tendered ` +
          `commitment with no 'superseded_by'. A losing bidder left tendered is still on the hook for ` +
          `an offer that can no longer be accepted.`,
        fix:
          `Release it: transition it to Cancelled, or set 'superseded_by' to the winning commitment ` +
          `so the record shows it was outbid.`,
      });
    }
  }

  // --- price rules (only against the commitment that actually won) ----------
  const winner = awarded.length === 1 ? (awarded[0] as Commitment) : undefined;
  if (winner && auction.state.type === "Closed" && auction.state.winning_price) {
    const price = auction.state.winning_price;
    const offer = tenderedOffer(winner);
    if (offer !== null) {
      if (price.currency !== offer.currency) {
        violations.push({
          rule: "auction-price-currency",
          message:
            `Auction '${auction.id}' closed at ${price.amount} ${price.currency}, but the winning bid ` +
            `'${winner.id as string}' was offered in ${offer.currency}. A clearing price in a different ` +
            `currency than the bid does not conserve value across the resolution.`,
          fix:
            `Quote the clearing price in ${offer.currency}, or convert() explicitly and record the ` +
            `conversion (Invariant 1: Value Conservation).`,
        });
      } else if (price.amount > offer.amount) {
        violations.push({
          rule: "auction-price-exceeds-bid",
          message:
            `Auction '${auction.id}' closed at ${price.amount} ${price.currency}, above the winning ` +
            `bid '${winner.id as string}' of ${offer.amount} ${offer.currency}. A winner cannot be ` +
            `charged more than they offered.`,
          fix:
            `Set winning_price to at most the winner's offer of ${offer.amount} ${offer.currency}. ` +
            `(A clearing price BELOW the bid is sound — a Vickrey auction pays the second price — so ` +
            `only the excess is refused.)`,
        });
      }
    }
  }

  return violations;
}
