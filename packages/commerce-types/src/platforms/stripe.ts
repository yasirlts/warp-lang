/**
 * Stripe → Warp model mappings. Stripe represents money in the smallest
 * currency unit (cents for USD, no decimals for JPY); the mapping converts to
 * and from Warp's decimal `Money` correctly per currency.
 */

import type { CurrencyCode, Money } from "../money.js";
import type { Commitment, Party, Value } from "../primitives.js";
import { commitmentId, individual, newCommitment, partyId, valueId } from "../primitives.js";
import type { CommitmentState } from "../states.js";
import { applyCommitmentPath } from "../transitions.js";

/** The synthetic party recorded as the actor of adapter-built history entries. */
const ADAPTER_ACTOR = partyId("system:stripe-adapter");

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

/**
 * Currencies with no minor unit — the Stripe amount is already the whole unit.
 * (Uppercase; `minorUnitFactor` normalizes case.)
 */
const ZERO_DECIMAL = new Set([
  "JPY", "KRW", "VND", "CLP", "ISK", "XAF", "XOF", "XPF", "BIF", "DJF",
  "GNF", "KMF", "MGA", "PYG", "RWF", "UGX", "VUV",
]);

/**
 * Currencies with THREE minor digits (millimes/fils) — the Stripe amount is the
 * whole unit × 1000, NOT × 100. TND is in this package's featured currency list;
 * treating it as two-decimal made every TND amount 10× wrong.
 */
const THREE_DECIMAL = new Set(["TND", "BHD", "KWD", "OMR", "JOD"]);

/**
 * The integer factor between a currency's whole unit and its Stripe minor unit:
 * 1 (zero-decimal), 1000 (three-decimal), or 100 (the default two-decimal case).
 */
function minorUnitFactor(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 1;
  if (THREE_DECIMAL.has(c)) return 1000;
  return 100;
}

/** Convert a Stripe minor-unit amount into Warp `Money`. */
export function fromStripeAmount(amount: number, currency: string): Money {
  const code = currency.toUpperCase() as CurrencyCode;
  return { amount: amount / minorUnitFactor(currency), currency: code };
}

/**
 * Convert Warp `Money` into a Stripe `{ amount, currency }`. Rounds to an
 * integer after scaling so `1.5 * 1000` is exactly `1500`, never `1499.9999`.
 */
export function toStripeAmount(money: Money): { amount: number; currency: string } {
  const amount = Math.round(money.amount * minorUnitFactor(money.currency));
  return { amount, currency: money.currency.toLowerCase() };
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
  // Fresh Draft → canonical path to the final state, so the commitment carries
  // a valid history (see transitions.ts / checkI4TemporalIntegrity).
  const draft: Commitment = {
    ...newCommitment(buyer, partyId("stripe_merchant")),
    id: commitmentId(pi.id),
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
  return applyCommitmentPath(draft, intentState(pi), ADAPTER_ACTOR, "stripe-adapter");
}

export function fromStripeCustomer(customer: StripeCustomer): Party {
  // Stripe customer payloads carry no locale here; en/USD/US is an explicit
  // fallback — overwrite `.locale` when the caller knows the real locale.
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
