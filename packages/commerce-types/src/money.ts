/**
 * Money — the typed monetary value of the Warp Commerce Model (Primitive 2:
 * Value → ValueForm → Money). Money ALWAYS carries its currency; there is no
 * amount without a denomination. This is how accidental currency mixing is
 * caught rather than silently allowed: you cannot add MAD to EUR.
 *
 * `CurrencyCode` and `Money` — together with the `MoneyBreakdown` family — are
 * generated from `schema/structure/money.schema.json` (see
 * `./generated/types.generated.ts`). This module re-exports them and adds the
 * hand-written money arithmetic that the schema deliberately does not carry.
 */

import type { CurrencyCode, Money, MoneyBreakdown } from "./generated/types.generated.js";

export type {
  CurrencyCode,
  Money,
  MoneyComponentKind,
  MoneyComponent,
  MoneyBreakdown,
  MoneyOrBreakdown,
} from "./generated/types.generated.js";

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

// ---------------------------------------------------------------------------
// Minor-unit precision — the substrate for exact money arithmetic (avoids the
// 0.1 + 0.2 !== 0.3 class of float bugs). Used by Invariant 6 and `allocate`.
// ---------------------------------------------------------------------------

const ZERO_DECIMAL_CURRENCIES = new Set([
  "JPY", "KRW", "VND", "CLP", "ISK", "XAF", "XOF", "XPF", "BIF", "DJF",
  "GNF", "KMF", "MGA", "PYG", "RWF", "UGX", "VUV",
]);
const THREE_DECIMAL_CURRENCIES = new Set(["TND", "BHD", "KWD", "OMR", "JOD"]);

/** Number of minor-unit digits for a currency: 0, 3, or the default 2. */
export function currencyDecimals(currency: CurrencyCode): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(c)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(c)) return 3;
  return 2;
}

/**
 * Half the smallest minor unit of `currency` — the tolerance for "are these two
 * amounts equal?" comparisons. For USD (2 decimals) this is 0.005; any
 * difference smaller than half a cent is float noise, not a real discrepancy.
 */
export function moneyEpsilon(currency: CurrencyCode): number {
  return 0.5 * Math.pow(10, -currencyDecimals(currency));
}

/** True if `a` and `b` are equal to within `currency`'s minor-unit tolerance. */
export function moneyEquals(a: number, b: number, currency: CurrencyCode): boolean {
  return Math.abs(a - b) < moneyEpsilon(currency);
}

/**
 * Split `total` into parts proportional to `weights`, guaranteeing the parts
 * sum **exactly** to `total` (in minor units). Uses the largest-remainder
 * method: compute each ideal share, floor to whole minor units, then hand the
 * leftover minor units one-by-one to the parts with the largest fractional
 * remainders. This is how a parent commitment is split into children without
 * violating Invariant 6 — naive `total * w / sum` rounding loses or gains a
 * cent and breaks the tree-consistency check.
 *
 * Throws on an empty `weights` array or a non-positive weight sum.
 */
export function allocate(total: Money, weights: number[]): Money[] {
  if (weights.length === 0) throw new Error("allocate: weights must be non-empty");
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) throw new Error("allocate: weights must sum to a positive number");

  const factor = Math.pow(10, currencyDecimals(total.currency));
  const totalMinor = Math.round(total.amount * factor);

  const ideal = weights.map((w) => (totalMinor * w) / sumW);
  const minor = ideal.map((x) => Math.floor(x));
  const distributed = minor.reduce((a, b) => a + b, 0);
  let remainder = totalMinor - distributed; // in [0, weights.length)

  // Hand each leftover minor unit to the part with the next-largest remainder.
  const byFraction = ideal
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0 && k < byFraction.length; k++, remainder--) {
    const entry = byFraction[k];
    if (entry) minor[entry.i] = (minor[entry.i] ?? 0) + 1;
  }

  return minor.map((m) => ({ amount: m / factor, currency: total.currency }));
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

// ---------------------------------------------------------------------------
// MoneyBreakdown sum validation — the canonical `money_breakdown_sum` rule
// (schema/behavior/invariants.json, invariant I-1). This is the explicit
// extension of I-1 (Value Conservation) to a MoneyBreakdown.
// ---------------------------------------------------------------------------

/**
 * Enforce the canonical `money_breakdown_sum` rule
 * (schema/behavior/invariants.json → invariant I-1, expression `money_breakdown_sum`):
 *
 *     all(c.amount.currency === total.currency for c in components)
 *     AND moneyEquals(sum(c.amount.amount for c in components), total.amount, total.currency)
 *
 * i.e. every component shares the total's currency and the component amounts sum
 * to the total within the currency's minor-unit tolerance (a Discount component
 * carries a negative amount and therefore subtracts). Equality is checked with
 * `moneyEquals`, NOT exact float equality, so a 0.1 + 0.2 breakdown reconciles
 * against a 0.3 total. Throws on violation — the TypeScript twin of Python's
 * `validate_money_breakdown` (packages/commerce-types-py money.py).
 */
export function validateMoneyBreakdown(breakdown: MoneyBreakdown): void {
  const currency = breakdown.total.currency;

  // single-currency clause
  for (const c of breakdown.components) {
    if (c.amount.currency !== currency) {
      throw new CurrencyMismatchError(c.amount.currency, currency);
    }
  }

  // sum clause (minor-unit tolerance, NOT exact float equality)
  const componentSum = breakdown.components.reduce((s, c) => s + c.amount.amount, 0);
  if (!moneyEquals(componentSum, breakdown.total.amount, currency)) {
    throw new Error(
      `MoneyBreakdown components sum to ${componentSum} ${currency} but total is ` +
        `${breakdown.total.amount} ${currency} (money_breakdown_sum)`,
    );
  }
}
