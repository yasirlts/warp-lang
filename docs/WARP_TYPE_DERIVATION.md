# WARP TYPE DERIVATION
## Audit of the Warp runtime type system against the Warp Commerce Model
### Version 0.1 — Audited against WARP_COMMERCE_MODEL v0.2

---

## Section 1 — Methodology

This document maps every type in the Warp runtime to its source in
[WARP_COMMERCE_MODEL.md](WARP_COMMERCE_MODEL.md) (the Commerce Model,
v0.2). It exists to ensure the type system is a faithful implementation of
the formal commerce model rather than an ad hoc collection of types built
for specific use cases. Types in **Category 1 (CORRECT)** require no change.
Types in **Category 2 (NEEDS_REVISION)** require the specific revisions
documented here. Types in **Category 3 (MISSING)** do not yet exist and must
be added. The next engineering session implements Category 2 revisions and
Category 3 additions, in that order.

A note on scope discovered during the audit, because it frames everything
below: the model's centre of gravity is the **Commitment** — "the central
primitive of the commerce model. Every commerce operation either leads to a
Commitment, is recorded as a Commitment, or is the execution of a
Commitment." The current Warp type system has **no Commitment type, no
CommitmentState, no Fulfillment, no Value, no Party, and no Intent type**.
What it has instead is a well-built layer of *marketing, intelligence, and
identity* types (`CustomerProfile`, `StrategyRecommendation`, `CartState`,
`Occasion`, `SegmentCriteria`, `CampaignAudience`, `ABTestVariant`) that were
correct for the Phase 1–3 cart-recovery and campaign use cases but sit
mostly *outside* or *adjacent to* the model's five primitives. The single
type that the model treats as money — `Currency` — is correct. Almost
everything else is either a partial stand-in for a primitive (e.g.
`OrderID` for `CommitmentID`, `CustomerProfile` for `Party`, `CartState`
for `Intent(Active)`) or a strategy/marketing type the model deliberately
excludes.

The implication for the rebuild: this is not a tidy-up. The model's spine
(Party → Intent → Commitment → Fulfillment over Value, governed by six
invariants) is almost entirely Category 3. The existing types are not
*wrong* so much as *not yet the model* — they describe the surface the
merchant touches, not the commerce state underneath it.

Files audited:
- `crates/warp-core/src/types/commerce.rs` (the entire commerce type system;
  `mod.rs` declares no additional types)
- `crates/warp-catalog/src/node_registry.rs` (the 11-node manifest)
- `crates/warp-core/src/dsl/type_checker.rs` (the v0.1 type checker)
- `STATUS.md` (current build state — Phase 3, 280 tests, 6 crates)

---

## Section 2 — Type Audit

Every type in `commerce.rs`, in source order. Free functions
(`tenant_workflow_key`, `assert_tenant_key`) and the `cfg(test)` module are
not types and are not audited; the tenant error type is noted under
`TenantId`.

### Currency
**Category:** CORRECT
**Model source:** Primitive 2: Value → ValueForm → Money
**Model definition:** "Money { amount: MoneyAmount, currency: CurrencyCode } … Money always carries its currency. There is no amount without a currency in this model."
**Current implementation:** `struct Currency { amount: Decimal, code: CurrencyCode }` — a `Decimal` amount that always carries a `CurrencyCode`, with checked `add`, explicit `convert_to`, and `is_at_least`; mixed-currency operations return `CurrencyError`.
**Verdict:** Faithful to the model's Money — currency is mandatory, arithmetic is exact (`Decimal`), and cross-currency operations require explicit conversion, exactly as the model's "Critical constraint on Money" demands.
**Change required:** — (none for the `Exact` case; the model's `MoneyAmount::Estimated` variant is a separate *missing* type, tracked in Section 4, not a defect in `Currency`)

### CurrencyCode
**Category:** NEEDS_REVISION
**Model source:** Primitive 2: Value → ValueForm → Money.currency (and Primitive 1: Party → Locale.currency)
**Model definition:** "currency: CurrencyCode — ISO 4217, always present, never implicit … includes custom: CurrencyCode::Custom(String) for loyalty points, internal credits."
**Current implementation:** `enum CurrencyCode { MAD, EUR, USD }` — a closed three-variant enum.
**Verdict:** Partially faithful. The model's `CurrencyCode` is the full ISO 4217 space *plus* a `Custom(String)` escape hatch for loyalty points and internal credits. The closed three-variant enum cannot express the model's POS multi-currency tests (MAD/DZD/TND appear in the model's passing test set) nor loyalty-point "currencies".
**Change required:** Add a `Custom(String)` variant per the model, and either widen the closed set to the ISO 4217 codes Warp commits to supporting (at minimum DZD and TND, which appear in the model's POS test results) or document the closed set as a deliberate Warp subset. Without `Custom`, loyalty/credit value cannot be represented as Money.

### CurrencyError
**Category:** CORRECT
**Model source:** Implementation detail enforcing the Invariant on Money (Primitive 2: "makes [currency confusion] impossible to express").
**Model definition:** The model does not name an error type; it states mixed-currency operations must be "impossible to express."
**Current implementation:** `enum CurrencyError { MixedCurrencies { left, right } }` — returned by `add`/`is_at_least` when codes differ.
**Verdict:** Implementation detail, not a model concept. It is the mechanism by which `Currency` honours the model's Money constraint, and it does so correctly. No model source is expected.
**Change required:** —

### PhoneNumber
**Category:** CORRECT
**Model source:** Not a primitive structure. Referenced in the AI Contract → "Commerce mistakes that become impossible with the model": "Sending WhatsApp to an unvalidated phone (PhoneNumber is a distinct type from String in the Warp type system derived from this model; the compiler catches this)."
**Model definition:** The model names `PhoneNumber` only as the canonical example of a Warp type that makes an unvalidated-input mistake impossible; it is contact metadata on a Party, not a primitive.
**Current implementation:** `struct PhoneNumber { e164: String (private), whatsapp_routable: bool }` with `parse` (E.164 validation) as the only constructor.
**Verdict:** Faithful to the model's *intent* (a distinct, validated type the compiler can require), even though the model does not give `PhoneNumber` a structural definition. It is the correct shape for a `Party` contact field once `Party` exists.
**Change required:** — (when `Party`/`Locale` land in Section 3, `PhoneNumber` should become a field on the Party's contact info rather than living only on `CustomerProfile`; that is a placement change driven by the new type, not a defect in `PhoneNumber` itself)

### PhoneNumberError
**Category:** CORRECT
**Model source:** Implementation detail of `PhoneNumber` validation.
**Model definition:** None.
**Current implementation:** `enum PhoneNumberError { InvalidFormat(String) }`.
**Verdict:** Implementation detail. Correct.
**Change required:** —

### TenantId
**Category:** CORRECT (out of model by design)
**Model source:** None. Multi-tenancy is infrastructure (CONTRACTS C-03), not a commerce concept. The model is explicitly a model of *commerce state*, and isolation/tenancy is below it.
**Model definition:** None — the model has no notion of tenant; it models commerce itself, platform-agnostically.
**Current implementation:** `struct TenantId(String)` plus `tenant_workflow_key`, `assert_tenant_key`, and `TenantKeyMismatch` — the ADR-0002 execution-isolation key.
**Verdict:** Correctly *outside* the model. This is a runtime/infrastructure type. It should not be forced into a model primitive; note only that when `Party`/`Commitment` land, every model object will additionally carry a `tenant_id` as an infrastructure field (C-03), orthogonal to the model.
**Change required:** —

### TenantKeyMismatch
**Category:** CORRECT (out of model by design)
**Model source:** None (infrastructure error for `assert_tenant_key`).
**Model definition:** None.
**Current implementation:** `struct TenantKeyMismatch { actual, expected }`.
**Verdict:** Infrastructure detail. Correct.
**Change required:** —

### Platform
**Category:** NEEDS_REVISION
**Model source:** Platform Mapping section (Shopify, SAP, Odoo, WooCommerce, Agora) — the model treats platform as the *source* whose native representation maps mechanically to model objects; it does not define a `Platform` enum as a primitive.
**Model definition:** The model says "Each platform implements a Warp adapter that translates its native representation to the model. The mapping is mechanical." Platform is the origin label, not a commerce primitive.
**Current implementation:** `enum Platform { Agora, Shopify, WooCommerce, OpenCart, Magento, Odoo }`.
**Verdict:** Correctly derived in spirit (a tag identifying the source platform), using different framing than the model (the model frames platforms as adapter sources, not as a value type). The set diverges from the model: the model's mapping section names **SAP S/4HANA** as a first-class mapped platform, which Warp's enum omits, and Warp adds `OpenCart`/`Magento` which the model does not enumerate. This is acceptable terminology/scope divergence, flagged for reconciliation rather than treated as a contradiction.
**Change required:** Reconcile the variant set with the model's Platform Mapping section — add `SAP` (the model gives a full SAP S/4HANA mapping) or document why Warp defers it; confirm `OpenCart`/`Magento` are intended Warp extensions beyond the model's enumerated set. Low urgency (the tag does not affect invariant enforcement).

### Language
**Category:** NEEDS_REVISION
**Model source:** Primitive 1: Party → Locale.language
**Model definition:** "language: LanguageCode — BCP 47 (e.g. \"fr-MA\", \"ar-MA\", \"zgh-MA\")."
**Current implementation:** `enum Language { Arabic, French, English, Darija }` — a closed four-variant enum.
**Verdict:** Does not match. The model's `LanguageCode` is BCP 47 (a string standard covering language *and* region — `fr-MA`, `ar-MA`, `zgh-MA`). Warp's closed enum loses the region tag entirely and cannot express the model's examples (no `zgh-MA` Tamazight; "Darija" is not a BCP 47 code — the model would express Moroccan Darija as `ary` / `ar-MA`). The enum is also a hard ceiling that a global commerce model cannot live under.
**Change required:** Introduce a `LanguageCode` newtype validating BCP 47 (or at minimum carrying language + optional region), and either map the current `Language` enum onto it as a convenience or replace it. Reconcile "Darija" with BCP 47 (`ary` or `ar-MA`). This is the model-faithful representation of `Locale.language`. Note the cross-cutting cost: every WhatsApp template and notification node branches on `Language` (per the source comment), so this is a deliberate, breaking change to coordinate.

### Channel
**Category:** NEEDS_REVISION
**Model source:** Ambiguous — Warp's `Channel` conflates two distinct model concepts: Primitive 3: Intent → IntentContext.channel (`Web | Mobile | Physical | Voice | Agent`) and the delivery mechanism in Primitive 4: CommitmentTerms → DeliveryMethod → DigitalDelivery / Fulfillment.
**Model definition:** The model's `Channel` is the *engagement* channel ("how the party is engaging": `Web | Mobile | Physical | Voice | Agent`). The model has **no** "WhatsApp | FCM | Email | SMS" enum — those are outbound *delivery mechanisms*, which live under `DeliveryMechanism`/communication, not under the Intent's channel.
**Current implementation:** `enum Channel { WhatsApp, FCM, Email, SMS }` — used both as a customer's "preferred channel" and as ACP's "recommended channel".
**Verdict:** Does not match the model's `Channel`. Warp's `Channel` is an *outbound communication mechanism*, a different concept from the model's *engagement channel*. The name collides with a model term while meaning something else — a real source of confusion for the "two independent implementations" goal.
**Change required:** Rename Warp's enum to something like `OutboundChannel` or `CommunicationChannel` to free the name `Channel` for the model's engagement concept (`Web | Mobile | Physical | Voice | Agent`), which should be added as part of `IntentContext` in Section 3. Keep the four delivery mechanisms; they are real and correct as *communication* mechanisms, just not as the model's `Channel`.

### CustomerProfile
**Category:** NEEDS_REVISION
**Model source:** Primitive 1: Party (specifically `PartyType::Individual`); see also Platform Mapping "Customer → Party(Individual)".
**Model definition:** "A Party is any entity that can participate in commerce. … Party { id: PartyID, type: PartyType, locale: Locale, capacity: Capacity }."
**Current implementation:** `struct CustomerProfile { customer_id: String, phone: PhoneNumber, language: Language, preferred_channel: Channel, email: Option<String>, name: Option<String> }` — the ACP-shaped record.
**Verdict:** A partial, ACP-flavoured stand-in for `Party(Individual)`. It carries contact + preference fields but **none of the model's structural Party fields**: no `PartyType` (Individual/Organization/System), no `Capacity` (the basis of Invariant 3 — capacity verification), no `Locale` (it has `language` loosely but no `currency`/`jurisdiction`), and `customer_id` is a raw `String` rather than a typed `PartyID`/`CustomerID`. The model is also role-neutral ("Role is contextual, not intrinsic") — "Customer" bakes in a buyer role the model deliberately avoids.
**Change required:** Reframe as (or back with) the model's `Party` type. At minimum: type the id as `CustomerID`/`PartyID`; add `PartyType`; add `Capacity` (so the compiler can enforce Invariant 3 — e.g. `can_buy = false` while a Dispute is open, per the AI Contract); fold `language` into a `Locale { language, currency, jurisdiction }`. `CustomerProfile` may survive as an ACP DTO that *projects from* a `Party`, but it must not be the canonical party representation.

### StrategyRecommendation
**Category:** CORRECT (out of model by design)
**Model source:** None — explicitly excluded. AI Contract → "What an AI agent CANNOT determine from the model alone": "What the best next action is (strategy is outside the model)"; and "What Is Not In This Model" → "Recommendation and personalization … This is strategy built on top of the model's state."
**Model definition:** None. The model states: "The model provides state. Strategy is built on top of state."
**Current implementation:** `struct StrategyRecommendation { discount_code, recommended_products, confidence, rationale, recommended_channel }` — ACP's next-move recommendation.
**Verdict:** Correctly *outside* the model. Strategy is the model's explicit boundary. This type belongs to the intelligence layer that consumes model state, not to the model. No change needed for model-faithfulness.
**Change required:** — (note: `recommended_channel` carries the same `Channel` rename as above; otherwise out of scope for the model)

### OrderID
**Category:** NEEDS_REVISION
**Model source:** Primitive 4: Commitment → CommitmentID; Invariant 5: Identity Permanence — "A platform's native order ID maps to exactly one CommitmentID. The mapping is established at Commitment creation and never changes."
**Model definition:** "id: CommitmentID — globally unique, immutable, never reused." The model has no `OrderID`; an order *is* a Commitment, and its native order ID is a foreign key that maps to a `CommitmentID`.
**Current implementation:** `struct OrderID(String)` — validated newtype (≤128 chars, alnum/`-`/`_`), distinct from `CustomerID`.
**Verdict:** A platform-native concept standing in for the model's `CommitmentID`. The validation and the type-distinctness from `CustomerID` are good engineering, but the model's primary identity for an order is `CommitmentID`, and `OrderID` should be the *platform-native* id that maps to it (per Invariant 5), not the canonical id.
**Change required:** Introduce `CommitmentID` (Section 3) as the canonical identity. Keep `OrderID` as the platform-native foreign key, and record the `OrderID → CommitmentID` mapping at Commitment creation (Invariant 5). Do not let `OrderID` remain the de facto order identity.

### OrderIDError
**Category:** CORRECT
**Model source:** Implementation detail of `OrderID` validation.
**Current implementation:** `enum OrderIDError { Empty, TooLong, InvalidChars }`.
**Verdict:** Implementation detail. Correct.
**Change required:** —

### CustomerID
**Category:** NEEDS_REVISION
**Model source:** Primitive 1: Party → PartyID; Invariant 5: Identity Permanence ("PartyID … globally unique and … never reused").
**Model definition:** "id: PartyID — globally unique, immutable, never reused." The model has no `CustomerID`; a customer is a `Party` playing the `Initiator` role, identified by `PartyID`.
**Current implementation:** `struct CustomerID(String)` — same validation surface as `OrderID`, distinct type.
**Verdict:** A role-baked stand-in for `PartyID`. "Customer" presumes the buyer role the model treats as contextual ("Role is contextual, not intrinsic"). The validated-newtype mechanism is sound; the naming and the absence of a general `PartyID` are the issue.
**Change required:** Introduce `PartyID` as the model identity. `CustomerID` may remain as a convenience alias / projection for the common case, but the canonical party identity is `PartyID`, and the same id space must serve sellers, intermediaries, guarantors, and fulfillers (the model's other roles).

### CartItem
**Category:** NEEDS_REVISION
**Model source:** Primitive 2: Value → ValueForm → PhysicalGood (a line item is a desired/committed `Value`); within a cart it is part of Primitive 3: Intent → Desire.
**Model definition:** A `Value { id: ValueID, form: ValueForm, quantity, state }`; for a physical line, `ValueForm::PhysicalGood { sku: SKU, condition, location, attributes, provenance }`.
**Current implementation:** `struct CartItem { product_id: String, name: String, quantity: u32, unit_price: Currency, vendor_id: String }`.
**Verdict:** A flattened line item that is *adjacent to* the model's `Value`. `product_id` is a raw `String` where the model requires a typed `SKU`; there is no `ValueID`, no `ValueState`, no `condition`/`location`/`provenance`; `vendor_id` is a raw `String` where the model would carry a `PartyID` (the fulfilling party). Quantity as bare `u32` loses the model's `Quantity` (which carries a unit). It works for cart-recovery but is not the model's value representation.
**Change required:** Type `product_id` as `SKU`; type `vendor_id` as `PartyID`; introduce `Quantity` (value + unit); and relate the line to a `Value`/`ValueForm`. Full alignment depends on `Value`, `SKU`, `Quantity`, `PartyID` landing in Section 3 — `CartItem` then becomes a projection of `Value(PhysicalGood)`.

### CartState
**Category:** NEEDS_REVISION
**Model source:** Primitive 3: Intent (specifically `IntentState::Active`); Platform Mapping — "Cart → Intent(Active)", "Abandoned Checkout → Intent(Abandoned)".
**Model definition:** "An Intent is a party's expressed desire to engage in commerce. It exists before any Commitment. … Intent { id: IntentID, party: PartyID, desire: Desire, state: IntentState, history, created_at, expires_at }."
**Current implementation:** `struct CartState { cart_id, customer_id: CustomerID, items: Vec<CartItem>, subtotal: Currency, currency: CurrencyCode, vendor_ids: Vec<String>, … }` with derived `total()`, `item_count()`, `vendor_count()`.
**Verdict:** This is the model's `Intent(Active)` in all but name — and it is missing the structural pieces that make Intent a first-class primitive. There is no `IntentID`, no `IntentState` (so the Active→Abandoned→Converted/Expired lifecycle that the `CartAbandoned` node *implements* has no type), no `history` (Invariant 4 — append-only IntentTransitions), no `Desire`/constraints/context (so occasion, recipient, budget, urgency cannot ride on the cart). `customer_id` is correctly typed; `vendor_ids` is raw `String`. The model explicitly elevates Intent precisely so "cart abandonment [is] a formal state transition rather than an afterthought webhook" — the current `CartState` is exactly the afterthought-webhook shape the model is reacting against.
**Change required:** Promote to (or back with) the model's `Intent` type: add `IntentID`, `IntentState` (Active/Abandoned/Converted{commitment_id}/Expired), an append-only `history: Vec<IntentTransition>`, and a `Desire`/`IntentContext` (so `Occasion`, recipient, budget, channel attach to the cart per the model). `CartState` may remain as the live-cart projection of an `Intent`, but `Intent` must exist as the primitive.

### Occasion
**Category:** NEEDS_REVISION
**Model source:** Primitive 3: Intent → Desire → IntentContext.occasion
**Model definition:** "occasion: Option<Occasion> { Birthday | Anniversary | Eid | Ramadan | MothersDay | ValentinesDay | WeddingAnniversary | Corporate | Custom(String) }."
**Current implementation:** `enum Occasion { Birthday, Anniversary, Eid, Ramadan, MothersDay, ValentinesDay, WeddingAnniversary, Custom(String) }` (snake_case wire format; `Custom` serializes as `{"custom": …}`).
**Verdict:** Very nearly a faithful match — same семь named variants plus `Custom(String)` — but it is **missing the model's `Corporate` variant**. The model enumerates `Corporate` (corporate gifting / B2B occasions); Warp omits it. Otherwise the variant set and the escape hatch align with the model. (The wire format is a Warp serialization decision the model does not constrain.)
**Change required:** Add the `Corporate` variant to match the model's enumeration. Confirm the snake_case wire format is acceptable for the spec (the model does not mandate a serialization, but the "two independent implementations" goal benefits from one — already codified in WARP_TYPE_SPEC). Minor, mechanical.

### OccasionEvent
**Category:** CORRECT (out of model by design — trigger plumbing)
**Model source:** No direct primitive. It is the typed event the `OccasionTrigger` emits; the *occasion* it carries derives from Primitive 3 (IntentContext.occasion), but the event wrapper itself is Warp trigger plumbing, not a model object. Closest model analogue: a signal that an `Intent` should be created.
**Model definition:** The model has no "occasion event" — it has `Occasion` as a field on an Intent's context. The model's "What Is Not In This Model" places demand generation ("how Intents are created") outside the model.
**Current implementation:** `struct OccasionEvent { tenant_id, customer_id: CustomerID, occasion: Occasion, days_until: u32, occasion_date: String }`.
**Verdict:** Implementation detail (a trigger payload) that lives correctly outside the model — it is part of "how Intents are created," which the model excludes. Worth noting two things for later: `occasion_date: String` should become a typed `Timestamp`/`Date` (the model uses `Timestamp` everywhere — see Invariant 4), and when `Intent` exists this event should produce an `Intent` rather than feed marketing nodes directly.
**Change required:** — (out of model; but flag `occasion_date: String` for the `Timestamp` migration in Section 4)

### SegmentCriteria
**Category:** CORRECT (out of model by design)
**Model source:** None — excluded. "What Is Not In This Model" → "Marketing and demand generation" and "Recommendation and personalization … strategy built on top of the model's state."
**Model definition:** None.
**Current implementation:** `struct SegmentCriteria { min_order_count, min_total_spent_mad, language, last_purchase_within_days, has_whatsapp_consent }` — a typed audience predicate.
**Verdict:** Correctly outside the model. Segmentation is marketing/strategy. The model would view the *result* of segmentation as a set of Parties/Intents, but the criteria themselves are strategy. No model-faithfulness change.
**Change required:** — (note: `language: Option<Language>` inherits the `LanguageCode` revision; `min_total_spent_mad: Option<u64>` is a raw MAD integer rather than `Currency` — a money-as-integer that contradicts C-01's spirit and the model's Money constraint, worth fixing independently of the model audit)

### CampaignAudience
**Category:** CORRECT (out of model by design)
**Model source:** None — excluded (marketing). Tangentially, the model's multi-recipient `Intent.desire.recipients: Vec<Recipient>` is the closest structural cousin, but a campaign audience is a marketing construct, not an Intent.
**Model definition:** None.
**Current implementation:** `struct CampaignAudience { tenant_id, customers: Vec<String>, criteria: SegmentCriteria, label: Option<String> }` with `size()`.
**Verdict:** Correctly outside the model (marketing). `customers: Vec<String>` should ideally be `Vec<CustomerID>`/`Vec<PartyID>` once those are canonical, but that is a type-hygiene nit, not a model alignment issue.
**Change required:** — (note: type `customers` as `Vec<CustomerID>` for hygiene; not model-blocking)

### ABTestVariant
**Category:** CORRECT (out of model by design)
**Model source:** None — excluded. A/B routing is strategy/experimentation ("strategy is outside the model").
**Model definition:** None.
**Current implementation:** `enum ABTestVariant { A, B }`.
**Verdict:** Correctly outside the model. Experimentation is strategy. No model-faithfulness change.
**Change required:** —

---

## Section 3 — Node Type Audit

Each of the 11 catalog nodes (`crates/warp-catalog/src/node_registry.rs`)
audited as a model state transition. A node *should* implement a transition
in the model's state machine; in practice most current nodes are
marketing/communication/intelligence/timing nodes that touch the model only
at its edges. That finding is itself the most important output of this
section: **only `CartAbandoned` and `OrderPlaced` correspond to model state
transitions at all.** The rest are pre-commerce (marketing/triggers),
strategy (ACP), communication, or infrastructure (timing). The model's core
lifecycle — `Commitment` Draft→Proposed→Accepted→…→Fulfilled and the whole
`Fulfillment` state machine — has **zero** node coverage today.

"Input/Output types" below are judged against the model's required fields
for the transition the node implements (or would implement).

### CartAbandoned
**Model transition:** Intent(Active → Abandoned) — the model's named example: "a cart abandonment is Active → Abandoned"; Platform Mapping "Abandoned Checkout → Intent(Abandoned)".
**Input types:** NEEDS_REVISION
**Output types:** NEEDS_REVISION
**Change required:** Inputs `min_value` (Currency/Money ✓) and `after` (Duration ✓) are correctly typed. But the transition operates on an `Intent`, and there is no `Intent`/`IntentState` type — the node emits a `CartState` (an untyped-state Intent stand-in) rather than transitioning an `Intent` from `Active` to `Abandoned` and appending an `IntentTransition` (Invariant 4). Output must become an `Intent` in state `Abandoned` once `Intent`/`IntentState`/`IntentTransition` exist (Section 4). Until then the node cannot record the transition the model says it performs.

### OrderPlaced
**Model transition:** Commitment(→ Accepted) — Platform Mapping "Order(paid) → Commitment(Accepted)", "order.placed.v1 → Commitment(Accepted)".
**Input types:** NEEDS_REVISION
**Output types:** NEEDS_REVISION
**Change required:** Inputs `min_value` (Currency ✓) and optional `platform` (Platform ✓) are fine as a *filter*. But the node represents an order reaching `Accepted`, and there is no `Commitment`/`CommitmentState` type to produce. Output should be a `Commitment` in state `Accepted`, carrying parties (initiator/counterparty), subject (offered/requested Values), and an `originated_from: IntentID` link back to the cart's Intent. Capacity must be verified for `Accepted` (Invariant 3). All of this is blocked on `Commitment` (Section 4). The node currently carries an `OrderID`-shaped payload, not a Commitment.

### WhatsAppSend
**Model transition:** None (outside the model). A marketing/recovery WhatsApp message does not transfer committed value, so it is **not** a `Fulfillment`. It is communication / demand generation, which the model excludes ("Marketing and demand generation … the model sees the Intent once it exists, not what caused it"). It would only be `Fulfillment(DigitalDelivery)` if it delivered committed digital value (e.g. a license key) — which this node does not.
**Input types:** CORRECT
**Output types:** CORRECT
**Change required:** — for model alignment. Inputs `to: PhoneNumber` (✓, the model's canonical type-safety example) and `template`/`lang` are correct. Note only that the `lang` input inherits the `LanguageCode` revision (Section 2) and that this node should *not* be modelled as a Fulfillment despite the task brief's example — that would misclassify marketing as value transfer and corrupt Invariant 1 accounting.

### DelayFor
**Model transition:** None (infrastructure). Durable timer; not a commerce state transition. The model's temporal concepts are `TimingConstraint`/`DeliveryWindow`/timestamps, not delays.
**Input types:** CORRECT
**Output types:** CORRECT
**Change required:** — `duration: Duration` is correctly typed. Out of model by nature.

### DelayUntil
**Model transition:** None (infrastructure). Durable timer to an absolute time. Relates loosely to the model's `DeliveryWindow`/`Timestamp` but implements no transition.
**Input types:** NEEDS_REVISION
**Output types:** CORRECT
**Change required:** Input `target_datetime` is a string/loose datetime; the model uses a typed `Timestamp` everywhere (Invariant 4 — temporal integrity). Type `target_datetime` as the `Timestamp` introduced in Section 4. Out of model otherwise.

### ACPGetCustomerProfile
**Model transition:** None — it is a *read*, not a transition. It loads a `Party`. The AI Verification Protocol step 1 ("Load the current state of all relevant commerce objects") is the closest model touchpoint, but loading is not a transition.
**Input types:** NEEDS_REVISION
**Output types:** NEEDS_REVISION
**Change required:** Input `customer_id` should be `CustomerID`/`PartyID` (currently flows as a string into ACP). Output is `CustomerProfile`, which per Section 2 must become (or project from) the model's `Party`. The node itself is a model-adjacent read and stays outside the transition machinery.

### ACPEvaluateStrategy
**Model transition:** None — explicitly outside the model. "Strategy is outside the model."
**Input types:** NEEDS_REVISION
**Output types:** CORRECT
**Change required:** Input `customer_id` should be `CustomerID`/`PartyID`; the strategy *context* in the model would be an `Intent`/`CartState`/`Commitment` rather than opaque JSON. Output `StrategyRecommendation` is correctly outside the model (Section 2). No transition to implement — this is the strategy layer that consumes model state.

### OccasionTrigger
**Model transition:** None (demand generation — outside the model). Produces an `OccasionEvent` that *should* create an `Intent`; "how Intents are created" is explicitly excluded from the model.
**Input types:** CORRECT
**Output types:** NEEDS_REVISION
**Change required:** Inputs `occasion` (Occasion — add `Corporate`, Section 2) and `days_before` are fine. Output `OccasionEvent` carries `occasion_date: String` which should be a typed `Timestamp`/`Date`; and the model would have this trigger *produce an Intent* (with the occasion in `IntentContext`) rather than emit a bare marketing event. Out of model, but should feed the Intent primitive once it exists.

### CustomerSegment
**Model transition:** None — marketing/strategy (outside the model).
**Input types:** NEEDS_REVISION
**Output types:** NEEDS_REVISION
**Change required:** Inputs `customer_ids` (should be `Vec<CustomerID>`) and `criteria` (`SegmentCriteria` — fix `min_total_spent_mad` to `Currency`, Section 2). Output `CampaignAudience` is fine as a marketing construct but should carry `Vec<CustomerID>` not `Vec<String>`. All hygiene, not model-transition work — segmentation stays outside the model.

### CampaignFanOut
**Model transition:** None — marketing send (outside the model). Structurally echoes the model's multi-recipient `Intent.desire.recipients` / parent-child Commitment fan-out, but a campaign blast is marketing, not a commerce transition.
**Input types:** NEEDS_REVISION
**Output types:** CORRECT
**Change required:** Inputs `audience` (`CampaignAudience` ✓), `recipients`, `template_id`. `recipients` typing should align with `CustomerID`/`PartyID`. Output is per-customer sends — marketing, outside the model. No transition.

### ABTestRoute
**Model transition:** None — experimentation/strategy (outside the model).
**Input types:** NEEDS_REVISION
**Output types:** CORRECT
**Change required:** Input `customer_id` → `CustomerID`; `experiment_id`/`variant_a_weight` are experiment config. Output `ABTestVariant` is correctly outside the model. No transition.

**Section 3 summary:** 2 of 11 nodes (`CartAbandoned`, `OrderPlaced`) correspond
to model transitions, and both are blocked on missing primitives (`Intent`,
`Commitment`) before they can record the transitions they represent. The
remaining 9 are marketing/strategy/communication/infrastructure nodes that
correctly sit outside the model — but the catalog has **no node** that drives
a `Commitment` through `Proposed → Accepted → Fulfilled`, no node that creates
a `Fulfillment`, and no node for returns/refunds (the model's
"new Commitment with parties reversed"). The node catalog is a
marketing-automation catalog, not yet a commerce-state-transition catalog.

---

## Section 4 — Missing Types

The model's primitives walked top to bottom. For each model type/field/concept,
whether a corresponding Warp type exists. This is the largest and most
important section: the model's five primitives are almost entirely absent from
the runtime. Proposed Rust is a *sketch* for the next session, not final code.

Priorities: **P1** = required for invariant enforcement in the compiler;
**P2** = required for correct platform-adapter mapping; **P3** = required for
completeness but not blocking.

---

### Party
**Model source:** Primitive 1: Party
**Model definition:** Any entity that can participate in commerce — holds value, makes commitments, fulfills obligations, acts as intermediary/guarantor. `Party { id: PartyID, type: PartyType, locale: Locale, capacity: Capacity }`.
**Why needed:** Every Commitment names parties (initiator, counterparty, intermediaries); Invariant 3 (capacity verification) reads `Capacity`. `CustomerProfile` is an ACP DTO, not a model Party.
**Proposed implementation:**
```rust
pub struct PartyID(String);            // globally unique, immutable, never reused (Inv. 5)
pub enum PartyType { Individual, Organization, System }
pub struct Party {
    pub id: PartyID,
    pub party_type: PartyType,
    pub locale: Locale,
    pub capacity: Capacity,
}
```
**Priority:** P1

### PartyID
**Model source:** Primitive 1: Party.id; Invariant 5
**Model definition:** "globally unique, immutable, never reused."
**Why needed:** Canonical party identity; the same id space serves buyer, seller, intermediary, fulfiller, guarantor. `CustomerID` is a role-baked partial stand-in.
**Proposed implementation:** `pub struct PartyID(String);` (validated newtype, same surface as `CustomerID`).
**Priority:** P1

### PartyType
**Model source:** Primitive 1: PartyType
**Model definition:** `Individual | Organization | System` — `System` is an AI agent/automated system acting on behalf of a principal.
**Why needed:** AI Contract requires recording the acting party as `PartyType::System` (step 6 of the Verification Protocol); franchise/B2B modelling distinguishes Organization.
**Proposed implementation:** `pub enum PartyType { Individual, Organization, System }`
**Priority:** P1

### PartyRole
**Model source:** Primitive 1: PartyRole
**Model definition:** `Initiator | Counterparty | Intermediary | Fulfiller | Guarantor` — "Role is contextual, not intrinsic."
**Why needed:** A Commitment assigns roles; the model insists roles are per-Commitment, not baked into the party. Required to express escrow (Guarantor), marketplaces (Intermediary), dropship (Fulfiller).
**Proposed implementation:** `pub enum PartyRole { Initiator, Counterparty, Intermediary, Fulfiller, Guarantor }`
**Priority:** P1

### Capacity
**Model source:** Primitive 1: Party.capacity
**Model definition:** `Capacity { can_buy, can_sell, can_fulfill, can_guarantee, verified_at: Timestamp }`.
**Why needed:** **Invariant 3 (Capacity Verification)** is unenforceable without it — "A Commitment cannot reach Accepted state unless the capacity of all parties for their roles has been verified." Also the AI Contract: "Capacity.can_buy is false while an active Dispute exists."
**Proposed implementation:**
```rust
pub struct Capacity {
    pub can_buy: bool,
    pub can_sell: bool,
    pub can_fulfill: bool,
    pub can_guarantee: bool,
    pub verified_at: Timestamp,
}
```
**Priority:** P1

### Locale
**Model source:** Primitive 1: Party.locale
**Model definition:** `Locale { language: LanguageCode (BCP 47), currency: CurrencyCode (ISO 4217), jurisdiction: JurisdictionCode (ISO 3166-1 alpha-2) }`.
**Why needed:** Correct platform-adapter mapping and MENA-first defaults (C-07); the current `Language` enum is a partial, region-less stand-in for `Locale.language`.
**Proposed implementation:**
```rust
pub struct Locale {
    pub language: LanguageCode,       // see below
    pub currency: CurrencyCode,
    pub jurisdiction: JurisdictionCode,
}
```
**Priority:** P2

### LanguageCode
**Model source:** Primitive 1: Locale.language
**Model definition:** BCP 47 (`fr-MA`, `ar-MA`, `zgh-MA`).
**Why needed:** Replaces/backs the closed `Language` enum (Section 2 NEEDS_REVISION); carries region, which `Language` cannot.
**Proposed implementation:** `pub struct LanguageCode(String);` validating BCP 47, with helpers mapping the existing `Language` variants.
**Priority:** P2

### JurisdictionCode
**Model source:** Primitive 1: Locale.jurisdiction; Primitive 4: CommitmentTerms.jurisdiction
**Model definition:** ISO 3166-1 alpha-2 (`MA`, `FR`).
**Why needed:** Commitment governing law; international B2B; correct adapter mapping.
**Proposed implementation:** `pub struct JurisdictionCode(String);` (2-letter validated).
**Priority:** P2

### Value
**Model source:** Primitive 2: Value
**Model definition:** `Value { id: ValueID, form: ValueForm, quantity: Quantity, state: ValueState }` — what moves between parties.
**Why needed:** A Commitment's `offered`/`requested` are `Vec<Value>`; Invariant 1 (Value Conservation) operates on Value; `CartItem` is a flattened partial stand-in.
**Proposed implementation:**
```rust
pub struct ValueID(String);
pub struct Value {
    pub id: ValueID,
    pub form: ValueForm,
    pub quantity: Quantity,
    pub state: ValueState,
}
```
**Priority:** P1

### ValueForm
**Model source:** Primitive 2: ValueForm
**Model definition:** `PhysicalGood | DigitalGood | Service | Money | ContingentValue | Nothing`.
**Why needed:** The model represents *everything that moves* through this enum. Only `Money` partially exists (as `Currency`). PhysicalGood/Service/DigitalGood are needed for any non-trivial commerce.
**Proposed implementation:**
```rust
pub enum ValueForm {
    PhysicalGood(PhysicalGood),
    DigitalGood(DigitalGood),
    Service(Service),
    Money(Currency),                 // reuse the existing, correct Money type
    ContingentValue(Box<ContingentValue>),
    Nothing,
}
```
**Priority:** P1 (the `Money` and `PhysicalGood` arms); P3 (Digital/Service/Contingent detail)

### MoneyAmount::Estimated
**Model source:** Primitive 2: Money.amount → `Estimated { amount, basis, final_at, cap }`
**Model definition:** Best-estimate money at commitment time with a finalization trigger and optional cap (metered/gig/time-and-materials).
**Why needed:** Gig economy with surge pricing and metered billing are in the model's passing test set; `Currency` only expresses `Exact`.
**Proposed implementation:**
```rust
pub enum MoneyAmount { Exact(Currency), Estimated { amount: Currency, basis: EstimationBasis, final_at: FinalizationTrigger, cap: Option<Currency> } }
pub enum EstimationBasis { Metered, Distance, Time, Fixed }
```
**Priority:** P2

### Quantity
**Model source:** Primitive 2: Value.quantity
**Model definition:** A quantity (the model carries a unit, e.g. `capacity_unit`, "hours", "words").
**Why needed:** `CartItem.quantity: u32` and `FulfillmentItem.quantity` lose the unit; services and metered goods need a unit.
**Proposed implementation:** `pub struct Quantity { pub amount: Decimal, pub unit: Option<String> }`
**Priority:** P2

### SKU
**Model source:** Primitive 2: PhysicalGood.sku (also listed as a core type in CLAUDE.md)
**Model definition:** "sku: SKU — what the good is" (catalog-validated product identifier).
**Why needed:** `CartItem.product_id` is a raw `String`; CLAUDE.md lists `SKU` as a core commerce type that does not yet exist.
**Proposed implementation:** `pub struct SKU(String);` (validated; catalog-resolution is a later concern).
**Priority:** P2

### ValueState
**Model source:** Primitive 2: ValueState
**Model definition:** Physical/money: `Available | Reserved{commitment, basis} | UnderAuction{…} | Committed | InTransit | Transferred | Returned`; digital: `AccessGranted | AccessSuspended | AccessRevoked | AccessExpired`.
**Why needed:** Invariant 1 (conservation) and Invariant 3 (capacity — the `Reserved.basis` carries `ReservationBasis`) both read ValueState. No type exists.
**Proposed implementation:**
```rust
pub enum ValueState {
    Available,
    Reserved { commitment: CommitmentID, basis: ReservationBasis },
    UnderAuction { auction_process: AuctionProcessID, closes_at: Timestamp },
    Committed { commitment: CommitmentID },
    InTransit { fulfillment: FulfillmentID },
    Transferred { to: PartyID, at: Timestamp },
    Returned { from: PartyID, initiated_at: Timestamp },
    // digital variants: AccessGranted/Suspended/Revoked/Expired
}
```
**Priority:** P1

### ReservationBasis
**Model source:** Primitive 2: ValueState.Reserved.basis; Invariant 3 note
**Model definition:** `PhysicalStock | ProductionCapacity | TimeSlot | RecurringTimeSlot | DriverCapacity | Speculative`.
**Why needed:** Invariant 3 — "A Commitment may reach Accepted with Speculative reservation but the Commitment must record the reservation basis explicitly"; AI Contract — "ReservationBasis is a required field on Reserved ValueState." Dropshipping/made-to-order honesty depends on it.
**Proposed implementation:**
```rust
pub enum ReservationBasis { PhysicalStock, ProductionCapacity, TimeSlot { /* … */ }, RecurringTimeSlot { /* … */ }, DriverCapacity, Speculative }
```
**Priority:** P1

### Intent
**Model source:** Primitive 3: Intent
**Model definition:** A party's expressed desire before any Commitment — `Intent { id: IntentID, party: PartyID, desire: Desire, state: IntentState, history: Vec<IntentTransition>, created_at, expires_at }`.
**Why needed:** `CartAbandoned` *implements* `Intent(Active → Abandoned)` but there is no Intent type. The model elevates Intent specifically so cart abandonment is "a formal state transition rather than an afterthought webhook." `CartState` is the de facto stand-in.
**Proposed implementation:**
```rust
pub struct IntentID(String);
pub struct Intent {
    pub id: IntentID,
    pub party: PartyID,
    pub desire: Desire,
    pub state: IntentState,
    pub history: Vec<IntentTransition>,   // append-only (Inv. 4)
    pub created_at: Timestamp,
    pub expires_at: Option<Timestamp>,
}
```
**Priority:** P1

### IntentState
**Model source:** Primitive 3: IntentState
**Model definition:** `Active | Abandoned | Converted { commitment_id } | Expired`.
**Why needed:** The Active→Abandoned transition the `CartAbandoned` node performs has no type to move; `Converted{commitment_id}` is the formal link from cart to order (Intent → Commitment).
**Proposed implementation:**
```rust
pub enum IntentState { Active, Abandoned, Converted { commitment_id: CommitmentID }, Expired }
```
**Priority:** P1

### IntentTransition
**Model source:** Primitive 3: IntentTransition; Invariant 4
**Model definition:** `{ from: IntentState, to: IntentState, at: Timestamp, actor: PartyID, reason: Option<String> }` — append-only, immutable.
**Why needed:** Invariant 4 (Temporal Integrity) requires an append-only history of transitions per object.
**Proposed implementation:** struct as above.
**Priority:** P1

### Desire / Constraints / IntentContext
**Model source:** Primitive 3: Intent.desire
**Model definition:** `Desire { value_form, constraints: { budget, timing, quantity, preferences }, context: IntentContext { occasion, recipient, channel, urgency } }`.
**Why needed:** Carries `Occasion` (which exists but currently has no Intent to attach to), recipient (gift commerce), budget, urgency, and the model's engagement `Channel` (`Web|Mobile|Physical|Voice|Agent`). Gift/occasion commerce depends on this.
**Proposed implementation:**
```rust
pub struct Desire { pub value_form: ValueForm, pub constraints: Constraints, pub context: IntentContext }
pub struct IntentContext { pub occasion: Option<Occasion>, pub recipient: Option<PartyID>, pub channel: EngagementChannel, pub urgency: Urgency }
pub enum EngagementChannel { Web, Mobile, Physical, Voice, Agent }   // the model's real "Channel"
pub enum Urgency { Low, Normal, High, Critical }
```
**Priority:** P2

### Recipient
**Model source:** Primitive 3: "On multi-recipient intent" → `Recipient { party: PartyID, address: Address, items_desired: Vec<ValueForm> }`
**Model definition:** Multi-recipient gifting — one Intent, multiple recipients, each producing a child Commitment.
**Why needed:** Multi-recipient gifting is in the model's passing test set (three addresses).
**Proposed implementation:** struct as above; `Intent.desire.recipients: Vec<Recipient>`.
**Priority:** P3

### Commitment
**Model source:** Primitive 4: Commitment — "the central primitive of the commerce model."
**Model definition:** A formal agreement between ≥2 parties to exchange value under specified terms — `Commitment { id, parties, subject, terms, state, history, originated_from, parent, children, created_at, expires_at }`.
**Why needed:** The model's centre. **No Commitment type exists.** Every order, every transition, every invariant (2, 3, 5, 6) hangs off it. `OrderID` is a bare-id stand-in.
**Proposed implementation:**
```rust
pub struct CommitmentID(String);
pub struct Commitment {
    pub id: CommitmentID,
    pub parties: CommitmentParties,        // initiator, counterparty, intermediaries
    pub subject: CommitmentSubject,        // offered: Vec<Value>, requested: Vec<Value>
    pub terms: CommitmentTerms,
    pub state: CommitmentState,
    pub history: Vec<CommitmentTransition>,// append-only (Inv. 4)
    pub originated_from: Option<IntentID>,
    pub parent: Option<CommitmentID>,
    pub children: Vec<CommitmentID>,
    pub created_at: Timestamp,
    pub expires_at: Option<Timestamp>,
}
```
**Priority:** P1

### CommitmentID
**Model source:** Primitive 4: Commitment.id; Invariant 5
**Model definition:** "globally unique, immutable, never reused"; a platform's native order id maps to exactly one CommitmentID.
**Why needed:** Canonical order identity; `OrderID` should map *to* it, not replace it.
**Proposed implementation:** `pub struct CommitmentID(String);`
**Priority:** P1

### CommitmentState
**Model source:** Primitive 4: CommitmentState + "Valid state transitions — the complete list"
**Model definition:** `Draft | Proposed | Tendered{…} | Accepted | Modified{…} | PartiallyFulfilled{…} | Active | Fulfilled | Cancelled{…} | Disputed{…} | Refunded{…}`, with an exhaustive valid-transition table.
**Why needed:** **Invariant 2 (State Monotonicity)** is the single most important unenforceable rule today — "A Fulfilled Commitment cannot return to Accepted. A Cancelled Commitment cannot become Fulfilled." The AI Contract's "impossible mistakes" (fulfilling a Cancelled commitment, cancelling a Fulfilled one) require this enum + a transition validator. This is the model's spine and it is entirely absent.
**Proposed implementation:**
```rust
pub enum CommitmentState {
    Draft,
    Proposed,
    Tendered { offer: Currency, valid_condition: TenderCondition, closes_at: Timestamp,
               superseded_by: Option<CommitmentID>, auction_process: Option<AuctionProcessID> },
    Accepted,
    Modified { previous_terms: Box<CommitmentTerms>, modification_by: PartyID, reason: String },
    PartiallyFulfilled { fulfilled_items: Vec<ValueID>, remaining_items: Vec<ValueID> },
    Active,
    Fulfilled,
    Cancelled { by: PartyID, reason: String, at: Timestamp, fee: Option<Currency> },
    Disputed { by: PartyID, reason: String, evidence: Vec<Evidence>, opened_at: Timestamp },
    Refunded { amount: Currency, method: PaymentMethod, at: Timestamp },
}
// plus: fn is_valid_transition(from: &CommitmentState, to: &CommitmentState) -> bool
//       implementing the model's exhaustive transition table.
```
**Priority:** P1

### CommitmentTransition
**Model source:** Primitive 4: Commitment.history; Invariant 4
**Model definition:** Append-only, immutable transition record with timestamp.
**Why needed:** Invariant 4; Axiom 4 ("state is fully determined by its history").
**Proposed implementation:** `pub struct CommitmentTransition { pub from: CommitmentState, pub to: CommitmentState, pub at: Timestamp, pub actor: PartyID, pub reason: Option<String> }`
**Priority:** P1

### CommitmentTerms (+ DeliveryTerms, PaymentTerms, CommitmentCondition, CommitmentDuration)
**Model source:** Primitive 4: CommitmentTerms
**Model definition:** `{ delivery: DeliveryTerms, payment: PaymentTerms, conditions: Vec<CommitmentCondition>, jurisdiction: JurisdictionCode, duration: Option<CommitmentDuration> }` with rich `DeliveryMethod` and `PaymentTiming` enums and ~12 condition variants.
**Why needed:** Capacity verification reads conditions (`QualityInspection`, `ConditionVerification`); subscriptions need `PaymentTiming::Recurring` + `CommitmentDuration::OpenEnded`; the `GracePeriod`/`NoShowPolicy` conditions appear in the model's passing service tests.
**Proposed implementation:** A `CommitmentTerms` struct plus `DeliveryMethod`, `PaymentTerms`/`PaymentTiming`, and a `CommitmentCondition` enum mirroring the model. (Large — sketch deferred; build the `delivery.method`/`payment.timing` skeleton first.)
**Priority:** P2 (P1 for the subset that capacity-verification conditions read)

### DeliveryWindow
**Model source:** Primitive 4: DeliveryTerms.window (also a core type in CLAUDE.md)
**Model definition:** `{ earliest: Timestamp, latest: Timestamp }` (with timezone per CLAUDE.md).
**Why needed:** CLAUDE.md lists `DeliveryWindow` as a core type; the AI Contract's "Commitment at risk (delivery window approaching)" reads it. Does not exist.
**Proposed implementation:** `pub struct DeliveryWindow { pub earliest: Timestamp, pub latest: Timestamp }`
**Priority:** P2

### Fulfillment
**Model source:** Primitive 5: Fulfillment
**Model definition:** The execution of a Commitment — the actual movement of value. `Fulfillment { id, commitment, items, method, state, evidence, history, period?, trigger_result?, planned_at, started_at?, completed_at? }`. One Commitment → many Fulfillments.
**Why needed:** The entire fulfillment half of the model has no type. No node creates one; no return/refund (`Fulfillment(Reversed)`) can be expressed.
**Proposed implementation:**
```rust
pub struct FulfillmentID(String);
pub struct Fulfillment {
    pub id: FulfillmentID,
    pub commitment: CommitmentID,
    pub items: Vec<FulfillmentItem>,        // { value: ValueID, from: PartyID, to: PartyID, quantity: Quantity }
    pub method: FulfillmentMethod,
    pub state: FulfillmentState,
    pub evidence: Vec<Evidence>,
    pub history: Vec<FulfillmentTransition>,
    pub planned_at: Timestamp,
    pub started_at: Option<Timestamp>,
    pub completed_at: Option<Timestamp>,
}
```
**Priority:** P1

### FulfillmentState
**Model source:** Primitive 5: FulfillmentState
**Model definition:** `Planned | InProgress | Completed | Failed{reason, at, recoverable} | Reversed{reason, initiated_by, at}`.
**Why needed:** Invariant 2 also governs FulfillmentState; the lifecycle diagram drives `Commitment → Fulfilled` off `Fulfillment(Completed)`; `Reversed` is how returns work (P-8 dead-letter visibility maps to `Failed`).
**Proposed implementation:**
```rust
pub enum FulfillmentState { Planned, InProgress, Completed,
    Failed { reason: String, at: Timestamp, recoverable: bool },
    Reversed { reason: String, initiated_by: PartyID, at: Timestamp } }
```
**Priority:** P1

### FulfillmentTransition
**Model source:** Primitive 5: Fulfillment.history; Invariant 4
**Why needed:** Invariant 4 append-only history for fulfillments.
**Proposed implementation:** `pub struct FulfillmentTransition { from: FulfillmentState, to: FulfillmentState, at: Timestamp, actor: PartyID }`
**Priority:** P1

### Evidence
**Model source:** Primitive 5: Evidence
**Model definition:** `ProofOfDelivery | PaymentReceipt | AccessGrant | ServiceCompletion | WarehouseReceipt | BillOfLading | CustomsClearance | TriggerVerification`.
**Why needed:** Fulfillment carries proof of completion; the AI Contract's "whether a return Commitment satisfies the condition requirements" reads evidence.
**Proposed implementation:** `pub enum Evidence { ProofOfDelivery{…}, PaymentReceipt{…}, AccessGrant{…}, ServiceCompletion{…}, WarehouseReceipt{…}, BillOfLading{…}, CustomsClearance{…}, TriggerVerification{…} }`
**Priority:** P2

### Timestamp
**Model source:** Used pervasively across all five primitives; Invariant 4 (Temporal Integrity)
**Model definition:** A point in time on every transition; "No transition can have a timestamp earlier than any previous transition."
**Why needed:** Every history entry, every state with `at`/`closes_at`/`verified_at`. Currently dates are raw `String` (`OccasionEvent.occasion_date`, `DelayUntil.target_datetime`). A typed `Timestamp` is the substrate for Invariant 4.
**Proposed implementation:** `pub struct Timestamp(/* chrono::DateTime<Utc> or i64 epoch + tz */);` with ISO 8601 (de)serialization. Note C-07: timezone defaults to Africa/Casablanca.
**Priority:** P2 (P1 once Invariant-4 checks land)

### Address / Location
**Model source:** Primitive 2 (PhysicalGood.location), Primitive 4 (DeliveryTerms.address), Recipient.address
**Model definition:** Physical place / postal address.
**Why needed:** Physical delivery and returns; multi-recipient gifting.
**Proposed implementation:** `pub struct Address { /* lines, city, postal, jurisdiction: JurisdictionCode */ }` and a `Location`.
**Priority:** P2

### DateRange / TimeWindow / Duration / Frequency
**Model source:** Primitive 2 (ServiceSchedule), Primitive 4 (TimeWindow, CommitmentDuration), Primitive 5 (period)
**Model definition:** Time spans and recurrences used by services, subscriptions, reservations.
**Why needed:** Subscriptions, appointments, service packages (all in the model's passing tests). `Duration` exists only as a DSL `ConfigValue`, not as a commerce type.
**Proposed implementation:** `DateRange { start, end }`, `TimeWindow { from, to }`, a commerce-level `Duration`, `Frequency` enum.
**Priority:** P2 (P3 for `Frequency` until subscriptions are built)

### ContingentValue / ContingentTrigger
**Model source:** Primitive 2: ValueForm::ContingentValue; Primitive 4: ContingentDelivery
**Model definition:** Value that depends on a trigger firing (insurance, prediction markets, options).
**Why needed:** Insurance/derivatives are in the model's passing tests; not blocking for commerce e-commerce.
**Proposed implementation:** `pub struct ContingentValue { trigger: ContingentTrigger, if_triggered: Box<Value>, if_not_triggered: Box<Value> }`
**Priority:** P3

### DigitalGood / AccessModel / Service / ServiceDelivery
**Model source:** Primitive 2: ValueForm::DigitalGood, ValueForm::Service
**Model definition:** Licensing/streaming/API/NFT access models; service delivery/scheduling.
**Why needed:** Digital commerce + services domains (in the model's passing tests). Not blocking for the physical cart-recovery core.
**Proposed implementation:** The model's `DigitalGood`/`AccessModel` and `Service`/`ServiceDelivery` trees.
**Priority:** P3

### ResolutionProcess / ResolutionCandidate / ResolutionOutcome
**Model source:** Primitive 4: "The Resolution Process — for PartiallyFulfilled Commitments"
**Model definition:** Substitution/cancellation workflow for unresolved items in a PartiallyFulfilled Commitment.
**Why needed:** Multi-recipient stock-failure-with-substitute is in the model's passing tests; depends on `Commitment`/`PartiallyFulfilled`.
**Proposed implementation:** The model's `ResolutionProcess` + `ResolutionCandidate` + `ResolutionOutcome` structs.
**Priority:** P3

### AuctionProcess / AuctionMechanism / AuctionState / TenderCondition
**Model source:** Primitive 4: "The AuctionProcess" + CommitmentState::Tendered + ValueState::UnderAuction (v0.2 additions)
**Model definition:** Auxiliary coordination record managing Tendered Commitments; four mechanisms (English/Dutch/SealedBid/Vickrey).
**Why needed:** Market-making commerce (auctions). Not blocking for Warp's commerce-automation core, but part of full model fidelity.
**Proposed implementation:** `AuctionProcessID`, `AuctionProcess`, `AuctionMechanism`, `AuctionState`, `TenderCondition` per the model.
**Priority:** P3

### EntitlementConsumption
**Model source:** Primitive 5: "EntitlementConsumption — for metered digital services"
**Model definition:** Lightweight per-access measurement record linked to a Commitment (instead of a Fulfillment per API call).
**Why needed:** Metered API billing with overage (in the model's passing tests).
**Proposed implementation:** The model's `EntitlementConsumption` struct.
**Priority:** P3

---

## Section 5 — Summary Tables

### TABLE A — CORRECT (no change needed)

| Type | Model Source | Notes |
|------|-------------|-------|
| Currency | Primitive 2: Value → ValueForm → Money | Faithful: mandatory currency, `Decimal` exactness, explicit conversion. Only the `Estimated` amount variant is separately missing. |
| CurrencyError | Primitive 2 (Money constraint mechanism) | Implementation detail; correctly makes mixed-currency ops impossible. |
| PhoneNumber | AI Contract (canonical type-safety example) | Faithful in intent; becomes a `Party` contact field once `Party` exists. |
| PhoneNumberError | `PhoneNumber` validation detail | Correct implementation detail. |
| TenantId | None — infrastructure (C-03) | Correctly outside the model. |
| TenantKeyMismatch | None — infrastructure | Correct infrastructure error. |
| StrategyRecommendation | None — strategy is explicitly excluded | Correctly outside the model (intelligence layer). |
| OccasionEvent | None — demand generation, excluded | Trigger plumbing; flag `occasion_date: String` → `Timestamp` later. |
| SegmentCriteria | None — marketing, excluded | Correctly outside; fix `min_total_spent_mad` → `Currency` for hygiene. |
| CampaignAudience | None — marketing, excluded | Correctly outside; type `customers` as `Vec<CustomerID>` for hygiene. |
| ABTestVariant | None — experimentation/strategy, excluded | Correctly outside the model. |

### TABLE B — NEEDS REVISION

| Type | Current Issue | Required Change | Priority |
|------|--------------|-----------------|----------|
| CurrencyCode | Closed `{MAD,EUR,USD}`; no `Custom`, no DZD/TND | Add `Custom(String)` (loyalty/credits); widen or document the ISO 4217 subset (add DZD/TND per model POS tests) | P2 |
| Platform | Omits SAP (model maps it); adds OpenCart/Magento (model doesn't enumerate) | Reconcile variant set with model Platform Mapping; add `SAP` or document deferral | P3 |
| Language | Closed enum, region-less; "Darija" isn't BCP 47 | Introduce `LanguageCode` (BCP 47); map/replace `Language`; reconcile Darija (`ary`/`ar-MA`) | P2 |
| Channel | Name collides with model's engagement `Channel` but means outbound delivery mechanism | Rename to `OutboundChannel`; add the model's `EngagementChannel {Web,Mobile,Physical,Voice,Agent}` | P2 |
| CustomerProfile | ACP DTO standing in for `Party`; no PartyType/Capacity/Locale; `customer_id: String` | Back with `Party`; add `PartyType`, `Capacity` (Inv. 3), `Locale`; type the id | P1 |
| OrderID | Platform-native id used as canonical order identity | Introduce `CommitmentID`; make `OrderID` the platform FK that maps to it (Inv. 5) | P1 |
| CustomerID | Role-baked stand-in for `PartyID` | Introduce `PartyID`; keep `CustomerID` as convenience alias only | P1 |
| CartItem | Flattened line; `product_id`/`vendor_id` raw `String`; `quantity: u32` | Type as `SKU` / `PartyID` / `Quantity`; relate to `Value(PhysicalGood)` | P2 |
| CartState | Is `Intent(Active)` but lacks IntentID/IntentState/history/Desire | Promote to / back with `Intent`; add `IntentState`, append-only `history`, `Desire`/context | P1 |
| Occasion | Missing the model's `Corporate` variant | Add `Corporate` | P3 |

### TABLE C — MISSING (must be added)

| Type | Model Source | Priority | Blocks |
|------|-------------|----------|--------|
| Party | Primitive 1: Party | P1 | All Commitment parties; canonical customer model |
| PartyID | Primitive 1; Invariant 5 | P1 | Identity permanence; party references |
| PartyType | Primitive 1: PartyType | P1 | AI Contract (System actor); B2B/franchise |
| PartyRole | Primitive 1: PartyRole | P1 | Escrow/marketplace/dropship modelling |
| Capacity | Primitive 1: Party.capacity | P1 | **Invariant 3** (capacity verification) |
| Locale | Primitive 1: Party.locale | P2 | Adapter mapping; MENA defaults (C-07) |
| LanguageCode | Primitive 1: Locale.language | P2 | Replaces closed `Language` enum |
| JurisdictionCode | Primitive 1 / Primitive 4 | P2 | Governing law; international B2B |
| Value | Primitive 2: Value | P1 | **Invariant 1**; Commitment subject |
| ValueForm | Primitive 2: ValueForm | P1 | Representing anything that moves |
| MoneyAmount::Estimated | Primitive 2: Money.amount | P2 | Gig/metered/time-and-materials pricing |
| Quantity | Primitive 2: Value.quantity | P2 | Unit-bearing quantities (services/metered) |
| SKU | Primitive 2: PhysicalGood.sku (CLAUDE.md core type) | P2 | Typed product identity in line items |
| ValueState | Primitive 2: ValueState | P1 | **Invariants 1 & 3** |
| ReservationBasis | Primitive 2: Reserved.basis; Inv. 3 | P1 | **Invariant 3** (speculative-basis honesty) |
| Intent | Primitive 3: Intent | P1 | `CartAbandoned` transition; cart→order link |
| IntentID | Primitive 3 | P1 | Intent identity |
| IntentState | Primitive 3: IntentState | P1 | Active→Abandoned→Converted/Expired |
| IntentTransition | Primitive 3; Inv. 4 | P1 | **Invariant 4** (intent history) |
| Desire/Constraints/IntentContext | Primitive 3: Intent.desire | P2 | Occasion/recipient/budget/engagement channel |
| Recipient | Primitive 3 (multi-recipient) | P3 | Multi-recipient gifting |
| **Commitment** | Primitive 4: Commitment | P1 | **The model's centre**; Invariants 2,3,5,6 |
| CommitmentID | Primitive 4; Inv. 5 | P1 | Canonical order identity |
| **CommitmentState** | Primitive 4: CommitmentState + transition table | P1 | **Invariant 2**; AI Contract impossible-mistakes |
| CommitmentTransition | Primitive 4; Inv. 4 | P1 | **Invariant 4** (commitment history) |
| CommitmentTerms (+Delivery/Payment/Condition/Duration) | Primitive 4: CommitmentTerms | P2 | Subscriptions; capacity-condition checks |
| DeliveryWindow | Primitive 4 (CLAUDE.md core type) | P2 | "At risk" detection; delivery terms |
| Fulfillment | Primitive 5: Fulfillment | P1 | Entire execution half of the model |
| FulfillmentID | Primitive 5 | P1 | Fulfillment identity |
| FulfillmentState | Primitive 5: FulfillmentState | P1 | **Invariant 2**; returns (`Reversed`) |
| FulfillmentTransition | Primitive 5; Inv. 4 | P1 | **Invariant 4** (fulfillment history) |
| Evidence | Primitive 5: Evidence | P2 | Proof of completion; return-condition checks |
| Timestamp | All primitives; Inv. 4 | P2 | **Invariant 4** substrate; replaces date `String`s |
| Address / Location | Primitives 2, 4 | P2 | Physical delivery; returns; gifting |
| DateRange/TimeWindow/Duration/Frequency | Primitives 2, 4, 5 | P2 | Services; subscriptions; reservations |
| ContingentValue/ContingentTrigger | Primitive 2 / 4 | P3 | Insurance; derivatives |
| DigitalGood/AccessModel/Service/ServiceDelivery | Primitive 2 | P3 | Digital + services domains |
| ResolutionProcess/Candidate/Outcome | Primitive 4 | P3 | Partial-fulfillment substitution |
| AuctionProcess/Mechanism/State/TenderCondition | Primitive 4 (v0.2) | P3 | Market-making (auctions) |
| EntitlementConsumption | Primitive 5 | P3 | Metered digital billing |

---

## Section 6 — Compiler Gap Analysis

The current type checker (`crates/warp-core/src/dsl/type_checker.rs`, v0.1)
performs three structural checks: (1) node types exist in
`BUILTIN_NODE_SPECS`, (2) `<instance>.<field>` references resolve to a
declared instance or `trigger`, (3) required inputs are present. It does
**not** perform output-type checking (deferred to v0.2, per the module
docs) and does not know about any model primitive — it validates workflow
*structure*, not commerce *semantics*.

The model's six invariants require semantic checks the type checker cannot
currently perform, primarily because the types those checks operate on
(`CommitmentState`, `ValueState`, `Capacity`, transitions, timestamps,
parent/child trees) do not exist yet (Section 4). Each invariant is analysed
below. Error messages are written in commerce language per P-2 ("a confusing
error message is a bug") and the AI Contract's debuggability goal.

### Invariant 1 — Value Conservation
**Current compiler support:** None
**Gap:** The compiler has no `Value`, `ValueState`, or transfer concept, so it cannot verify that value is conserved across a transfer — that the originating party no longer holds transferred value, and that a provider cannot grant more non-exclusive access rights than its license permits. There is nothing in the AST today that even represents a value transfer.
**Required check:** Once `Value`/`ValueState`/`Fulfillment` exist, validate that every `Fulfillment` moving a `Value` flips that `Value`'s state away from the originator (`Available/Reserved → Transferred/InTransit`) and that no two concurrent Fulfillments transfer the same exclusive `ValueID`. For non-exclusive digital goods, verify granted access rights do not exceed the provider's sub-licensable entitlement.
**Error message should say:** `"Line N: Value 'SKU-PAINTING' is transferred to two parties by Fulfillments F-001 and F-002, but it is an exclusive good — value cannot be in two places. A transfer removes it from the originator (Invariant 1: Value Conservation)."`
**Priority:** P3 (depends on `Value`/`Fulfillment`; not on the cart-recovery critical path)

### Invariant 2 — State Monotonicity
**Current compiler support:** None
**Gap:** No `CommitmentState`/`FulfillmentState` type and no transition table exist, so the compiler cannot reject an illegal transition. This is the highest-value missing check: the AI Contract's flagship "impossible mistakes" (fulfilling a Cancelled Commitment, cancelling a Fulfilled one) are exactly Invariant-2 violations, and today nothing prevents a generated workflow from expressing them.
**Required check:** Add `CommitmentState`/`FulfillmentState` (Section 4) plus an `is_valid_transition(from, to)` function implementing the model's exhaustive transition table. When a workflow node drives a commitment/fulfillment from one state to another, verify the pair appears in the table; reject otherwise. (The only legitimate "reversal" is a *new* Commitment with parties exchanged — the checker should suggest that.)
**Error message should say:** `"Line N: This step moves Commitment from 'Fulfilled' to 'Cancelled', which is not a valid transition — a Fulfilled commitment is terminal. To reverse it, create a new Commitment with the parties exchanged (a return/refund), per Invariant 2: State Monotonicity."`
**Priority:** P1

### Invariant 3 — Capacity Verification
**Current compiler support:** None
**Gap:** No `Capacity` on parties and no `ReservationBasis` on value, so the compiler cannot enforce that a Commitment only reaches `Accepted` once all parties' role-capacity is verified — nor that a `Speculative` reservation is recorded explicitly rather than silently.
**Required check:** Add `Capacity` (on `Party`) and `ReservationBasis` (on `ValueState::Reserved`). Before any transition to `CommitmentState::Accepted`, verify: counterparty `can_sell`/`can_fulfill` for its role; initiator `can_buy` (and is not in an active Dispute — `can_buy=false`); reserved inventory has a non-`Speculative` basis, OR the `Speculative` basis is explicitly recorded on the Commitment.
**Error message should say:** `"Line N: Commitment cannot reach 'Accepted' — the seller's capacity to fulfill has not been verified, and inventory for 'SKU-123' is reserved on a Speculative basis without recording it. Either verify capacity or record the Speculative basis explicitly (Invariant 3: Capacity Verification)."`
**Priority:** P1

### Invariant 4 — Temporal Integrity
**Current compiler support:** None
**Gap:** Timestamps are raw `String`s (`OccasionEvent.occasion_date`, `DelayUntil.target_datetime`) and there is no transition-history type, so the compiler cannot verify that histories are append-only and monotonically non-decreasing in time. (Note: durable, ordered execution is enforced at *runtime* by Restate, but the *type-level* guarantee the model asks for does not exist.)
**Required check:** Add `Timestamp` (Section 4) and require every `*Transition` history to be append-only with non-decreasing timestamps. At compile time, reject a workflow that writes a transition with a timestamp expression that could precede the prior transition, and reject mutation (rather than append) of history. Corrections must be new superseding entries.
**Error message should say:** `"Line N: This step records a Commitment transition dated before the previous transition on the same commitment. History is append-only and time must not move backward — record a correcting entry that supersedes the previous one instead (Invariant 4: Temporal Integrity)."`
**Priority:** P2 (P1 once transition types land)

### Invariant 5 — Identity Permanence
**Current compiler support:** Partial
**Gap:** `OrderID`/`CustomerID` are unique-by-construction validated newtypes, and the node registry rejects duplicate node ids — so *format/local* uniqueness has some coverage. But there is no `CommitmentID`/`PartyID`/`ValueID`/`IntentID`/`FulfillmentID`, and nothing enforces that these are never *reused* across the system or that a platform's native order id maps to exactly one `CommitmentID` and never re-maps.
**Required check:** Add the five model ID newtypes. Enforce (at the boundary that admits external ids) a stable one-to-one `OrderID → CommitmentID` mapping established at creation and never changed; reject any workflow/adapter step that would re-map an existing native id to a new `CommitmentID` or reuse a retired id.
**Error message should say:** `"Line N: Native order id 'shopify-1099' is already mapped to Commitment 'cmt_abc'; it cannot be re-mapped to a new Commitment. Each native id maps to exactly one CommitmentID for life (Invariant 5: Identity Permanence)."`
**Priority:** P2

### Invariant 6 — Commitment Tree Consistency
**Current compiler support:** None
**Gap:** No `Commitment` type and therefore no `parent`/`children` relationship, so the compiler cannot verify that the sum of child `subject.requested` values (in base currency) equals the parent's. Multi-vendor carts (the `vendor_count`-driven fan-out that `CartState` already anticipates) are precisely the parent/child case this invariant governs.
**Required check:** Once `Commitment` with `parent`/`children` exists, verify that for any parent the sum of children's `subject.requested` Money (converted to a common base currency via explicit `CurrencyConversion`) equals the parent's `subject.requested`, and that a child `Modified`/`Cancelled` triggers a parent recalculation. Reject a constructed tree whose children do not sum to the parent.
**Error message should say:** `"Line N: Child commitments sum to 740 MAD but the parent commitment's requested total is 750 MAD. A parent must always equal the sum of its children in the base currency — recalculate after the substitution (Invariant 6: Commitment Tree Consistency)."`
**Priority:** P2 (P1 once multi-vendor parent/child commitments are built)

**Section 6 summary:** 0 of 6 invariants have full compiler support; 1
(Identity Permanence) has partial support via validated newtypes and the
duplicate-id registry check. The other 5 are entirely unimplemented, and 3
of them (I-1, I-2, I-3, I-6) cannot even be *started* until their underlying
model types (`Value`, `CommitmentState`, `Capacity`, `Commitment` tree) exist
— which is the dependency that makes Section 4 (Missing Types) the gating
work for the next session.

---

## Audit totals

- **CORRECT:** 11 types (1 model-derived + 4 implementation details + 6 correctly-outside-the-model)
- **NEEDS_REVISION:** 10 types
- **MISSING:** 40 model types/concepts (P1: 19, P2: 13, P3: 8)
- **Compiler invariant gaps:** 6 of 6 (5 none, 1 partial)

The shape of the work: the existing types are a sound *surface* (money,
phone, identity, marketing) but the model's *spine* — Party, Intent,
Commitment, Fulfillment, Value, and the state machines and histories that
make the six invariants enforceable — is almost entirely Category 3. The
next session's order is fixed by dependency: land the P1 primitives and
their state/transition types first (they unblock Invariants 2, 3, and the two
real commerce nodes), then the P1 ID and history types (Invariants 4, 5, 6),
then the Category 2 revisions that re-home the existing surface types onto the
new primitives.

---

*This document is the specification for the type-system rebuild in the next*
*engineering session. It changes no Rust code. Audited against*
*WARP_COMMERCE_MODEL v0.2 on 2026-06-08.*
