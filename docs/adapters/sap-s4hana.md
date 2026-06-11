# SAP S/4HANA Warp Adapter Specification

**Status: Specification — implementation in Phase 3.**

This document specifies how SAP S/4HANA's business eventing surface
translates into Warp's typed commerce vocabulary. The adapter is
**not yet implemented**; this spec is the engineering brief Phase 3
will execute against.

---

## Overview

SAP S/4HANA is the largest enterprise ERP in the world. A Warp
adapter for S/4HANA is the unlock that puts Warp on the same canvas
as Tier-1 retail, manufacturing, and B2B commerce — every Fortune 500
running SAP becomes a candidate Warp tenant without touching their
SAP installation.

The adapter sits between SAP's outbound event surface (Business
Eventing on BTP) and Warp's chain workflows. SAP emits OData /
CloudEvents-shaped webhooks; the adapter validates them, translates
to Warp types, and fires the matching chain (`CartRecoveryFull` /
`PostPurchaseWorkflow`).

This adapter is the first one whose source platform is **not** a
storefront. Odoo (Phase 2 session 8) was Warp's first ERP adapter
but Odoo is mid-market; SAP carries enterprise expectations around
auth, signing, idempotency, and SLA.

---

## Integration approach

**SAP Business Eventing (SAP BTP)** is the canonical outbound event
surface for S/4HANA. It emits CloudEvents-format envelopes over HTTPS
when business objects change. The Warp SAP adapter is a Business
Eventing consumer:

```
SAP S/4HANA (on-prem or cloud)
        │
        ▼  (SAP Cloud Connector or direct, depending on deployment)
SAP Business Technology Platform (BTP)
        │
        ▼  (HTTPS webhook, CloudEvents envelope, OAuth client-credentials)
warp-catalog::adapters::sap::SapEventBridge (Restate service)
        │
        ▼  translate_sap_event(envelope) → CartAbandonedInput | OrderPlacedInput
        ▼
WORKFLOW_ROUTES → CartRecoveryFull | PostPurchaseWorkflow
```

**Why Business Eventing (not iDoc / RFC).** iDoc and RFC are
batch-friendly transports inherited from R/3. Business Eventing is
the S/4HANA-native real-time path with first-class CloudEvents
support, OAuth 2.0 client credentials, and BTP-managed retries —
all the affordances Warp's adapter contract already assumes. Choosing
iDoc would force the adapter to also build a sequencing + dedup
layer, expanding scope from "translation" to "ESB-lite."

---

## Event mapping

Warp's two chain families are the v0.1 targets:

| SAP Event                       | Warp Type            | Notes                                                           |
|---------------------------------|----------------------|-----------------------------------------------------------------|
| `SalesOrder.Created.v1`         | `OrderPlacedInput`   | OrderID prefix `sap_{SalesOrder}`; routes to `PostPurchaseWorkflow` |
| `SalesOrder.Changed.v1`         | (future)             | Status transitions — defer until merchants request the path     |
| `BusinessPartner.Changed.v1`    | (future)             | Customer-record updates — needs new commerce type before usable |

Only `SalesOrder.Created.v1` is in scope for v0.1. The other two are
named here so a future PR can land them additively without revisiting
the namespacing rules.

---

## `SalesOrder.Created.v1` payload (CloudEvents envelope)

Drawn from SAP's published Business Eventing schema for
`API_SALES_ORDER_SRV` and adjusted for the fields Warp consumes.
Fields not used by Warp are listed for completeness; the adapter
must ignore them rather than reject.

```json
{
  "specversion": "1.0",
  "type": "sap.s4.beh.salesorder.v1.SalesOrder.Created.v1",
  "source": "/default/sap.s4/SALESORDER",
  "id": "ev-2026-05-26T10:00:00.000Z-12345",
  "time": "2026-05-26T10:00:00.000Z",
  "datacontenttype": "application/json",
  "data": {
    "SalesOrder":               "0000123456",
    "SoldToParty":              "0010000001",
    "TransactionCurrency":      "MAD",
    "TotalNetAmount":           "850.00",
    "OrderDate":                "2026-05-26T10:00:00.000Z",
    "SalesOrganization":        "1010",
    "DistributionChannel":      "10",
    "OrganizationDivision":     "00",
    "to_Item": [
      {
        "SalesOrderItem":       "10",
        "Material":             "MAT-ABC",
        "MaterialName":         "Sample Product",
        "RequestedQuantity":    "2",
        "RequestedQuantityUnit":"EA",
        "NetAmount":             "425.00",
        "Plant":                "1010"
      }
    ]
  }
}
```

The adapter reads `data.SalesOrder`, `data.SoldToParty`,
`data.TransactionCurrency`, `data.TotalNetAmount`, `data.OrderDate`,
and `data.to_Item` (length only). Everything else is ignored at v0.1.

---

## Translation rules

Concretely, the adapter constructs a `Translated::OrderPlaced` from
the envelope as follows. Each row maps a SAP field to a Warp construction
call — the same shape the Odoo adapter follows in
[`crates/warp-catalog/src/adapters/odoo/event_bridge.rs`](../../crates/warp-catalog/src/adapters/odoo/event_bridge.rs).

| Warp field                | Construction                                                                                  | Notes                                                            |
|---------------------------|-----------------------------------------------------------------------------------------------|------------------------------------------------------------------|
| `tenant_id`               | from envelope header `X-Warp-Tenant-Id` (per ADR-0003 v0.2 routing)                            | stop-gap envelope field `tenant_id` accepted until v0.2 lands     |
| `order_id`                | `OrderID::new(&format!("sap_{}", data.SalesOrder))?`                                          | Rule 1 — namespace the platform id at the boundary               |
| `customer_id`             | `CustomerID::new(&format!("sap_customer_{}", data.SoldToParty))?`                             | Rule 1                                                           |
| `order_value`             | `Currency::new(Decimal::from_str(&data.TotalNetAmount)?, CurrencyCode::from_str(&data.TransactionCurrency)?)` | Rule 2 — parse to `Currency` at the boundary, never `f64`        |
| `placed_at`               | `data.OrderDate` (already ISO 8601 in CloudEvents)                                            | Rule 5 — no translation needed                                   |
| `platform`                | `Platform::SAP`                                                                               | requires the enum variant landing first (see "Platform enum" below) |
| `item_count`              | `data.to_Item.len() as u32`                                                                   | Optional metadata; surfaced for the Post-Purchase template       |
| `delivery_address`        | None                                                                                          | SAP carries it on a separate object; v0.2 work                   |

### Rejection paths

The adapter MUST surface each of these as a structured
`AdapterError` (matching the Odoo / Shopify shape) — never a runtime
panic and never a silent drop:

- Missing or empty `SalesOrder`           → `AdapterError::InvalidOrderID`
- Missing or empty `SoldToParty`          → `AdapterError::InvalidCustomerID`
- `TotalNetAmount` not parseable          → `AdapterError::InvalidAmount`
- `TransactionCurrency` not in `MAD | EUR | USD` → `AdapterError::UnknownCurrency`
- Envelope `type` ≠ a known SAP event    → `AdapterError::UnknownEventType`

Every rejection echoes the offending field value in the Display message
so operators can grep the SAP outbound log.

### Currency support

v0.1 of the Warp type system carries `MAD | EUR | USD`. The SAP
adapter does NOT silently coerce other currencies — a SAP order in
`AED` or `GBP` fails at the adapter with `UnknownCurrency` and the
adapter author opens a PR to extend `CurrencyCode`.

This is the same posture as every other adapter; SAP merchants
typically run multi-currency configurations and we expect to add
codes through that PR pathway during Phase 3 rollout.

---

## Authentication + signing

### OAuth 2.0 client credentials (transport)

SAP Business Eventing uses OAuth 2.0 client credentials to
authenticate the receiver. The adapter MUST:

1. Accept an `Authorization: Bearer <token>` header on every inbound
   webhook.
2. Validate the token against the SAP BTP destination's JWKS endpoint
   (cached with a sensible TTL).
3. Reject any request without a valid token with HTTP 401.

The token validation logic lives in `warp-server`'s pre-handler
middleware (cross-cutting, not per-adapter) so future adapters using
OAuth (Salesforce, Workday) reuse the same gate.

### Webhook signature (defense in depth)

SAP signs Business Eventing webhooks with a tenant-scoped HMAC
shared secret. The adapter MUST:

1. Accept an `X-Sap-Signature` header carrying `sha256=<hex>`.
2. Recompute the signature over the raw request body with the
   per-tenant secret (stored in `warp_tenants.platform_config.webhook_secret`).
3. Reject any request whose computed signature does not match,
   regardless of the OAuth token result.

This is belt-and-braces: if a token leaks, the signature still blocks
forged payloads from impersonating a tenant.

Detailed implementation deferred to Phase 3 — landing OAuth + HMAC
together with the adapter ensures Day 1 is hardened, not bolted on
later.

---

## Idempotency

SAP Business Eventing retries on failure. CloudEvents envelopes carry
a unique `id` per emission; the adapter MUST:

1. Compute a Restate workflow key as
   `{tenant_id}:{envelope.id}` so a retry lands on the same Restate
   invocation rather than re-running the chain.
2. Treat replays as no-ops at the chain level — Restate's exactly-once
   semantics handle this once the key is shared.

This pattern is already proven by C-05 testing on `CartRecoveryFull`;
the SAP adapter is structurally identical, the contract just calls it
out explicitly because enterprise auditors ask.

---

## Platform enum

Implementing this adapter requires extending the closed `Platform`
enum in [`crates/warp-core/src/types/commerce.rs`](../../crates/warp-core/src/types/commerce.rs):

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub enum Platform {
    Agora, Shopify, WooCommerce, OpenCart, Magento, Odoo,
    // Phase 3 addition:
    SAP,
}
```

Mirror the change in:

1. `WARP_TYPE_SPEC_v0.1.md` Platform table — add a `SAP` row with
   the `sap_` prefix convention.
2. The Platform's serialization round-trip test in
   `crates/warp-core/src/types/commerce.rs`.
3. The merchant API's `AdapterType::SAP` variant (and the
   `webhook_path_for` map in `crates/warp-server/src/api/tenants.rs`).

These are all single-line additions; the closed-enum design is
deliberate so an unsupported platform fails at compile time.

---

## Compatibility surface

Following the [WARP_COMPATIBLE_GUIDE](../WARP_COMPATIBLE_GUIDE.md):

- **Rule 1 (namespace ids):** every SAP id prefixed `sap_` /
  `sap_customer_` at the adapter boundary.
- **Rule 2 (Currency validation):** `TotalNetAmount` parsed to
  `Decimal` and combined with a validated `CurrencyCode`.
- **Rule 3 (PhoneNumber):** SAP's `SalesOrder` payload doesn't carry
  a phone number directly — the `BusinessPartner.Changed.v1` extension
  will, and Warp will surface it through `ACPGetCustomerProfile` until
  then.
- **Rule 4 (tenant_id on every event):** per-tenant webhook URLs
  with header-based tenancy in v0.2; v0.1 stop-gap is the envelope
  `tenant_id` field, same as the other Phase 2 adapters.
- **Rule 5 (ISO 8601 timestamps):** SAP's `OrderDate` is already
  ISO 8601 in the CloudEvents shape — passthrough.

The adapter passes `/api/v1/validate-event` against a sample
`order.placed` payload the moment the translation layer compiles.

---

## Estimated implementation

| Item                                              | Estimate          |
|---------------------------------------------------|-------------------|
| Adapter crate skeleton + `translate_sap_event`    | 1 day             |
| OAuth bearer-token validation middleware          | 1 day             |
| HMAC signature verification                       | 0.5 day           |
| 8 unit tests (matching the Odoo adapter coverage) | 1 day             |
| Live SAP BTP sandbox integration test             | 0.5–1 day         |
| Documentation in this file + `WARP_COMPATIBLE_GUIDE.md` reference | 0.5 day |
| **Total (one senior Rust engineer)**              | **3–5 days**      |

Implementation follows the same pattern as the Odoo adapter shipped
in Phase 2 session 8. The SAP-specific work concentrates in two
places: the OAuth/HMAC middleware (cross-cutting, future-reusable),
and the SAP-flavored field-mapping in `translate_sap_event`.

---

## Out of scope (Phase 3 work)

- **`SalesOrder.Changed.v1`** — status transitions. Needs a new
  Warp event family because `order.placed` only fires on creation.
- **`BusinessPartner.Changed.v1`** — customer-record updates. Needs
  either a richer `CustomerProfile` or a new `CustomerUpdated`
  event family.
- **Inbound delivery events** — `OutboundDelivery.Created.v1`,
  `DeliveryDocument.Posted.v1`. Mapped to a future `delivery.shipped`
  event family.
- **SAP RFC fallback** — for tenants on legacy SAP without Business
  Eventing. Deferred until a paying customer asks; the architecture
  shouldn't shape itself around a fallback nobody needs.

---

## References

- [SAP Business Eventing documentation](https://help.sap.com/docs/SAP_S4HANA_CLOUD/0f69f8fb28ac4bf48d2b57b9637e81fa/) — SAP-side specification.
- [Warp adapter contract](../WARP_COMPATIBLE_GUIDE.md) — the five rules
  every Warp adapter implements.
- [Warp Type Spec v0.1](../WARP_TYPE_SPEC_v0.1.md) — the typed
  vocabulary the adapter emits.
- [Odoo adapter](../../crates/warp-catalog/src/adapters/odoo/event_bridge.rs) —
  the nearest reference implementation. Read this first when starting
  the SAP adapter — the shape and the tests transfer almost line-by-line.
- [ADR-0003 platform adapter interface](../adr/0003-platform-adapter-interface.md) —
  the architectural contract every adapter satisfies.

---

## Owner + status tracking

- **Owner:** Warp core engineering (Lamar Tech).
- **Status:** Specification — implementation in Phase 3.
- **First-target customer:** to be announced once an enterprise SAP
  pilot signs. The implementation will happen in coordination with
  that pilot so the live-test data is real.
- **Updates:** changes to this spec require either a PR review (for
  field-mapping or auth changes) or an ADR (for any deviation from
  the five-rule adapter contract).
