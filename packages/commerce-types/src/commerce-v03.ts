/**
 * Types introduced in Warp Commerce Model v0.3 that don't belong to an
 * existing primitive file: cascade cancellation, volume pricing, loyalty
 * earn terms, threshold activation (group commerce), the AwardProtest
 * auxiliary record (government procurement), and the v0.3 Evidence types.
 *
 * Derived from WARP_COMMERCE_MODEL.md v0.3. State machines live in
 * `states.ts`; the five primitives in `primitives.ts`.
 */

import type { Money } from "./money.js";
import type { CommitmentState } from "./states.js";

// ---------------------------------------------------------------------------
// CascadeCancellation — a parent's cancellation propagates to its children
// (event cancellation, franchise collapse, multi-year contract, force majeure).
// ---------------------------------------------------------------------------

/** What a parent does to a child when a cascade fires. */
export interface RefundPolicy {
  amount: "FullRefund" | { kind: "PartialRefund"; rate: number };
  deadline_days?: number;
}

export type CascadeTrigger =
  | { type: "ParentCancelled" }
  | { type: "ParentDisputed" }
  | { type: "ExternalEvent"; event_type: string };

export type CascadeScope =
  | { type: "AllChildren" }
  | { type: "ChildrenInState"; states: CommitmentState["type"][] };

export interface CascadeCancellation {
  trigger: CascadeTrigger;
  applies_to: CascadeScope;
  child_transition: CommitmentState;
  auto_refund?: RefundPolicy;
}

// ---------------------------------------------------------------------------
// VolumePricing — wholesale tiered pricing with optional year-end true-up.
// ---------------------------------------------------------------------------

export interface VolumeTier {
  min: number;
  max?: number;
  price_per_unit: Money;
}

/** Year-end reconciliation when a buyer crosses into a cheaper tier. */
export interface TrueUpPolicy {
  reconcile_at: string; // ISO date of the reconciliation
  applies_to_prior_units: boolean;
}

export interface VolumePricing {
  tiers: VolumeTier[];
  true_up?: TrueUpPolicy;
}

// ---------------------------------------------------------------------------
// LoyaltyEarnTerm — point accrual on purchase (loyalty programs).
// ---------------------------------------------------------------------------

export interface LoyaltyEarnTerm {
  program: string;
  earn_rate: number;
  points_earned: number;
  credited_on: "FulfillmentComplete" | "PaymentReceived";
  currency: string; // CurrencyCode::Custom value (e.g. "PTS")
}

// ---------------------------------------------------------------------------
// ThresholdActivation — group buying / crowdfunding minimum-viable commitments.
// ---------------------------------------------------------------------------

export interface GroupPriceTier {
  participants: number;
  price: Money;
}

export interface ThresholdActivation {
  minimum_participants: number;
  maximum_participants?: number;
  activation_deadline: string;
  if_threshold_not_met: CommitmentState["type"];
  if_threshold_met: CommitmentState["type"];
  price_tiers?: GroupPriceTier[];
}

// ---------------------------------------------------------------------------
// AwardProtest — government procurement challenge (auxiliary record).
// Not a Commitment Dispute: it challenges whether the correct Tendered
// Commitment was selected, before the award is final.
// ---------------------------------------------------------------------------

export type AwardProtestState =
  | { type: "Filed" }
  | { type: "UnderReview"; reviewer: string }
  | { type: "Upheld"; remedy: "ReEvaluation" | "AwardToProtestant" | "Cancellation" }
  | { type: "Dismissed" };

export interface AwardProtest {
  id: string;
  filed_by: string;
  against: string; // CommitmentID of the awarded Commitment
  // References `AuctionProcess.id` from auction.ts (the procurement auction
  // whose award is being challenged).
  auction_process: string;
  grounds: string[];
  filed_at: string;
  deadline_for_response: string;
  reviewing_body?: string;
  state: AwardProtestState;
}

// ---------------------------------------------------------------------------
// v0.3 Evidence types.
// ---------------------------------------------------------------------------

export interface RegistryRecording {
  type: "RegistryRecording";
  registry: string;
  reference: string;
  recorded_at: string;
  notary?: string;
}

export interface MedicalRecord {
  type: "MedicalRecord";
  reference: string;
  issued_by: string;
  patient: string;
  service_date: string;
}

export interface RetirementCertificate {
  type: "RetirementCertificate";
  reference: string;
  issued_by: string;
  quantity: number;
  retired_at: string;
  project_id: string;
}

export type EvidenceV03 = RegistryRecording | MedicalRecord | RetirementCertificate;
