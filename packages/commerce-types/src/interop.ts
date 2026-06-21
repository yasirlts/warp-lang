/**
 * Interoperability layer — Warp as the neutral model (a canonical intermediate
 * representation) between commerce platforms.
 *
 * The inbound adapters (src/platforms/*) already map one platform object into a
 * Warp commitment (a Shopify order, a Stripe charge, a WooCommerce order). This
 * module adds the two pieces that make Warp a real CIR, by COMPOSING those
 * adapters + the validators — it does not reimplement them:
 *
 *   A. {@link unify} — INBOUND unification. Merge several platform objects that
 *      the CALLER asserts represent the same transaction into one coherent Warp
 *      commitment, and validate that value is conserved across them.
 *   B. {@link toStripeAction} / {@link toShopifyAction} / {@link toWooCommerceAction}
 *      — OUTBOUND emission. Translate a VALIDATED Warp action into a structured,
 *      platform-shaped descriptor the application can send.
 *
 * TWO LINES THIS MODULE DOES NOT CROSS:
 *
 *   1. Unification is a MECHANISM, not DISCOVERY. The correspondence ("this
 *      Shopify order is this Stripe charge") is an INPUT the caller asserts by
 *      passing the objects together. Warp does NOT auto-reconcile or infer which
 *      order matches which charge — that is application glue.
 *   2. Outbound is a DESCRIPTION, not EXECUTION. The emitters return a descriptor
 *      object only. They make NO network calls, hold NO credentials, and execute
 *      nothing on any platform. Sending the descriptor is the application's job.
 *
 * TypeScript first. Other-language interop is roadmap.
 */

import { guardObject, type GuardViolation, type ProposedAction, type World } from "./guard.js";
import { moneyEquals } from "./money.js";
import type { Money } from "./money.js";
import type { Commitment } from "./primitives.js";
import { toStripeAmount } from "./platforms/stripe.js";

/** The platforms this interop layer can unify from and emit to. */
export type InteropPlatform = "shopify" | "stripe" | "woocommerce";

/**
 * One side of a unification: a platform object ALREADY mapped to a Warp
 * commitment via the inbound adapter (e.g. `fromShopifyOrder`,
 * `fromStripePaymentIntent`). Passing several of these to {@link unify} is how
 * the caller ASSERTS they correspond — the correspondence is not discovered.
 */
export interface UnifySource {
  platform: InteropPlatform;
  commitment: Commitment;
}

/**
 * The result of unifying corresponded sources. On success, `commitment` is the
 * single merged view and `world` wraps it (validated). On failure, `violations`
 * explains why the sources do not form a coherent transaction — most importantly
 * a value-conservation mismatch (I-1) when the platforms disagree on the amount.
 */
export type UnifyResult =
  | { ok: true; commitment: Commitment; world: World }
  | { ok: false; violations: GuardViolation[] };

/** The single Money committed by a commitment (sum of `requested`), or null. */
function committedMoney(c: Commitment): Money | null {
  const monies: Money[] = [];
  for (const v of c.subject.requested) {
    if (v.form.kind === "Money") monies.push(v.form.money);
  }
  if (monies.length === 0) return null;
  const currency = monies[0]?.currency;
  if (currency === undefined) return null;
  if (monies.some((m) => m.currency !== currency)) return null; // mixed: point-in-time I-1
  return monies.reduce((acc, m) => ({ amount: acc.amount + m.amount, currency }));
}

/**
 * Merge corresponded platform objects into one validated Warp commitment.
 *
 * The first source is the PRIMARY — it carries the canonical lifecycle (state +
 * history) for the unified commitment. Every other source must CONSERVE value
 * against it: the committed amounts must match (same currency, within the minor-
 * unit tolerance the model uses for I-1). A disagreement — e.g. a Shopify order
 * total of 200 against a Stripe charge of 150 — is reported as an I-1 (Value
 * Conservation) violation, because value is not conserved across the unified
 * view. The merged commitment is then validated by {@link guardObject} (the full
 * six-invariant audit), so the unified object is a real, valid Warp commitment.
 *
 * The correspondence is the CALLER'S assertion (passing the sources together).
 * `unify` does NOT infer which objects correspond; it validates the merge of the
 * ones it is given.
 */
export function unify(sources: UnifySource[], opts?: { id?: string }): UnifyResult {
  if (sources.length === 0) {
    return {
      ok: false,
      violations: [
        {
          rule: "unify-empty",
          message: "unify requires at least one mapped platform source.",
          fix: "Map each platform object with its inbound adapter (e.g. fromShopifyOrder) and pass the corresponding ones together.",
        },
      ],
    };
  }

  const primary = sources[0];
  if (primary === undefined) {
    return { ok: false, violations: [{ rule: "unify-empty", message: "no primary source.", fix: "Pass at least one source." }] };
  }
  const primaryMoney = committedMoney(primary.commitment);

  // Cross-source value conservation — the I-1 principle applied across platforms,
  // using the same money-equality tolerance the invariant uses. Each corresponded
  // source must agree on the committed amount (same currency).
  const violations: GuardViolation[] = [];
  for (let i = 1; i < sources.length; i++) {
    const other = sources[i];
    if (other === undefined) continue;
    const otherMoney = committedMoney(other.commitment);
    if (primaryMoney === null || otherMoney === null) continue; // no money to compare
    if (
      otherMoney.currency !== primaryMoney.currency ||
      !moneyEquals(otherMoney.amount, primaryMoney.amount, primaryMoney.currency)
    ) {
      violations.push({
        rule: "I-1",
        message:
          `Corresponded sources do not conserve value: ${primary.platform} commits ` +
          `${primaryMoney.amount} ${primaryMoney.currency} but ${other.platform} commits ` +
          `${otherMoney.amount} ${otherMoney.currency}. Value is not conserved across the unified transaction.`,
        fix:
          `Confirm the objects truly correspond and that the amounts (and currency) match; ` +
          `a partial capture or fee belongs in its own Value, not a silent mismatch.`,
      });
    }
  }
  if (violations.length > 0) {
    return { ok: false, violations };
  }

  // The unified commitment: the primary's lifecycle, optionally re-identified.
  const commitment: Commitment = opts?.id !== undefined ? { ...primary.commitment, id: opts.id as Commitment["id"] } : primary.commitment;

  // Validate the merged view against the full six invariants (composes auditCommerce).
  const verdict = guardObject([commitment], [], []);
  if (!verdict.ok) {
    return { ok: false, violations: verdict.violations };
  }
  return { ok: true, commitment, world: verdict.next };
}

// ---------------------------------------------------------------------------
// Outbound emission — validated, platform-shaped DESCRIPTORS. No execution.
// ---------------------------------------------------------------------------

/** A Stripe-shaped descriptor of the call the application should make. */
export type StripeDescriptor =
  | { kind: "stripe.refund"; payment_intent: string; amount: number; currency: string }
  | { kind: "stripe.cancel"; payment_intent: string };

/** A Shopify-shaped descriptor of the call the application should make. */
export type ShopifyDescriptor =
  | { kind: "shopify.refund"; order_id: string; amount: string; currency: string }
  | { kind: "shopify.cancel"; order_id: string };

/** A WooCommerce-shaped descriptor of the call the application should make. */
export type WooCommerceDescriptor =
  | { kind: "woocommerce.refund"; order_id: string; amount: string; currency: string }
  | { kind: "woocommerce.cancel"; order_id: string };

/**
 * The outcome of emitting a platform payload. On success, `descriptor` is the
 * structured call the app should make (it is NOT sent here). On failure, the
 * action has no faithful representation on that platform and `reason` says so —
 * rather than emitting a lossy guess.
 */
export type EmitResult<D> =
  | { ok: true; platform: InteropPlatform; descriptor: D }
  | { ok: false; platform: InteropPlatform; reason: string };

function notRepresentable<D>(platform: InteropPlatform, action: ProposedAction): EmitResult<D> {
  return {
    ok: false,
    platform,
    reason:
      `A '${action.to.type}' action has no faithful ${platform} equivalent in this layer ` +
      `(covered: Refunded → refund, Cancelled → cancel). Handle it in the application, or extend the emitter.`,
  };
}

/**
 * Emit a Stripe-shaped descriptor for a VALIDATED action. The caller must have
 * already validated the action (guardAction / a session); this only translates.
 * Refund amounts are converted to Stripe minor units via the existing
 * {@link toStripeAmount}. Coverage: Refunded → refund, Cancelled → cancel; any
 * other action type returns a not-representable result.
 */
export function toStripeAction(action: ProposedAction): EmitResult<StripeDescriptor> {
  if (action.to.type === "Refunded") {
    const { amount, currency } = toStripeAmount(action.to.amount);
    return { ok: true, platform: "stripe", descriptor: { kind: "stripe.refund", payment_intent: action.commitment, amount, currency } };
  }
  if (action.to.type === "Cancelled") {
    return { ok: true, platform: "stripe", descriptor: { kind: "stripe.cancel", payment_intent: action.commitment } };
  }
  return notRepresentable("stripe", action);
}

/**
 * Emit a Shopify-shaped descriptor for a VALIDATED action. Coverage: Refunded →
 * refund, Cancelled → cancel; any other action type is not representable here.
 */
export function toShopifyAction(action: ProposedAction): EmitResult<ShopifyDescriptor> {
  if (action.to.type === "Refunded") {
    const m = action.to.amount;
    return { ok: true, platform: "shopify", descriptor: { kind: "shopify.refund", order_id: action.commitment, amount: String(m.amount), currency: m.currency } };
  }
  if (action.to.type === "Cancelled") {
    return { ok: true, platform: "shopify", descriptor: { kind: "shopify.cancel", order_id: action.commitment } };
  }
  return notRepresentable("shopify", action);
}

/**
 * Emit a WooCommerce-shaped descriptor for a VALIDATED action. Coverage:
 * Refunded → refund, Cancelled → cancel; any other action type is not
 * representable here.
 */
export function toWooCommerceAction(action: ProposedAction): EmitResult<WooCommerceDescriptor> {
  if (action.to.type === "Refunded") {
    const m = action.to.amount;
    return { ok: true, platform: "woocommerce", descriptor: { kind: "woocommerce.refund", order_id: action.commitment, amount: String(m.amount), currency: m.currency } };
  }
  if (action.to.type === "Cancelled") {
    return { ok: true, platform: "woocommerce", descriptor: { kind: "woocommerce.cancel", order_id: action.commitment } };
  }
  return notRepresentable("woocommerce", action);
}
