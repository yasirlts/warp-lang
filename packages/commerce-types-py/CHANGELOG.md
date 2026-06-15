# Changelog — warp-commerce-types (Python)

All notable changes to the Python package. It is the Python twin of the npm
package `@warp-lang/commerce-types` and tracks the same canonical
[Warp Commerce Model schema](https://github.com/yasirlts/warp-lang/tree/main/schema),
frozen at v1.0.0.

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
