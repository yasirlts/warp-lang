// Write-time cross-source RECONCILIATION verdict. unify answers a binary
// question (do the corresponded sources merge, yes or no). reconcile answers the
// operator's question when three or more systems should agree: which sources are
// coherent, which one drifted, and by how much — a structured per-source verdict
// with the drift attributed (which platform, what signed delta) as I-1.
//
// Run it before a multi-source write commits. It composes unify (which composes
// the I-1 conservation check); it discovers no correspondences and executes
// nothing.
//
//   npm install @warp-lang/commerce-types
//   node reconcile.mjs
//
import { reconcile } from "@warp-lang/commerce-types";
import { fromShopifyOrder } from "@warp-lang/commerce-types/platforms/shopify";
import { fromStripePaymentIntent } from "@warp-lang/commerce-types/platforms/stripe";
import { fromWooOrder } from "@warp-lang/commerce-types/platforms/woocommerce";

// Three platform objects the app asserts are the SAME 200 MAD transaction:
// Shopify carries the order lifecycle, Stripe the payment, WooCommerce a mirror.
const shopify200 = fromShopifyOrder({ id: "order_123", currency: "MAD", total_price: "200.00", financial_status: "paid", fulfillment_status: "fulfilled" });
const stripe200 = fromStripePaymentIntent({ id: "pi_abc", amount: 20000, currency: "mad", status: "succeeded" });
const woo200 = fromWooOrder({ id: 9, currency: "MAD", total: "200.00", status: "completed" });

// ── All three conserve → ok ──────────────────────────────────────────────────
const okVerdict = reconcile(
  [
    { platform: "shopify", commitment: shopify200 },
    { platform: "stripe", commitment: stripe200 },
    { platform: "woocommerce", commitment: woo200 },
  ],
  { id: "order_123" },
);
console.log(`all conserve (200 == 200 == 200 MAD) → ok: ${okVerdict.ok}`);
for (const s of okVerdict.sources) {
  console.log(`  ${s.platform.padEnd(12)} ${String(s.amount).padStart(4)} ${s.currency} → conserves: ${s.conserves}`);
}

// ── One source drifts → blocked, attributed ──────────────────────────────────
// Stripe captured only 150 MAD against the 200 MAD order — a 50 MAD shortfall.
const stripe150 = fromStripePaymentIntent({ id: "pi_short", amount: 15000, currency: "mad", status: "succeeded" });
const drift = reconcile([
  { platform: "shopify", commitment: shopify200 },
  { platform: "stripe", commitment: stripe150 },
  { platform: "woocommerce", commitment: woo200 },
]);
console.log(`\none drifts (Stripe 150 vs unified 200 MAD) → ok: ${drift.ok}`);
for (const s of drift.sources) {
  const tail = s.conserves ? "conserves" : `DRIFT [${s.violation?.rule}] delta ${s.delta} ${s.currency}`;
  console.log(`  ${s.platform.padEnd(12)} ${String(s.amount).padStart(4)} ${s.currency} → ${tail}`);
}
if (drift.ok === false) {
  const stripe = drift.sources.find((s) => s.platform === "stripe");
  console.log(`\nattribution → ${stripe?.platform} drifted by ${stripe?.delta} ${stripe?.currency} [${stripe?.violation?.rule}]`);
  console.log(`message: ${stripe?.violation?.message}`);
}
