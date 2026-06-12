# Warp Commerce Model — Canonical Schema Spine

**Version 1.0.0 — frozen.** This directory is the **canonical, language-neutral
source of truth** for the Warp Commerce Model. TypeScript, Python, and Rust
types are **generated from** or **validated against** these files. When the spec
([`spec/COMMERCE_MODEL.md`](../spec/COMMERCE_MODEL.md)) and a downstream language
package disagree, **this directory is the arbiter.**

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
                                 ├─► TypeScript  (packages/commerce-types) — generated / validated
schema/behavior/*.json ──────────┼─► Python      — generated / validated
                                 └─► Rust         — generated / validated
```

- **TypeScript**: regenerate interfaces from `structure/`, re-apply id brands,
  and emit the transition tables + invariant checkers from `behavior/`. The
  package's existing test suite is the canary — generated output must keep it
  green.
- **Python / Rust**: generate dataclasses / structs from `structure/`; implement
  `behavior/transitions.json` and `invariants.json` directly; pass the shared
  `fixtures` from `invariants.json`.

The **conformance fixtures** named in `invariants.json` — not hand-written
per-language code — are the cross-language correctness guarantee.

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
