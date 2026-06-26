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
// `createMultiAgentSession` — make multi-agent use first-class: several named agents
// act on one SHARED world; the (already actor-agnostic) cumulative/invariant checks
// hold over their combined actions, and a rejection is ATTRIBUTED to the actor whose
// action tipped the world into violation. Composes createSession; no forked checks.
// Attribution is the tipping action, NOT collusion detection. TS first; ports roadmap.
export * from "./multi-agent.js";
// `planCompensation` / `validateCompensation` / `compensate` — model the unwinding of a
// multi-step flow as an explicit sequence of compensating actions (each a legal reversing
// transition) and validate the compensation for coherence (net value conserved, no
// over-refund) by running it through a session. Composes validTransitions + createSession;
// it does not fork invariant/transition logic, and it does NOT execute rollbacks on
// external systems — the plan is a sequence of validated descriptors. TS first; ports roadmap.
export * from "./saga.js";
// `createReturnsSession` — the returns / RMA lifecycle as a SESSION-LAYER profile, no
// schema change. A return is a child commitment against the parent order (parties
// exchanged, per the schema's reversal note); partial returns and over-return safety are
// the existing per-tree refund cap (checkI6TreeConsistency + the I-1 cumulative probe);
// the RMA stages (requested→authorized→…→refunded) are an in-memory overlay that GATES
// the money move, NOT new commitment states. Composes createSession; no forked logic.
// TypeScript first; ports roadmap.
export * from "./returns.js";
// `unify` / `toStripeAction` / `toShopifyAction` / `toWooCommerceAction` — the
// interop CIR: merge caller-corresponded platform objects into one validated Warp
// commitment (inbound), and translate a validated Warp action into a platform-shaped
// descriptor (outbound). Composes the inbound adapters + guardObject; it does not
// auto-reconcile correspondences and does not execute anything. TS first; ports roadmap.
export * from "./interop.js";
// `reconcile` — write-time cross-source coherence verdict. Given N corresponded
// sources, returns a STRUCTURED per-source verdict (each source's amount vs the
// unified amount), surfacing any drift as I-1 with attribution (which platform,
// what signed delta). Composes unify (which itself composes the I-1 conservation
// check) pairwise for the per-source decision; it does not re-derive I-1, does not
// auto-reconcile correspondences, and executes nothing. TS first; ports roadmap.
export * from "./reconcile.js";
// `toEffect` / `toEffects` — host-agnostic effect DESCRIPTORS (Boundary-A:
// effects-as-data). Translate a VALIDATED Warp action into a neutral
// `{ kind, target, payload }` descriptor of what a host would do, leaving HOW
// (platform, API, credentials) to the host. Composes the same coverage shape as
// the platform emitters; describes the effect, does NOT execute it. TS first.
export * from "./effects.js";
// `validateSettlement` / `createSettlementTracker` — validate that a multi-component
// settlement (principal / tax / fees / shipping) RECONCILES against a commitment's
// committed total in one currency, and track partial settlements cumulatively.
// Composes MoneyBreakdown + validateMoneyBreakdown (the money_breakdown_sum / I-1
// rule) + the session refund-ledger idiom; it does NOT compute tax (component
// amounts are caller-supplied; Warp checks they add up). TS first; ports roadmap.
export * from "./settlement.js";
// `checkSettlementPolicy` / `SAMPLE_VAT_PACK` — regulatory policy packs as DATA over
// validateSettlement. A pack lists, per jurisdiction, the tax_rate values its Tax
// components may declare; checkSettlementPolicy first delegates to validateSettlement
// (the money_breakdown_sum / I-1 reconciliation) unchanged, then checks each caller-
// supplied Tax component against the pack's permitted rates and that its amount equals
// rate × base. It does NOT compute tax: rates are pack data, base/amount/rate are caller
// inputs, Warp checks they reconcile. Not a tax engine. TS first; ports roadmap.
export * from "./policy-packs.js";
// `guardWithProfile` / `PROFILES` — named DATA profiles (digital / physical /
// subscription) that constrain which commitment states and value-form kinds apply
// to a kind of commerce, as a caller-side filter. guardWithProfile checks the
// profile's data constraint FIRST and then DELEGATES to the unmodified guardAction,
// so the frozen transition table + six invariants still decide safety. A profile can
// only narrow what is allowed; it is config, not a schema change or new invariant
// logic. TypeScript first; ports roadmap.
export * from "./profiles.js";
// `negotiate` / `guardConcession` — guard a multi-step micro-negotiation (offer →
// counter → accept) so an agent cannot be driven into an invalid concession: a
// counter-offer that discounts below the merchant's floor (the concession budget,
// checked through the canonical I-1 over-refund oracle) or an illegal state move
// (rejected by the session/guard with its planning-oracle alternatives). Composes
// createSession + guardAction + checkI1ValueConservation; it does not fork
// invariant/transition logic, and it VALIDATES a sequence — it does not execute,
// price, or settle anything. TypeScript first; ports roadmap.
export * from "./negotiation.js";

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
// `signFulfillment` / `verifyFulfillment` — a detached Ed25519 signature over a
// canonical serialization of a Fulfillment, carried as a toolkit-layer envelope
// (`{ fulfillment, signature, signer }`), NOT a schema field — the same pattern by
// which `idempotencyKey` rides on a proposed action. Proves authenticity + tamper-
// evidence for a given signer key; does not bind the key to a real identity (PKI,
// out of scope) and is not a zero-knowledge proof.
export * from "./attestation.js";

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
