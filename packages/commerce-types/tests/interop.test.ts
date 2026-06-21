import { describe, expect, it } from "vitest";

import { unify, toStripeAction, toShopifyAction, toWooCommerceAction } from "../src/interop.js";
import type { ProposedAction } from "../src/guard.js";
import { fromShopifyOrder } from "../src/platforms/shopify.js";
import { fromStripePaymentIntent } from "../src/platforms/stripe.js";
import { fromWooOrder } from "../src/platforms/woocommerce.js";
import { partyId } from "../src/primitives.js";

// A Shopify order and a Stripe charge for the SAME 200 MAD transaction.
const shopify200 = fromShopifyOrder({ id: "order_123", currency: "MAD", total_price: "200.00", financial_status: "paid", fulfillment_status: "fulfilled" });
const stripe200 = fromStripePaymentIntent({ id: "pi_abc", amount: 20000, currency: "mad", status: "succeeded" });

const refund = (amount: number): ProposedAction => ({
  commitment: "order_123",
  to: { type: "Refunded", amount: { amount, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
  actor: "agent",
});

describe("unify — inbound unification (mechanism, not discovery)", () => {
  it("merges caller-corresponded sources into one validated commitment", () => {
    const u = unify([{ platform: "shopify", commitment: shopify200 }, { platform: "stripe", commitment: stripe200 }], { id: "order_123" });
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(u.commitment.id).toBe("order_123");
      expect(u.commitment.state.type).toBe("Fulfilled");
      expect(u.world.commitments).toHaveLength(1);
    }
  });

  it("rejects sources that do not conserve value (I-1)", () => {
    const stripe150 = fromStripePaymentIntent({ id: "pi_bad", amount: 15000, currency: "mad", status: "succeeded" });
    const u = unify([{ platform: "shopify", commitment: shopify200 }, { platform: "stripe", commitment: stripe150 }]);
    expect(u.ok).toBe(false);
    if (!u.ok) {
      expect(u.violations[0]?.rule).toBe("I-1");
      expect(u.violations[0]?.message).toContain("200");
      expect(u.violations[0]?.message).toContain("150");
    }
  });

  it("does NOT auto-reconcile a mismatch — it surfaces it rather than picking one", () => {
    // If unify silently reconciled (e.g. averaged or chose a side), this would
    // pass. The contract is that a mismatch is a violation, never reconciled.
    const stripe999 = fromStripePaymentIntent({ id: "pi_x", amount: 99900, currency: "mad", status: "succeeded" });
    const u = unify([{ platform: "shopify", commitment: shopify200 }, { platform: "stripe", commitment: stripe999 }]);
    expect(u.ok).toBe(false);
  });

  it("correspondence is a required INPUT — unify only considers the sources passed", () => {
    // A single source is simply validated; unify never goes and finds others to
    // merge. (No discovery: the caller asserts the set.)
    const u = unify([{ platform: "shopify", commitment: shopify200 }]);
    expect(u.ok).toBe(true);
    if (u.ok) expect(u.world.commitments).toHaveLength(1);
  });

  it("rejects an empty source set with a clear message", () => {
    const u = unify([]);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.violations[0]?.rule).toBe("unify-empty");
  });
});

describe("outbound emission — validated descriptors, no execution", () => {
  it("emits a Stripe refund descriptor in minor units", () => {
    const e = toStripeAction(refund(40));
    expect(e.ok).toBe(true);
    if (e.ok) {
      expect(e.descriptor).toEqual({ kind: "stripe.refund", payment_intent: "order_123", amount: 4000, currency: "mad" });
    }
  });

  it("emits a Shopify refund descriptor in decimal units", () => {
    const e = toShopifyAction(refund(40));
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.descriptor).toEqual({ kind: "shopify.refund", order_id: "order_123", amount: "40", currency: "MAD" });
  });

  it("emits a WooCommerce refund descriptor", () => {
    const e = toWooCommerceAction(refund(40));
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.descriptor.kind).toBe("woocommerce.refund");
  });

  it("emits a cancel descriptor for a Cancelled action", () => {
    const cancel: ProposedAction = { commitment: "order_123", to: { type: "Cancelled", by: partyId("agent"), reason: "x", at: "2026-03-01T00:00:00.000Z" }, actor: "agent" };
    const e = toStripeAction(cancel);
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.descriptor).toEqual({ kind: "stripe.cancel", payment_intent: "order_123" });
  });

  it("returns an honest not-representable result for an action with no platform equivalent", () => {
    const accept: ProposedAction = { commitment: "order_123", to: { type: "Accepted" }, actor: "agent" };
    const e = toStripeAction(accept);
    expect(e.ok).toBe(false);
    if (!e.ok) {
      expect(e.reason).toContain("no faithful stripe equivalent");
      expect(e.reason).toContain("Accepted");
    }
  });

  it("an emitter never executes — it returns a descriptor object, nothing else", () => {
    // The result is plain data: no functions, no thenables (no async/network).
    const e = toWooCommerceAction(refund(10));
    expect(typeof e).toBe("object");
    if (e.ok) expect(typeof (e.descriptor as { then?: unknown }).then).toBe("undefined");
  });
});

describe("unify composes the WooCommerce adapter too", () => {
  it("unifies a Woo order with a Stripe charge that conserve", () => {
    const woo200 = fromWooOrder({ id: 77, currency: "MAD", total: "200.00", status: "completed" });
    const u = unify([{ platform: "woocommerce", commitment: woo200 }, { platform: "stripe", commitment: stripe200 }]);
    expect(u.ok).toBe(true);
  });
});
