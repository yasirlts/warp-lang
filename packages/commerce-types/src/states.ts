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

// ---------------------------------------------------------------------------
// Payment timing — when value moves in a Commitment (Primitive 4, terms.payment).
// The base timings are simple variants; the v0.3 additions carry structured data.
// ---------------------------------------------------------------------------

export type PaymentTiming =
  | { type: "Immediate" }
  | { type: "Upfront" }
  | { type: "OnDelivery" }
  | { type: "OnServiceCompletion" }
  | { type: "AfterGoodsReceived" }
  | { type: "Installments" }
  | { type: "Milestone" }
  | { type: "Recurring" }
  | { type: "Simultaneous" }
  | { type: "Metered" }
  // v0.3 — payment after fulfillment AND after a post-fulfillment trigger resolves
  | { type: "PostFulfillment"; trigger: PostFulfillmentTrigger }
  // v0.3 — trade finance: importer pays the bank to receive title documents
  | { type: "DocumentsAgainstPayment"; documents_held_by: PartyID; release_condition: string }
  // v0.3 — B2B credit terms: Net30 / Net60 / Net90
  | {
      type: "Net";
      days: 30 | 60 | 90;
      from: "InvoiceDate" | "DeliveryDate" | "EndOfMonth";
      early_payment_discount?: number;
    }
  // v0.3 — marketplace platforms, single- or double-sided commission
  | { type: "CommissionSplit"; structure: CommissionStructure };

export type PaymentTimingType = PaymentTiming["type"];

/** v0.3 — the post-fulfillment event that must resolve before payment. */
export type PostFulfillmentTrigger =
  | { type: "InsuranceAdjudication"; adjudicator: PartyID; claim_reference?: string; deadline?: string }
  | { type: "InspectionCompletion"; inspector: PartyID; standard?: string }
  | { type: "AcceptanceTest"; tester: PartyID; criteria: string };

/** v0.3 — how a marketplace platform takes commission. */
export type CommissionStructure =
  | { type: "SingleSided"; rate: number; paid_by: string; paid_to: PartyID }
  | { type: "DoubleSided"; buyer_fee: CommissionFee; seller_fee: CommissionFee };

export interface CommissionFee {
  rate: number;
  paid_to: PartyID;
}

// ---------------------------------------------------------------------------
// Evidence — proof a Fulfillment occurred (model Primitive 5: Evidence).
// The complete union, suitable for attaching to `Fulfillment.evidence`.
// ---------------------------------------------------------------------------

/**
 * Proof a Fulfillment occurred. Discriminated on `kind`.
 *
 * NOTE — relationship to `EvidenceV03` (commerce-v03.ts): the three v0.3
 * members below (`RegistryRecording`, `MedicalRecord`, `RetirementCertificate`)
 * are *parallel representations* of the standalone `EvidenceV03` interfaces,
 * which key on `type`. `EvidenceV03` is left untouched for anyone already
 * importing it; this `Evidence` union (keyed on `kind`, consistent with the
 * rest of this file's structures) is the complete set for attaching to a
 * Fulfillment. They are not interchangeable by discriminant — pick `Evidence`
 * for new code.
 */
export type Evidence =
  | { kind: "ProofOfDelivery"; photo_uri?: string; signature?: string; timestamp: string; recipient: PartyID }
  | { kind: "PaymentReceipt"; reference: string; amount: Money; timestamp: string; mechanism: string }
  | { kind: "AccessGrant"; token: string; granted_at: string; expires_at?: string }
  | { kind: "ServiceCompletion"; confirmed_by: PartyID; timestamp: string; notes?: string }
  | { kind: "WarehouseReceipt"; location: string; received_at: string }
  | {
      kind: "BillOfLading";
      reference: string;
      issued_by: PartyID;
      origin_port: string;
      destination_port: string;
      issued_at: string;
    }
  | { kind: "CustomsClearance"; reference: string; cleared_at: string; jurisdiction: string }
  | { kind: "TriggerVerification"; trigger_type: string; timestamp: string }
  // v0.3 (parallel to EvidenceV03 — see note above):
  | { kind: "RegistryRecording"; registry: string; reference: string; recorded_at: string; notary?: string }
  | { kind: "MedicalRecord"; reference: string; issued_by: string; patient: string; service_date: string }
  | {
      kind: "RetirementCertificate";
      reference: string;
      issued_by: string;
      quantity: number;
      retired_at: string;
      project_id: string;
    };
