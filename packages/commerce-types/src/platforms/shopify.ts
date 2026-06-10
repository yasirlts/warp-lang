/**
 * Shopify → Warp model mappings. The mapping is mechanical: a Shopify order
 * IS a Commitment, a cart IS an Intent, a customer IS a Party. Minimal Shopify
 * type stubs are defined here so the package has no external dependencies.
 */

import type { CurrencyCode } from "../money.js";
import type { Commitment, Fulfillment, Intent, Party, Value } from "../primitives.js";
import {
  commitmentId,
  fulfillmentId,
  individual,
  newCommitment,
  newFulfillment,
  newIntent,
  partyId,
  valueId,
} from "../primitives.js";
import type { CommitmentState } from "../states.js";

// --- minimal Shopify type stubs (only the fields we map) -------------------

export type ShopifyFinancialStatus = "pending" | "paid" | "refunded" | "voided";
export type ShopifyFulfillmentStatus = "unfulfilled" | "partial" | "fulfilled" | null;

export interface ShopifyOrder {
  id: string;
  currency: CurrencyCode;
  total_price: string; // Shopify sends money as a decimal string
  financial_status: ShopifyFinancialStatus;
  fulfillment_status?: ShopifyFulfillmentStatus;
  customer?: ShopifyCustomer;
}

export interface ShopifyCart {
  token: string;
  customer?: ShopifyCustomer;
}

export interface ShopifyCustomer {
  id: string;
  email?: string;
}

export interface ShopifyProduct {
  id: string;
  sku: string;
  title?: string;
}

export interface ShopifyFulfillment {
  id: string;
  order_id: string;
  status: "pending" | "open" | "success" | "cancelled" | "failure";
}

export type ShopifyOrderStatus = ShopifyFinancialStatus | "fulfilled";

export interface ShopifyLineItem {
  sku: string;
  quantity: number;
}

// --- mappings --------------------------------------------------------------

function orderState(order: ShopifyOrder): CommitmentState {
  if (order.fulfillment_status === "fulfilled") return { type: "Fulfilled" };
  switch (order.financial_status) {
    case "pending":
      return { type: "Proposed" };
    case "paid":
      return { type: "Accepted" };
    case "refunded":
      return { type: "Refunded", amount: { amount: Number(order.total_price), currency: order.currency }, at: new Date().toISOString() };
    case "voided":
      return { type: "Cancelled", by: partyId("shopify"), reason: "voided", at: new Date().toISOString() };
  }
}

export function fromShopifyOrder(order: ShopifyOrder): Commitment {
  const buyer = order.customer ? partyId(order.customer.id) : partyId("shopify_guest");
  const c = newCommitment(buyer, partyId("shopify_store"));
  return {
    ...c,
    id: commitmentId(order.id),
    state: orderState(order),
    subject: {
      offered: [],
      requested: [
        {
          id: valueId(),
          form: { kind: "Money", money: { amount: Number(order.total_price), currency: order.currency } },
          quantity: 1,
          state: { type: "Available" },
        },
      ],
    },
  };
}

export function fromShopifyCart(cart: ShopifyCart): Intent {
  const buyer = cart.customer ? partyId(cart.customer.id) : partyId("shopify_guest");
  return { ...newIntent(buyer), originated_from: cart.token };
}

export function fromShopifyCustomer(customer: ShopifyCustomer): Party {
  return individual(partyId(customer.id), { language: "en", currency: "USD", jurisdiction: "US" });
}

export function fromShopifyProduct(product: ShopifyProduct): Value {
  return {
    id: valueId(product.id),
    form: { kind: "PhysicalGood", sku: product.sku, condition: "New" },
    quantity: 1,
    state: { type: "Available" },
  };
}

export function fromShopifyFulfillment(f: ShopifyFulfillment): Fulfillment {
  const base = newFulfillment(commitmentId(f.order_id));
  const ful = { ...base, id: fulfillmentId(f.id) };
  switch (f.status) {
    case "success":
      return { ...ful, state: { type: "Completed" } };
    case "open":
    case "pending":
      return { ...ful, state: { type: "InProgress" } };
    case "failure":
      return { ...ful, state: { type: "Failed", reason: "shopify failure", recoverable: true } };
    case "cancelled":
      return { ...ful, state: { type: "Reversed", reason: "cancelled", initiated_by: partyId("shopify"), at: new Date().toISOString() } };
  }
}

export function toShopifyOrderStatus(state: CommitmentState): ShopifyOrderStatus {
  switch (state.type) {
    case "Proposed":
    case "Draft":
    case "Tendered":
      return "pending";
    case "Accepted":
    case "Active":
    case "Modified":
    case "PartiallyFulfilled":
      return "paid";
    case "Fulfilled":
      return "fulfilled";
    case "Refunded":
      return "refunded";
    case "Cancelled":
    case "Disputed":
      return "voided";
  }
}

export function toShopifyLineItem(value: Value): ShopifyLineItem {
  const sku = value.form.kind === "PhysicalGood" ? value.form.sku : "";
  return { sku, quantity: value.quantity };
}
