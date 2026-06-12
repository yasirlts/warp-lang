/**
 * CommitmentTerms — the terms aggregate the model attaches to a Commitment
 * (model Primitive 4: `Commitment.terms`): delivery, payment, conditions, and
 * the v0.3 term structures (cascade, volume pricing, loyalty, required
 * documents, duration, jurisdiction).
 *
 * Generated from `schema/structure/commitment.schema.json` — see
 * `./generated/types.generated.ts` — and re-exported here. Discriminated unions
 * key on `kind` (DeliveryMethod, CommitmentCondition) or `type` (PaymentTiming,
 * which lives in states.ts).
 */

export type {
  // DeliveryMethod — how value moves under a Commitment. 10 base + 4 v0.3.
  DeliveryMethod,
  // CommitmentCondition — prerequisites gating transitions. 10 base + 8 v0.3.
  CommitmentCondition,
  // PaymentTerms / DeliveryTerms wrappers, RequiredDocuments, CommitmentDuration.
  PaymentTerms,
  DeliveryTerms,
  RequiredDocuments,
  CommitmentDuration,
  // The aggregate — every field optional.
  CommitmentTerms,
} from "./generated/types.generated.js";
