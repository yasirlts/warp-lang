import { describe, expect, it } from "vitest";
import { fromShopifyOrder, toShopifyOrderStatus } from "../src/platforms/shopify.js";
import { fromWooOrder } from "../src/platforms/woocommerce.js";
import { fromStripeAmount, fromStripePaymentIntent, toStripeAmount } from "../src/platforms/stripe.js";

describe("Shopify mapping", () => {
  it("maps a paid order to Commitment(Accepted)", () => {
    const c = fromShopifyOrder({ id: "1099", currency: "USD", total_price: "150.00", financial_status: "paid" });
    expect(c.state.type).toBe("Accepted");
    expect(c.id).toBe("1099");
  });
  it("maps a fulfilled order to Commitment(Fulfilled)", () => {
    const c = fromShopifyOrder({ id: "1100", currency: "USD", total_price: "150.00", financial_status: "paid", fulfillment_status: "fulfilled" });
    expect(c.state.type).toBe("Fulfilled");
  });
  it("round-trips state → Shopify status", () => {
    expect(toShopifyOrderStatus({ type: "Accepted" })).toBe("paid");
    expect(toShopifyOrderStatus({ type: "Fulfilled" })).toBe("fulfilled");
    expect(toShopifyOrderStatus({ type: "Proposed" })).toBe("pending");
  });
});

describe("WooCommerce mapping", () => {
  it("maps completed → Fulfilled, processing → Accepted", () => {
    expect(fromWooOrder({ id: 7, currency: "MAD", total: "200.00", status: "completed" }).state.type).toBe("Fulfilled");
    expect(fromWooOrder({ id: 8, currency: "MAD", total: "200.00", status: "processing" }).state.type).toBe("Accepted");
  });
});

describe("Stripe mapping + minor-unit conversion", () => {
  it("succeeded PaymentIntent → Commitment(Accepted)", () => {
    const c = fromStripePaymentIntent({ id: "pi_1", amount: 15000, currency: "usd", status: "succeeded" });
    expect(c.state.type).toBe("Accepted");
  });
  it("converts cents ↔ decimal for two-decimal currencies", () => {
    expect(fromStripeAmount(15000, "usd")).toEqual({ amount: 150, currency: "USD" });
    expect(toStripeAmount({ amount: 150, currency: "USD" })).toEqual({ amount: 15000, currency: "usd" });
  });
  it("treats JPY as zero-decimal", () => {
    expect(fromStripeAmount(1500, "jpy")).toEqual({ amount: 1500, currency: "JPY" });
    expect(toStripeAmount({ amount: 1500, currency: "JPY" })).toEqual({ amount: 1500, currency: "jpy" });
  });
});
