# Changelog — @warp-lang/commerce-types

All notable changes to the npm package. The package tracks the canonical
[Warp Commerce Model schema](https://github.com/yasirlts/warp-lang/tree/main/schema),
frozen at v1.0.0.

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
