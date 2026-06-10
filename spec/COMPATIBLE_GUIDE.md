# How to Make Your Platform Warp-Compatible

This document is the public guide for any commerce platform, ERP, or
intelligence layer that wants its events and actions to live in the
Warp vocabulary. It is paired with the [Warp Type
Specification](TYPE_SPEC.md) — the spec defines the types;
this guide explains how to *emit* them correctly.

If you are a platform engineer reading this, you are the audience.
Warp's merchants want to write their workflows once and run them on
any commerce backend; you make that possible by emitting events that
speak Warp's type system.

---

## What "Warp-compatible" means

A platform is Warp-compatible when its native commerce events have
been translated into Warp's typed vocabulary at the boundary. Once
that translation exists:

- Any Warp workflow runs against your platform's data — without the
  workflow knowing anything about your API.
- Any AI builder description in Arabic, French,
  English, or Darija that compiles against Warp produces a workflow
  that also runs against your platform.
- Any Warp node — `WhatsAppSend`, `ACPGetCustomerProfile`,
  `DelayFor` — can operate on data that originated in your system,
  because adapter translation ensures the typed events on the inside
  look identical to events from any other source.

In other words: **the merchant builds in Warp, you provide the
substrate.** Their workflow library is portable; their migration cost
to or from your platform is zero.

A Warp adapter is *not* a wrapper around your API. It is a typed
translator: raw platform event in, typed Warp event out.

---

## The adapter contract — five rules

Repeated here from [the type spec](TYPE_SPEC.md)
with concrete examples drawn from the five adapters that ship today
(Agora, Shopify, OpenCart, WooCommerce, Odoo). Following all five is
the minimum bar for the `Warp-compatible` badge.

### Rule 1 — Namespace platform-native identifiers

Prefix every order id and customer id with your platform short-name at
the adapter boundary, so dashboards can attribute every record to its
source without disambiguation tables.

```rust
// Shopify adapter, taken from crates/warp-catalog/src/adapters/shopify/event_bridge.rs
let order_id = OrderID::new(&format!("shopify_{}", raw_id))?;
let customer_id = CustomerID::new(&format!("shopify_customer_{}", raw_customer_id))?;
```

| Platform     | Order prefix     | Customer prefix         |
|--------------|------------------|-------------------------|
| Shopify      | `shopify_`       | `shopify_customer_`     |
| WooCommerce  | `wc_`            | `wc_customer_`          |
| OpenCart     | (store-native)   | (store-native)          |
| Agora        | `agora_`         | `agora_customer_`       |
| Odoo         | `odoo_`          | `odoo_customer_`        |

OpenCart is the exception because its merchants typically pick their
own id schemes; the OpenCart adapter accepts the store's native ids
without re-prefixing. New adapters should add a prefix.

### Rule 2 — Validate monetary amounts into `Currency` at the boundary

A bad amount must fail at the adapter, not deep in a workflow seven
nodes later. Parse to `Currency` before you emit the event; if the
parse fails, reject the inbound webhook with a structured error your
upstream can act on.

```rust
let amount = Decimal::from_str(&envelope.amount_str)
    .map_err(|_| AdapterError::InvalidAmount(envelope.amount_str.clone()))?;
let currency_code = CurrencyCode::from_str(&envelope.currency)
    .map_err(|_| AdapterError::UnknownCurrency(envelope.currency.clone()))?;
let cart_value = Currency::new(amount, currency_code);
```

Workflows trust their inputs because adapters did the work. They do
not re-validate every step.

### Rule 3 — Validate phone numbers into `PhoneNumber` at the boundary

If the resulting event will be consumed by a `WhatsAppSend` slot, a
raw string can ride on a `String` slot but not on a `PhoneNumber`
slot. Translate it at the adapter:

```rust
let phone = PhoneNumber::parse(&raw_phone)
    .map_err(|e| AdapterError::InvalidPhone(e.to_string()))?;
```

`PhoneNumber::parse` enforces E.164 — leading `+`, 7–15 ASCII digits,
no spaces or dashes. If your upstream emits phone numbers in the
"local" format, you must normalize at the boundary.

### Rule 4 — Include `tenant_id` on every event

Warp enforces multi-tenancy by Postgres RLS. Every event must
carry a `tenant_id` (per ADR-0002)
or the workflow has no way to acquire a connection.

v0.1 accepts `tenant_id` on the envelope as a stop-gap; per-tenant
webhook URLs with header-based tenancy (and HMAC signing) land in a
later spec revision (see ADR-0003).

```json
{
  "event_type": "cart.abandoned",
  "tenant_id": "tenant_aimer_prod_001",
  "session_id": "sess_42",
  "customer_id": "cust_007",
  "cart_value": "750.00",
  "currency": "MAD"
}
```

No event leaves your adapter without a `TenantId`.

### Rule 5 — Use ISO 8601 for all timestamps

If your upstream uses `YYYY-MM-DD HH:MM:SS` (OpenCart, Odoo), or epoch
milliseconds (Shopify webhooks sometimes do), translate at the
boundary. Workflows never re-format timestamps; dashboards expect
parseable input.

```rust
// crates/warp-catalog/src/adapters/datetime_utils.rs
pub fn parse_erp_datetime(raw: &str) -> Result<String, AdapterError> {
    let naive = NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
        .map_err(|_| AdapterError::InvalidDatetime(raw.to_string()))?;
    Ok(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc).to_rfc3339())
}
```

The `validate-event` endpoint surfaces non-ISO timestamps as warnings
(not errors) so your tests catch them before deployment.

---

## Step-by-step: implementing a Warp adapter

### Step 1 — Choose your event topics

Map your platform's commerce events to Warp's event families. Today
Warp recognizes two families on the chain-routing path:

| Warp event family   | Maps to chain                | Typical upstream events            |
|---------------------|------------------------------|------------------------------------|
| `cart.abandoned`    | `CartRecoveryFull`           | Shopify `checkouts/create` + no follow-up; WooCommerce `cart.abandoned`; OpenCart `cart.abandon`; Odoo `sale.order.cancelled` (draft) |
| `order.placed`      | `PostPurchaseWorkflow`       | Shopify `orders/create`; WooCommerce `order.created`; OpenCart `order.add`; Odoo `sale.order.created` |

The full routing table is `WORKFLOW_ROUTES` in
[`crates/warp-catalog/src/node_registry.rs`](../crates/warp-catalog/src/node_registry.rs).

If you have a third event family (e.g. `subscription.renewed`),
propose it via PR — adding it requires a Warp release because the
routing table is closed-set on purpose.

### Step 2 — Implement the translation layer

For each event:

1. **Parse the platform-native payload.** Webhooks deliver JSON or
   form-encoded bodies; you decide how to read them. The translation
   layer is your code; Warp only sees the output.
2. **Validate monetary amounts** into a `Currency` value.
3. **Validate phone numbers** into a `PhoneNumber`.
4. **Namespace identifiers** with your platform prefix (Rule 1).
5. **Include `tenant_id`** on every event (Rule 4).
6. **Convert timestamps** to ISO 8601 (Rule 5).
7. **Return either** a typed Warp event (`CartAbandonedInput` /
   `OrderPlacedInput`) **or** a structured `AdapterError` whose
   Display message names the rejected field.

A pure `translate_<platform>_event(envelope) -> Result<Translated,
AdapterError>` function is the recommended shape. Pure means
unit-testable without spinning a Restate runtime; the five existing
adapters each ship 6–8 unit tests against this function alone.

### Step 3 — Register your adapter with Restate

Your adapter is a Restate service. The boilerplate:

```rust
#[restate_sdk::service]
trait MyPlatformEventBridge {
    async fn events(&self, envelope: MyPlatformEnvelope) -> Result<IngestResult, HandlerError>;
}

pub struct MyPlatformEventBridgeImpl {
    billing_pool: Option<Arc<TenantPool>>,
}

impl MyPlatformEventBridgeImpl {
    pub fn new(billing_pool: Option<Arc<TenantPool>>) -> Self {
        Self { billing_pool }
    }
}

impl MyPlatformEventBridge for MyPlatformEventBridgeImpl {
    async fn events(&self, ctx: Context<'_>, envelope: MyPlatformEnvelope)
        -> Result<IngestResult, HandlerError>
    {
        let translated = translate_my_platform_event(&envelope)?;
        let route = route_for_event(&translated.event_type)
            .ok_or_else(|| TerminalError::new("no route for event"))?;

        // Look up the merchant's installed WorkflowConfig and apply overrides.
        let overrides = resolve_overrides_for(
            self.billing_pool.as_deref(),
            &translated.tenant_id,
            route.template_id,
        ).await;

        // Fire the chain with the merchant's typed overrides.
        let invocation_id = ctx
            .workflow_client::<MyChain>(workflow_key)
            .send()
            .run(/* … */)
            .await?;

        Ok(IngestResult {
            accepted_event_type: translated.event_type,
            workflow: route.restate_service.to_string(),
            invocation_id,
        })
    }
}
```

The five existing adapters in `crates/warp-catalog/src/adapters/`
follow this shape. Read [Agora](../crates/warp-catalog/src/adapters/agora/event_bridge.rs)
for the simplest example (no header-based event-type discrimination)
or [Shopify](../crates/warp-catalog/src/adapters/shopify/event_bridge.rs)
for the `X-Shopify-Topic` header routing pattern.

### Step 4 — Test with the Warp type validator

Once your translation layer compiles, point it at your local
warp-server and POST your translated event to:

```http
POST /api/v1/validate-event
Content-Type: application/json

{
  "event_type": "cart.abandoned",
  "payload": {
    "tenant_id": "tenant_aimer_prod_001",
    "session_id": "sess_42",
    "customer_id": "cust_007",
    "cart_value": "750.00",
    "currency": "MAD",
    "abandoned_at": "2026-05-26T12:34:56Z"
  }
}
```

The validator runs the same boundary checks the live adapters run.
Possible responses:

- `{ valid: true, event_type, warnings: [] }` — your translation
  satisfies the contract. Production-ready.
- `{ valid: true, event_type, warnings: [...] }` — passes today but
  has soft issues (e.g. non-ISO 8601 timestamps). Production tools
  should treat warnings as TODOs.
- `{ valid: false, event_type, errors: [...] }` — your translation
  violates one or more rules. Read the error messages, fix the
  adapter, re-validate.

The endpoint is documented in the [API surface](../crates/warp-server/src/api/validate_event.rs)
and CI-tested.

### Step 5 — Verify against a live Restate

Once the validator is green, register your adapter's Restate service
against a local warp-server + Restate runtime:

```bash
# Boot warp-server with your adapter compiled in.
target/debug/warp-server &

# Register the deployment with Restate.
restate deployments register http://localhost:9080

# Fire a translated event into your adapter.
curl -X POST http://localhost:9080/MyPlatformEventBridge/events \
  -H 'content-type: application/json' \
  -d @your-test-payload.json
```

You should see your service's invocation in the Restate journal
followed by the chain workflow's six invocations (for
`cart.abandoned`) or four (for `order.placed`).

---

## Reference: existing adapter implementations

Each ships translation tests + an adapter-level integration test. Use
the closest match to your platform as a template:

- **[Agora](../crates/warp-catalog/src/adapters/agora/event_bridge.rs)** —
  native event bus, no webhook. Simplest adapter: the event envelope
  is already Warp-shaped, so the adapter mainly validates and routes.
  Start here if you're building an adapter for a system you control.
- **[Shopify](../crates/warp-catalog/src/adapters/shopify/event_bridge.rs)** —
  webhook with header-based event-type discrimination
  (`X-Shopify-Topic` → `orders/create` | `checkouts/create`). Numeric
  ids prefixed (`shopify_…`, `shopify_customer_…`). Largest merchant
  base; the model adapter for SaaS commerce.
- **[WooCommerce](../crates/warp-catalog/src/adapters/woocommerce/event_bridge.rs)** —
  same shape as Shopify; `X-WC-Webhook-Topic` header drives routing.
  `wc_` / `wc_customer_` namespacing. `billing.email` surfaced as
  `delivery_address`.
- **[OpenCart](../crates/warp-catalog/src/adapters/opencart/event_bridge.rs)** —
  payload-field-driven discrimination (`event_type` rides on the
  body, not a header). Includes `parse_opencart_datetime` translation
  of `YYYY-MM-DD HH:MM:SS` to ISO 8601 — refactored into the shared
  `parse_erp_datetime` helper.
- **[Odoo](../crates/warp-catalog/src/adapters/odoo/event_bridge.rs)** —
  Warp's first ERP adapter. Handles Odoo's `many2one` tuple convention
  (`partner_id: [55, "Name"]`, `currency_id: [1, "MAD"]`) via
  `parse_many2one_id` + `parse_currency_id`. Use this template for
  any ERP integration (SAP, Microsoft Dynamics, NetSuite).

---

## Reference: Warp type spec

Read [the type spec](TYPE_SPEC.md) before writing
adapter code. The spec defines the types; this guide tells you how to
emit them. Together they are the full contract.

The spec covers: `Currency`, `PhoneNumber`, `OrderID`, `CustomerID`,
`TenantId`, `CustomerProfile`, `CartState`, `Language`, `Channel`,
`Platform`. Each entry documents invariants, construction paths,
error variants, display format, and serialization format.

---

## Becoming officially Warp-compatible

Submit a PR to [yasirlts/warp-lang](https://github.com/yasirlts/warp-lang) with:

1. **Your adapter implementation** in `crates/warp-catalog/src/adapters/{platform}/`.
   Follow the shape of the existing adapters; CI checks formatting
   and clippy with `-D warnings`.
2. **Unit tests covering every event type** your adapter handles —
   one happy path per event family plus rejection cases for each rule
   in this guide.
3. **An entry in `Platform`** ([crates/warp-core/src/types/commerce.rs](../crates/warp-core/src/types/commerce.rs))
   if your platform isn't already listed. This is a closed enum — a
   PR is the only path.
4. **An entry in `ALL_NODES`** ([crates/warp-catalog/src/node_registry.rs](../crates/warp-catalog/src/node_registry.rs))
   if you add new commerce node types. Most adapter PRs do not need
   this — adapters are infrastructure, not nodes.
5. **Adapter-level documentation** in `docs/adapters/{platform}.md`
   following the shape of the existing adapter docs. Include sample
   payloads (real ones — redact the sensitive bits, don't synthesize)
   and the smallest reproducible curl that lands an event.
6. **A live-run note** at the bottom of the docs/{platform}.md file:
   the journal IDs, billing rows, and screenshot of any side-effects
   demonstrating that the adapter works end-to-end against a real
   merchant tenant.

PRs are reviewed within five business days. Once merged, your
platform appears in the [Reference: existing adapter implementations](#reference-existing-adapter-implementations)
list above and in CLAUDE.md's "Platform adapter architecture"
section.

---

## Frequently asked questions

**Q: Does Warp support polling adapters in addition to webhook
adapters?**
Yes — the trait surface is `subscribe(event)` not `webhook(payload)`,
so a polling adapter just calls `subscribe` from a cron tick instead
of an HTTP handler. The Agora adapter is closest to this shape.

**Q: My platform's currency isn't in `MAD | EUR | USD`. What do I
do?**
PR the additional `CurrencyCode` variant. Warp's MENA-first stance
keeps the v0.1 set small; we're happy to add codes as adapter authors
request them. Don't try to round-trip your currency through one of
the existing codes — that's the exact bug `Currency` exists to
prevent.

**Q: My platform doesn't separate cart abandonment from
order-creation events. What do I do?**
Pick the closest event family. Odoo's `sale.order.cancelled` (with a
draft state) maps to `cart.abandoned` for the same reason — it's the
closest equivalent. The merchant-facing canvas hides the impedance
mismatch; your adapter takes the hit.

**Q: Can I emit additional fields beyond what Warp's event types
require?**
Yes — Warp's event input structs deserialize via `#[serde(default)]`
where appropriate, and unknown fields are ignored. Extra fields ride
through unconsumed today; future Warp versions may pick them up if
they map to new commerce types.

**Q: Where do I report adapter bugs?**
Open an issue on [yasirlts/warp-lang](https://github.com/yasirlts/warp-lang/issues)
tagged `adapter:{platform}`. Include the rejected payload (redacted),
the AdapterError message, and the Restate invocation id if the
adapter accepted the payload but the chain failed downstream.
