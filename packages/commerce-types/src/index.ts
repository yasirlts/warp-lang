/**
 * @warp-lang/commerce-types
 *
 * Formal commerce types derived from the Warp Commerce Model v0.2:
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
export * from "./primitives.js";
export * from "./transitions.js";
export * from "./invariants.js";

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
} from "./invariants.js";
