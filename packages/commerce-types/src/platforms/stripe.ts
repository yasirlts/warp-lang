/**
 * Stripe → Warp model mappings. Stripe represents money in the smallest
 * currency unit (cents for USD, no decimals for JPY); the mapping converts to
 * and from Warp's decimal `Money` correctly per currency.
 */

import type { CurrencyCode, Money } from "../money.js";
import type { Commitment, Party, Value } from "../primitives.js";
import { commitmentId, individual, newCommitment, partyId, valueId } from "../primitives.js";
import type { CommitmentState } from "../states.js";

export type StripePaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "processing"
  | "succeeded"
  | "canceled";

export interface StripePaymentIntent {
  id: string;
  amount: number; // smallest currency unit
  currency: string; // lowercase ISO code
  status: StripePaymentIntentStatus;
  customer?: string;
}

export interface StripeCustomer {
  id: string;
  email?: string;
}

export interface StripePrice {
  id: string;
  unit_amount: number; // smallest currency unit
  currency: string;
}

/** Currencies Stripe treats as zero-decimal (amount is already the whole unit). */
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx",
  "vnd", "vuv", "xaf", "xof", "xpf",
]);

/** Convert a Stripe minor-unit amount into Warp `Money`. */
export function fromStripeAmount(amount: number, currency: string): Money {
  const code = currency.toUpperCase() as CurrencyCode;
  if (ZERO_DECIMAL.has(currency.toLowerCase())) return { amount, currency: code };
  return { amount: amount / 100, currency: code };
}

/** Convert Warp `Money` into a Stripe `{ amount, currency }`. */
export function toStripeAmount(money: Money): { amount: number; currency: string } {
  const currency = money.currency.toLowerCase();
  const amount = ZERO_DECIMAL.has(currency)
    ? Math.round(money.amount)
    : Math.round(money.amount * 100);
  return { amount, currency };
}

function intentState(pi: StripePaymentIntent): CommitmentState {
  switch (pi.status) {
    case "requires_payment_method":
    case "requires_confirmation":
    case "processing":
      return { type: "Proposed" };
    case "succeeded":
      return { type: "Accepted" };
    case "canceled":
      return { type: "Cancelled", by: partyId("stripe"), reason: "canceled", at: new Date().toISOString() };
  }
}

export function fromStripePaymentIntent(pi: StripePaymentIntent): Commitment {
  const buyer = pi.customer ? partyId(pi.customer) : partyId("stripe_guest");
  const c = newCommitment(buyer, partyId("stripe_merchant"));
  return {
    ...c,
    id: commitmentId(pi.id),
    state: intentState(pi),
    subject: {
      offered: [],
      requested: [
        {
          id: valueId(),
          form: { kind: "Money", money: fromStripeAmount(pi.amount, pi.currency) },
          quantity: 1,
          state: { type: "Available" },
        },
      ],
    },
  };
}

export function fromStripeCustomer(customer: StripeCustomer): Party {
  return individual(partyId(customer.id), { language: "en", currency: "USD", jurisdiction: "US" });
}

export function fromStripePrice(price: StripePrice): Value {
  return {
    id: valueId(price.id),
    form: { kind: "Money", money: fromStripeAmount(price.unit_amount, price.currency) },
    quantity: 1,
    state: { type: "Available" },
  };
}
