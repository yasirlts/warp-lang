/**
 * @warp-lang/commerce-types
 *
 * Formal commerce types derived from the Warp Commerce Model v0.3:
 * - the five primitives (Party, Value, Intent, Commitment, Fulfillment),
 * - currency-safe Money,
 * - validated state transitions (the 26-transition commitment table),
 * - runtime checkers for the six invariants.
 *
 * Platform mappings (Shopify, WooCommerce, Stripe) are available via subpath
 * imports, e.g. `import { fromShopifyOrder } from "@warp-lang/commerce-types/platforms/shopify"`.
 */

export * from "./money.js";
export * from "./states.js";
// The CommerceObject union (any top-level entity) and the frozen schema version
// these types were generated from — both come straight from the canonical
// schema spine (schema/structure/index.schema.json + schema/VERSION).
export type { CommerceObject } from "./generated/types.generated.js";
export { SCHEMA_VERSION } from "./generated/types.generated.js";
export * from "./primitives.js";
export * from "./transitions.js";
export * from "./invariants.js";
// v0.3 — full commerce vocabulary (cascade cancellation, volume pricing,
// loyalty earn terms, threshold activation, AwardProtest, v0.3 Evidence).
// PaymentTiming + its PostFulfillmentTrigger / CommissionStructure /
// CommissionFee are re-exported above via `export * from "./states.js"`.
export * from "./commerce-v03.js";
// v0.3.0 — gap-closure: the terms aggregate (delivery/payment/conditions/…),
// the market-making AuctionProcess, metered EntitlementConsumption, and the
// PartiallyFulfilled ResolutionProcess. `Evidence` (states.ts) and
// `ContingentValue`/`Quantity` (primitives.ts) surface via the `export *`
// lines above.
export * from "./terms.js";
export * from "./auction.js";
export * from "./metering.js";
export * from "./resolution.js";

// Aliases — the `verifyInvariantN` / `auditCommerceCode` names used by the
// CLAUDE.md template's quick-reference resolve to the canonical checkers.
export {
  auditCommerce as auditCommerceCode,
  checkI1ValueConservation as verifyInvariant1,
  checkI2StateMonotonicity as verifyInvariant2,
  checkI3CapacityVerification as verifyInvariant3,
  checkI4TemporalIntegrity as verifyInvariant4,
  checkI5IdentityPermanence as verifyInvariant5,
  checkI6TreeConsistency as verifyInvariant6,
  checkI1MoneyBreakdownSum as verifyMoneyBreakdown,
} from "./invariants.js";
