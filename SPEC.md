# Warp Commerce Model — Formal Specification

**Spec version:** 1.0.0
**Tracks:** Warp Commerce Model schema frozen at **v1.0.0** (`schema/VERSION`).
**Status:** A specification document. It describes the model as it exists in
this repository at schema v1.0.0. It is not, and does not claim to be, an
adopted external standard; publication and standardization are the
maintainer's to pursue.

---

## 0. Purpose and scope

This document is a formal, versioned specification of the Warp Commerce Model
sufficient for an outsider to implement a new conformant binding in any
language without reading the reference source. It defines:

1. the **five primitives** (Party, Value, Intent, Commitment, Fulfillment),
   field by field;
2. the **six invariants** (I-1 .. I-6), as precise statements;
3. the **state model and transition contract** for the three stateful
   primitives; and
4. the **conformance contract** — what an implementation must reproduce, and
   how it is checked.

Everything here is grounded in the canonical artifacts in this repository.
Each section names the file it derives from. Where this prose and a canonical
file disagree, **the canonical file wins** — the schema and the conformance
fixtures are the source of truth, this document is their description.

### 0.1 Canonical sources

| Layer | File(s) |
|-------|---------|
| Structure (shapes) | `schema/structure/{index,party,value,money,intent,commitment,fulfillment,auxiliary}.schema.json` (JSON Schema 2020-12) |
| Behavior (transitions) | `schema/behavior/transitions.json` |
| Behavior (invariants) | `schema/behavior/invariants.json` |
| Reference invariant impl | `packages/commerce-types/src/invariants.ts` |
| Reference transition impl | `packages/commerce-types/src/transitions.ts` |
| Reference money impl | `packages/commerce-types/src/money.ts` |
| Generated types | `packages/commerce-types/src/generated/types.generated.ts` (`SCHEMA_VERSION = "1.0.0"`) |
| Conformance manifest | `conformance/manifest.json` |
| Conformance runner | `conformance/runner/run.mjs` |
| Four-way cross-check | `conformance/tooling/crosscheck.mjs` |
| Conformance guide | `docs/CONFORMANCE.md` |
| Conceptual model | `spec/COMMERCE_MODEL.md` (the "what is commerce" companion to this implementer-facing spec) |

### 0.2 Conventions

- **MUST / MUST NOT / MAY / SHOULD** follow their ordinary RFC 2119 sense.
- A **branded ID** is a non-empty string. JSON Schema cannot express the brand;
  bindings in typed languages SHOULD re-apply it (the TypeScript generator
  emits `string & { __brand: 'PartyID' }`, etc.). At the wire level a branded
  ID is just a string.
- All timestamps are **ISO 8601** strings.
- Objects are **closed**: every primitive schema sets
  `additionalProperties: false`. Unknown fields are a structural error.
- A **discriminated union** uses a literal tag field — `type` for state and
  value/payment variants, `kind` for value forms, delivery methods, conditions,
  evidence, and money components. Read the tag to choose the variant; each
  variant is itself closed.

---

## 1. The five primitives

Source: `schema/structure/index.schema.json`. The root `CommerceObject` is a
`oneOf` over the five primitives plus four auxiliary records (`AuctionProcess`,
`AwardProtest`, `ResolutionProcess`, `EntitlementConsumption`, defined in
`auxiliary.schema.json`). The auxiliary records are coordination/measurement
helpers and are out of scope for the core primitive contract below; a binding
MAY implement them but is not required to in order to satisfy the invariants.

### 1.1 Party (Primitive 1)

Source: `schema/structure/party.schema.json`.

A Party is any entity that can participate in commerce. Role is contextual, not
intrinsic — the same Party can be Initiator in one Commitment and Counterparty
in another.

`Party` object — all fields required:

| Field | Type | Notes |
|-------|------|-------|
| `id` | `PartyID` (branded string, 1–256 chars) | globally unique, immutable, never reused (I-5) |
| `party_type` | enum: `Individual` \| `Organization` \| `System` | `System` = an AI agent / automated system acting for a principal |
| `locale` | `PartyLocale` | see below |
| `capacity` | `PartyCapacity` | see below |

`PartyLocale` — all required, closed:

| Field | Type |
|-------|------|
| `language` | BCP 47 tag (e.g. `fr-MA`, `ar-MA`, `zgh-MA`) |
| `currency` | `CurrencyCode` |
| `jurisdiction` | ISO 3166-1 alpha-2 (e.g. `MA`, `FR`) |

`PartyCapacity` — all required, closed. The safe default is everything `false`
until verified; this is what I-3 reads.

| Field | Type |
|-------|------|
| `can_buy` | boolean |
| `can_sell` | boolean |
| `can_fulfill` | boolean |
| `can_guarantee` | boolean |
| `verified_at` | ISO 8601 timestamp |

`PartyRole` (enum `Initiator` \| `Counterparty` \| `Intermediary` \| `Fulfiller`
\| `Guarantor`) is defined in the schema and used by `CommitmentParties`; it is
not a field on `Party` itself.

### 1.2 Value (Primitive 2)

Source: `schema/structure/value.schema.json`, `schema/structure/money.schema.json`.

Value is what moves between parties. A `Value` instance — all fields required:

| Field | Type | Notes |
|-------|------|-------|
| `id` | `ValueID` (branded string, ≥1 char) | unique, never reused (I-5) |
| `form` | `ValueForm` (discriminated on `kind`) | what kind of value |
| `quantity` | number | bare number for backward compatibility; the unit-bearing `Quantity {amount, unit?}` type is used where a unit is needed (e.g. wholesale `RecurringDelivery`) |
| `state` | `ValueState` (discriminated on `type`) | lifecycle |

**`ValueForm`** — six variants, tag `kind`:

- `PhysicalGood` — `{kind, sku, condition, location?}`. `condition` ∈ `New` \|
  `Used` \| `Refurbished` \| `Damaged` \| `RequiresInspection`.
- `DigitalGood` — `{kind, identifier, exclusivity, access_model}`. `exclusivity`
  ∈ `Exclusive` (one holder at a time; transfer means originator loses it) \|
  `NonExclusive` (many hold simultaneously; granting does not reduce provider
  capacity). `access_model` is an `AccessModel` union (tag `kind`):
  `License` \| `Stream` \| `Download` \| `APIAccess` \| `NFT` \| `EventAccess` \|
  `DocumentaryCollection` \| `CarbonCredit`, each with its own required fields
  (see schema).
- `Service` — `{kind, identifier, delivery_model}`. `delivery_model.location` ∈
  `Physical` \| `Remote` \| `Either`.
- `Money` — `{kind, money, breakdown?}`. `money` is a `Money` (see §1.2.1).
  `breakdown` is **optional**; when present it MUST decompose `money` per I-1
  (`money_breakdown_sum`). Omitting it keeps plain-Money usage valid.
- `Nothing` — `{kind}`. Explicit zero value (e.g. a `ContingentValue` whose
  trigger did not fire).
- `ContingentValue` — `{kind, trigger_type, monitoring_period_start?,
  monitoring_period_end?, monitoring_party?, if_triggered_description,
  if_not_triggered_description}`. Value dependent on a trigger (insurance,
  options, prediction markets). The package carries lightweight string
  descriptions of the triggered / not-triggered values to avoid a recursive
  type explosion.

**`ValueState`** — eight variants, tag `type`:

| Variant | Required fields beyond `type` |
|---------|-------------------------------|
| `Available` | — |
| `Reserved` | `commitment_id`, `basis` (`ReservationBasis`) |
| `UnderAuction` | `auction_process_id`, `closes_at` |
| `Committed` | `commitment_id` |
| `InTransit` | `fulfillment_id` |
| `Transferred` | `to` (PartyID), `at` |
| `Returned` | `from` (PartyID), `initiated_at` |
| `Retired` | `retired_at`, `retired_by`, `reason`, `certificate?` — **terminal**; no transition out (carbon credits after offset, redeemed gift certificates, used coupons) |

`ReservationBasis` ∈ `PhysicalStock` \| `ProductionCapacity` \| `TimeSlot` \|
`RecurringTimeSlot` \| `DriverCapacity` \| `Speculative`. `Speculative` means no
formal verification, risk accepted (dropshipping, made-to-order); I-3 requires
the basis be recorded so capacity risk is computable.

#### 1.2.1 Money

Source: `schema/structure/money.schema.json`.

`Money` — `{amount: number, currency: CurrencyCode}`, both required, closed.
**Money always carries its currency; a bare decimal is not valid Money.**
`CurrencyCode` is an open ISO-4217 string that also admits `Custom`
denominations such as loyalty points (`PTS`). `amount` is in major currency
units.

Minor-unit precision is **per currency**: TND/BHD/KWD/OMR/JOD = 3 decimals,
JPY/KRW etc. = 0, most others = 2 (see `docs/CONFORMANCE.md` Step 1 and
`packages/commerce-types/src/money.ts`). Equality between monetary amounts is
checked within a per-currency tolerance (`moneyEpsilon`, half the smallest minor
unit), **not** exact float equality.

`MoneyComponent` — `{kind, amount: Money, label?, tax_rate?, jurisdiction?}`.
`kind` ∈ `Base` \| `Tax` \| `Discount` \| `Shipping` \| `Surcharge` \| `Tip` \|
`Adjustment`. A `Discount` carries a **negative** amount.

`MoneyBreakdown` — `{total: Money, components: MoneyComponent[]}` (≥1 component).
The invariant `money_breakdown_sum` (an explicit extension of I-1): every
component shares `total`'s currency, and the component amounts sum to `total`
within the currency tolerance (Discounts subtract).

### 1.3 Intent (Primitive 3)

Source: `schema/structure/intent.schema.json`.

An Intent is a party's expressed desire to engage in commerce, existing before
any Commitment. Cart abandonment is the formal transition `Active -> Abandoned`.

`Intent` object:

| Field | Type | Required |
|-------|------|----------|
| `id` | `IntentID` (branded string) | yes |
| `party` | `PartyID` | yes |
| `state` | `IntentState` | yes |
| `history` | `IntentTransition[]` | yes |
| `created_at` | ISO 8601 | yes |
| `expires_at` | ISO 8601 | no |
| `originated_from` | string | no |

`IntentState` — four variants, tag `type`:

| Variant | Extra required fields | Meaning |
|---------|----------------------|---------|
| `Active` | — | open |
| `Abandoned` | — | party stopped without committing |
| `Converted` | `commitment_id` | became a Commitment |
| `Expired` | — | time limit reached without conversion |

`IntentTransition` — `{from: IntentState, to: IntentState, at, actor: PartyID,
reason?}`; `from/to/at/actor` required. Append-only and immutable (I-4).

### 1.4 Commitment (Primitive 4)

Source: `schema/structure/commitment.schema.json`.

A Commitment is a formal agreement between two or more parties to exchange value
under specified terms. It is the central primitive — everything else exists to
create, describe, or fulfill Commitments.

`Commitment` object:

| Field | Type | Required |
|-------|------|----------|
| `id` | `CommitmentID` (branded string) | yes |
| `parties` | `CommitmentParties` | yes |
| `subject` | `CommitmentSubject` | yes |
| `state` | `CommitmentState` | yes |
| `history` | `CommitmentTransition[]` | yes |
| `children` | `CommitmentID[]` | yes (MAY be empty) |
| `created_at` | ISO 8601 | yes |
| `parent` | `CommitmentID` | no |
| `originated_from` | `IntentID` | no |
| `expires_at` | ISO 8601 | no |
| `terms` | `CommitmentTerms` | no |

`CommitmentParties` — `{initiator: PartyID, counterparty: PartyID,
intermediaries: PartyID[]}`, all required (`intermediaries` MAY be empty).

`CommitmentSubject` — `{offered: Value[], requested: Value[]}`, both required.
`offered` is what the counterparty provides; `requested` is what the initiator
provides in return (usually Money, sometimes goods for barter). A requested
Money Value MAY carry an optional `MoneyBreakdown` on its `Money` form.

`CommitmentTransition` — `{from: CommitmentState, to: CommitmentState, at,
actor: PartyID, reason?}`; `from/to/at/actor` required. Append-only, immutable
(I-4).

**`CommitmentState`** — 11 variants, tag `type`. The legal transitions among
them are defined in §3, not here; this lists the shapes:

| Variant | Extra required fields |
|---------|----------------------|
| `Draft` | — |
| `Proposed` | — |
| `Tendered` | `offer_amount`, `offer_currency`, `closes_at`; `superseded_by?` |
| `Accepted` | — |
| `Modified` | `modified_by` (PartyID), `reason` |
| `PartiallyFulfilled` | `fulfilled_item_ids[]`, `remaining_item_ids[]` |
| `Active` | — (subscriptions/ongoing services; never reaches `Fulfilled` while active) |
| `Fulfilled` | — |
| `Cancelled` | `by` (PartyID), `reason`, `at` |
| `Disputed` | `by` (PartyID), `reason`, `opened_at` |
| `Refunded` | `amount` (Money), `at` |

`CommitmentStateType` is the enum of those 11 discriminant names, used by
condition fields (e.g. `if_fail`, `must_complete_before`) that reference a
target state by name.

**`CommitmentTerms`** (optional aggregate, every field optional): `delivery`
(`DeliveryTerms`), `payment` (`PaymentTerms`), `conditions`
(`CommitmentCondition[]`), `cascade`, `volume_pricing`, `loyalty` (the last
three reference `auxiliary.schema.json`), `required_documents`, `jurisdiction`,
`duration` (`CommitmentDuration`).

The terms sub-types are rich discriminated unions (10–18 variants each); a
binding targeting full coverage must follow the schema exactly. Summary of the
tag fields and variant counts (full field lists in the schema):

- `PaymentTiming` (tag `type`, 14 variants): `Immediate`, `Upfront`,
  `OnDelivery`, `OnServiceCompletion`, `AfterGoodsReceived`, `Installments`,
  `Milestone`, `Recurring`, `Simultaneous`, `Metered`, `PostFulfillment`
  (carries `trigger`), `DocumentsAgainstPayment`, `Net` (`days` ∈ 30/60/90),
  `CommissionSplit` (carries `structure`).
- `DeliveryMethod` (tag `kind`, 14 variants): `PhysicalDelivery`,
  `InPersonHandover`, `InterStoreTransfer`, `InternalTransfer`,
  `ServicePerformance`, `DigitalDelivery`, `MoneyTransfer`, `ContingentDelivery`,
  `WhiteGlove`, `ReturnDelivery`, plus v0.3 `TitleTransfer`, `RecurringDelivery`,
  `CustomsRelease`, `RegistryRetirement`.
- `CommitmentCondition` (tag `kind`, 18 variants): `QualityInspection`,
  `AuthenticationVerification`, `DeliverableAcceptance`, `ConditionVerification`,
  `InsuredEventMonitoring`, `GracePeriod`, `RoyaltyDistribution`,
  `StaffDiscount`, `NoShowPolicy`, `SimultaneousAccessLimit`, plus v0.3
  `FinancingContingency`, `InspectionContingency`, `PrescriptionRequired`,
  `RegistryVerification`, `ThresholdActivation`, `ComplianceDocumentation`,
  `NoReturnPolicy`, `EventCancellationPolicy`.

### 1.5 Fulfillment (Primitive 5)

Source: `schema/structure/fulfillment.schema.json`.

A Fulfillment is the execution of a Commitment — the actual movement of value or
grant of access. A Commitment describes what will happen; a Fulfillment records
what did happen. One Commitment produces many Fulfillments.

`Fulfillment` object:

| Field | Type | Required |
|-------|------|----------|
| `id` | `FulfillmentID` (branded string) | yes |
| `commitment` | `CommitmentID` | yes |
| `state` | `FulfillmentState` | yes |
| `history` | `FulfillmentTransition[]` | yes |
| `planned_at` | ISO 8601 | yes |
| `started_at` | ISO 8601 | no |
| `completed_at` | ISO 8601 | no |
| `evidence` | `Evidence[]` | no |

`FulfillmentState` — five variants, tag `type`:

| Variant | Extra required fields | Meaning |
|---------|----------------------|---------|
| `Planned` | — | scheduled, not started |
| `InProgress` | — | movement/service has begun |
| `Completed` | — | value received, evidence recorded |
| `Failed` | `reason`, `recoverable` (boolean) | `recoverable` gates the retry `Failed -> Planned` (see §3.3) |
| `Reversed` | `reason`, `initiated_by` (PartyID), `at` | return/refund — value moving back |

`FulfillmentTransition` — `{from, to, at, actor: PartyID}`, all required.
Append-only, immutable (I-4).

`Evidence` — proof a Fulfillment occurred, tag `kind`, 11 variants:
`ProofOfDelivery`, `PaymentReceipt`, `AccessGrant`, `ServiceCompletion`,
`WarehouseReceipt`, `BillOfLading`, `CustomsClearance`, `TriggerVerification`,
plus v0.3 `RegistryRecording`, `MedicalRecord`, `RetirementCertificate` (each
with its own required fields — see schema).

---

## 2. The six invariants

Source: `schema/behavior/invariants.json` (structured metadata + reference impl
names) and `packages/commerce-types/src/invariants.ts` (reference checkers). The
`enforcement_kind` field of each invariant tells a binding **how** to enforce
it: `structural` (sum/decomposition), `transition` (table membership),
`sequence` (timestamp ordering), `uniqueness` (id), `precondition` (predicate
before a transition).

A conformant binding MUST reproduce each invariant's verdict on the fixtures
(§4). The reference checker named after each invariant is the normative behavior
where prose is ambiguous.

### I-1 — Value Conservation (structural)

Value is never created or destroyed by a commerce operation; it transfers (the
originating party no longer holds it). Conservation has four clauses by
`ValueForm`:

1. **Physical / money** — after a `Transferred` transition the source's holding
   decreases by exactly the amount the destination's increases; nothing appears
   or vanishes.
2. **Non-exclusive digital** — granting access does not reduce the provider's
   copy; a provider MUST NOT grant more concurrent/seat access than the license
   permits it to sub-license.
3. **Exclusive digital** (NFT, unique certificate, carbon credit
   pre-retirement) — transfer follows the physical rule (originator loses the
   token); `Retired` is permanent consumption by mutual agreement, **not** a
   transfer.
4. **Loyalty / merchant-issued currency** — issuance is controlled value
   *creation*; conservation applies to the issuer's aggregate **outstanding
   liability**: `outstanding_points * redemption_value_per_point <=
   issuer_revenue_capacity` (same currency). Redeemed points transfer normally
   (customer → merchant) then are extinguished.

Datafiable expressions a binding MUST check (reference impls in parentheses):

- **`no_currency_mixing`** (`checkI1ValueConservation`): for a Commitment's
  subject (`offered ++ requested`), the count of distinct currencies among Money
  values is ≤ 1 **unless** an explicit `CurrencyConversion` is recorded in
  `terms.payment.currency_conversion`.
- **Over-refund** (`checkI1ValueConservation`): a `Refunded` commitment MUST NOT
  refund more, in the same currency, than the `requested` total committed
  (compared within `moneyEpsilon`).
- **`money_breakdown_sum`** (`validateMoneyBreakdown` / `checkI1MoneyBreakdownSum`):
  all component currencies equal the total currency AND the components sum to the
  total within tolerance (Discounts negative). This is the explicit extension of
  I-1 to `MoneyBreakdown`.
- **`loyalty_liability_bound`** (`checkLoyaltyLiability`): the liability bound in
  clause 4, with liability and capacity in the same currency.

### I-2 — State Monotonicity (transition)

Commitment, Intent, and Fulfillment state transitions follow directed paths
defined by the tables in `schema/behavior/transitions.json` (§3). A `Fulfilled`
Commitment cannot return to `Accepted`; a `Cancelled` Commitment cannot become
`Fulfilled`. **The only apparent reversal (returning goods/money) is a NEW
forward-moving Commitment with the parties exchanged — never a backward state
change on the original object.**

Checks (`checkI2StateMonotonicity` / `isValid*Transition`): for every history
entry, `to.type ∈ table[from.type]`; for Fulfillment, the documented
`Failed -> Planned` recoverable special case applies (§3.3). The reference
checker additionally rejects history whose timestamps move backward.

### I-3 — Capacity Verification (precondition)

A Commitment MUST NOT reach `Accepted` unless the role-appropriate capacity of
its parties has been verified. The reference precondition
(`checkI3CapacityVerification`) checks the initiator's `can_buy === true` once
the commitment has reached `Accepted` (or any later state). The full rule
(prose): check the role-appropriate flag(s) — `can_buy` for the initiator/buyer,
`can_sell`/`can_fulfill` for the counterparty/fulfiller, `can_guarantee` for a
guarantor — true at the moment of acceptance.

A Commitment MAY reach `Accepted` with a `Speculative` reservation, but the
`ReservationBasis` MUST be recorded on the `Reserved` `ValueState` so downstream
systems can compute capacity risk.

### I-4 — Temporal Integrity (sequence)

Every transition is recorded with a timestamp. No transition's timestamp may be
earlier than any previous transition on the **same** object (equal timestamps
are allowed — `>=`, not `>`). History is append-only and immutable; a correction
is a new superseding entry, never a mutation. Fulfillments execute only after
their Commitment is `Accepted`.

Checks: `history_non_decreasing` (timestamp guard on each
`transition*`); `fulfillment_after_accepted` (`checkI4TemporalIntegrity`): a
Fulfillment that is `InProgress` or `Completed` requires its Commitment to have
an `Accepted` timestamp, and `started_at` (if present) MUST be ≥ that timestamp.

### I-5 — Identity Permanence (uniqueness)

`PartyID`, `ValueID`, `IntentID`, `CommitmentID`, `FulfillmentID` are globally
unique and never reused. A platform's native order ID maps to exactly one
`CommitmentID`, fixed at creation. Check (`checkI5IdentityPermanence`): no
identifier value appears more than once across the union of **all** ids in scope
— including across different primitive types, since ids are globally unique.

### I-6 — Commitment Tree Consistency (structural)

For a parent Commitment and its present children, the sum of all child
`subject.requested` Money values (in a single base currency) MUST equal the
parent `subject.requested` value, within `moneyEpsilon`. Recompute on any child
`Modified`/`Cancelled`. Mixed currencies across parent and children without
explicit conversion is itself a violation. For exact splits that never drift,
build children with `allocate()` (`money.ts`). Check: `checkI6TreeConsistency`.

---

## 3. State model and transition contract

Source: `schema/behavior/transitions.json` (the machine-readable tables, the
canonical form of I-2) and `packages/commerce-types/src/transitions.ts`
(reference validators). Each table is keyed by source state; the value is the
exhaustive list of legal targets. **Every pair NOT listed is rejected.**

### 3.1 Commitment (26 transitions, 11 states)

```
Draft              -> Proposed, Tendered, Cancelled
Proposed           -> Accepted, Cancelled, Modified
Tendered           -> Accepted, Cancelled
Accepted           -> Modified, PartiallyFulfilled, Active, Cancelled, Disputed
Modified           -> Accepted, Cancelled
PartiallyFulfilled -> Fulfilled, Modified, Cancelled
Active             -> Modified, Cancelled, Disputed
Fulfilled          -> Disputed, Refunded
Cancelled          -> (terminal)
Disputed           -> Fulfilled, Refunded, Cancelled
Refunded           -> (terminal)
```

Terminal states: `Cancelled`, `Refunded`. Validator:
`isValidCommitmentTransition`.

### 3.2 Intent (4 states)

```
Active    -> Abandoned, Converted, Expired
Abandoned -> (terminal)
Converted -> (terminal)
Expired   -> (terminal)
```

Terminal: `Abandoned`, `Converted`, `Expired`. Validator:
`isValidIntentTransition`.

### 3.3 Fulfillment (5 states) and the recoverable special case

```
Planned    -> InProgress, Failed
InProgress -> Completed, Failed, Reversed
Completed  -> Reversed
Failed     -> (empty in the table)
Reversed   -> (terminal)
```

**Special case:** `Failed` is listed with an empty target set, but a `Failed`
Fulfillment MAY transition to `Planned` — **and only when** the `Failed` state's
`recoverable` flag is `true`. A non-recoverable `Failed` is genuinely terminal.
A binding MUST implement this identically: the table-driven check rejects
`Failed -> Planned`, and the special case re-admits it iff `recoverable ===
true`. Reference: `isValidFulfillmentTransition` in
`packages/commerce-types/src/transitions.ts`:

```ts
if (from.type === "Failed") {
  return to.type === "Planned" ? from.recoverable : false;
}
return FULFILLMENT_TRANSITIONS[from.type].includes(to.type);
```

### 3.4 Reversals are new commitments

A return or refund is never a backward transition. It is modeled as a new
forward-moving Commitment with the parties exchanged (I-2). This is why the
tables contain no edges that "undo" a prior state.

---

## 4. Conformance contract

Source: `docs/CONFORMANCE.md`, `conformance/manifest.json`,
`conformance/runner/run.mjs`, `conformance/tooling/crosscheck.mjs`.

A binding is **conformant at schema vX** when it reproduces the model's verdict
on every fixture in the suite at that version: accepting all `valid/`, rejecting
all `invalid/` **by the named rule**, matching every `transitions/` step, and
reproducing the money round-trips. Conformance is defined against the fixtures,
not against any one implementation's source.

### 4.1 The fixtures

The manifest (`conformance/manifest.json`, schema `1.0.0`) enumerates the
fixtures. At v1.0.0 it lists **54 fixtures** by `kind`:

- `scene` — a set of commerce objects audited as a whole (the invariant
  scenarios `i1`..`i6`, the money/tree/refund/commission valid scenes, and 22
  domain **case studies**: physical-ecommerce, gifting, pos, services, bnpl,
  escrow, fx, saas, streaming, api-metering, nft, auction-family, real-estate,
  healthcare, government-procurement, wholesale, marketplace, trade-finance,
  events, loyalty, group-buying, carbon-credits).
- `transition-sequence` — a sequence of transitions, each checked for validity
  (commitment happy path, backward-rejection, intent abandon/convert,
  fulfillment failed recoverable/non-recoverable).
- `money-roundtrip` — minor-unit precision round-trips.
- `money-breakdown` — `money_breakdown_sum` valid and invalid cases.
- `state-catalog` — structural enumerations of every state/form/type variant.

Each `invalid/` fixture names the `rule` it must be rejected by (e.g. `I-1`,
`money_breakdown_sum`) and carries an `.expected.json` sidecar.

Three real bugs from the v0.3.1 audit are permanently locked as regression
fixtures (TND 10× minor-unit, adapter empty-history, I-6 float equality); a
binding that fails any of them has reintroduced the bug and is by definition not
conformant.

### 4.2 The compliance test

The normative test is the reference runner:

```
node conformance/runner/run.mjs
```

It loads `conformance/manifest.json` and validates every fixture against the
**canonical** schema files (it carries a small, dependency-free JSON Schema
2020-12 validator, structure + transitions + the six invariants per
`invariants.json`), then compares each verdict to the fixture's `expect` (and,
for invalid fixtures, the named `rule`). Exit `0` iff every fixture matched. At
schema v1.0.0 this run reports **54/54 fixtures passed — CONFORMANT**.

A binding implementer has two routes (`docs/CONFORMANCE.md`):

- **Path A (normative):** port `run.mjs` to your language — load the manifest,
  apply the check for each fixture's `kind`, compare to `expect`/`rule`.
- **Path B (quick start):** emit a JSON array of per-fixture verdicts in the
  documented shape (`id, kind, runnable, verdict, rules, steps, note`) and score
  it with `conformance/tooling/score-adapter.mjs`, which applies the same
  agreement check and prints `X/Y`.

### 4.3 The four-way cross-check

`conformance/tooling/crosscheck.mjs` is the cross-language guarantee: it runs the
four reference binding emitters — TypeScript (`crosscheck-ts.mjs`), Python
(`crosscheck-python.py`), Rust (`crosscheck-rust`), and Go (`crosscheck-go`) —
aligns their per-fixture verdicts with the manifest's expectation, and prints:

```
fixture | expected | TS | Python | Rust | Go | agree?
```

A fixture runnable in all four MUST get the same verdict from TS, Python, Rust,
and Go **and** match the expectation; any disagreement exits non-zero. Fixtures
no behavioral binding can run (the `state-catalog` structural enumerations) are
marked n/a — covered by the schema runner — not counted as disagreements. Per
`docs/CONFORMANCE.md`, the four bindings agree on **45/45** behaviorally
runnable fixtures at v1.0.0 (the other structural fixtures validated by the
runner).

### 4.4 What a pass proves — and does not

A clean pass means precisely: *the implementation agrees with the Warp Commerce
Model, on these fixtures, at this schema version* — it accepts what the model
accepts and rejects what the model rejects, naming the same rule per rejection.
A pass does **not** prove the implementation is correct in general or on inputs
no fixture exercises; the suite is a finite, curated set. Size the claim to
exactly *"compatible at schema vX,"* verifiable by re-running the suite.

---

## 5. Versioning

This spec is **v1.0.0** and tracks the Warp Commerce Model schema frozen at
**v1.0.0** (`schema/VERSION` = `1.0.0`, `conformance/VERSION` = `1.0.0`,
generated `SCHEMA_VERSION = "1.0.0"`). A fixture that could change a verdict only
changes on a major schema bump; a binding pins the schema version it targets and
claims compatibility at exactly that version. When the schema version advances,
this document is updated to track it, and the version line at the top changes
accordingly.

---

## 6. Relationship to other documents

- `spec/COMMERCE_MODEL.md` — the conceptual specification ("what is commerce,
  stated formally"). This document (`SPEC.md`) is its implementer-facing
  counterpart, grounded field-by-field in the frozen v1.0.0 schema and the
  conformance suite.
- `docs/CONFORMANCE.md` — the step-by-step guide to building and scoring a
  binding; this document specifies *what* must hold, that guide walks through
  *how* to verify it.
- `schema/` and `conformance/` — the canonical source of truth. Where this
  document and a canonical file differ, the canonical file governs.
```
