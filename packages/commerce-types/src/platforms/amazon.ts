/**
 * Amazon (Selling Partner API — Orders) → Warp model mappings. An Amazon Order
 * IS a Commitment: its `OrderStatus` is the lifecycle and its `OrderTotal` is
 * the committed Money. Amazon represents money as `{ CurrencyCode, Amount }`
 * where `Amount` is a decimal STRING, so the mapping parses it into Warp's
 * `Money`.
 *
 * Same shape as the Shopify / WooCommerce / Stripe / PayPal mappers: a fresh
 * Draft is replayed along the canonical path to the order's final state, so the
 * returned commitment carries a VALID history (see transitions.ts).
 */

import type { CurrencyCode } from "../money.js";
import type { Commitment, Party, Value } from "../primitives.js";
import { commitmentId, individual, newCommitment, partyId, valueId } from "../primitives.js";
import type { CommitmentState } from "../states.js";
import { applyCommitmentPath } from "../transitions.js";

/** The synthetic party recorded as the actor of adapter-built history entries. */
const ADAPTER_ACTOR = partyId("system:amazon-adapter");

// --- minimal Amazon SP-API type stubs (only the fields we map) -------------

/**
 * Amazon SP-API OrderStatus. `Pending`/`PendingAvailability` are pre-payment
 * (intent recorded, value not yet committed); `Unshipped`/`PartiallyShipped`
 * are paid-and-awaiting-fulfilment; `Shipped` is fulfilled; `Canceled` is
 * cancelled. `InvoiceUnconfirmed` is treated as accepted-but-unshipped. Amazon
 * has no terminal "refunded" OrderStatus — a refund is a separate financial
 * event (see {@link AmazonRefundEvent}).
 */
export type AmazonOrderStatus =
  | "Pending"
  | "PendingAvailability"
  | "Unshipped"
  | "PartiallyShipped"
  | "InvoiceUnconfirmed"
  | "Shipped"
  | "Canceled";

export interface AmazonMoney {
  CurrencyCode: CurrencyCode;
  Amount: string; // Amazon sends money as a decimal string
}

export interface AmazonOrder {
  AmazonOrderId: string;
  OrderStatus: AmazonOrderStatus;
  OrderTotal?: AmazonMoney;
  BuyerInfo?: AmazonBuyerInfo;
}

export interface AmazonBuyerInfo {
  BuyerEmail?: string;
  /** Amazon anonymizes buyers; a stable per-order buyer id when present. */
  BuyerId?: string;
}

/**
 * An Amazon refund financial event (from the Finances API). Amazon keeps
 * refunds OUTSIDE the order status (the order stays `Shipped`), so a refund
 * maps from this object, not from {@link AmazonOrder}.
 */
export interface AmazonRefundEvent {
  /** The Warp commitment id this refund applies to (the AmazonOrderId). */
  AmazonOrderId: string;
  RefundAmount: AmazonMoney;
}

export interface AmazonOrderItem {
  /** Amazon Standard Identification Number — used as the SKU when no SellerSKU. */
  ASIN: string;
  SellerSKU?: string;
  Title?: string;
  QuantityOrdered: number;
}

/**
 * PER-ADAPTER LIMITATION — the Amazon SP-API exposes no pre-checkout "cart"
 * resource (buyers shop in Amazon's own UI; the seller never sees a cart). The
 * earliest object a seller receives is the Order in a `Pending` status, which
 * this mapper already surfaces as a Commitment in the Proposed state. There is
 * therefore no `fromAmazonCart`. This is documented rather than fabricated.
 *
 * PER-ADAPTER LIMITATION — Amazon anonymizes buyer identity. `BuyerId` is often
 * absent; when it is, the mapper records `amazon_buyer` rather than inventing a
 * stable identifier. Callers that have resolved a real customer should overwrite
 * the commitment's `buyer` party afterward.
 */

// --- mappings --------------------------------------------------------------

function orderMoney(order: AmazonOrder): { amount: number; currency: CurrencyCode } {
  if (order.OrderTotal === undefined) return { amount: 0, currency: "USD" };
  return { amount: Number(order.OrderTotal.Amount), currency: order.OrderTotal.CurrencyCode };
}

function orderState(order: AmazonOrder): CommitmentState {
  switch (order.OrderStatus) {
    case "Pending":
    case "PendingAvailability":
      return { type: "Proposed" };
    case "Unshipped":
    case "PartiallyShipped":
    case "InvoiceUnconfirmed":
      return { type: "Accepted" };
    case "Shipped":
      return { type: "Fulfilled" };
    case "Canceled":
      return { type: "Cancelled", by: partyId("amazon"), reason: "canceled", at: new Date().toISOString() };
  }
}

export function fromAmazonOrder(order: AmazonOrder): Commitment {
  const buyer = order.BuyerInfo?.BuyerId ? partyId(order.BuyerInfo.BuyerId) : partyId("amazon_buyer");
  const money = orderMoney(order);
  const draft: Commitment = {
    ...newCommitment(buyer, partyId("amazon_seller")),
    id: commitmentId(order.AmazonOrderId),
    subject: {
      offered: [],
      requested: [
        {
          id: valueId(),
          form: { kind: "Money", money },
          quantity: 1,
          state: { type: "Available" },
        },
      ],
    },
  };
  return applyCommitmentPath(draft, orderState(order), ADAPTER_ACTOR, "amazon-adapter");
}

/**
 * Map an Amazon refund financial event onto its originating order's commitment.
 * Because Amazon keeps refunds OUTSIDE the order status, this drives the
 * commitment to the Warp `Refunded` state from the refund event.
 */
export function fromAmazonRefund(refund: AmazonRefundEvent): Commitment {
  const money = { amount: Number(refund.RefundAmount.Amount), currency: refund.RefundAmount.CurrencyCode };
  const draft: Commitment = {
    ...newCommitment(partyId("amazon_buyer"), partyId("amazon_seller")),
    id: commitmentId(refund.AmazonOrderId),
    subject: {
      offered: [],
      requested: [{ id: valueId(), form: { kind: "Money", money }, quantity: 1, state: { type: "Available" } }],
    },
  };
  return applyCommitmentPath(draft, { type: "Refunded", amount: money, at: new Date().toISOString() }, ADAPTER_ACTOR, "amazon-adapter");
}

export function fromAmazonBuyer(buyer: AmazonBuyerInfo): Party {
  // Amazon buyer payloads carry no locale here; en/USD/US is an explicit
  // fallback — overwrite `.locale` when the caller knows the real locale.
  const id = buyer.BuyerId ?? "amazon_buyer";
  return individual(partyId(id), { language: "en", currency: "USD", jurisdiction: "US" });
}

export function fromAmazonItem(item: AmazonOrderItem): Value {
  return {
    id: valueId(item.ASIN),
    form: { kind: "PhysicalGood", sku: item.SellerSKU ?? item.ASIN, condition: "New" },
    quantity: item.QuantityOrdered,
    state: { type: "Available" },
  };
}
