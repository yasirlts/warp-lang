/**
 * EntitlementConsumption — a lightweight per-access measurement record for
 * metered digital services (model Primitive 5: "EntitlementConsumption"). The
 * model is explicit that a Fulfillment per API call would be architecturally
 * wrong; this links a measured consumption event to its parent Commitment.
 * When `total_consumed_this_period` exceeds the allowance, an overage child
 * Commitment is created (priced at the metered rate).
 *
 * Generated from `schema/structure/auxiliary.schema.json` — see
 * `./generated/types.generated.ts` — and re-exported here.
 */

export type { EntitlementConsumption } from "./generated/types.generated.js";
