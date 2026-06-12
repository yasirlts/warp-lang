/**
 * Types introduced in Warp Commerce Model v0.3 that don't belong to an
 * existing primitive file: cascade cancellation, volume pricing, loyalty
 * earn terms, threshold activation (group commerce), and the AwardProtest
 * auxiliary record (government procurement).
 *
 * These are generated from `schema/structure/auxiliary.schema.json` — see
 * `./generated/types.generated.ts` — and re-exported here under the names the
 * package has always used. The `EvidenceV03` family below is NOT in the schema:
 * it is the legacy `type`-keyed representation kept for backward compatibility
 * (the canonical, `kind`-keyed `Evidence` union lives in states.ts / the
 * fulfillment schema). See the note on `Evidence` in states.ts.
 */

export type {
  // CascadeCancellation — a parent's cancellation propagates to its children.
  RefundPolicy,
  CascadeTrigger,
  CascadeScope,
  CascadeCancellation,
  // VolumePricing — wholesale tiered pricing with optional year-end true-up.
  VolumeTier,
  TrueUpPolicy,
  VolumePricing,
  // LoyaltyEarnTerm — point accrual on purchase (loyalty programs).
  LoyaltyEarnTerm,
  // ThresholdActivation — group buying / crowdfunding minimum-viable commitments.
  GroupPriceTier,
  ThresholdActivation,
  // AwardProtest — government procurement challenge (auxiliary record).
  AwardProtestState,
  AwardProtest,
} from "./generated/types.generated.js";

// ---------------------------------------------------------------------------
// v0.3 Evidence types — the legacy `type`-keyed representation.
//
// These predate the canonical `kind`-keyed `Evidence` union (states.ts /
// fulfillment.schema.json) and are NOT part of the schema. They are retained
// untouched for anyone already importing `EvidenceV03`; new code should use
// `Evidence`. They are not interchangeable by discriminant (`type` vs `kind`).
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
