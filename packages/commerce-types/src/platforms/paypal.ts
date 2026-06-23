/**
 * PayPal → Warp model mappings. A PayPal Order (v2 Orders API) IS a Commitment:
 * its `status` is the lifecycle and its `purchase_units[].amount` is the
 * committed Money. PayPal represents money as a decimal string plus a separate
 * `currency_code`, so the mapping parses the string into Warp's `Money`.
 *
 * Same shape as the Shopify / WooCommerce / Stripe mappers: a fresh Draft is
 * replayed along the canonical path to the order's final state, so the returned
 * commitment carries a VALID history (not an empty one that would falsely fail
 * the temporal-integrity check — see transitions.ts).
 */

import type { CurrencyCode } from "../money.js";
import type { Commitment, Party, Value } from "../primitives.js";
import { commitmentId, individual, newCommitment, partyId, valueId } from "../primitives.js";
import type { CommitmentState } from "../states.js";
import { applyCommitmentPath } from "../transitions.js";

/** The synthetic party recorded as the actor of adapter-built history entries. */
const ADAPTER_ACTOR = partyId("system:paypal-adapter");

// --- minimal PayPal type stubs (only the fields we map) --------------------

/**
 * PayPal Orders v2 status. `CREATED`/`SAVED`/`APPROVED`/`PAYER_ACTION_REQUIRED`
 * are pre-capture (the buyer's intent is recorded but value has not moved);
 * `COMPLETED` is captured; `VOIDED` is cancelled. PayPal has no terminal
 * "refunded" status on the Order itself — a refund is a separate `Refund`
 * resource under a capture (see {@link PayPalRefund} below).
 */
export type PayPalOrderStatus =
  | "CREATED"
  | "SAVED"
  | "APPROVED"
  | "PAYER_ACTION_REQUIRED"
  | "COMPLETED"
  | "VOIDED";

export interface PayPalAmount {
  currency_code: CurrencyCode;
  value: string; // PayPal sends money as a decimal string
}

export interface PayPalPurchaseUnit {
  amount: PayPalAmount;
}

export interface PayPalOrder {
  id: string;
  status: PayPalOrderStatus;
  purchase_units: PayPalPurchaseUnit[];
  payer?: PayPalPayer;
}

export interface PayPalPayer {
  payer_id: string;
  email_address?: string;
}

/**
 * A captured PayPal Refund resource. PayPal models a refund OUTSIDE the order
 * status (the order stays `COMPLETED`), so a refund maps from this object, not
 * from {@link PayPalOrder}. `status` is `COMPLETED` once the refund settles.
 */
export interface PayPalRefund {
  id: string;
  status: "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED";
  amount: PayPalAmount;
  /** The Warp commitment id this refund applies to (the originating order id). */
  order_id: string;
}

export interface PayPalProduct {
  id: string;
  /** PayPal Catalog `sku` (optional in PayPal; "" when absent). */
  sku?: string;
  name?: string;
}

/**
 * PER-ADAPTER LIMITATION — PayPal has no first-class "cart" object equivalent to
 * a Shopify cart or a Woo cart. The pre-payment buyer intent lives inside the
 * Order's pre-capture statuses (CREATED/APPROVED), which this mapper already
 * surfaces as a Commitment in the Proposed state. There is therefore no
 * `fromPayPalCart` here — a separate Intent would duplicate the Order, not add
 * information. This is documented rather than fabricated.
 */

// --- mappings --------------------------------------------------------------

/** The single committed amount of a PayPal order (its first purchase unit). */
function orderMoney(order: PayPalOrder): { amount: number; currency: CurrencyCode } {
  const unit = order.purchase_units[0];
  if (unit === undefined) return { amount: 0, currency: "USD" };
  return { amount: Number(unit.amount.value), currency: unit.amount.currency_code };
}

function orderState(order: PayPalOrder): CommitmentState {
  switch (order.status) {
    case "CREATED":
    case "SAVED":
    case "APPROVED":
    case "PAYER_ACTION_REQUIRED":
      return { type: "Proposed" };
    case "COMPLETED":
      return { type: "Accepted" };
    case "VOIDED":
      return { type: "Cancelled", by: partyId("paypal"), reason: "voided", at: new Date().toISOString() };
  }
}

export function fromPayPalOrder(order: PayPalOrder): Commitment {
  const buyer = order.payer ? partyId(order.payer.payer_id) : partyId("paypal_guest");
  const money = orderMoney(order);
  const draft: Commitment = {
    ...newCommitment(buyer, partyId("paypal_merchant")),
    id: commitmentId(order.id),
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
  return applyCommitmentPath(draft, orderState(order), ADAPTER_ACTOR, "paypal-adapter");
}

/**
 * Map a settled PayPal Refund onto its originating order's commitment. Because
 * PayPal keeps refunds OUTSIDE the order status, this drives the commitment to
 * the Warp `Refunded` state from the refund resource. Only a `COMPLETED` refund
 * represents value that has actually moved; a non-completed refund maps to the
 * Accepted (captured-but-not-refunded) state, so callers do not over-report.
 */
export function fromPayPalRefund(refund: PayPalRefund): Commitment {
  const money = { amount: Number(refund.amount.value), currency: refund.amount.currency_code };
  const draft: Commitment = {
    ...newCommitment(partyId("paypal_payer"), partyId("paypal_merchant")),
    id: commitmentId(refund.order_id),
    subject: {
      offered: [],
      requested: [{ id: valueId(), form: { kind: "Money", money }, quantity: 1, state: { type: "Available" } }],
    },
  };
  const target: CommitmentState =
    refund.status === "COMPLETED"
      ? { type: "Refunded", amount: money, at: new Date().toISOString() }
      : { type: "Accepted" };
  return applyCommitmentPath(draft, target, ADAPTER_ACTOR, "paypal-adapter");
}

export function fromPayPalPayer(payer: PayPalPayer): Party {
  // PayPal payer payloads carry no locale here; en/USD/US is an explicit
  // fallback — overwrite `.locale` when the caller knows the real locale.
  return individual(partyId(payer.payer_id), { language: "en", currency: "USD", jurisdiction: "US" });
}

export function fromPayPalProduct(product: PayPalProduct): Value {
  return {
    id: valueId(product.id),
    form: { kind: "PhysicalGood", sku: product.sku ?? "", condition: "New" },
    quantity: 1,
    state: { type: "Available" },
  };
}
