# Schema / binding backlog — post-v1.0.0

Findings surfaced by the cross-language conformance reconciliation
(`conformance/`, run via `conformance/tooling/crosscheck.mjs`). The schema is
**frozen at v1.0.0**; nothing here is a change to the v1.0.0 schema. These are
items to weigh for a future v1.1.0.

---

## B-1 — TS binding lacks a MoneyBreakdown checker (binding parity, NOT a schema gap)

**What.** The canonical schema fully specifies the `money_breakdown_sum` rule as an
expression of **Invariant I-1** (`schema/behavior/invariants.json` → `I-1` →
`rule.expressions[id=money_breakdown_sum]`), and the structure
(`schema/structure/money.schema.json` → `MoneyBreakdown` / `MoneyComponent`).

- **Python** (`warp-commerce-types`) implements it: `money.validate_money_breakdown`
  enforces single-currency + components-sum-to-total (minor-unit tolerance).
- **TypeScript** (`@warp-lang/commerce-types`) does **not** expose any standalone
  MoneyBreakdown checker. `checkI1ValueConservation` only checks commitment-subject
  currency mixing (the `no_currency_mixing` expression of I-1), not the
  `money_breakdown_sum` expression.

**Evidence (conformance cross-check).** The four `money-breakdown` fixtures are
runnable in Python (correct verdicts) but n/a in TS (no API):

| fixture | TS | Python |
|---|---|---|
| money-breakdown-sums-correctly | n/a (no checker) | accept |
| money-breakdown-float-tolerance | n/a (no checker) | accept |
| money-breakdown-currency-mixed | n/a (no checker) | reject:money_breakdown_sum |
| money-breakdown-sum-mismatch | n/a (no checker) | reject:money_breakdown_sum |

All 19 fixtures runnable in **both** bindings agree exactly (0 disagreements).
This is the one parity gap.

**Why it is not a schema gap.** The schema is complete and unambiguous; only one
binding implements the specified rule. The fix is in the TS package, not the schema.

**Proposed v1.1 action.** Add to `@warp-lang/commerce-types` a
`validateMoneyBreakdown(breakdown)` (and surface it from `auditCommerce` when a
`MoneyValue.breakdown` is present), mirroring Python's `validate_money_breakdown`
and the `money_breakdown_sum` expression. Then the four money-breakdown fixtures
become runnable-in-both and the cross-check covers them on both sides.

**Until then.** The conformance runner (`conformance/runner/run.mjs`) enforces
`money_breakdown_sum` against the canonical schema directly, and Python enforces
it at runtime, so the rule is still gated by the suite — just not yet by TS.
