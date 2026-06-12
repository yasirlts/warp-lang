/**
 * AuctionProcess — the auxiliary coordination record for market-making
 * commerce (model Primitive 4: "The AuctionProcess"). Not a sixth primitive:
 * it manages the collection of Tendered Commitments and determines the winner
 * when the auction closes. Includes the v0.3 `ScoredSelection` mechanism
 * (government procurement) and the `AwardProtestUpheld` close reason.
 *
 * Generated from `schema/structure/auxiliary.schema.json` — see
 * `./generated/types.generated.ts` — and re-exported here. `AwardProtest`
 * (commerce-v03.ts) references an auction by string id; that id is this
 * module's `AuctionProcess.id`.
 */

export type {
  AuctionMechanism,
  AuctionCloseReason,
  AuctionState,
  AuctionProcess,
} from "./generated/types.generated.js";
