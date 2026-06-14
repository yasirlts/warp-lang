# Changelog — @warp-lang/commerce-types

All notable changes to the npm package. The package tracks the canonical
[Warp Commerce Model schema](https://github.com/yasirlts/warp-lang/tree/main/schema),
frozen at v1.0.0.

## 1.1.0

### Added

- **`order()` — the high-level fluent builder, now published.** Compose a
  history-complete, auditable order in a few lines
  (`order().from(b).to(s).item({ price }).paid().fulfilled().build()`), then run
  the headline check via `AuditedOrder.audit()`. It is a convenience over the
  existing primitives — internally it replays the canonical path through
  `applyCommitmentPath` / `applyFulfillmentPath`, so its output passes
  `auditCommerce` exactly as a hand-built object does. `.build()` returns
  `Result<AuditedOrder>`; invalid compositions return `{ ok: false, error }`,
  never a throw or a silently coerced object.

### Changed

- **API surface organized into Core / Advanced tiers** (docs + `index.ts`
  grouping only — no export was added or removed). The ~10 "start here" exports
  are documented under "Core API"; everything else remains exported under
  "Advanced API".
- **Duplicate names deprecated.** Each function now has one canonical name; the
  older duplicate aliases still work but are marked `@deprecated` (editors show a
  strikethrough) and will be removed in a future major. Migrate as follows:

  | Deprecated alias | Use instead |
  |------------------|-------------|
  | `auditCommerceCode` | `auditCommerce` |
  | `verifyInvariant1` | `checkI1ValueConservation` |
  | `verifyInvariant2` | `checkI2StateMonotonicity` |
  | `verifyInvariant3` | `checkI3CapacityVerification` |
  | `verifyInvariant4` | `checkI4TemporalIntegrity` |
  | `verifyInvariant5` | `checkI5IdentityPermanence` |
  | `verifyInvariant6` | `checkI6TreeConsistency` |
  | `verifyMoneyBreakdown` | `checkI1MoneyBreakdownSum` |

### Notes

- `order()` is a **TypeScript convenience**; it is not part of the Python
  package (`warp-commerce-types`), which exposes the same primitives,
  transitions, and invariant checkers. The two bindings remain proven equivalent
  on the shared model by the conformance cross-check.
- No breaking changes: every name exported by 1.0.0 is still exported.

## 1.0.0

### BREAKING

- **`Result<T>` is now a discriminated union.** It changed from the
  non-discriminated interface

  ```ts
  interface Result<T> { ok: boolean; value?: T; error?: string }
  ```

  to

  ```ts
  type Result<T> = { ok: true; value: T } | { ok: false; error: string };
  ```

  **Migration:** check `r.ok` to narrow the type — on the success branch
  `r.value` is present with no non-null assertion, and `r.error` exists only on
  the failure branch.

  ```ts
  const r = transitionCommitment(order, { type: "Accepted" }, partyId("store"));
  // before: r.value!         (non-null assertion required)
  // after:
  if (r.ok) {
    r.value; // Commitment — narrowed, no `!`
  } else {
    r.error; // string
  }
  ```

  This affects `transitionCommitment`, `transitionIntent`, and
  `transitionFulfillment`. Callers that used `r.value!` should switch to an
  `if (r.ok)` narrowing (or `if (r.ok === false) throw new Error(r.error)`).

### Added

- **`convert()` now rejects invalid rates.** A non-positive, `NaN`, or
  non-finite (`Infinity`) conversion rate throws the new typed
  `InvalidRateError` instead of silently producing a meaningless amount.

### Notes

- Types and transition tables are generated from the canonical schema spine
  (`schema/structure/*.schema.json` + `schema/behavior/transitions.json`) and
  proven equivalent to the Python package by the conformance cross-check.
