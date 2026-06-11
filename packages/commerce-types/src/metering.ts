/**
 * EntitlementConsumption — a lightweight per-access measurement record for
 * metered digital services (model Primitive 5: "EntitlementConsumption"). The
 * model is explicit that a Fulfillment per API call would be architecturally
 * wrong; this links a measured consumption event to its parent Commitment.
 * When `total_consumed_this_period` exceeds the allowance, an overage child
 * Commitment is created (priced at the metered rate).
 *
 * Derived from WARP_COMMERCE_MODEL.md v0.3.
 */

export interface EntitlementConsumption {
  id: string;
  /** The parent CommitmentID this consumption belongs to. */
  commitment: string;
  /** What is being metered, e.g. "api-calls", "executions-per-month". */
  entitlement: string;
  consumed_this_event: number;
  total_consumed_this_period: number;
  total_allowed_this_period: number;
  period_start: string;
  period_end: string;
  timestamp: string;
  overage: boolean;
}
