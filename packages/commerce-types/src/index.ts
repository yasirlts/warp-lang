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
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE SURFACE IS TIERED. Everything below is exported; the tiers tell you what
 * to reach for first. See the package README "Core API" / "Advanced API".
 *
 *   CORE (start here — ~10):
 *     order, AuditedOrder            the fluent builder front door + its result
 *     Money, MoneyBreakdown          the money types
 *     add, convert                   currency-safe money math
 *     newCommitment / newIntent /
 *       newFulfillment, partyId      the primitive constructors
 *     transitionCommitment           the main state-machine entry
 *     auditCommerce                  the headline six-invariant check
 *
 *   ADVANCED (kept, fully supported, lower-level):
 *     per-invariant checkI* + checkLoyaltyLiability; isValid*Transition,
 *     applyCommitmentPath / applyFulfillmentPath, transitionIntent /
 *     transitionFulfillment; subtract / compare / allocate / format / zero /
 *     isMoney / currencyDecimals / moneyEpsilon / moneyEquals /
 *     validateMoneyBreakdown; the id + party constructors; the error classes;
 *     now, SCHEMA_VERSION; and the full v0.3 type vocabulary.
 *
 *   DEPRECATED ALIASES (still work; see the bottom of this file):
 *     auditCommerceCode, verifyInvariant1…6, verifyMoneyBreakdown.
 * ──────────────────────────────────────────────────────────────────────────
 */

// ── CORE-bearing modules ────────────────────────────────────────────────────
// These barrels carry the core surface (and their advanced siblings):
//   money.js       → CORE: Money, MoneyBreakdown, add, convert
//                    ADVANCED: subtract, compare, allocate, format, zero, isMoney,
//                    currencyDecimals, moneyEpsilon, moneyEquals, validateMoneyBreakdown
//   primitives.js  → CORE: newCommitment, newIntent, newFulfillment, partyId
//                    ADVANCED: commitmentId/intentId/fulfillmentId/valueId,
//                    individual/organization/system, unverifiedCapacity, now, the types
//   transitions.js → CORE: transitionCommitment, validTransitions
//                    ADVANCED: transitionIntent/Fulfillment, isValid*Transition,
//                    validIntentTransitions/validFulfillmentTransitions,
//                    applyCommitmentPath/applyFulfillmentPath, Result, error classes
//   invariants.js  → CORE: auditCommerce
//                    ADVANCED: checkI1…I6, checkI1MoneyBreakdownSum, checkLoyaltyLiability
//   builder.js     → CORE: order, AuditedOrder (+ the OrderBuilder type)
export * from "./money.js";
export * from "./primitives.js";
export * from "./transitions.js";
export * from "./invariants.js";
export * from "./builder.js";
// `guardAction` / `guardObject` — validate a proposed commerce action before it
// executes. A composition over transitionCommitment + auditCommerce (the proven
// logic); it does not re-derive invariants. TypeScript first; other bindings roadmap.
export * from "./guard.js";
// `createSession` — validate a SEQUENCE of actions against the accumulated world,
// catching cross-step violations (cumulative over-refund, refund-before-capture)
// that single-action guardAction cannot see. Composes guardAction + the canonical
// I-1 check; it does not fork invariant logic. TypeScript first; ports roadmap.
export * from "./session.js";

// ── ADVANCED type vocabulary ────────────────────────────────────────────────
// State machines, the v0.3 commerce vocabulary, and the market-making /
// metering / resolution records. All advanced; surfaced for completeness.
export * from "./states.js";
// The CommerceObject union (any top-level entity) and the frozen schema version
// these types were generated from — both come straight from the canonical
// schema spine (schema/structure/index.schema.json + schema/VERSION).
export type { CommerceObject } from "./generated/types.generated.js";
export { SCHEMA_VERSION } from "./generated/types.generated.js";
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

// ── DEPRECATED ALIASES ──────────────────────────────────────────────────────
// One canonical name per function; these older duplicate names still work so no
// existing import breaks. They are re-bindings of the canonical functions (same
// runtime behavior) and are slated for removal in a future major version.
// Migrate to the canonical name shown in each @deprecated tag.
import {
  auditCommerce,
  checkI1MoneyBreakdownSum,
  checkI1ValueConservation,
  checkI2StateMonotonicity,
  checkI3CapacityVerification,
  checkI4TemporalIntegrity,
  checkI5IdentityPermanence,
  checkI6TreeConsistency,
} from "./invariants.js";

/** @deprecated Use {@link auditCommerce} instead. Removed in a future major. */
export const auditCommerceCode = auditCommerce;
/** @deprecated Use {@link checkI1ValueConservation} instead. Removed in a future major. */
export const verifyInvariant1 = checkI1ValueConservation;
/** @deprecated Use {@link checkI2StateMonotonicity} instead. Removed in a future major. */
export const verifyInvariant2 = checkI2StateMonotonicity;
/** @deprecated Use {@link checkI3CapacityVerification} instead. Removed in a future major. */
export const verifyInvariant3 = checkI3CapacityVerification;
/** @deprecated Use {@link checkI4TemporalIntegrity} instead. Removed in a future major. */
export const verifyInvariant4 = checkI4TemporalIntegrity;
/** @deprecated Use {@link checkI5IdentityPermanence} instead. Removed in a future major. */
export const verifyInvariant5 = checkI5IdentityPermanence;
/** @deprecated Use {@link checkI6TreeConsistency} instead. Removed in a future major. */
export const verifyInvariant6 = checkI6TreeConsistency;
/** @deprecated Use {@link checkI1MoneyBreakdownSum} instead. Removed in a future major. */
export const verifyMoneyBreakdown = checkI1MoneyBreakdownSum;
