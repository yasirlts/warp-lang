# Warp Commerce Model — Canonical Schema Spine

**Version 1.0.0 — frozen.** This directory is the **canonical, language-neutral
source of truth** for the Warp Commerce Model. The **TypeScript, Python, and
Rust** bindings are all **generated from** these files and proven equivalent by
the conformance cross-check (CI-enforced): all three produce the identical
verdict on every fixture runnable in all three — **45 of the 51 fixtures**; the
remaining **6 are state-catalog fixtures**, which are purely structural and so
are n/a for every behavioral binding (they are covered by the runner + JSON
Schema). When the spec ([`spec/COMMERCE_MODEL.md`](../spec/COMMERCE_MODEL.md))
and a downstream language package disagree, **this directory is the arbiter.**

It is derived faithfully from `spec/COMMERCE_MODEL.md` v0.3 and is kept exactly
compatible with the live TypeScript package
[`packages/commerce-types`](../packages/commerce-types) (the 26-transition
commitment table here is byte-for-byte the one its tests assert).

## The two layers

### Layer 1 — Structure (`structure/*.schema.json`)

The *shapes* of every type, as [JSON Schema Draft 2020-12](https://json-schema.org/specification-links#2020-12).
One file per primitive group, wired together with cross-file `$ref`:

| File | Contains |
|------|----------|
| `party.schema.json` | Party, PartyID, PartyType, PartyLocale, PartyCapacity, PartyRole |
| `value.schema.json` | Value, ValueForm (Physical/Digital/Service/Money/Nothing/Contingent), ValueState (incl. Retired), AccessModel (incl. EventAccess, DocumentaryCollection, CarbonCredit), ReservationBasis, Condition, Quantity |
| `money.schema.json` | Money (amount + **required** currency), CurrencyCode (open string), **MoneyBreakdown** (+ MoneyComponent / MoneyComponentKind / MoneyOrBreakdown) |
| `intent.schema.json` | Intent, IntentState, IntentTransition |
| `commitment.schema.json` | Commitment, CommitmentState (all 11), CommitmentTransition, CommitmentParties, CommitmentSubject, CommitmentTerms, DeliveryMethod, CommitmentCondition, PaymentTiming, PaymentTerms, CommissionStructure, PostFulfillmentTrigger, CommitmentDuration, RequiredDocuments, CommitmentStateType |
| `fulfillment.schema.json` | Fulfillment, FulfillmentState, Evidence (base + v0.3), FulfillmentTransition |
| `auxiliary.schema.json` | AuctionProcess, AuctionMechanism (incl. ScoredSelection), AwardProtest, ResolutionProcess, EntitlementConsumption, CascadeCancellation, VolumePricing, LoyaltyEarnTerm, ThresholdActivation |
| `index.schema.json` | Root schema — `$ref`s all of the above; carries a `version` field and a `CommerceObject` union |

Each file declares an `$id` (`https://warp-lang.dev/schema/1.0.0/structure/<file>`),
the 2020-12 `$schema`, and `"x-warp-schema-version": "1.0.0"`. Cross-file
references use a bare filename + JSON Pointer, e.g.
`{"$ref": "money.schema.json#/$defs/Money"}`.

**Brand types** (`PartyID`, `CommitmentID`, …) are plain strings with a
description noting the brand. JSON Schema can't enforce branding — the
TypeScript generator re-applies it as `string & { __brand: 'PartyID' }`.

**`MoneyBreakdown`** is core from v1: a `total` plus typed `components`
(`Base`/`Tax`/`Discount`/`Shipping`/`Surcharge`/`Tip`/`Adjustment`). The
components must sum to the total in the same currency — see Layer 2,
`I-1 / money_breakdown_sum`. `Money` may appear plain or, where a total
decomposes (e.g. a `MoneyValue` inside a `CommitmentSubject.requested`), carry
an optional `breakdown`; plain-Money usage stays valid.

### Layer 2 — Behavior (`behavior/*.json`)

Behavior as **declarative data**, not code, so every language implements it
identically:

- **`transitions.json`** — the exact state-transition tables (commitment: 26
  edges across 11 states; intent; fulfillment). Documents the `Failed → Planned`
  special case (recoverable only). This is the machine-readable form of
  Invariant 2.
- **`invariants.json`** — the six invariants as metadata: `id`, `name`,
  `description`, `enforcement_kind` (`structural` / `transition` / `sequence` /
  `uniqueness` / `precondition`), machine-readable `rule` expressions where the
  invariant is datafiable (the sum rules, uniqueness, ordering, table
  membership), a precise `prose_spec` where it needs real logic (I-1
  cross-transfer conservation), and the list of conformance `fixtures` that are
  the cross-language guarantee.

## Regenerating downstream types

The schema is upstream of every language binding:

```
schema/structure/*.schema.json ─┐
                                 ├─► TypeScript  (packages/commerce-types)    — generated + cross-checked
schema/behavior/*.json ──────────┼─► Python      (packages/commerce-types-py) — generated + cross-checked
                                 └─► Rust         (crates/warp-commerce-types)     — generated + cross-checked
```

- **TypeScript**: regenerate interfaces from `structure/`, re-apply id brands,
  and emit the transition tables + invariant checkers from `behavior/`. The
  package's existing test suite is the canary — generated output must keep it
  green.
- **Python**: generate dataclasses from `structure/`; implement
  `behavior/transitions.json` and `invariants.json` directly; pass the shared
  `fixtures` from `invariants.json`.
- **Rust**: `crates/warp-commerce-types/scripts/generate-rust.mjs` regenerates
  serde-derived Rust types from `structure/` (re-applying the same BRANDS /
  open-CurrencyCode seams) and the transition tables from `behavior/`; the
  hand-written runtime (`src/runtime.rs`) ports the runner's transition / audit
  / money rules. A `--check` drift mode (CI-gated, like the TS/Python codegen
  gates) fails if the committed generated Rust diverges from the schema. (This
  is the schema-derived type binding; the older `warp-core` / `warp-generated`
  crates remain the compiler/runtime, not a type binding.)

The **conformance fixtures** named in `invariants.json` — not hand-written
per-language code — are the cross-language correctness guarantee. Today that
guarantee covers **TypeScript, Python, and Rust**: the cross-check runs all
three and requires agreement on every fixture runnable in all three (45 of 51;
the 6 state-catalog fixtures are structural and n/a for behavioral bindings).

## Validate

```
node schema/validate.mjs
```

Zero dependencies (Node ≥ 18). Asserts every schema is well-formed, declares the
2020-12 dialect + version stamp, that **every `$ref` resolves**, light
JSON-Schema structural sanity, and that the transition canary is intact (11
states / 26 commitment edges; `Failed` terminal in the table). If `ajv` (2020
dialect) is importable it additionally compiles every schema for full
meta-validation; otherwise the self-contained checks stand alone.

## Stability

Frozen at **1.0.0**. The five primitives and six invariants are stable. Changes
go through a version bump and update `VERSION`, every file's
`x-warp-schema-version`, and the `$id` version segment together.
