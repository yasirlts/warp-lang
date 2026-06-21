# Changelog — warp-commerce-types (Python)

All notable changes to the Python package. It is the Python twin of the npm
package `@warp-lang/commerce-types` and tracks the same canonical
[Warp Commerce Model schema](https://github.com/yasirlts/warp-lang/tree/main/schema),
frozen at v1.0.0.

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
