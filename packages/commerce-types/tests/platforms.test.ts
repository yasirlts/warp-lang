import { describe, expect, it } from "vitest";
import { fromShopifyOrder, toShopifyOrderStatus } from "../src/platforms/shopify.js";
import { fromWooOrder } from "../src/platforms/woocommerce.js";
import { fromStripeAmount, fromStripePaymentIntent, toStripeAmount } from "../src/platforms/stripe.js";
import { fromPayPalOrder, fromPayPalRefund, fromPayPalProduct } from "../src/platforms/paypal.js";
import { fromAmazonOrder, fromAmazonRefund, fromAmazonItem } from "../src/platforms/amazon.js";
import { unify, toPayPalAction, toAmazonAction } from "../src/interop.js";
import type { ProposedAction } from "../src/guard.js";
import { partyId } from "../src/primitives.js";

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

describe("PayPal mapping", () => {
  it("maps a COMPLETED order to Commitment(Accepted) with the committed Money", () => {
    const c = fromPayPalOrder({
      id: "5O190127TN364715T",
      status: "COMPLETED",
      purchase_units: [{ amount: { currency_code: "USD", value: "150.00" } }],
    });
    expect(c.state.type).toBe("Accepted");
    expect(c.id).toBe("5O190127TN364715T");
    expect(c.subject.requested[0]?.form).toEqual({ kind: "Money", money: { amount: 150, currency: "USD" } });
  });
  it("maps CREATED/APPROVED (pre-capture) to Proposed and VOIDED to Cancelled", () => {
    expect(fromPayPalOrder({ id: "o1", status: "CREATED", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }] }).state.type).toBe("Proposed");
    expect(fromPayPalOrder({ id: "o2", status: "APPROVED", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }] }).state.type).toBe("Proposed");
    expect(fromPayPalOrder({ id: "o3", status: "VOIDED", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }] }).state.type).toBe("Cancelled");
  });
  it("maps a settled refund (outside the order status) to Refunded; non-completed stays Accepted", () => {
    expect(fromPayPalRefund({ id: "rf1", status: "COMPLETED", amount: { currency_code: "USD", value: "40.00" }, order_id: "o1" }).state.type).toBe("Refunded");
    expect(fromPayPalRefund({ id: "rf2", status: "PENDING", amount: { currency_code: "USD", value: "40.00" }, order_id: "o1" }).state.type).toBe("Accepted");
  });
  it("maps a product to a PhysicalGood Value (empty sku when PayPal omits it)", () => {
    expect(fromPayPalProduct({ id: "prod-1" }).form).toEqual({ kind: "PhysicalGood", sku: "", condition: "New" });
  });
});

describe("Amazon mapping", () => {
  it("maps Shipped → Fulfilled, Unshipped → Accepted, Pending → Proposed, Canceled → Cancelled", () => {
    const total = { OrderTotal: { CurrencyCode: "USD" as const, Amount: "200.00" } };
    expect(fromAmazonOrder({ AmazonOrderId: "111-1", OrderStatus: "Shipped", ...total }).state.type).toBe("Fulfilled");
    expect(fromAmazonOrder({ AmazonOrderId: "111-2", OrderStatus: "Unshipped", ...total }).state.type).toBe("Accepted");
    expect(fromAmazonOrder({ AmazonOrderId: "111-3", OrderStatus: "Pending", ...total }).state.type).toBe("Proposed");
    expect(fromAmazonOrder({ AmazonOrderId: "111-4", OrderStatus: "Canceled", ...total }).state.type).toBe("Cancelled");
  });
  it("carries the OrderTotal as the committed Money and uses AmazonOrderId as the id", () => {
    const c = fromAmazonOrder({ AmazonOrderId: "902-3159896", OrderStatus: "Unshipped", OrderTotal: { CurrencyCode: "GBP", Amount: "59.99" } });
    expect(c.id).toBe("902-3159896");
    expect(c.subject.requested[0]?.form).toEqual({ kind: "Money", money: { amount: 59.99, currency: "GBP" } });
  });
  it("maps a refund financial event (outside the order status) to Refunded", () => {
    expect(fromAmazonRefund({ AmazonOrderId: "111-1", RefundAmount: { CurrencyCode: "USD", Amount: "25.00" } }).state.type).toBe("Refunded");
  });
  it("uses SellerSKU, falling back to ASIN, and carries QuantityOrdered", () => {
    expect(fromAmazonItem({ ASIN: "B00X", SellerSKU: "SKU-9", QuantityOrdered: 3 }).form).toEqual({ kind: "PhysicalGood", sku: "SKU-9", condition: "New" });
    expect(fromAmazonItem({ ASIN: "B00Y", QuantityOrdered: 2 }).form).toEqual({ kind: "PhysicalGood", sku: "B00Y", condition: "New" });
    expect(fromAmazonItem({ ASIN: "B00X", SellerSKU: "SKU-9", QuantityOrdered: 3 }).quantity).toBe(3);
  });
});

describe("PayPal + Amazon interop (unify + outbound descriptors, no execution)", () => {
  const refundAction: ProposedAction = { commitment: "o1", to: { type: "Refunded", amount: { amount: 40, currency: "USD" }, at: "2026-02-01T00:00:00.000Z" }, actor: "agent" };
  const cancelAction: ProposedAction = { commitment: "o1", to: { type: "Cancelled", by: partyId("agent"), reason: "x", at: "2026-02-01T00:00:00.000Z" }, actor: "agent" };
  const fulfillAction: ProposedAction = { commitment: "o1", to: { type: "Fulfilled" }, actor: "agent" };

  it("unifies a PayPal order with a matching Amazon order (value conserved)", () => {
    const pp = fromPayPalOrder({ id: "u1", status: "COMPLETED", purchase_units: [{ amount: { currency_code: "USD", value: "200.00" } }] });
    const az = fromAmazonOrder({ AmazonOrderId: "u1", OrderStatus: "Unshipped", OrderTotal: { CurrencyCode: "USD", Amount: "200.00" } });
    const r = unify([{ platform: "paypal", commitment: pp }, { platform: "amazon", commitment: az }], { id: "u1" });
    expect(r.ok).toBe(true);
  });
  it("blocks a PayPal/Amazon value mismatch as I-1", () => {
    const pp = fromPayPalOrder({ id: "u2", status: "COMPLETED", purchase_units: [{ amount: { currency_code: "USD", value: "200.00" } }] });
    const az = fromAmazonOrder({ AmazonOrderId: "u2", OrderStatus: "Unshipped", OrderTotal: { CurrencyCode: "USD", Amount: "150.00" } });
    const r = unify([{ platform: "paypal", commitment: pp }, { platform: "amazon", commitment: az }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]?.rule).toBe("I-1");
  });
  it("emits a PayPal refund descriptor and a void descriptor (descriptor only)", () => {
    const refund = toPayPalAction(refundAction);
    expect(refund).toEqual({ ok: true, platform: "paypal", descriptor: { kind: "paypal.refund", order_id: "o1", amount: { value: "40", currency_code: "USD" } } });
    const cancel = toPayPalAction(cancelAction);
    expect(cancel.ok && cancel.descriptor.kind).toBe("paypal.void");
  });
  it("emits an Amazon refund descriptor and a cancel descriptor (descriptor only)", () => {
    const refund = toAmazonAction(refundAction);
    expect(refund).toEqual({ ok: true, platform: "amazon", descriptor: { kind: "amazon.refund", amazon_order_id: "o1", amount: { Amount: "40", CurrencyCode: "USD" } } });
    const cancel = toAmazonAction(cancelAction);
    expect(cancel.ok && cancel.descriptor.kind).toBe("amazon.cancel");
  });
  it("returns an honest not-representable result for a non-refund/cancel action (no fabrication)", () => {
    const pp = toPayPalAction(fulfillAction);
    const az = toAmazonAction(fulfillAction);
    expect(pp.ok).toBe(false);
    expect(az.ok).toBe(false);
    if (!pp.ok) expect(pp.reason).toContain("no faithful paypal equivalent");
    if (!az.ok) expect(az.reason).toContain("no faithful amazon equivalent");
  });
});
