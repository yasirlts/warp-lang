/**
 * The state machines of the Warp Commerce Model. Each state is a discriminated
 * union keyed on `type`. The valid transitions between these states are
 * enforced in `transitions.ts`; this file only surfaces the shapes.
 *
 * All of these types are generated from the canonical schema
 * (`schema/structure/intent|commitment|fulfillment.schema.json`) — see
 * `./generated/types.generated.ts`. This module re-exports them under the
 * names the package has always used, plus the `…Type` discriminant aliases.
 */

export type {
  // Intent (Primitive 3)
  IntentState,
  IntentStateType,
  // Commitment (Primitive 4) — the central primitive. All 11 variants.
  CommitmentState,
  CommitmentStateType,
  // Fulfillment (Primitive 5)
  FulfillmentState,
  FulfillmentStateType,
  // Payment timing (Primitive 4, terms.payment) + its v0.3 carriers.
  PaymentTiming,
  PaymentTimingType,
  PostFulfillmentTrigger,
  CommissionStructure,
  CommissionFee,
  // Evidence — proof a Fulfillment occurred (Primitive 5), keyed on `kind`.
  Evidence,
} from "./generated/types.generated.js";
