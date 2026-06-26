/**
 * Regulatory policy packs — named DATA describing a jurisdiction's tax-component
 * expectations, layered over the frozen {@link validateSettlement} reconciliation
 * check. The first pack is a VAT reconciliation profile (e.g. EU / Morocco VAT):
 * which `tax_rate` values a jurisdiction permits, supplied as data.
 *
 * SCOPE, STATED PLAINLY. A policy pack validates that a settlement's tax
 * components RECONCILE against caller-supplied rates and the committed total. It
 * is NOT a tax engine and NOT a tax calculator:
 *   - it does NOT compute what the tax SHOULD be,
 *   - it does NOT pick a rate, derive a jurisdiction, or know any tax law,
 *   - the allowed rates are pack DATA (supplied by the caller / regulator), and
 *     each component's base amount, tax amount, and `tax_rate` are caller-supplied
 *     inputs on the {@link MoneyComponent}s.
 * The pack's only added check, on top of `validateSettlement`, is downstream and
 * arithmetic: (a) every Tax component declares a `tax_rate` the pack lists for its
 * jurisdiction, and (b) the declared tax amount equals `tax_rate × taxable base`
 * within the currency's minor-unit tolerance. A settlement whose tax is the wrong
 * rate for real-world law but matches a rate the caller put in the pack will PASS;
 * deciding which rate the law requires is out of scope and the pack does not
 * pretend otherwise.
 *
 * COMPOSITION, NOT REIMPLEMENTATION. The reconciliation that the components sum to
 * the committed total in one currency is {@link validateSettlement} (settlement.ts),
 * which is itself the canonical `money_breakdown_sum` / I-1 rule from money.ts.
 * This module calls it unchanged and reports its violations verbatim; it never
 * re-derives the sum check or any invariant. The added rate check is a pure read
 * over the caller's components and the pack's data — the same "config narrows,
 * delegated logic decides" shape as profiles.ts ({@link guardWithProfile}).
 *
 * Minor-unit tolerance is shared via {@link moneyEquals} (money.ts), so the
 * rate-vs-amount arithmetic uses the same epsilon as the rest of the package.
 *
 * TypeScript first. Ports to Python / Rust / Go are roadmap.
 */

import { moneyEquals } from "./money.js";
import type { MoneyBreakdown, MoneyComponent, Money } from "./money.js";
import { validateSettlement } from "./settlement.js";
import type { SettlementResult, SettlementViolation } from "./settlement.js";

/**
 * A jurisdiction's permitted tax rates, as DATA. `rates` are the `tax_rate`
 * values (fractions, e.g. 0.2 for 20%) a Tax component may legally declare for
 * this jurisdiction in the pack author's understanding — not computed, not
 * verified against any external authority.
 */
export interface JurisdictionTaxRates {
  /** ISO 3166-1 alpha-2 jurisdiction code, matching MoneyComponent.jurisdiction (e.g. "MA", "FR"). */
  jurisdiction: string;
  /** Permitted `tax_rate` values for this jurisdiction (fractions: 0.2 === 20%). DATA, not law. */
  rates: readonly number[];
}

/**
 * A regulatory policy pack: a named, versioned bundle of jurisdiction tax-rate
 * data. Pure DATA — no behaviour, no schema fields, no invariant logic. A VAT
 * pack lists, per jurisdiction, which `tax_rate` values its Tax components may
 * declare. The pack is authored / supplied by the caller; this module only
 * reads it.
 */
export interface RegulatoryPolicyPack {
  /** Stable id used as a registry key (e.g. "eu-vat", "ma-vat"). */
  id: string;
  /** Human-readable label. */
  label: string;
  /** One-line description of what this pack covers. */
  description: string;
  /** Per-jurisdiction permitted tax rates. */
  jurisdictions: readonly JurisdictionTaxRates[];
}

/**
 * The verdict of checking a settlement against a policy pack. Reuses the
 * settlement violation idiom so callers handle one shape. A pack rejection can
 * carry violations from the underlying {@link validateSettlement} (reconciliation)
 * AND from the pack's rate check.
 */
export type PolicyCheckResult = SettlementResult;

/** Lookup the permitted rates for a jurisdiction in a pack (null if not covered). */
function ratesFor(pack: RegulatoryPolicyPack, jurisdiction: string): readonly number[] | null {
  const entry = pack.jurisdictions.find((j) => j.jurisdiction === jurisdiction);
  return entry ? entry.rates : null;
}

/**
 * The taxable base for a Tax component: the sum of all non-Tax, non-Discount
 * component amounts, plus Discount amounts (which are negative and so reduce the
 * base). This is the amount the caller's `tax_rate` is applied against. It is read
 * straight off the caller's components — the pack does not decide what is taxable,
 * it uses the breakdown the caller already labelled.
 *
 * NOTE: this is a single-rate convenience. A settlement that mixes several taxable
 * bases at different rates should carry that structure in its components; this
 * helper treats every non-tax line as part of one base, which is the common
 * single-rate VAT case.
 */
function taxableBase(settlement: MoneyBreakdown): number {
  return settlement.components
    .filter((c) => c.kind !== "Tax")
    .reduce((s, c) => s + c.amount.amount, 0);
}

/**
 * Check a settlement against a regulatory policy pack.
 *
 * Step 1 — reconciliation: delegate to {@link validateSettlement} unchanged. If
 * the components do not sum to the committed total in one currency (I-1), the
 * pack check fails with those violations and the rate check is not reached.
 *
 * Step 2 — rate check (the pack's added DATA constraint): for every Tax component,
 *   (a) it must declare a `jurisdiction` and a `tax_rate`,
 *   (b) that `tax_rate` must be one the pack lists for that jurisdiction, and
 *   (c) the declared tax amount must equal `tax_rate × taxableBase` within the
 *       currency's minor-unit tolerance.
 * All three use caller-supplied numbers and pack data; none compute tax law.
 *
 * Returns `{ ok: true }` when the settlement reconciles and every Tax component
 * matches a permitted, internally-consistent rate; else `{ ok: false, violations }`.
 */
export function checkSettlementPolicy(
  settlement: MoneyBreakdown,
  committedTotal: Money,
  pack: RegulatoryPolicyPack,
): PolicyCheckResult {
  // Step 1: reconciliation is the frozen check — reuse it verbatim.
  const reconciled = validateSettlement(settlement, committedTotal);
  if (reconciled.ok === false) return reconciled;

  // Step 2: the pack's data-level rate check over the caller's Tax components.
  const violations: SettlementViolation[] = [];
  const base = taxableBase(settlement);
  const currency = settlement.total.currency;

  for (const c of settlement.components) {
    if (c.kind !== "Tax") continue;
    const taxViolation = checkTaxComponent(c, pack, base, currency);
    if (taxViolation) violations.push(taxViolation);
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** Validate one Tax component against the pack. Returns a violation, or null if OK. */
function checkTaxComponent(
  c: MoneyComponent,
  pack: RegulatoryPolicyPack,
  base: number,
  currency: string,
): SettlementViolation | null {
  const label = c.label ? ` ("${c.label}")` : "";

  if (c.jurisdiction === undefined || c.tax_rate === undefined) {
    return {
      rule: `${pack.id}/tax-rate`,
      message:
        `Tax component${label} is missing ${c.jurisdiction === undefined ? "a jurisdiction" : ""}` +
        `${c.jurisdiction === undefined && c.tax_rate === undefined ? " and " : ""}` +
        `${c.tax_rate === undefined ? "a tax_rate" : ""} — policy pack "${pack.id}" checks each Tax ` +
        `component against the permitted rates for its jurisdiction, so both are required.`,
      fix:
        `Set the Tax component's jurisdiction (ISO 3166-1 alpha-2, e.g. "FR") and tax_rate ` +
        `(a fraction, e.g. 0.2 for 20%) to the values the caller computed.`,
    };
  }

  const permitted = ratesFor(pack, c.jurisdiction);
  if (permitted === null) {
    return {
      rule: `${pack.id}/jurisdiction`,
      message:
        `Tax component${label} declares jurisdiction "${c.jurisdiction}", which policy pack ` +
        `"${pack.id}" does not cover — the pack lists no permitted rates for it.`,
      fix:
        `Use a jurisdiction the pack covers (${pack.jurisdictions.map((j) => j.jurisdiction).join(", ")}), ` +
        `or extend the pack data with a JurisdictionTaxRates entry for "${c.jurisdiction}".`,
    };
  }

  if (!permitted.includes(c.tax_rate)) {
    return {
      rule: `${pack.id}/tax-rate`,
      message:
        `Tax component${label} declares tax_rate ${c.tax_rate} for "${c.jurisdiction}", but policy ` +
        `pack "${pack.id}" permits only [${permitted.join(", ")}] there.`,
      fix:
        `Use one of the permitted rates [${permitted.join(", ")}] for "${c.jurisdiction}", or correct ` +
        `the caller-supplied rate. The pack does not compute the correct rate — it checks against its data.`,
    };
  }

  // Internal consistency: the declared tax amount must equal rate × base.
  const expected = base * c.tax_rate;
  if (!moneyEquals(c.amount.amount, expected, currency)) {
    return {
      rule: `${pack.id}/tax-reconcile`,
      message:
        `Tax component${label} declares ${c.amount.amount} ${currency} at rate ${c.tax_rate} on a ` +
        `taxable base of ${base} ${currency}, but ${c.tax_rate} × ${base} = ${expected} ${currency} — ` +
        `the declared tax does not reconcile against the caller-supplied rate and base.`,
      fix:
        `Make the Tax amount equal tax_rate × base (${expected} ${currency}), or adjust the base / rate ` +
        `the caller supplied. The pack checks the arithmetic reconciles; it does not compute the tax.`,
    };
  }

  return null;
}

/**
 * A small built-in VAT pack covering a few MENA + EU jurisdictions, as a starting
 * sample. The rates are illustrative DATA for the example and tests — NOT a
 * maintained, authoritative tax-rate table. Callers building a real integration
 * should supply their own pack from a source of truth they trust.
 */
export const SAMPLE_VAT_PACK: RegulatoryPolicyPack = {
  id: "sample-vat",
  label: "Sample VAT pack",
  description:
    "Illustrative VAT reconciliation pack for examples and tests. Rates are sample data, not an " +
    "authoritative tax table; supply your own pack for production use.",
  jurisdictions: [
    { jurisdiction: "MA", rates: [0, 0.07, 0.1, 0.14, 0.2] }, // Morocco standard + reduced
    { jurisdiction: "FR", rates: [0, 0.055, 0.1, 0.2] }, // France standard + reduced
    { jurisdiction: "DE", rates: [0, 0.07, 0.19] }, // Germany standard + reduced
  ],
};
