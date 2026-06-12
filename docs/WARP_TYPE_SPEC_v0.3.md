# Warp Commerce Type Specification v0.3

**Status: Draft — still v0.x.** Surface area may change in minor
revisions; breaking changes will bump the major. v1.0 will be declared
only when two independent implementations exist (see
[Versioning](#versioning) below).

**Supersedes:** [v0.2](WARP_TYPE_SPEC_v0.2.md). v0.3 reconciles the
spec with the Phase 3 session 8 runtime implementation. Three types
change shape — `Occasion`, `SegmentCriteria`, `ABTestVariant` — and
no others. The serialization convention `Occasion` follows is
codified (snake_case), and `Custom(String)` is introduced as the
merchant escape hatch on `Occasion`. No new sections are added; no
v0.2 invariant is relaxed. Runtime and spec are now in agreement.
The full delta is in the [Changelog](#changelog).

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

## Serialization Conventions

The live ACP integration on 2026-05-28 surfaced inconsistent casing
between Warp's PascalCase Rust enum variants and ACP's lowercase JSON
tokens. v0.2 codifies the contract that resolved that mismatch.

**All enum variants serialize to lowercase strings.** Currency codes
are the one exception (they are uppercase by ISO convention):

| Type                | Variant                    | JSON output     |
|---------------------|----------------------------|-----------------|
| `Language`          | `Language::French`         | `"french"`      |
| `Language`          | `Language::Arabic`         | `"arabic"`      |
| `Language`          | `Language::English`        | `"english"`     |
| `Language`          | `Language::Darija`         | `"darija"`      |
| `Channel`           | `Channel::WhatsApp`        | `"whatsapp"`    |
| `Channel`           | `Channel::Email`           | `"email"`       |
| `Channel`           | `Channel::SMS`             | `"sms"`         |
| `Channel`           | `Channel::FCM`             | `"fcm"`         |
| `CurrencyCode`      | `CurrencyCode::MAD`        | `"MAD"`         |
| `CurrencyCode`      | `CurrencyCode::EUR`        | `"EUR"`         |
| `CurrencyCode`      | `CurrencyCode::USD`        | `"USD"`         |
| `Platform`          | `Platform::Shopify`        | `"shopify"`     |
| `Platform`          | `Platform::Agora`          | `"agora"`       |
| `Occasion`          | `Occasion::Birthday`       | `"birthday"`             |
| `Occasion`          | `Occasion::Anniversary`    | `"anniversary"`          |
| `Occasion`          | `Occasion::Eid`            | `"eid"`                  |
| `Occasion`          | `Occasion::Ramadan`        | `"ramadan"`              |
| `Occasion`          | `Occasion::MothersDay`     | `"mothers_day"`          |
| `Occasion`          | `Occasion::ValentinesDay`  | `"valentines_day"`       |
| `Occasion`          | `Occasion::WeddingAnniversary` | `"wedding_anniversary"` |
| `Occasion`          | `Occasion::Custom("diwali")` | `{"custom": "diwali"}` |
| `ABTestVariant`     | `ABTestVariant::A`         | `"A"`                    |
| `ABTestVariant`     | `ABTestVariant::B`         | `"B"`                    |

`ABTestVariant` and currency codes preserve their canonical case
because both are single-letter or three-letter identifiers whose
case is conventional outside Warp (`A/B` testing literature, ISO 4217).

**Parsers must be case-insensitive on input.** A `Language` parser
accepts all of `"French"`, `"FRENCH"`, `"french"`, `"FrEnCh"` and
yields `Language::French`. A `Channel` parser accepts `"WhatsApp"`,
`"WHATSAPP"`, `"whatsapp"`. Adapters MAY pass through upstream
casing; Warp normalizes on input and always emits lowercase on output.

**Rationale.** Real-world systems return inconsistent casing. ACP
emits `"french"`. Shopify emits `"en"` (a different token entirely,
mapped by the Shopify adapter to `Language::English` at the boundary).
WooCommerce emits `"en_US"`. A spec that demanded a single casing on
input would force every adapter to add a normalization step Warp
could centralize. Warp accepts any case on input and normalizes on
output; the contract is "lowercase emitted, anything accepted."

Two helpers in `acp_client.rs` (in the `warp-catalog` crate — part of
Warp's commercial distribution, not included in this open-source repository)
demonstrate the boundary pattern:
`parse_acp_language(&str) -> Language` and
`parse_acp_channel(&str) -> Channel`. Both fall back to a safe default
(`French` / `WhatsApp`) with a `tracing::warn!` on unknown values —
never panic.

---

## Core Types

### Currency

**Definition.** A monetary value with its currency code attached.

The implementation type is `Currency { amount: Decimal, code: CurrencyCode }`
([source]). Amounts are exact-precision decimals (no floating-point
drift on money). Currency codes are the closed set `MAD | EUR | USD`
in v0.2 — additional codes land per merchant demand, not
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
floats. Currency codes serialize in uppercase per ISO 4217 — see
[Serialization Conventions](#serialization-conventions).

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

#### Adapter Normalization Contract for PhoneNumber

**New in v0.2.** Real-world adapters never see E.164 on the wire.
Shopify emits `"0612345678"`. WooCommerce emits `"06 12 34 56 78"`.
Some upstreams emit `"+212600000000"` (already E.164, normalized
upstream). A type that accepts only E.164 will reject most real
merchant data unless adapters normalize first.

**Adapters MUST normalize phone numbers to E.164 before constructing
a `PhoneNumber`.** Raw local formats are not valid input to
`PhoneNumber::parse`. The normalization step lives in the adapter,
not in the type — `PhoneNumber::parse` is the second line of defense
and the contract gatekeeper, never the normalizer.

**Morocco normalization rules** (the home-country reference; other
countries follow the same shape):

| Raw input         | Normalized form  | Notes                                  |
|-------------------|------------------|----------------------------------------|
| `"06XXXXXXXX"`    | `"+2126XXXXXXXX"` | strip leading `0`, prepend `+212`     |
| `"07XXXXXXXX"`    | `"+2127XXXXXXXX"` | strip leading `0`, prepend `+212`     |
| `"212XXXXXXXXX"`  | `"+212XXXXXXXXX"` | prepend `+`                            |
| `"+212XXXXXXXXX"` | `"+212XXXXXXXXX"` | pass through unchanged                 |
| `" 06 XX XX XX XX "` | normalize then `"+2126XXXXXXXX"` | strip whitespace before applying rules |
| `""` or `null`    | (do not construct) | use `Option::None` upstream          |

**On unparseable input.** If normalization produces a value that
`PhoneNumber::parse` still rejects:

1. **Log a warning** with the raw value (`tracing::warn!`) so operators
   can grep webhook logs and trace the offending record.
2. **Use a fallback or `None`** — emit the surrounding event with the
   phone field absent, never with an unnormalized string.
3. **Never panic.** A malformed phone from one customer must not take
   down the adapter for every other customer.
4. **Never pass an unnormalized phone to a `PhoneNumber` field.**
   Bypassing this contract surfaces as a runtime parse error deep
   inside a workflow; the type system's value is destroyed if
   adapters bypass the contract.

The adapter normalization contract complements the five-rule adapter
contract in [Adapter Contract](#adapter-contract) below — it is rule
3 ("Validate phone numbers into PhoneNumber before emission") spelled
out in operational detail.

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

- `customer_id` is `String` here (not `CustomerID`) because the ACP
  boundary returns a free-form id. A future revision will tighten
  this to `CustomerID` once every ACP adapter validates upstream.
- `preferred_channel` carries the customer's setting; ACP's
  `StrategyRecommendation` may suggest overriding it per message.
- Nullable-field semantics are normative — see
  [Nullable Fields — Semantic Meaning](#nullable-fields--semantic-meaning).

**Serialization format (JSON).**

```json
{
  "customer_id": "cust_001",
  "phone": { "e164": "+212661234567", "whatsapp_routable": true },
  "language": "arabic",
  "preferred_channel": "whatsapp",
  "email": "customer@example.com",
  "name": "Customer Name"
}
```

---

### StrategyRecommendation

**Definition.** What `ACPEvaluateStrategy` returns: a typed offer
recommendation for the next outbound message.

**Fields.**

| Field                  | Type               | Notes                                                  |
|------------------------|--------------------|--------------------------------------------------------|
| `discount_code`        | `Option<String>`   | `None` means "no discount" — see below                 |
| `confidence`           | `f32`              | `0.0..=1.0`, inclusive on both ends                    |
| `rationale`            | `String`           | human-readable trace (e.g. `"matched_rule: …"`)        |
| `recommended_channel`  | `Channel`          | what ACP thinks should override `preferred_channel`    |
| `recommended_products` | `Vec<String>`      | optional upsell SKUs; empty `Vec` when none            |

**The offer branch invariant** is the cross-field rule the live ACP
integration surfaced. It is spelled out in its own section below:
[The Offer Branch Invariant](#the-offer-branch-invariant).

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
`"English"`, `"Darija"`) — same as the enum variant names. The Rust
`Display` impl keeps PascalCase for human-readable logs; serialization
is separate.

**Serialization format (JSON).** Lowercase, per
[Serialization Conventions](#serialization-conventions):
`"arabic" | "french" | "english" | "darija"`. Parsers are
case-insensitive on input.

---

### Channel

**Definition.** Closed set of outbound channels Warp can reach a
customer on.

**Variants.** `WhatsApp | FCM | Email | SMS`.

Used by `CustomerProfile.preferred_channel` (what the customer prefers)
and by `StrategyRecommendation.recommended_channel` (what ACP thinks
should override the preference for the next message).

**Display format.** `"WhatsApp" | "FCM" | "Email" | "SMS"` (PascalCase
in human-readable logs).

**Serialization format (JSON).** Lowercase, per
[Serialization Conventions](#serialization-conventions):
`"whatsapp" | "fcm" | "email" | "sms"`. Parsers are case-insensitive
on input.

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

**Serialization format (JSON).** Lowercase: `"agora" | "shopify" |
"woocommerce" | "opencart" | "magento" | "odoo"`.

---

### Occasion *(updated in v0.3)*

**Definition.** A closed set of marketing-relevant occasions Warp's
campaign nodes branch on. Occasion-aware templates exist for
abandoned-cart, post-purchase, occasion-anchored, and re-engagement
workflows; the `Occasion` enum is what selects them. The MENA-first
posture is intentional — Eid and Ramadan are first-class variants,
not generic "holiday" tags.

**Variants.** `Birthday | Anniversary | Eid | Ramadan | MothersDay |
ValentinesDay | WeddingAnniversary | Custom(String)`.

**v0.2 → v0.3 delta.**

- **Added:** `Birthday`, `Anniversary`, `ValentinesDay`,
  `WeddingAnniversary`, `Custom(String)`.
- **Removed:** `BlackFriday`, `BackToSchool`, `NewYear`, `None`.
  None of the removed variants are MENA-relevant retail moments;
  `None` is replaced by `Option<Occasion>` at field sites where
  absence-of-tag matters.

**Notes.**

- The gifting vertical (the first wave of Warp merchants) anchors
  every campaign on a person-to-person occasion: birthdays,
  anniversaries, Eid, weddings, Valentine's, Mother's Day. The
  variant set reflects that vocabulary directly.
- `Custom(String)` is the per-merchant escape hatch. A beauty shop's
  "first salon visit" anniversary, a music store's "Mawazine festival
  weekend," or any merchant-specific date that doesn't belong in the
  closed set rides through `Custom("mawazine_festival")`. The carried
  string is convention-free but `lowercase_with_underscores` is
  recommended so it round-trips cleanly through dashboards.
- The compiler still treats `Occasion` as a closed sum type — adding
  `Birthday2` requires a Warp release. `Custom` is the only growth
  surface.

**Display format.** PascalCase variant names in logs:
`Birthday | Anniversary | Eid | Ramadan | MothersDay | ValentinesDay |
WeddingAnniversary | Custom(<string>)`. The PascalCase Display is for
human-facing log lines and Restate keys; the snake_case form below
is for JSON wires.

**Serialization format (JSON).** snake_case strings for closed-set
variants; externally-tagged object for `Custom`:

```json
"birthday"
"anniversary"
"eid"
"ramadan"
"mothers_day"
"valentines_day"
"wedding_anniversary"
{"custom": "mawazine_festival"}
```

The `Custom` object form is `serde`'s default external-tag
representation for tuple variants — the variant name (snake_cased)
is the single key, the carried string is the value. Parsers MUST
accept this exact shape.

---

### SegmentCriteria *(updated in v0.3)*

**Definition.** The typed predicate `CustomerSegment` evaluates over
a list of customer ids + per-customer attributes to produce a
`CampaignAudience`.

**Fields.**

| Field                       | Type                | Notes                                            |
|-----------------------------|---------------------|--------------------------------------------------|
| `min_order_count`           | `Option<u32>`       | exclude customers with fewer than N orders       |
| `min_total_spent_mad`       | `Option<u64>`       | MAD whole units; exclude below this lifetime spend |
| `language`                  | `Option<Language>`  | filter to a single language                      |
| `last_purchase_within_days` | `Option<u32>`       | exclude customers whose last purchase is older   |
| `has_whatsapp_consent`      | `Option<bool>`      | filter to consenting customers                   |

**v0.2 → v0.3 delta.**

- **Renamed:** `min_purchases` → `min_order_count` (matches the
  `order_count` attribute on `CustomerAttributes`).
- **Type narrowed:** `min_total_spend: Option<Currency>` →
  `min_total_spent_mad: Option<u64>`. Currency-typed comparison is
  deferred to Phase 4 when `warp-storage` direct queries against the
  customer table are available — at that point the predicate engine
  will get its currency normalization step. Phase 3 ships MAD-only
  comparisons; this is the explicit scope cut.
- **Type narrowed:** `languages: Vec<Language>` → `language:
  Option<Language>`. Multi-language filtering is Phase 4 (an
  `OR`-composition over multiple `CustomerSegment` nodes covers the
  Phase 3 use case).
- **Removed:** `preferred_channels: Vec<Channel>`. Channel routing
  is the campaign node's concern (`CampaignFanOut` dispatches per
  the recipient's contact channel), not a segmentation criterion.
- **Removed:** `occasion: Option<Occasion>`. Occasion is the
  trigger's anchor, not a customer attribute. Occasion-driven
  segmentation is done upstream by `OccasionTrigger` selecting which
  customers to enter the workflow.
- **Added:** `last_purchase_within_days: Option<u32>` and
  `has_whatsapp_consent: Option<bool>`, the two highest-demand
  fields from the merchant outreach work (the pricing pilots wanted
  "active customers" and "consented customers" as one-click filters).

**Invariants.**

- An empty `SegmentCriteria` (all fields `None`) matches every
  customer. The composition is AND across fields; OR-composition is
  done upstream (multiple `CustomerSegment` invocations).
- `min_total_spent_mad` is denominated in **whole MAD units**, not
  minor units. A merchant-facing canvas displaying `MAD 500` writes
  `min_total_spent_mad: 500`, not `50000`.

**Serialization format (JSON).**

```json
{
  "min_order_count": 2,
  "min_total_spent_mad": 500,
  "language": "arabic",
  "last_purchase_within_days": 90,
  "has_whatsapp_consent": true
}
```

Field names are snake_case per the [Serialization
Conventions](#serialization-conventions) — the predicate is JSON-
round-trippable to the same shape across Warp implementations.

---

### ABTestVariant *(updated in v0.3)*

**Definition.** The label that `ABTestRoute` assigns to a workflow
invocation so downstream nodes can branch on the assignment.

**Variants.** `A | B`.

**v0.2 → v0.3 delta.**

- **Removed:** `C` and `D`. Multi-arm experiments are deferred to
  Phase 4. Two-variant experiments cover ~95% of Phase 3 merchant use
  cases (cart-recovery template A vs B, discount amount A vs B,
  send-time morning vs evening), and the deterministic-hash routing
  shape is materially simpler with two arms.

**Invariants.**

- Variant assignment is sticky per `(experiment_id, customer_id)` —
  the same customer in the same experiment always gets the same
  variant. The shipped runtime computes the assignment as
  `SHA-256("{experiment_id}:{customer_id}")[0] <
  (variant_a_weight * 255 / 100)`, which is deterministic by
  construction (replay-safe — Restate replays land the same customer
  in the same variant; no per-call RNG, no storage write).
- The set is closed; adding `C` requires a Warp release. Phase 4
  will introduce a separate `MultiArmVariant` type rather than
  extending `ABTestVariant`, so two-arm experiments stay simple.

**Display format.** Single uppercase letter (`"A"`, `"B"`).

**Serialization format (JSON).** Single uppercase letter. The
single-letter convention follows A/B testing literature and is
preserved on the wire (see
[Serialization Conventions](#serialization-conventions)).

---

## Nullable Fields — Semantic Meaning

**New in v0.2.** Warp uses `Option<T>` only where `None` carries a
defined business meaning. Adapters and downstream workflows MUST
honour these semantics rather than treating `None` as an error to
recover from.

### `CustomerProfile.name`

**Semantic.** `None` means the platform has no name for this
customer. Many e-commerce checkouts allow guest purchases with no
name field; ACP also returns `name: null` for customers known only
by phone.

**Workflow contract.**

- Templates that interpolate `name` MUST provide a fallback. The
  cart-recovery `cart_reminder` template uses `{{name | default: "you"}}`
  semantics (or the language equivalent — `"vous"` in French, `"أنت"`
  in Arabic).
- An adapter that has a name string MUST include it. An adapter that
  doesn't MUST emit `None` — not an empty string, not the literal
  text `"null"`, not `"Customer"`.

### `CustomerProfile.email`

**Semantic.** `None` means no email on record. WhatsApp-first
customers in MENA frequently have no email field on their commerce
profile.

**Workflow contract.**

- `EmailSend` MUST branch on `Some(_)` before invoking. Attempting
  delivery without checking yields a runtime guardrail trip, never a
  silent no-op.
- A workflow that requires email delivery as its only outreach MUST
  declare that constraint and fail closed when `email` is `None`.
  Mixed-channel workflows (e.g. "WhatsApp if reachable, email
  otherwise") MUST branch explicitly.

### `StrategyRecommendation.discount_code`

**Semantic.** `None` means the strategy engine determined that no
discount is appropriate for this context. This is a **valid business
decision**, not an error.

The live ACP integration on 2026-05-28 returned `discount_code: null`
with `confidence: 1.0` and `rationale: "matched_rule:
checkout_giftwrap"` — ACP was certain the right next message was a
gift-wrap upsell, with no coupon. Treating that response as "ACP
failed to return a discount" would have sent the customer a generic
discount message instead of the gift-wrap nudge.

**Workflow contract.**

- Workflows MUST branch on `Some(_)` before rendering an offer
  template that depends on a coupon code. See
  [The Offer Branch Invariant](#the-offer-branch-invariant).
- `None` paired with `confidence == 1.0` is not a contradiction —
  high confidence in "no discount" is a real ACP outcome.

### `StrategyRecommendation.recommended_products`

**Semantic.** Empty `Vec` (not `None`) when ACP has no upsell to
suggest. v0.2 declines to model "no upsell" as `None` because the
operations on the field (`iter`, `len`, `is_empty`) work uniformly
on an empty `Vec` and avoid an `Option<Vec<_>>` unwrap in every
caller.

---

## The Offer Branch Invariant

**New in v0.2.** The cart-recovery flow has a two-message structure:
a first nudge ("you left items in your cart") and a follow-up either
*with* an offer ("here's 10% off code WARP10") or *without* ("any
questions about your cart?"). Selecting between those follow-ups is a
two-condition branch.

**The invariant.** Render the offer follow-up if and only if:

```text
send_offer = discount_code.is_some() AND confidence > threshold
```

**Both conditions must be true. Neither alone is sufficient.**

| `discount_code`  | `confidence` | `threshold` | Branch taken          |
|------------------|--------------|-------------|-----------------------|
| `Some("WARP10")` | `0.85`       | `0.7`       | **offer**             |
| `Some("WARP10")` | `0.50`       | `0.7`       | generic (low conf.)   |
| `None`           | `1.0`        | `0.7`       | generic (no coupon)   |
| `None`           | `0.50`       | `0.7`       | generic               |

**Why both checks.** The naïve shape `send_offer = confidence >
threshold` was the original cart-recovery branch through Phase 2. The
Phase 3 session 6 live run against `acp.aimer.ma` returned `confidence
= 1.0` with `discount_code = null` (the `matched_rule:
checkout_giftwrap` case), which under the naïve shape would have
rendered the `cart_offer` template with `discount_code: null` in the
params block — sending the customer a message that promised a
discount that didn't exist. The fix is the dual-condition check;
it shipped in commit `399f2ea` 2026-05-28.

This rule is normative for any v0.2-compatible implementation. A
follow-up that selects the offer template on confidence alone is not
Warp-compatible.

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
   `PhoneNumber` may carry one. Adapters MUST follow the
   [PhoneNumber normalization contract](#adapter-normalization-contract-for-phonenumber)
   — local formats are not valid input to `PhoneNumber::parse`.
4. **Include `tenant_id` on every event.** Adapters in v0.2 accept
   `tenant_id` on the envelope as a stop-gap; per-tenant webhook URLs
   with header-based tenancy land in a later spec revision (ADR-0003).
   Either way, no event leaves the adapter without a `TenantId`.
5. **Use ISO 8601 for all timestamps.** Adapters whose upstream uses
   other formats (e.g. OpenCart's `YYYY-MM-DD HH:MM:SS`) translate at
   the boundary. Workflows never re-format.

A `Platform` variant must exist for an adapter; do not invent values
client-side. Add the variant first (Warp release), ship the adapter
second.

**Implementations.** Warp ships five adapters that implement this
contract today: Agora (native event bus, no webhook), Shopify,
WooCommerce, OpenCart, and Odoo. The five reference implementations
live in `crates/warp-catalog/src/adapters/` — part of Warp's commercial
distribution, not included in this open-source repository.

---

## Versioning

This spec follows semver.

- **Major** bumps for breaking changes — removed fields, narrowed
  invariants, renamed variants, changed serialization formats. A v1
  consumer must not be able to read a v2 emitter.
- **Minor** bumps for additive changes — new optional fields on
  existing types, new enum variants on extensible enums, new sibling
  types. v0.2 was a minor bump from v0.1 (three new types, four new
  normative sections). v0.3 is a minor bump from v0.2 despite reshaping
  three v0.2 types — both versions are draft (`v0.x` is unstable);
  the breaking-change-bumps-major rule applies once v1.0 declares
  stability.
- **Patch** bumps for documentation fixes that do not change the
  surface — clearer prose, fixed examples, corrected serialization
  snippets.

**v0.x is unstable.** Minor bumps may include breaking changes during
v0; pin against an exact version in adapter contracts. v1.0 will be
declared only when two independent implementations exist (a Warp
runtime + a second-party tool that produces or consumes typed
events) — the public commitment line, not a marketing goalpost.

---

## Out of scope in v0.3

These types are named in [CLAUDE.md] but not yet given a full
normative section in this spec:

- `DeliveryWindow` — date range with timezone, validated against
  delivery areas.
- `CampaignAudience` — the typed audience `CampaignFanOut` accepts.
  **Shipped in the Phase 3 session 8 runtime** (`tenant_id`,
  `customers: Vec<String>`, `criteria: SegmentCriteria`, `label:
  Option<String>`) but its full normative section is deferred to
  v0.4 so v0.3 stays focused on the three reconciliation deltas.
  Until then, treat the runtime's shape in
  [`commerce.rs`](../crates/warp-core/src/types/commerce.rs) as the
  contract.
- `OccasionEvent` — the typed event `OccasionTrigger` emits.
  **Shipped in the Phase 3 session 8 runtime** (`tenant_id`,
  `customer_id`, `occasion`, `days_until`, `occasion_date`); full
  spec section deferred to v0.4 alongside `CampaignAudience`.
- `VendorDraft` — product submission with enrichment state machine.
- `SKU` — product identifier with catalog validation.

Each will land with the first node that needs it. Until then, the
relevant fields are `Option<String>` on the adapter surface and free
text in the workflow.

[CLAUDE.md]: ../CLAUDE.md

---

## Changelog

### v0.3 (2026-05-29)

Reconciliation release. Three v0.2 types reshape to match the Phase 3
session 8 runtime implementation; no other v0.2 surface changes.

- **`Occasion` variants updated — MENA-first gifting vocabulary.**
  - **Added:** `Birthday`, `Anniversary`, `ValentinesDay`,
    `WeddingAnniversary`, `Custom(String)`.
  - **Removed:** `BlackFriday`, `BackToSchool`, `NewYear`, `None`.
    None of the removed variants are MENA-relevant retail moments.
    `None`'s role is filled by `Option<Occasion>` at field sites.
- **`Occasion` serialization codified — snake_case (was PascalCase
  in the draft runtime).** All closed-set variants serialize as
  snake_case strings (`"birthday"`, `"mothers_day"`,
  `"wedding_anniversary"`); `Custom(value)` serializes as
  `{"custom": "<value>"}`. Brought into line with the v0.2
  Serialization Conventions table. Runtime fixed in commit
  [`dd7f5c9`](../) (`#[serde(rename_all = "snake_case")]` on
  `Occasion`); spec table updated to match.
- **`SegmentCriteria` simplified to Phase 3 implementable fields.**
  - **Renamed:** `min_purchases` → `min_order_count`.
  - **Type narrowed:** `min_total_spend: Option<Currency>` →
    `min_total_spent_mad: Option<u64>` (MAD whole units; Currency-
    typed comparison deferred to Phase 4 when `warp-storage` direct
    queries are available).
  - **Type narrowed:** `languages: Vec<Language>` → `language:
    Option<Language>` (multi-language filter deferred to Phase 4).
  - **Removed:** `preferred_channels: Vec<Channel>` (channel routing
    is `CampaignFanOut`'s concern, not segmentation).
  - **Removed:** `occasion: Option<Occasion>` (occasion is the
    trigger's anchor, not a customer attribute).
  - **Added:** `last_purchase_within_days: Option<u32>` and
    `has_whatsapp_consent: Option<bool>` (the two highest-demand
    filters from merchant outreach).
- **`ABTestVariant` narrowed to A | B (was A/B/C/D).**
  - Multi-arm experiments deferred to Phase 4 via a separate
    `MultiArmVariant` type. Two-variant experiments cover ~95% of
    Phase 3 merchant use cases.
- **`CampaignAudience` and `OccasionEvent` ship in the runtime;
  full normative spec sections deferred to v0.4.** Out-of-scope
  section names both and points at
  [`commerce.rs`](../crates/warp-core/src/types/commerce.rs) as the
  interim contract.
- **Runtime and spec now in agreement.** Goal 3 (Type Spec v1.0 —
  two independent implementations) was blocked on the v0.2-runtime
  divergence introduced in session 8; v0.3 unblocks it.

### v0.2 (2026-05-29)

- **Serialization Conventions section added.** All enum variants
  serialize to lowercase strings; currency codes and `ABTestVariant`
  preserve their canonical casing. Parsers are case-insensitive on
  input. Codifies the contract that resolved the Phase 3 session 6
  ACP-casing mismatch.
- **PhoneNumber normalization contract for adapters added.** Spells
  out the Morocco normalization rules (`06X… → +212 6X…`), the
  unparseable-input fallback (`tracing::warn!` + `None` or fallback,
  never panic), and the rule that adapters MUST normalize before
  `PhoneNumber::parse` rather than relying on the type to do it.
- **Nullable Fields — Semantic Meaning section added.** Defines what
  `None` means for `CustomerProfile.name`, `CustomerProfile.email`,
  `StrategyRecommendation.discount_code`, and
  `StrategyRecommendation.recommended_products`. Documents that
  `name: null` is real-world, `email: null` requires the workflow to
  branch, and `discount_code: null` with high confidence is a valid
  business decision (not an error).
- **Offer Branch Invariant section added.** Defines `send_offer =
  discount_code.is_some() AND confidence > threshold`. Neither
  condition alone is sufficient. Surfaced by the Phase 3 session 6
  live run against `acp.aimer.ma` returning `confidence=1.0,
  discount_code=null`; the dual-condition fix shipped in commit
  `399f2ea` 2026-05-28.
- **Occasion type added** — closed enum (`Ramadan | Eid |
  BlackFriday | NewYear | BackToSchool | MothersDay | None`),
  MENA-first defaults.
- **SegmentCriteria type added** — typed predicate for
  `CustomerSegment`. Currency-aware filters (no naked decimal spend
  thresholds).
- **ABTestVariant type added** — closed enum `A | B | C | D`, sticky
  per `(experiment_id, customer_id)`.
- **Adapter count updated.** Five platform adapters implemented:
  Agora, Shopify, WooCommerce, OpenCart, Odoo (Magento variant
  reserved; SAP S/4HANA spec'd but not yet implemented).

### v0.1 (initial)

- Initial specification.
- 10 core commerce types: `Currency`, `PhoneNumber`, `OrderID`,
  `CustomerID`, `TenantId`, `CustomerProfile`, `CartState`,
  `Language`, `Channel`, `Platform`.
- Adapter contract (5 rules).
- Versioning policy.
