// Warp as the neutral model between platforms (a canonical intermediate
// representation): map each platform IN once, reason in ONE model, emit a
// validated platform-shaped payload OUT — without auto-reconciling and without
// executing anything on any platform.
//
//   npm install @warp-lang/commerce-types
//   node cross-platform.mjs
//
import { unify, toStripeAction, guardAction } from "@warp-lang/commerce-types";
import { fromShopifyOrder } from "@warp-lang/commerce-types/platforms/shopify";
import { fromStripePaymentIntent } from "@warp-lang/commerce-types/platforms/stripe";

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
