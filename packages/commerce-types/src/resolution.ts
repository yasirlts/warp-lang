/**
 * ResolutionProcess — the substitution / cancellation workflow that opens for
 * each unresolved item when a Commitment reaches `PartiallyFulfilled` (model
 * Primitive 4: "The Resolution Process"). Each candidate is a proposed
 * substitute with its price delta and delivery-window impact; the customer
 * accepts a substitute or cancels the item.
 *
 * Derived from WARP_COMMERCE_MODEL.md v0.3.
 */

import type { Money } from "./money.js";
import type { CommitmentID, PartyID, ValueID } from "./primitives.js";

export type CandidateState = "Pending" | "Accepted" | "Rejected";

export interface ResolutionCandidate {
  id: string;
  proposed_by: PartyID;
  substitute_description: string;
  fulfilling_party?: PartyID;
  price_delta: Money;
  new_total: Money;
  original_window: string;
  new_window: string;
  state: CandidateState;
}

export type ResolutionState =
  | { type: "AwaitingCustomerDecision" }
  | { type: "Resolved"; outcome: "SubstituteAccepted" | "ItemCancelled"; candidate_id?: string }
  | { type: "Expired" };

export interface ResolutionProcess {
  id: string;
  parent_commitment: CommitmentID;
  unresolved_item: ValueID;
  original_value: Money;
  candidates: ResolutionCandidate[];
  state: ResolutionState;
  deadline: string;
}
