/**
 * ResolutionProcess — the substitution / cancellation workflow that opens for
 * each unresolved item when a Commitment reaches `PartiallyFulfilled` (model
 * Primitive 4: "The Resolution Process"). Each candidate is a proposed
 * substitute with its price delta and delivery-window impact; the customer
 * accepts a substitute or cancels the item.
 *
 * Generated from `schema/structure/auxiliary.schema.json` — see
 * `./generated/types.generated.ts` — and re-exported here.
 */

export type {
  CandidateState,
  ResolutionCandidate,
  ResolutionState,
  ResolutionProcess,
} from "./generated/types.generated.js";
