/**
 * The state machines of the Warp Commerce Model. Each state is a discriminated
 * union keyed on `type`. The valid transitions between these states are
 * enforced in `transitions.ts` — this file defines the shapes only.
 */

import type { Money } from "./money.js";
import type { CommitmentID, PartyID } from "./primitives.js";

// ---------------------------------------------------------------------------
// Intent (Primitive 3)
// ---------------------------------------------------------------------------

export type IntentState =
  | { type: "Active" }
  | { type: "Abandoned" }
  | { type: "Converted"; commitment_id: CommitmentID }
  | { type: "Expired" };

export type IntentStateType = IntentState["type"];

// ---------------------------------------------------------------------------
// Commitment (Primitive 4) — the central primitive. All 11 variants.
// ---------------------------------------------------------------------------

export type CommitmentState =
  | { type: "Draft" }
  | { type: "Proposed" }
  | {
      type: "Tendered";
      offer_amount: number;
      offer_currency: string;
      closes_at: string;
      superseded_by?: CommitmentID;
    }
  | { type: "Accepted" }
  | { type: "Modified"; modified_by: PartyID; reason: string }
  | { type: "PartiallyFulfilled"; fulfilled_item_ids: string[]; remaining_item_ids: string[] }
  | { type: "Active" }
  | { type: "Fulfilled" }
  | { type: "Cancelled"; by: PartyID; reason: string; at: string }
  | { type: "Disputed"; by: PartyID; reason: string; opened_at: string }
  | { type: "Refunded"; amount: Money; at: string };

export type CommitmentStateType = CommitmentState["type"];

// ---------------------------------------------------------------------------
// Fulfillment (Primitive 5)
// ---------------------------------------------------------------------------

export type FulfillmentState =
  | { type: "Planned" }
  | { type: "InProgress" }
  | { type: "Completed" }
  | { type: "Failed"; reason: string; recoverable: boolean }
  | { type: "Reversed"; reason: string; initiated_by: PartyID; at: string };

export type FulfillmentStateType = FulfillmentState["type"];
