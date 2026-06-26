import { describe, expect, it } from "vitest";

import { reconcile } from "../src/reconcile.js";
import { unify } from "../src/interop.js";
import { fromShopifyOrder } from "../src/platforms/shopify.js";
import { fromStripePaymentIntent } from "../src/platforms/stripe.js";
import { fromWooOrder } from "../src/platforms/woocommerce.js";

// Three platform objects the caller asserts are the SAME 200 MAD transaction.
const shopify200 = fromShopifyOrder({ id: "order_123", currency: "MAD", total_price: "200.00", financial_status: "paid", fulfillment_status: "fulfilled" });
const stripe200 = fromStripePaymentIntent({ id: "pi_abc", amount: 20000, currency: "mad", status: "succeeded" });
const woo200 = fromWooOrder({ id: 9, currency: "MAD", total: "200.00", status: "completed" });

describe("reconcile — write-time cross-source coherence verdict", () => {
  it("all sources conserve → ok, one verdict line per source", () => {
    const r = reconcile(
      [
        { platform: "shopify", commitment: shopify200 },
        { platform: "stripe", commitment: stripe200 },
        { platform: "woocommerce", commitment: woo200 },
      ],
      { id: "order_123" },
    );
    expect(r.ok).toBe(true);
    expect(r.sources).toHaveLength(3);
    expect(r.sources.every((s) => s.conserves)).toBe(true);
    expect(r.unifiedAmount).toEqual({ amount: 200, currency: "MAD" });
    if (r.ok) {
      expect(r.commitment.id).toBe("order_123");
      expect(r.world.commitments).toHaveLength(1);
    }
  });

  it("one drifting source → blocked, attributed to that source with rule I-1 and the delta", () => {
    // Stripe captured only 150 MAD against a 200 MAD order — a 50 MAD shortfall.
    const stripe150 = fromStripePaymentIntent({ id: "pi_short", amount: 15000, currency: "mad", status: "succeeded" });
    const r = reconcile([
      { platform: "shopify", commitment: shopify200 },
      { platform: "stripe", commitment: stripe150 },
      { platform: "woocommerce", commitment: woo200 },
    ]);

    expect(r.ok).toBe(false);
    expect(r.sources).toHaveLength(3);

    // The coherent sources stay coherent; the drifted one is named.
    const shop = r.sources.find((s) => s.platform === "shopify");
    const woo = r.sources.find((s) => s.platform === "woocommerce");
    const stripe = r.sources.find((s) => s.platform === "stripe");
    expect(shop?.conserves).toBe(true);
    expect(woo?.conserves).toBe(true);
    expect(stripe?.conserves).toBe(false);

    // Attribution: which source, what rule, what signed delta.
    expect(stripe?.violation?.rule).toBe("I-1");
    expect(stripe?.delta).toBe(-50); // 150 − 200
    expect(stripe?.amount).toBe(150);

    if (!r.ok) {
      expect(r.violations.length).toBeGreaterThanOrEqual(1);
      expect(r.violations[0]?.rule).toBe("I-1");
    }
  });

  it("more than one drifting source → each is attributed independently", () => {
    const stripe150 = fromStripePaymentIntent({ id: "pi_s", amount: 15000, currency: "mad", status: "succeeded" });
    const woo250 = fromWooOrder({ id: 11, currency: "MAD", total: "250.00", status: "completed" });
    const r = reconcile([
      { platform: "shopify", commitment: shopify200 },
      { platform: "stripe", commitment: stripe150 },
      { platform: "woocommerce", commitment: woo250 },
    ]);
    expect(r.ok).toBe(false);
    const drifted = r.sources.filter((s) => !s.conserves);
    expect(drifted.map((s) => s.platform).sort()).toEqual(["stripe", "woocommerce"]);
    expect(drifted.find((s) => s.platform === "stripe")?.delta).toBe(-50);
    expect(drifted.find((s) => s.platform === "woocommerce")?.delta).toBe(50);
  });

  it("does not re-derive conservation — the per-source verdict matches unify's pairwise verdict", () => {
    const stripe150 = fromStripePaymentIntent({ id: "pi_short", amount: 15000, currency: "mad", status: "succeeded" });
    const pairwise = unify([
      { platform: "shopify", commitment: shopify200 },
      { platform: "stripe", commitment: stripe150 },
    ]);
    const r = reconcile([
      { platform: "shopify", commitment: shopify200 },
      { platform: "stripe", commitment: stripe150 },
    ]);
    // unify rejects the pair; reconcile attributes the same rejection.
    expect(pairwise.ok).toBe(false);
    expect(r.ok).toBe(false);
    const stripe = r.sources.find((s) => s.platform === "stripe");
    if (pairwise.ok === false) {
      expect(stripe?.violation?.rule).toBe(pairwise.violations[0]?.rule);
    }
  });

  it("a single source reconciles to itself (ok, conserves)", () => {
    const r = reconcile([{ platform: "shopify", commitment: shopify200 }]);
    expect(r.ok).toBe(true);
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]?.conserves).toBe(true);
    expect(r.sources[0]?.delta).toBeUndefined();
  });

  it("an empty source set is rejected (defers to unify's messaging)", () => {
    const r = reconcile([]);
    expect(r.ok).toBe(false);
    expect(r.sources).toHaveLength(0);
  });
});
