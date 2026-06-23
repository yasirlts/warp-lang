/**
 * Multi-component settlement — validate that a settlement decomposed into typed
 * components (principal / tax / fees / shipping / …) RECONCILES against the
 * committed total, in one currency, and track partial settlements cumulatively.
 *
 * SCOPE, STATED PLAINLY. This module validates that a settlement is COHERENT: its
 * components sum to the committed total (I-1 / `money_breakdown_sum`), every
 * component shares one currency, and a sequence of partial settlements never
 * exceeds the total. It is NOT a tax engine. It does NOT compute tax rates, pick
 * a jurisdiction, or derive what the tax amount SHOULD be — those are
 * caller-supplied inputs. Warp's job here is the downstream check: given the
 * amounts a caller already computed, do they add up and conserve value. A
 * settlement whose `Tax` component is wrong-for-the-jurisdiction but still sums
 * to the total will PASS this validator — checking the tax math against a
 * jurisdiction is out of scope and the module does not pretend otherwise.
 *
 * COMPOSITION, NOT REIMPLEMENTATION. The two load-bearing pieces are reused, not
 * forked:
 *   - {@link MoneyBreakdown} + {@link validateMoneyBreakdown} (money.ts) — the
 *     typed components and the single-currency + sum-to-total rule. The breakdown
 *     IS the multi-component settlement; reconciliation IS `money_breakdown_sum`.
 *   - {@link moneyEquals} / {@link add} — minor-unit tolerance and currency-safe
 *     addition, shared with the rest of the package (the `0.1 + 0.2 = 0.3` case
 *     reconciles, mixed currencies throw).
 * The cumulative partial-settlement ledger mirrors the session refund-tally idiom
 * (session.ts): accumulate Money against the committed total, cap with the same
 * tolerance, surface "remaining" on rejection. It does not re-derive any
 * invariant — over-settlement is the breakdown sum rule applied to the running
 * total.
 *
 * TypeScript first. Ports to Python / Rust / Go are roadmap.
 */

import { add, moneyEquals, validateMoneyBreakdown } from "./money.js";
import type { Money, MoneyBreakdown, MoneyComponent } from "./money.js";

/** A single rejected-settlement reason, in the package's `{ rule, message, fix }` idiom. */
export interface SettlementViolation {
  /** The invariant or rule that was violated (e.g. "I-1"). */
  rule: string;
  /** What went wrong, in plain language. */
  message: string;
  /** How to make it valid. */
  fix: string;
}

/** The verdict of validating a single multi-component settlement against a total. */
export type SettlementResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: SettlementViolation[] };

/**
 * Validate that a multi-component settlement RECONCILES: its components sum to
 * `committedTotal` within the currency's minor-unit tolerance, in one currency
 * (a `Discount` component carries a negative amount and subtracts). This is the
 * `money_breakdown_sum` rule (I-1, Value Conservation) applied with the committed
 * total as the reference — i.e. the breakdown's own `total` must itself equal the
 * commitment's committed amount, AND the components must sum to it.
 *
 * Returns `{ ok: true }` when coherent, else `{ ok: false, violations }`. Does
 * NOT compute tax — the component amounts are caller-supplied; this only checks
 * they add up and conserve value.
 */
export function validateSettlement(
  settlement: MoneyBreakdown,
  committedTotal: Money,
): SettlementResult {
  const violations: SettlementViolation[] = [];

  // (1) The breakdown's declared total must match the committed amount, same
  // currency. A settlement that decomposes a DIFFERENT total than was committed
  // is incoherent even if its own components happen to sum to its own total.
  if (settlement.total.currency !== committedTotal.currency) {
    violations.push({
      rule: "I-1",
      message:
        `Settlement total is denominated in ${settlement.total.currency} but the commitment ` +
        `was committed in ${committedTotal.currency} — a settlement cannot change the currency ` +
        `of what was committed.`,
      fix:
        `Express the settlement in ${committedTotal.currency} (convert() the source amounts first); ` +
        `cross-currency settlement needs an explicit recorded conversion, not a silent re-denomination.`,
    });
    // Currency mismatch poisons every downstream sum comparison; report and stop.
    return { ok: false, violations };
  }
  if (!moneyEquals(settlement.total.amount, committedTotal.amount, committedTotal.currency)) {
    violations.push({
      rule: "I-1",
      message:
        `Settlement decomposes a total of ${settlement.total.amount} ${settlement.total.currency} ` +
        `but the commitment committed ${committedTotal.amount} ${committedTotal.currency} — the ` +
        `settlement total must equal what was committed.`,
      fix:
        `Set the settlement total to the committed ${committedTotal.amount} ${committedTotal.currency}, ` +
        `then decompose THAT into principal / tax / fees / shipping components.`,
    });
  }

  // (2) Components must sum to the breakdown total in one currency — the canonical
  // money_breakdown_sum rule. Reuse validateMoneyBreakdown verbatim (it throws),
  // translated into the violations idiom; never re-implement the sum check.
  try {
    validateMoneyBreakdown(settlement);
  } catch (e) {
    violations.push({
      rule: "I-1",
      message: `Settlement components do not reconcile: ${(e as Error).message}`,
      fix:
        "Make the components — principal, tax, fees, shipping (Discounts negative) — sum to the " +
        "settlement total in one currency. Component amounts are your input; Warp checks they add up.",
    });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** The amount settled so far on a commitment, with how many partial settlements composed it. */
interface SettlementTally {
  total: Money;
  count: number;
}

/** Read-only view onto the cumulative state of a settlement ledger entry. */
export interface SettlementProgress {
  /** Total settled so far (null if nothing has settled yet). */
  readonly settled: Money | null;
  /** Amount still outstanding against the committed total. */
  readonly remaining: Money;
  /** True once cumulative settlements reach the committed total (within tolerance). */
  readonly fullySettled: boolean;
  /** Number of partial settlements applied so far. */
  readonly count: number;
}

/**
 * A stateful tracker for PARTIAL multi-component settlements against a single
 * committed total. Each `settle(...)` is itself a multi-component breakdown that
 * must internally reconcile (its components sum to its own declared total); the
 * tracker then accumulates those declared totals and caps the running sum at the
 * committed amount. This is the session refund-ledger idiom (session.ts) applied
 * to settlement: a sequence of valid partial settlements whose SUM exceeds the
 * committed total is rejected, with the remaining headroom surfaced.
 *
 * Scope is per-tracker and in-memory — durable, cross-process settlement state
 * would need a persistent store and is not provided here.
 */
export interface SettlementTracker {
  /**
   * Apply one partial settlement (a multi-component breakdown whose declared
   * `total` is the amount settled in THIS step, and whose components sum to it).
   * On success the step's total is added to the running ledger; on failure the
   * ledger is unchanged. A step whose components don't reconcile, or that pushes
   * the cumulative total past the committed amount, is rejected.
   */
  settle(step: MoneyBreakdown): SettlementResult;
  /** The cumulative progress against the committed total. */
  progress(): SettlementProgress;
}

/**
 * Create a tracker that accumulates partial settlements against `committedTotal`.
 * Each step must be a multi-component breakdown denominated in the committed
 * currency, internally reconciling, and not exceeding the remaining headroom.
 */
export function createSettlementTracker(committedTotal: Money): SettlementTracker {
  let tally: SettlementTally | null = null;

  function progress(): SettlementProgress {
    const settledAmt = tally ? tally.total.amount : 0;
    const remaining = Math.max(0, committedTotal.amount - settledAmt);
    return {
      settled: tally ? tally.total : null,
      remaining: { amount: remaining, currency: committedTotal.currency },
      fullySettled: moneyEquals(settledAmt, committedTotal.amount, committedTotal.currency),
      count: tally ? tally.count : 0,
    };
  }

  function settle(step: MoneyBreakdown): SettlementResult {
    const violations: SettlementViolation[] = [];

    // The step must be in the committed currency — a partial settlement cannot
    // re-denominate the obligation. (Caught before the sum check so the message
    // is about currency, not an arithmetic mismatch across currencies.)
    if (step.total.currency !== committedTotal.currency) {
      return {
        ok: false,
        violations: [
          {
            rule: "I-1",
            message:
              `Partial settlement is in ${step.total.currency} but the commitment is settled in ` +
              `${committedTotal.currency} — partial settlements share the committed currency.`,
            fix:
              `Express this settlement in ${committedTotal.currency}; cross-currency settlement needs ` +
              `an explicit recorded conversion, not a silent re-denomination.`,
          },
        ],
      };
    }

    // The step must itself reconcile: its components sum to its declared total.
    // Reuse validateMoneyBreakdown — the same money_breakdown_sum rule.
    try {
      validateMoneyBreakdown(step);
    } catch (e) {
      violations.push({
        rule: "I-1",
        message: `Partial settlement components do not reconcile: ${(e as Error).message}`,
        fix:
          "Make this step's components sum to its declared total in one currency before applying it.",
      });
    }
    if (violations.length > 0) return { ok: false, violations };

    // Cumulative cap: the running total plus this step must not exceed the
    // committed amount (within minor-unit tolerance). This is the breakdown sum
    // rule applied to the SEQUENCE — the same conservation principle, lifted from
    // one breakdown to the accumulating ledger.
    const priorAmt = tally ? tally.total.amount : 0;
    const cumulative = priorAmt + step.total.amount;
    const overByTolerance =
      cumulative > committedTotal.amount &&
      !moneyEquals(cumulative, committedTotal.amount, committedTotal.currency);
    if (overByTolerance) {
      const remaining = Math.max(0, committedTotal.amount - priorAmt);
      return {
        ok: false,
        violations: [
          {
            rule: "I-1",
            message:
              `Cumulative settlements would reach ${cumulative} ${committedTotal.currency} across ` +
              `${(tally ? tally.count : 0) + 1} settlement(s), but only ${committedTotal.amount} ` +
              `${committedTotal.currency} was committed — value is not conserved across the settlements ` +
              `(each partial settlement reconciles alone, but together they over-settle the total).`,
            fix:
              `Settle at most the remaining ${remaining} ${committedTotal.currency} ` +
              `(committed ${committedTotal.amount} − already settled ${priorAmt}).`,
          },
        ],
      };
    }

    // Accepted. Fold the step's declared total into the running ledger.
    tally = {
      total: tally ? add(tally.total, step.total) : step.total,
      count: (tally ? tally.count : 0) + 1,
    };
    return { ok: true };
  }

  return { settle, progress };
}

/**
 * Convenience: the sum of every component of one `kind` in a settlement (e.g. the
 * total Tax across multiple tax lines), in the breakdown's currency. Returns a
 * zero Money in that currency when no component of the kind is present. Pure read
 * over the components the caller supplied — it does not compute or verify the tax,
 * only totals the lines the caller already labelled.
 */
export function componentTotal(settlement: MoneyBreakdown, kind: MoneyComponent["kind"]): Money {
  const currency = settlement.total.currency;
  const amount = settlement.components
    .filter((c) => c.kind === kind)
    .reduce((s, c) => s + c.amount.amount, 0);
  return { amount, currency };
}
