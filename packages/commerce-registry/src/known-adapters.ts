/**
 * Manifests for the adapters that ship in `@warp-lang/commerce-types`
 * (`packages/commerce-types/src/platforms`). These describe what those adapters
 * already do — they are not new adapters. Each `via` names a function that the
 * platform module actually exports; the capabilities below mirror those exports.
 *
 * `conformance` is set conservatively to "unverified": these manifests are
 * descriptions written here, not the output of running the canonical conformance
 * harness against the adapters. Calling them "verified" would overstate what this
 * file establishes.
 */

import type { AdapterManifest } from "./manifest.js";

/** Shopify: maps orders, carts, customers, products, fulfillments both ways. */
export const SHOPIFY_MANIFEST: AdapterManifest = {
  name: "shopify",
  description: "Shopify orders/carts/customers/products/fulfillments <-> Warp model.",
  platform: "shopify",
  conformance: "unverified",
  capabilities: [
    { direction: "inbound", entity: "Commitment", via: "fromShopifyOrder" },
    { direction: "inbound", entity: "Intent", via: "fromShopifyCart" },
    { direction: "inbound", entity: "Party", via: "fromShopifyCustomer" },
    { direction: "inbound", entity: "Value", via: "fromShopifyProduct" },
    { direction: "inbound", entity: "Fulfillment", via: "fromShopifyFulfillment" },
    { direction: "outbound", entity: "CommitmentState", via: "toShopifyOrderStatus" },
    { direction: "outbound", entity: "Value", via: "toShopifyLineItem" },
  ],
};

/** Stripe: payment intents, customers, prices inbound; amounts both ways. */
export const STRIPE_MANIFEST: AdapterManifest = {
  name: "stripe",
  description: "Stripe payment intents/customers/prices -> Warp model; money both ways.",
  platform: "stripe",
  conformance: "unverified",
  capabilities: [
    { direction: "inbound", entity: "Money", via: "fromStripeAmount" },
    { direction: "inbound", entity: "Commitment", via: "fromStripePaymentIntent" },
    { direction: "inbound", entity: "Party", via: "fromStripeCustomer" },
    { direction: "inbound", entity: "Value", via: "fromStripePrice" },
    { direction: "outbound", entity: "Money", via: "toStripeAmount" },
  ],
};

/** PayPal: orders, refunds, payers, products inbound only. */
export const PAYPAL_MANIFEST: AdapterManifest = {
  name: "paypal",
  description: "PayPal orders/refunds/payers/products -> Warp model.",
  platform: "paypal",
  conformance: "unverified",
  capabilities: [
    { direction: "inbound", entity: "Commitment", via: "fromPayPalOrder" },
    { direction: "inbound", entity: "Commitment", via: "fromPayPalRefund" },
    { direction: "inbound", entity: "Party", via: "fromPayPalPayer" },
    { direction: "inbound", entity: "Value", via: "fromPayPalProduct" },
  ],
};

/** Amazon: orders, refunds, buyers, items inbound only. */
export const AMAZON_MANIFEST: AdapterManifest = {
  name: "amazon",
  description: "Amazon orders/refunds/buyers/items -> Warp model.",
  platform: "amazon",
  conformance: "unverified",
  capabilities: [
    { direction: "inbound", entity: "Commitment", via: "fromAmazonOrder" },
    { direction: "inbound", entity: "Commitment", via: "fromAmazonRefund" },
    { direction: "inbound", entity: "Party", via: "fromAmazonBuyer" },
    { direction: "inbound", entity: "Value", via: "fromAmazonItem" },
  ],
};

/** The four adapters this item registers, as a convenience array. */
export const KNOWN_ADAPTER_MANIFESTS: AdapterManifest[] = [
  SHOPIFY_MANIFEST,
  STRIPE_MANIFEST,
  PAYPAL_MANIFEST,
  AMAZON_MANIFEST,
];
