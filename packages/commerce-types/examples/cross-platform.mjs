// Warp as the neutral model between platforms (a canonical intermediate
// representation): map each platform IN once, reason in ONE model, emit a
// validated platform-shaped payload OUT — without auto-reconciling and without
// executing anything on any platform.
//
//   npm install @warp-lang/commerce-types
//   node cross-platform.mjs
//
import { unify, toStripeAction, toPayPalAction, toAmazonAction, guardAction } from "@warp-lang/commerce-types";
import { fromShopifyOrder } from "@warp-lang/commerce-types/platforms/shopify";
import { fromStripePaymentIntent } from "@warp-lang/commerce-types/platforms/stripe";
import { fromPayPalOrder } from "@warp-lang/commerce-types/platforms/paypal";
import { fromAmazonOrder } from "@warp-lang/commerce-types/platforms/amazon";

// Two platform objects for the SAME transaction (the app knows they correspond —
// Warp does not discover this). A Shopify order carries the lifecycle; a Stripe
// charge carries the payment. Both 200 MAD.
const shopifyOrder = fromShopifyOrder({ id: "order_123", currency: "MAD", total_price: "200.00", financial_status: "paid", fulfillment_status: "fulfilled" });
const stripeCharge = fromStripePaymentIntent({ id: "pi_abc", amount: 20000 /* minor units = 200.00 MAD */, currency: "mad", status: "succeeded" });

// INBOUND unification — the caller ASSERTS correspondence by passing them together.
const unified = unify([{ platform: "shopify", commitment: shopifyOrder }, { platform: "stripe", commitment: stripeCharge }], { id: "order_123" });
console.log(`unify (200 MAD == 200 MAD) → ok: ${unified.ok}, one commitment '${unified.ok ? unified.commitment.id : "-"}' in state ${unified.ok ? unified.commitment.state.type : "-"}`);

if (unified.ok) {
  const world = unified.world;

  // An agent over-refunds: 500 MAD against a 200 MAD order. Validate in the ONE
  // model — the over-refund is caught with planning-oracle guidance.
  const over = guardAction(world, { commitment: "order_123", to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor: "agent" });
  if (over.ok === false) {
    const refundAlt = (over.alternatives ?? []).find((a) => a.to === "Refunded");
    console.log(`\nover-refund 500 MAD → BLOCKED [${over.violations[0].rule}]; Refunded bounded: ${refundAlt?.bounded ?? over.violations[0].fix}`);
  }

  // A valid refund of 40 MAD: validate, then EMIT the Stripe-shaped descriptor the
  // app would send. Warp describes the call; it does NOT make it.
  const refund = { commitment: "order_123", to: { type: "Refunded", amount: { amount: 40, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor: "agent" };
  const verdict = guardAction(world, refund);
  console.log(`\nvalid refund 40 MAD → accepted: ${verdict.ok}`);
  if (verdict.ok) {
    const emitted = toStripeAction(refund);
    console.log("emit (no API call — a descriptor only):", JSON.stringify(emitted.descriptor));
  }
}

// INBOUND mismatch — a Shopify total and a Stripe amount that do NOT conserve.
const stripeShort = fromStripePaymentIntent({ id: "pi_short", amount: 15000 /* 150.00 MAD */, currency: "mad", status: "succeeded" });
const mismatch = unify([{ platform: "shopify", commitment: shopifyOrder }, { platform: "stripe", commitment: stripeShort }]);
if (mismatch.ok === false) {
  console.log(`\nunify (200 MAD vs 150 MAD) → BLOCKED [${mismatch.violations[0].rule}]: ${mismatch.violations[0].message}`);
}

// ---------------------------------------------------------------------------
// More adapters — PayPal + Amazon, same CIR shape. Map IN, reason in ONE model,
// emit a platform-shaped descriptor OUT. (Salesforce is intentionally NOT here —
// its CRM Opportunity is a sales-pipeline forecast, not a value-conserving
// commitment, so it is documented as a per-adapter limitation rather than forced.)
// ---------------------------------------------------------------------------

// An Amazon order (carrying the SHIPPED lifecycle, the PRIMARY source) and a
// PayPal order (the payment side) the app asserts are the SAME 200 USD sale.
const amazonOrder = fromAmazonOrder({ AmazonOrderId: "sale_777", OrderStatus: "Shipped", OrderTotal: { CurrencyCode: "USD", Amount: "200.00" } });
const paypalOrder = fromPayPalOrder({ id: "sale_777", status: "COMPLETED", purchase_units: [{ amount: { currency_code: "USD", value: "200.00" } }] });
const ppUnified = unify([{ platform: "amazon", commitment: amazonOrder }, { platform: "paypal", commitment: paypalOrder }], { id: "sale_777" });
console.log(`\nunify Amazon+PayPal (200 USD == 200 USD) → ok: ${ppUnified.ok}, state ${ppUnified.ok ? ppUnified.commitment.state.type : "-"}`);

if (ppUnified.ok) {
  // A valid 30 USD refund — validate in the ONE model, then emit BOTH platform
  // descriptors. Warp describes each call; it does NOT make any.
  const refund = { commitment: "sale_777", to: { type: "Refunded", amount: { amount: 30, currency: "USD" }, at: "2026-02-01T00:00:00.000Z" }, actor: "agent" };
  const verdict = guardAction(ppUnified.world, refund);
  console.log(`valid refund 30 USD → accepted: ${verdict.ok}`);
  if (verdict.ok) {
    console.log("emit PayPal (descriptor only):", JSON.stringify(toPayPalAction(refund).descriptor));
    console.log("emit Amazon (descriptor only):", JSON.stringify(toAmazonAction(refund).descriptor));
  }

  // An action with no faithful platform equivalent — emitters say so honestly
  // instead of fabricating a mapping.
  const fulfill = { commitment: "sale_777", to: { type: "Fulfilled" }, actor: "agent" };
  const ppFulfill = toPayPalAction(fulfill);
  if (ppFulfill.ok === false) console.log(`\nemit PayPal 'Fulfilled' → not representable: ${ppFulfill.reason}`);
}

// INBOUND mismatch across the new adapters — Amazon 200 USD vs PayPal 150 USD.
const paypalShort = fromPayPalOrder({ id: "sale_777", status: "COMPLETED", purchase_units: [{ amount: { currency_code: "USD", value: "150.00" } }] });
const ppMismatch = unify([{ platform: "amazon", commitment: amazonOrder }, { platform: "paypal", commitment: paypalShort }]);
if (ppMismatch.ok === false) {
  console.log(`\nunify Amazon+PayPal (200 USD vs 150 USD) → BLOCKED [${ppMismatch.violations[0].rule}]: ${ppMismatch.violations[0].message}`);
}
