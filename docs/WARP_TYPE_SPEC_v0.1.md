# Warp Commerce Type Specification v0.1

**Status: Draft — not yet stable.** Surface area may change in minor
revisions without notice; breaking changes will bump the major. v1.0
will be declared only when two independent implementations exist
(see [Versioning](#versioning) below).

---

## Introduction

Warp's commerce types are the language other systems implement against
when they say "Warp-compatible." They are not data classes; they are
a contract.

Other workflow runtimes ship `String`, `Number`, and `Object` as their
universal primitives and let merchants discover at runtime — on a live
order, with a real customer — that they confused MAD for EUR, or wired
a label into a phone-number slot, or fed an order id where a customer
id was expected. Warp refuses that bargain. Every commerce concept
gets its own type, every wrong wire fails at compile time, and every
error message names the fix in commerce language rather than Rust
language.

The closest analogy is SQL: PostgreSQL doesn't accept a string where
an INTEGER column is declared, and it doesn't accept rows from one
table claiming to belong to another. The commerce types in this spec
play the same role for commerce workflows.

**Compiler enforcement.** The Warp compiler type-checks every workflow
before it can be installed against a tenant, returning a [`CompileError`]
that names the line and the violation. The six commerce invariants are
enforced to different degrees today:

- **I-3 Capacity Verification**, **I-4 Temporal Integrity**, **I-5 Identity
  Permanence** — enforced at compile time; a violation blocks compilation.
- **I-6 Commitment Tree Consistency** — partially checked (literal
  child/parent values; best-effort).
- **I-1 Value Conservation** — emits a *warning*; currency mixing compiles
  with a warning rather than blocking.
- **I-2 State Monotonicity** — not yet enforced at compile time; on the
  roadmap.

The `@warp-lang/commerce-types` npm package additionally provides runtime
validators (`auditCommerce`, `checkI*`) for these invariants.

[`CompileError`]: ../crates/warp-core/src/dsl/mod.rs

---

## Type System Principles

1. **Every commerce concept has a dedicated type.** Money, phone
   numbers, order identifiers, customer identifiers, currency codes,
   languages, channels — each is its own type, never a `String` or
   `Number`. A node that handles money declares `Currency`; a node
   that addresses a customer declares `PhoneNumber`. A `String` slot
   means "free text" — never money, never a phone, never an id.
2. **Wrong types fail at compile time, never at runtime.** Wiring a
   `String` to a `PhoneNumber` input is a `CompileError` that names
   the slot and suggests `PhoneNumber::parse(…)`. There is no runtime
   path that downgrades a typed slot to "accept anything."
3. **Types are portable — same type, any platform.** A `CartState`
   that comes from a Shopify webhook is the same `CartState` that
   comes from an Agora native event. Adapters translate at the
   boundary; downstream nodes never see platform-specific shapes.
4. **Error messages speak commerce, not Rust.** A failure reads
   "Cannot operate on mixed currencies: MAD and EUR. Use convert_to()
   first." — not `expected CurrencyCode::EUR, found CurrencyCode::MAD`.
   The compiler is the user's ally (P-2).

---

## Core Types

### Currency

**Definition.** A monetary value with its currency code attached.

The implementation type is `Currency { amount: Decimal, code: CurrencyCode }`
([source]). Amounts are exact-precision decimals (no floating-point
drift on money). Currency codes are the closed set `MAD | EUR | USD`
in v0.1 — additional codes land per merchant demand, not
speculatively.

[source]: ../crates/warp-core/src/types/commerce.rs

**Invariants.**

- Two `Currency` values cannot be combined unless their `CurrencyCode`s
  match. `Currency::mad(100).add(Currency::eur(20))` returns
  `CurrencyError::MixedCurrencies`. There is no implicit conversion.
- All arithmetic uses `rust_decimal::Decimal` — exact, no rounding
  drift. `Currency::mad(0.1) + Currency::mad(0.2)` is exactly
  `Currency::mad(0.3)`, not `0.30000000000000004`.
- Conversion between currencies is explicit and carries a rate.
  `Currency::mad(1000).convert_to(EUR, 0.092)` ≈ `Currency::eur(92)`.
  There is no built-in FX oracle; callers (typically nodes that wrap
  an FX adapter) pass the rate they were quoted.

**Construction.**

```rust
Currency::mad(580)             // MAD 580.00
Currency::eur(20)              // EUR 20.00
Currency::usd(Decimal::from_str("19.99").unwrap())
```

In `.warp` source, written as a first-class literal:

```text
min_value: Currency(200, MAD)
```

**Error cases.**

- `CurrencyError::MixedCurrencies { left, right }` — surfaces from
  `add()`, `is_at_least()`, and `CartState::total()` whenever two
  values disagree on `code`. The Display message names both codes and
  points the caller at `convert_to()`.

**Display format.** `"{amount:.2} {code}"`, e.g. `"580.00 MAD"`.

**Serialization format (JSON).**

```json
{ "amount": "580.00", "code": "MAD" }
```

The amount is serialized as a string (via `rust_decimal::serde::str`)
to preserve precision across systems whose JSON numbers are 64-bit
floats.

---

### PhoneNumber

**Definition.** An E.164-formatted phone number with a
WhatsApp-routable flag.

**Invariants.**

- The internal E.164 string is private; the only path to obtain a
  `PhoneNumber` is `PhoneNumber::parse(raw)`.
- E.164 shape: leading `+`, then 7–15 ASCII digits, no spaces, no
  dashes, no parentheses.
- `whatsapp_routable` is `false` on construction; flipped to `true`
  by `with_whatsapp()`, which the WhatsApp adapter calls after a
  Business API check confirms the number is reachable. A consumer
  that requires WhatsApp reachability should branch on this flag.

**Construction.**

```rust
let phone = PhoneNumber::parse("+212661234567")?;
let phone_with_wa = phone.with_whatsapp();
```

**Error cases.**

- `PhoneNumberError::InvalidFormat(raw)` — raw string did not satisfy
  the E.164 shape. The Display message echoes the rejected input so
  operators can grep webhook logs.

**Display format.** `"+212661234567"` (the raw E.164 string).

**Serialization format (JSON).**

```json
{ "e164": "+212661234567", "whatsapp_routable": false }
```

---

### OrderID

**Definition.** A validated order identifier.

**Invariants.**

- Non-empty.
- Maximum 128 characters.
- Allowed character set: ASCII alphanumeric, hyphen (`-`),
  underscore (`_`). No spaces, no quotes, no slashes.
- `OrderID` is a distinct type from `CustomerID`; passing one where
  the other is expected fails at compile time (see
  [`OrderID` doctest][orderid-doctest]).

[orderid-doctest]: ../crates/warp-core/src/types/commerce.rs

**Platform namespacing convention.** Every adapter prefixes its raw
platform id with the platform short-name before constructing the
`OrderID`, so dashboards know which platform every id came from at
a glance:

| Platform     | Prefix         | Example                          |
|--------------|----------------|----------------------------------|
| Shopify      | `shopify_`     | `shopify_820982911946154500`     |
| WooCommerce  | `wc_`          | `wc_1234`                        |
| OpenCart     | (store-native) | `ord_2026_001`                   |
| Agora        | `agora_`       | `agora_order_42`                 |
| Odoo         | `odoo_`        | `odoo_1234`                      |

The prefix is enforced at the adapter boundary, not by the type. The
type rejects invalid characters; the namespacing convention is
operational discipline.

**Construction.**

```rust
let id = OrderID::new("shopify_820982911946154500")?;
```

**Error cases.**

- `OrderIDError::Empty`
- `OrderIDError::TooLong(raw)` — over 128 chars.
- `OrderIDError::InvalidChars(raw)` — contains a character outside
  the allowed set.

**Display format.** The raw string, unmodified.

**Serialization format (JSON).** Bare string: `"shopify_820982911946154500"`.

---

### CustomerID

**Definition.** A validated customer identifier.

**Invariants.** Identical to `OrderID` — non-empty, ≤128 chars,
alphanumeric + `-` + `_`. The distinction lives at the type level:

```rust
fn accepts_customer_id(_id: CustomerID) { /* … */ }
let order_id = OrderID::new("ord_123").unwrap();
accepts_customer_id(order_id);  // <- compile error
```

Adapters namespace customer ids the same way they namespace order
ids: `shopify_customer_207119551`, `wc_customer_55`.

**Construction.**

```rust
let cust = CustomerID::new("shopify_customer_207119551")?;
```

**Error cases.** `CustomerIDError::{Empty, TooLong, InvalidChars}` —
same shape as `OrderIDError`.

**Display + serialization.** Bare string, same as `OrderID`.

---

### TenantId

**Definition.** Tenant-isolation key. Opaque string, compared by
value.

**Invariants.**

- Used as the prefix of every Restate workflow key:
  `"{tenant_id}:{primary}"` where `primary` is the session id (cart
  workflows), order id (order workflows), or analogous per-invocation
  identifier. The function [`tenant_workflow_key`] constructs the
  composite; [`assert_tenant_key`] checks at the top of every
  tenant-scoped workflow body that the URL-supplied Restate key
  matches the input's claimed tenant.
- Used as the Postgres RLS scope (`set_config('app.tenant_id', …)`).
  Every connection in `warp-storage` is bound to one `TenantId` for
  its lifetime; cross-tenant reads return zero rows by policy, not by
  application convention.

[`tenant_workflow_key`]: ../crates/warp-core/src/types/commerce.rs
[`assert_tenant_key`]: ../crates/warp-core/src/types/commerce.rs

**Construction.**

```rust
let t = TenantId::new("tenant_aimer_prod_001");
```

**Display format.** The raw string.

**Serialization format (JSON).** Bare string: `"tenant_aimer_prod_001"`.

---

### CustomerProfile

**Definition.** The unified customer record ACP returns. The phone
field is typed `PhoneNumber` — a node that calls
`profile.phone` into a `WhatsAppSend.to` slot is automatically
type-safe because both sides are `PhoneNumber`. ACP's adapter
re-parses the upstream phone string through `PhoneNumber::parse` at
the boundary, so a malformed phone from a misconfigured customer
record fails fast.

**Fields.**

| Field              | Type             | Required |
|--------------------|------------------|----------|
| `customer_id`      | `String`         | yes      |
| `phone`            | `PhoneNumber`    | yes      |
| `language`         | `Language`       | yes      |
| `preferred_channel`| `Channel`        | yes      |
| `email`            | `Option<String>` | no       |
| `name`             | `Option<String>` | no       |

**Notes.**

- `customer_id` is `String` here (not `CustomerID`) because v0.1's
  ACP boundary returns a free-form id. v0.2 will tighten this to
  `CustomerID` once every ACP adapter validates upstream.
- `preferred_channel` carries the customer's setting; ACP's
  `StrategyRecommendation` may suggest overriding it per message.

**Serialization format (JSON).**

```json
{
  "customer_id": "cust_001",
  "phone": { "e164": "+212661234567", "whatsapp_routable": true },
  "language": "Arabic",
  "preferred_channel": "WhatsApp",
  "email": "customer@example.com",
  "name": "Customer Name"
}
```

---

### CartState

**Definition.** The live cart for a customer at a point in time.

**Fields.**

| Field          | Type                 | Notes                                       |
|----------------|----------------------|---------------------------------------------|
| `cart_id`      | `String`             | session-scoped cart handle                  |
| `customer_id`  | `CustomerID`         | typed — distinct from order id              |
| `items`        | `Vec<CartItem>`      | line items; `total()` re-sums these         |
| `subtotal`     | `Currency`           | what the merchant's checkout reported       |
| `currency`     | `CurrencyCode`       | the cart's nominal currency                 |
| `vendor_ids`   | `Vec<String>`        | distinct vendor handles touched by the cart |

**`CartItem`.**

| Field        | Type       |
|--------------|------------|
| `product_id` | `String`   |
| `name`       | `String`   |
| `quantity`   | `u32`      |
| `unit_price` | `Currency` |
| `vendor_id`  | `String`   |

**Methods.**

- `total() -> Result<Currency, CurrencyError>` — sums `unit_price *
  quantity` across all items. Returns `CurrencyError::MixedCurrencies`
  if any two items disagree on `code`. The C-01 contract for money
  holds *inside* the cart, not just on its boundaries — a
  multi-currency cart snapshot is a data bug and the type surfaces
  it loudly.
- `item_count() -> u32` — sum of quantities (not number of distinct
  SKUs).
- `vendor_count() -> usize` — number of distinct vendor handles
  represented. Multi-vendor carts get split per-vendor for
  fulfillment; this number drives the fan-out factor downstream.

**Why `subtotal` and `total()` can diverge.** Many checkouts apply
discounts or store credit to the merchant-reported subtotal; the
line items don't know about that adjustment. `total()` is what the
line items add to; `subtotal` is what the merchant's checkout said
the customer owed.

---

### Language

**Definition.** Closed set of languages Warp's communication nodes
can speak.

**Variants.** `Arabic | French | English | Darija`.

**Notes.**

- Darija is first-class. Darija routes to LaudioLabs STT pipelines in
  the audio nodes (Phase 3) and to Darija-specific WhatsApp templates
  in the communication nodes (today).
- Adding a variant is a deliberate cross-cutting decision because
  every template selector branches on this — `Language` is enum, not
  string, on purpose.

**Display format.** Title case English (`"Arabic"`, `"French"`,
`"English"`, `"Darija"`) — same as the enum variant names.

**Serialization format (JSON).** `"arabic" | "french" | "english" |
"darija"` (snake_case via serde).

---

### Channel

**Definition.** Closed set of outbound channels Warp can reach a
customer on.

**Variants.** `WhatsApp | FCM | Email | SMS`.

Used by `CustomerProfile.preferred_channel` (what the customer prefers)
and by `StrategyRecommendation.recommended_channel` (what ACP thinks
should override the preference for the next message).

**Display format.** `"WhatsApp" | "FCM" | "Email" | "SMS"`.

**Serialization format (JSON).** `"whatsapp" | "fcm" | "email" |
"sms"` (snake_case via serde).

---

### Platform

**Definition.** The commerce platform that produced an event.

**Variants.** `Agora | Shopify | WooCommerce | OpenCart | Magento | Odoo`.

The `Odoo` variant landed in Phase 2 session 8 alongside Warp's
first ERP adapter — `sale.order.created` / `sale.order.cancelled`
webhooks translate to `OrderPlacedInput` / `CartAbandonedInput`
with the `odoo_` namespace prefix on every identifier.

Tag carried by every typed trigger event so downstream nodes can
branch on the source (Shopify and Agora differ on WhatsApp opt-in
semantics, for example) and dashboards can attribute outcomes by
platform.

`Platform` is closed at the type level so adapters cannot drift —
adding "Wix" requires a Warp release, not a customer-side hack.

---

### Occasion

**Definition.** A customer-facing commerce occasion that campaigns
may anchor on. MENA-first vocabulary: Eid and Ramadan are
first-class enum variants, not free-text strings.

**Variants.**

```
Occasion ::=
  | "Birthday"
  | "Anniversary"           ; merchant-relationship anniversary
  | "Eid"                   ; covers Al-Fitr and Al-Adha
  | "Ramadan"               ; campaign anchor — start of Ramadan
  | "MothersDay"
  | "ValentinesDay"
  | "WeddingAnniversary"    ; customer's own wedding anniversary
  | Custom(string)          ; merchant-defined escape hatch
```

`Custom` carries a free-form string (recommended: `lowercase_with_underscores`)
for merchant-specific occasions like `Custom("mawazine_festival")` or
`Custom("first_salon_visit")`. Closed-set variants are PascalCase tokens
on the wire.

**Wire format.**

PascalCase tag for closed-set variants, RFC 7159 tagged-enum shape
for `Custom`:

```json
"Birthday"
"Eid"
{"Custom": "mawazine_festival"}
```

**Why closed-set + Custom escape.**

Eid, Ramadan, and Valentine's Day each carry distinct campaign
templates, dashboard groupings, and ACP-side enrichment logic.
Promoting them to enum variants makes that wiring type-safe.
Anything outside the closed set is still expressible via `Custom`
without forcing every novel occasion through a Warp release.

### OccasionEvent

**Definition.** The typed event an `OccasionTrigger` emits when an
occasion is approaching for a known customer. Carries who, which
occasion, how many days out, and the calendar date.

**Fields.**

```
OccasionEvent {
  tenant_id:     TenantId
  customer_id:   CustomerID
  occasion:      Occasion
  days_until:    u32              ; 0 = today, 7 = a week away
  occasion_date: string           ; ISO 8601 date, e.g. "2026-06-15"
}
```

**Wire format.**

```json
{
  "tenant_id": "tenant_aimer",
  "customer_id": "cust_001",
  "occasion": "Birthday",
  "days_until": 7,
  "occasion_date": "2026-06-15"
}
```

`days_until` is non-negative: past-occasion firings are not modeled
at the event shape. A calendar lookup that returns a past date
either skips the customer or rolls forward to the next year.

### SegmentCriteria

**Definition.** Optional-only criteria a `CustomerSegment` node
filters by. Every field is `Option<T>`: a `SegmentCriteria::default()`
matches every customer in the input list; each `Some(_)` tightens.

**Fields.**

```
SegmentCriteria {
  min_order_count:           Option<u32>
  min_total_spent_mad:       Option<u64>      ; whole MAD
  language:                  Option<Language>
  last_purchase_within_days: Option<u32>
  has_whatsapp_consent:      Option<bool>
}
```

**Wire format.**

```json
{
  "min_order_count": 2,
  "min_total_spent_mad": 500,
  "language": "Arabic",
  "last_purchase_within_days": 90,
  "has_whatsapp_consent": true
}
```

`min_total_spent_mad` is denominated in whole MAD (not minor units)
to keep the merchant-facing canvas display ergonomic (`MAD 500`,
not `50000`).

### CampaignAudience

**Definition.** The typed audience a `CampaignFanOut` node accepts.
Carries the customer-id list AND the criteria that produced it, so
dashboards can answer "this campaign reached N customers — why?".

**Fields.**

```
CampaignAudience {
  tenant_id:  TenantId
  customers:  Vec<string>          ; customer ids (not full profiles)
  criteria:   SegmentCriteria      ; the filter that produced this list
  label:      Option<string>       ; human display name
}
```

**Wire format.**

```json
{
  "tenant_id": "tenant_aimer",
  "customers": ["cust_001", "cust_002"],
  "criteria": {"min_order_count": 2},
  "label": "Eid 2026 — Casablanca repeat buyers"
}
```

`customers` is `Vec<String>` (not `Vec<CustomerProfile>`) so the
audience is cheap to pass between nodes. The fan-out node hydrates
each id into a profile right before the per-customer send via
parallel `RecipientContact` entries.

### ABTestVariant

**Definition.** Cohort identifier emitted by `ABTestRoute`. Two-way
split; multi-arm experiments are deferred to Phase 4.

**Variants.** `A | B`

**Wire format.**

```json
"A"
"B"
```

The variant is deterministic by construction — the same
`(experiment_id, customer_id)` pair always produces the same
variant via SHA-256-keyed hash. Replay-safe; no per-call RNG.

---

## Adapter Contract

Any system that emits Warp-typed events must:

1. **Namespace platform-native identifiers.** Prefix order ids and
   customer ids with the platform name (`shopify_…`, `wc_customer_…`)
   at the adapter boundary so cross-platform dashboards can attribute
   every row to a source.
2. **Validate monetary amounts into `Currency` before emission.** A
   bad amount must fail at the adapter, not deep in a workflow seven
   steps later. The adapter parses, the workflow trusts.
3. **Validate phone numbers into `PhoneNumber` before emission.** A
   raw string can ride on a `String` slot; nothing typed as
   `PhoneNumber` may carry one.
4. **Include `tenant_id` on every event.** Adapters in v0.1 accept
   `tenant_id` on the envelope as a stop-gap; per-tenant webhook URLs
   with header-based tenancy land in a later spec revision (ADR-0003).
   Either way, no event leaves the adapter without a `TenantId`.
5. **Use ISO 8601 for all timestamps.** Adapters whose upstream uses
   other formats (e.g. OpenCart's `YYYY-MM-DD HH:MM:SS`) translate at
   the boundary. Workflows never re-format.

A `Platform` variant must exist for an adapter; do not invent values
client-side. Add the variant first (Warp release), ship the adapter
second.

---

## Versioning

This spec follows semver.

- **Major** bumps for breaking changes — removed fields, narrowed
  invariants, renamed variants, changed serialization formats. A v1
  consumer must not be able to read a v2 emitter.
- **Minor** bumps for additive changes — new optional fields on
  existing types, new enum variants on extensible enums (none today;
  Currency / Language / Channel / Platform are all closed in v0.1),
  new sibling types.
- **Patch** bumps for documentation fixes that do not change the
  surface — clearer prose, fixed examples, corrected serialization
  snippets.

**v0.x is unstable.** Minor bumps may include breaking changes during
v0; pin against an exact version in adapter contracts. v1.0 will be
declared only when two independent implementations exist (a Warp
runtime + a second-party tool that produces or consumes typed
events) — the public commitment line, not a marketing goalpost.

---

## Out of scope in v0.1

These types are named in [CLAUDE.md] but not yet shipped:

- `DeliveryWindow` — date range with timezone, validated against
  delivery areas.
- `CampaignAudience` — `List<CustomerProfile>` with segment metadata.
- `VendorDraft` — product submission with enrichment state machine.
- `SKU` — product identifier with catalog validation.

Each will land with the first node that needs it. Until then, the
relevant fields are `Option<String>` on the adapter surface and free
text in the workflow.

[CLAUDE.md]: ../CLAUDE.md
