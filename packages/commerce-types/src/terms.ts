/**
 * CommitmentTerms — the terms aggregate the model attaches to a Commitment
 * (model Primitive 4: `Commitment.terms`): delivery, payment, conditions, and
 * the v0.3 term structures (cascade, volume pricing, loyalty, required
 * documents, duration, jurisdiction).
 *
 * Derived from WARP_COMMERCE_MODEL.md v0.3. Discriminated unions key on `kind`
 * (matching `AccessModel` in primitives.ts); `PaymentTiming` keys on `type`
 * and lives in states.ts.
 */

import type { CurrencyCode, Money } from "./money.js";
import type { PartyID, Quantity } from "./primitives.js";
import type { CommitmentState, PaymentTiming } from "./states.js";
import type { CascadeCancellation, LoyaltyEarnTerm, VolumePricing } from "./commerce-v03.js";

// ---------------------------------------------------------------------------
// DeliveryMethod (GAP 3) — how value moves under a Commitment
// (model Primitive 4: DeliveryTerms.method). 11 base + 4 v0.3 variants.
// ---------------------------------------------------------------------------

export type DeliveryMethod =
  | { kind: "PhysicalDelivery"; carrier?: PartyID; tracking?: string }
  | { kind: "InPersonHandover"; location: string; staff_id?: PartyID }
  | { kind: "InterStoreTransfer"; from: string; to: string; customer_pickup: boolean }
  | { kind: "InternalTransfer"; from: string; to: string }
  | {
      kind: "ServicePerformance";
      performer: PartyID;
      location: string;
      scheduled_at: string;
      duration_minutes?: number;
    }
  | { kind: "DigitalDelivery"; mechanism: string; delivered_at?: string; access_token?: string }
  | { kind: "MoneyTransfer"; mechanism: string; reference?: string; cleared_at?: string }
  | { kind: "ContingentDelivery"; trigger: string }
  | { kind: "WhiteGlove"; carrier: PartyID }
  | { kind: "ReturnDelivery"; pickup_address?: string; dropoff_address?: string }
  // v0.3 additions:
  | {
      kind: "TitleTransfer";
      mechanism: "NotarialDeed" | "WarrantyDeed" | "LandRegistration";
      registry: string;
      title_number?: string;
      notary?: PartyID;
    }
  | {
      kind: "RecurringDelivery";
      schedule: string;
      quantity_per_delivery: Quantity;
      first_delivery: string;
      last_delivery?: string;
      flexibility?: { min_per_delivery: Quantity; max_per_delivery: Quantity };
    }
  | {
      kind: "CustomsRelease";
      customs_reference: string;
      cleared_at: string;
      duties_paid?: Money;
      inspection_required: boolean;
    }
  | {
      kind: "RegistryRetirement";
      registry: PartyID;
      retirement_reference: string;
      retired_on_behalf_of: PartyID;
      reason: string;
    };

// ---------------------------------------------------------------------------
// CommitmentCondition (GAP 4) — prerequisites gating specific transitions
// (model Primitive 4: CommitmentTerms.conditions). 10 base + 8 v0.3 variants.
// ---------------------------------------------------------------------------

export type CommitmentCondition =
  | {
      kind: "QualityInspection";
      inspector: PartyID;
      standard: string;
      must_complete_before: CommitmentState["type"];
      if_fail: CommitmentState["type"];
    }
  | {
      kind: "AuthenticationVerification";
      verifier: PartyID;
      must_complete_before: CommitmentState["type"];
    }
  | {
      kind: "DeliverableAcceptance";
      deliverable_id: string;
      accepted_by: PartyID;
      acceptance_window_days: number;
      if_rejected: CommitmentState["type"];
    }
  | {
      kind: "ConditionVerification";
      required_condition: string;
      inspector: PartyID;
      if_not_met: CommitmentState["type"];
    }
  | { kind: "InsuredEventMonitoring"; event_type: string; monitoring_party?: PartyID }
  | { kind: "GracePeriod"; duration_days: number; if_not_restored: CommitmentState["type"] }
  | { kind: "RoyaltyDistribution"; beneficiaries: { to: PartyID; rate: number }[] }
  | { kind: "StaffDiscount"; rate: number }
  | { kind: "NoShowPolicy"; grace_minutes: number; fee: Money }
  | { kind: "SimultaneousAccessLimit"; max_concurrent: number }
  // v0.3 additions:
  | {
      kind: "FinancingContingency";
      lender?: PartyID;
      amount: Money;
      rate_cap?: number;
      approval_deadline: string;
      if_not_met: CommitmentState["type"];
    }
  | {
      kind: "InspectionContingency";
      inspector?: PartyID;
      deadline: string;
      if_failed: CommitmentState["type"];
    }
  | {
      kind: "PrescriptionRequired";
      prescription?: {
        reference: string;
        issuer: PartyID;
        issued_at: string;
        valid_until: string;
        medication: string;
        quantity: string;
        refills: number;
      };
      verified_by?: PartyID;
      must_verify_before: CommitmentState["type"];
    }
  | {
      kind: "RegistryVerification";
      registry: PartyID;
      must_verify_before: CommitmentState["type"];
      verifies: string[];
    }
  | {
      kind: "ThresholdActivation";
      minimum_participants: number;
      maximum_participants?: number;
      activation_deadline: string;
      if_threshold_not_met: CommitmentState["type"];
      if_threshold_met: CommitmentState["type"];
    }
  | {
      kind: "ComplianceDocumentation";
      required_documents: string[];
      submission_deadline: string;
      verified_by: PartyID;
      if_not_submitted: CommitmentState["type"];
    }
  | { kind: "NoReturnPolicy"; basis: string; jurisdiction: string }
  | {
      kind: "EventCancellationPolicy";
      if_cancelled: {
        amount: "FullRefund" | { kind: "PartialRefund"; rate: number };
        deadline_days: number;
      };
    };

// ---------------------------------------------------------------------------
// PaymentTerms / DeliveryTerms wrappers, RequiredDocuments, CommitmentDuration
// ---------------------------------------------------------------------------

/** Wraps the `PaymentTiming` (states.ts) with method / split / conversion. */
export interface PaymentTerms {
  timing: PaymentTiming;
  method?: string;
  split?: { method: string; amount: Money; reference?: string }[];
  currency_conversion?: {
    from: CurrencyCode;
    to: CurrencyCode;
    rate: number;
    customer_pays: Money;
  };
}

export interface DeliveryTerms {
  method: DeliveryMethod;
  address?: string;
  window?: { earliest: string; latest: string };
  incoterm?: string;
}

/** Trade-finance documentary requirements (model Primitive 4). */
export interface RequiredDocuments {
  bill_of_lading?: boolean;
  commercial_invoice?: boolean;
  packing_list?: boolean;
  certificate_of_origin?: boolean;
  insurance_certificate?: boolean;
  customs_declaration?: boolean;
}

export type CommitmentDuration =
  | { kind: "Fixed"; ends_at: string }
  | { kind: "OpenEnded"; minimum_term_days?: number; cancellation_notice_days: number };

// ---------------------------------------------------------------------------
// The aggregate (GAP 1). Every field optional so a Commitment may carry as
// little or as much of its terms as the platform knows.
// ---------------------------------------------------------------------------

export interface CommitmentTerms {
  delivery?: DeliveryTerms;
  payment?: PaymentTerms;
  conditions?: CommitmentCondition[];
  cascade?: CascadeCancellation;
  volume_pricing?: VolumePricing;
  loyalty?: LoyaltyEarnTerm;
  required_documents?: RequiredDocuments;
  jurisdiction?: string;
  duration?: CommitmentDuration;
}
