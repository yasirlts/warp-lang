/**
 * WooCommerce → Warp model mappings. Same pattern as the Shopify mapper.
 */

import type { CurrencyCode } from "../money.js";
import type { Commitment, Intent, Party, Value } from "../primitives.js";
import {
  commitmentId,
  individual,
  newCommitment,
  newIntent,
  partyId,
  valueId,
} from "../primitives.js";
import type { CommitmentState } from "../states.js";

export type WooOrderStatus =
  | "pending"
  | "processing"
  | "on-hold"
  | "completed"
  | "cancelled"
  | "refunded"
  | "failed";

export interface WooOrder {
  id: number;
  currency: CurrencyCode;
  total: string;
  status: WooOrderStatus;
  customer_id?: number;
}

export interface WooCart {
  cart_key: string;
  customer_id?: number;
}

export interface WooCustomer {
  id: number;
  email?: string;
}

export interface WooProduct {
  id: number;
  sku: string;
  name?: string;
}

function orderState(order: WooOrder): CommitmentState {
  switch (order.status) {
    case "pending":
      return { type: "Proposed" };
    case "processing":
    case "on-hold":
      return { type: "Accepted" };
    case "completed":
      return { type: "Fulfilled" };
    case "refunded":
      return { type: "Refunded", amount: { amount: Number(order.total), currency: order.currency }, at: new Date().toISOString() };
    case "cancelled":
    case "failed":
      return { type: "Cancelled", by: partyId("woocommerce"), reason: order.status, at: new Date().toISOString() };
  }
}

export function fromWooOrder(order: WooOrder): Commitment {
  const buyer = order.customer_id ? partyId(String(order.customer_id)) : partyId("woo_guest");
  const c = newCommitment(buyer, partyId("woo_store"));
  return {
    ...c,
    id: commitmentId(String(order.id)),
    state: orderState(order),
    subject: {
      offered: [],
      requested: [
        {
          id: valueId(),
          form: { kind: "Money", money: { amount: Number(order.total), currency: order.currency } },
          quantity: 1,
          state: { type: "Available" },
        },
      ],
    },
  };
}

export function fromWooCart(cart: WooCart): Intent {
  const buyer = cart.customer_id ? partyId(String(cart.customer_id)) : partyId("woo_guest");
  return { ...newIntent(buyer), originated_from: cart.cart_key };
}

export function fromWooCustomer(customer: WooCustomer): Party {
  return individual(partyId(String(customer.id)), { language: "en", currency: "USD", jurisdiction: "US" });
}

export function fromWooProduct(product: WooProduct): Value {
  return {
    id: valueId(String(product.id)),
    form: { kind: "PhysicalGood", sku: product.sku, condition: "New" },
    quantity: 1,
    state: { type: "Available" },
  };
}
