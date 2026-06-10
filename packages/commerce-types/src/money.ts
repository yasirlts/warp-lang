/**
 * Money — the typed monetary value of the Warp Commerce Model (Primitive 2:
 * Value → ValueForm → Money). Money ALWAYS carries its currency; there is no
 * amount without a denomination. This is how Invariant 1 (Value Conservation)
 * becomes impossible to violate by accident: you cannot add MAD to EUR.
 */

/**
 * ISO 4217 currency code. The common set is enumerated for autocomplete; the
 * `(string & {})` member keeps the type open to any other ISO code (and to
 * `CurrencyCode::Custom` loyalty/credit denominations) without losing the
 * literal suggestions.
 */
export type CurrencyCode =
  | "MAD"
  | "EUR"
  | "USD"
  | "GBP"
  | "DZD"
  | "TND"
  | "AED"
  | "SAR"
  | "EGP"
  | "JPY"
  | "CAD"
  | "AUD"
  | "CHF"
  | "CNY"
  | "INR"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/** A monetary value. `currency` is required — always. */
export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

/** Thrown when an operation would combine two different currencies. */
export class CurrencyMismatchError extends Error {
  constructor(
    public readonly left: CurrencyCode,
    public readonly right: CurrencyCode,
  ) {
    super(
      `Cannot operate on mixed currencies: ${left} and ${right}. ` +
        `Use convert() first (Invariant 1: Value Conservation).`,
    );
    this.name = "CurrencyMismatchError";
  }
}

/** Type guard: is `value` a well-formed Money object? */
export function isMoney(value: unknown): value is Money {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Money).amount === "number" &&
    typeof (value as Money).currency === "string" &&
    (value as Money).currency.length > 0
  );
}

/** A zero amount in `currency`. */
export function zero(currency: CurrencyCode): Money {
  return { amount: 0, currency };
}

/** Add two amounts of the same currency. Throws on mismatch — never silent. */
export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return { amount: a.amount + b.amount, currency: a.currency };
}

/** Subtract `b` from `a` (same currency). Throws on mismatch. */
export function subtract(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return { amount: a.amount - b.amount, currency: a.currency };
}

/**
 * Convert `amount` into `to` at an explicit `rate` (units of `to` per one unit
 * of `amount.currency`). Conversion is always explicit — there is no implicit
 * FX in the model.
 */
export function convert(amount: Money, to: CurrencyCode, rate: number): Money {
  return { amount: amount.amount * rate, currency: to };
}

/** Compare two amounts of the same currency. Throws on mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

/** Human-readable rendering, e.g. `"150.00 MAD"`. */
export function format(amount: Money, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: amount.currency,
    }).format(amount.amount);
  } catch {
    // Unknown / custom currency code — fall back to "<amount> <CODE>".
    return `${amount.amount.toFixed(2)} ${amount.currency}`;
  }
}
