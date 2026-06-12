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

---

## Context: domain case-study reconciliation (Agent D, PR #1)

Agent D's 22-domain adversarial corpus was re-pointed at the canonical schema in
`reconcile-case-studies` (fixtures under `conformance/case-studies/`, generator
`conformance/case-studies/_generate.mjs`, auxiliary-record check
`conformance/case-studies/validate-aux.mjs`). All 22 domains validate + audit
clean as canonical `scene` fixtures (`node conformance/runner/run.mjs`), and the
auxiliary records validate against the canonical schema
(`node conformance/case-studies/validate-aux.mjs`).

**Record correction — D's "pending-v1.1" list does NOT apply to the canonical
schema.** D flagged ScoredSelection, the CommitmentCondition layer
(FinancingContingency / PrescriptionRequired / ThresholdActivation /
ComplianceDocumentation / NoReturnPolicy / EventCancellationPolicy / …),
CascadeCancellation, AwardProtest, and the v0.3 Evidence / DeliveryMethod /
PaymentTiming / AccessModel variants as "unrepresentable in schema v1.0.0".
Those flags were against D's **bespoke minimal schema** (superseded). The
**canonical** schema v1.0.0 expresses every one of them — verified by the
re-authored fixtures (which carry these constructs in `terms`) and by
`validate-aux.mjs` (ScoredSelection + AwardProtest). Net: **0 of D's listed
constructs is a real v1.1 gap.** Two genuinely new items did surface:

## B-2 — ValueState has no digital-access lifecycle (schema gap, candidate v1.1)

**What.** Canonical `schema/structure/value.schema.json` → `ValueState` is the
oneOf `{ Available, Reserved, UnderAuction, Committed, InTransit, Transferred,
Returned, Retired }`. The spec's Primitive 2 also describes an *access* lifecycle
for **non-exclusive digital goods** — AccessGranted / AccessSuspended /
AccessRevoked / AccessExpired — which the canonical v1.0.0 `ValueState` does not
implement.

**Evidence (case studies).** `streaming` (a failed-payment access *suspension*)
and `saas` (license *revocation*) cannot put that state on the Value. Both are
modelled at the Commitment level instead — `streaming` uses a `GracePeriod`
condition + the subscription `Active`/`Cancelled` states; the Value stays
`Available`/`Transferred`. The **domain is still conformant** (the lifecycle is
expressible at the Commitment level); only the fine-grained *value-state* of
"access suspended" is not first-class.

**Proposed v1.1 action.** Either add `AccessGranted` / `AccessSuspended` /
`AccessRevoked` / `AccessExpired` to `ValueState` for non-exclusive `DigitalGood`,
or document explicitly that digital-access lifecycle is intentionally a
Commitment-level concern (and not a Value state) so implementers stop reaching
for it. **No schema change is made here; the schema stays frozen at v1.0.0.**

## B-3 — Conformance runner has no `kind` for standalone auxiliary records (coverage, NOT a schema gap)

**What.** The shipped runner (`conformance/runner/run.mjs`) judges the fixture
kinds `scene` / `state-catalog` / `transition-sequence` / `money-breakdown` /
`money-roundtrip`. It has no kind that validates a *standalone* auxiliary record —
`AuctionProcess` (incl. the v0.3 `ScoredSelection` mechanism), `AwardProtest`,
`ResolutionProcess`, `EntitlementConsumption` — even though all four are fully
defined in `schema/structure/auxiliary.schema.json` and validate against it.

**Evidence.** `conformance/case-studies/validate-aux.mjs` validates representative
instances of all four against the canonical schema (5/5 valid), covering the
auction-family, government-procurement, gifting, and api-metering domains. This is
a *supplement* to the main runner, run separately.

**Why it is not a schema gap.** The schema is complete; the runner simply has no
fixture kind to exercise these records inside `node conformance/runner/run.mjs`.

**Proposed v1.1 action.** Add an `object` fixture kind to the runner that
`validateRef`s a payload against any `index.schema.json` `$def`, then fold the
`validate-aux.mjs` instances into `conformance/manifest.json` so auxiliary records
run in the single canonical command. (Optionally fold the case-study scene
generator into `conformance/tooling/build.mjs` so the case-study manifest entries
are regenerated + canonical-cross-checked alongside the core suite, rather than
appended by `_generate.mjs`.)
