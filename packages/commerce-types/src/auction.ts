/**
 * AuctionProcess — the auxiliary coordination record for market-making
 * commerce (model Primitive 4: "The AuctionProcess"). Not a sixth primitive:
 * it manages the collection of Tendered Commitments and determines the winner
 * when the auction closes. Includes the v0.3 `ScoredSelection` mechanism
 * (government procurement) and the `AwardProtestUpheld` close reason.
 *
 * `AwardProtest` (commerce-v03.ts) references an auction by string id; that id
 * is this module's `AuctionProcess.id`.
 *
 * Derived from WARP_COMMERCE_MODEL.md v0.3.
 */

import type { Money } from "./money.js";
import type { CommitmentID, PartyID, ValueID } from "./primitives.js";

export type AuctionMechanism =
  | { kind: "English"; reserve_price?: Money; increment?: Money }
  | { kind: "Dutch"; start_price: Money; decrement: Money; interval_seconds: number }
  | { kind: "SealedBid"; reserve_price?: Money; reveal_at: string }
  | { kind: "Vickrey"; reserve_price?: Money }
  // v0.3 — government procurement: winner by weighted multi-criteria score.
  | {
      kind: "ScoredSelection";
      criteria: { name: string; weight: number; max_points: number }[];
      minimum_threshold?: number;
      evaluation_committee: PartyID[];
      publication_required: boolean;
    };

export type AuctionCloseReason =
  | "NormalClose"
  | "ReserveNotMet"
  | "BuyItNowExercised"
  | "SellerCancelled"
  | "AwardProtestUpheld";

export type AuctionState =
  | { type: "Scheduled" }
  | { type: "Open" }
  | {
      type: "Closed";
      winning_commitment?: CommitmentID;
      winning_price?: Money;
      reason: AuctionCloseReason;
    };

export interface AuctionProcess {
  id: string;
  subject: ValueID;
  seller: PartyID;
  mechanism: AuctionMechanism;
  tendered_commitments: CommitmentID[];
  opens_at: string;
  closes_at: string;
  state: AuctionState;
}
