# Changelog — warp-commerce-types (Python)

All notable changes to the Python package. It is the Python twin of the npm
package `@warp-lang/commerce-types` and tracks the same canonical
[Warp Commerce Model schema](https://github.com/yasirlts/warp-lang/tree/main/schema),
frozen at v1.0.0.

## 1.4.0

### Notes

- **Version-parity release — no functional change.** This bump keeps the Python
  package in lockstep with npm `@warp-lang/commerce-types@1.4.0` (the tag-triggered
  release publishes both from one `vX.Y.Z` tag, and each package's declared version
  must match the tag).
- The npm 1.4.0 features — outbound effect descriptors, cross-source reconciliation,
  cumulative windowing, fractional split-fulfillment, guarded micro-negotiations,
  data profiles, the VAT reconciliation pack, and declarative data migrations — are
  **TypeScript-only and are not part of this Python package**. The Python surface
  (the five primitives, currency-safe money, the transition validators, the six
  invariant checkers, the guardrail + session layer shipped in 1.2.0–1.3.0) is
  unchanged and remains proven equivalent to the TS binding by the conformance
  cross-check.

## 1.3.0

### Added

This release brings the Python package up to the shared **agent session layer**
and mirrors the cross-checked session features. Everything below is proven
equivalent to the TypeScript binding on the shared model by the conformance
cross-check; no schema change (frozen v1.0.0).

- **Agent guardrail — `guard_action()` / `guard_object()`.** Validate a proposed
  commerce action before it executes, returning the verdict with each violation's
  invariant, message, and fix. (npm shipped the guardrail in 1.2.0; the Python
  1.2.0 release explicitly did not include it — it lands here.)
- **Agent session toolkit — `create_session()`** with **idempotency** (replay
  dedup via an idempotency key or content fingerprint — a retried call does not
  double-refund) and **optimistic concurrency** (a stale `expected_version` is
  reported as a conflict, not silently applied).
- **Interop — `unify()` + outbound descriptors** with Shopify and Stripe inbound
  mappers; a value mismatch across corresponded sources is caught as I-1.
- **Multi-agent** — invariants over a shared world with per-actor attribution
  (`create_multi_agent_session`).
- **Multi-object coherence** — per-tree cumulative conservation across a parent
  order and its line-item children.
- **Saga / compensation** — `plan_compensation` / `validate_compensation` /
  `compensate`: validate a compensating sequence for coherence; Warp validates,
  it does not execute rollbacks.

### Not in the Python package

To keep scope honest, several 1.3.0 features of the npm package are
TypeScript-only and are **not** part of `warp-commerce-types`: the fulfillment
attestation, multi-component settlement validation, the returns/RMA profile, and
the PayPal/Amazon interop adapters (Python interop carries Shopify and Stripe).
The compiler diagnostics (per-state monotonicity, domain-specific error
messages) belong to the Rust crate, not this package.

### Notes

- Additive and backward-compatible: every existing checker name and signature is
  unchanged.
- Attribution wording in the multi-agent layer is phrased per-binding; the
  verdicts (which invariant fired, the tipping actor, conflict-vs-violation)
  match the other bindings, proven by the cross-check.

## 1.2.0

### Added

- **I-1 now catches over-refunds (amount conservation).** `check_i1_value_conservation`
  — and therefore `audit_commerce` — now reports a violation when a commitment in
  `Refunded` state refunds more than was committed, in the same currency. The refund
  amount is read from the commitment's `Refunded` state; the committed amount from
  `subject.requested`. The bound is **refund ≤ committed, same currency**: a full
  refund (refund == committed) is accepted as the conservation boundary, and a
  cross-currency refund is out of scope for this check (it requires an explicit
  conversion). This is the same clause shipped in npm `@warp-lang/commerce-types@1.2.0`
  and is proven equivalent across the bindings by the conformance cross-check — no
  schema change (it is expressed entirely from existing fields of the frozen v1.0.0
  model).

### Notes

- The npm 1.2.0 release also adds a TypeScript-only **agent guardrail**
  (`guardAction`/`guardObject`); that convenience is not part of this Python package.
  The shared, cross-checked layer — the amount-conservation clause above — is present
  in both bindings.
- Additive and backward-compatible: every existing checker name and signature is
  unchanged; only a new violation case is reported where value was previously created
  by an over-refund.

## 1.1.0

### Notes

- **Version-parity release — no functional change.** This bump exists to keep
  the Python package in lockstep with the npm `@warp-lang/commerce-types@1.1.0`
  release. The tag-triggered release workflow publishes both packages from a
  single `vX.Y.Z` tag and guards each package's declared version against that
  tag, so the two versions must move together for a clean release.
- The npm 1.1.0 feature is the `order()` builder, which is a **TypeScript-only
  convenience and is not part of this Python package**. The Python surface — the
  five primitives, currency-safe money, the state-transition validators, and the
  six invariant checkers — is unchanged and remains proven equivalent to the TS
  binding by the conformance cross-check.

## 1.0.0

- Initial release: the five primitives, currency-safe `Money`, the three
  state-transition validators, and the six invariant checkers — generated from
  the canonical schema and proven equivalent to `@warp-lang/commerce-types` by
  the conformance cross-check.
