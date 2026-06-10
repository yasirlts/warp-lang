# Warp

**The formal commerce language.**

Warp is a typed workflow runtime for commerce. It defines what
commerce is — precisely enough that a compiler can enforce it.

## The Problem

Every commerce platform has its own model of commerce. SAP calls
an order a SalesOrder. Shopify calls it an Order. Odoo calls it a
sale.order. These are the same concept expressed in incompatible
vocabularies.

Every AI system that touches commerce must learn each platform's
vocabulary independently. Every integration requires custom mapping
work. Every developer who moves between platforms starts over.

Warp ends this.

## What Warp Is

Warp defines five primitives that hold across every commerce domain:

- **Party** — any entity participating in commerce
- **Value** — what moves or is accessed between parties
- **Intent** — expressed desire before commitment
- **Commitment** — formal agreement between parties
- **Fulfillment** — execution of a commitment

These five primitives have been tested adversarially across physical
goods commerce, services, financial commerce, and digital goods.
No sixth primitive has been found necessary.

## The Compiler

Warp workflows are written in `.warp` files and compiled before
they touch any real customer. The compiler enforces the commerce
model's invariants:

- You cannot fulfill a cancelled commitment
- You cannot mix currencies without explicit conversion
- A commitment cannot reach Accepted without capacity verification
- Fulfillment cannot precede Commitment in the same workflow

Commerce mistakes are impossible to express — not merely likely
to be caught.

## A Warp Workflow

```
project "cart_recovery" {
  version = "1.0.0"
  tenant  = "your-tenant-id"

  CartAbandoned trigger {
    min_value: Currency(200, MAD)
    after:     Duration(30, minutes)
  }

  ACPGetCustomerProfile profile {
    customer_id: trigger.customer_id
  }

  WhatsAppSend message {
    to:       profile.phone
    template: "cart_reminder"
    lang:     profile.language
  }
}
```

The compiler catches `profile.name` passed to `WhatsAppSend.to`
before this workflow ever runs — `to` expects `PhoneNumber`,
not `String`.

## Live

Warp is running in production at [warp.aimer.ma](https://warp.aimer.ma).

```bash
# Compile a workflow
curl -X POST https://warp.aimer.ma/api/v1/workflows/compile \
  -H "X-Warp-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_id": "your-tenant-id",
    "warp_source": "project \"hello\" {\n  version = \"1.0.0\"\n  tenant  = \"your-tenant-id\"\n  CartAbandoned trigger {\n    min_value: Currency(200, MAD)\n    after:     Duration(30, minutes)\n  }\n}"
  }'

# Response
{"workflow_name":"hello","node_count":1,"status":"compiled","warnings":[]}
```

You can get a tenant id and key in 30 seconds — see the
[Getting Started guide](docs/GETTING_STARTED.md).

## Get Started

→ [Getting Started Guide](docs/GETTING_STARTED.md) — zero to
  running workflow in 15 minutes

→ [Commerce Model](spec/COMMERCE_MODEL.md) — the formal
  specification of commerce

→ [Type Specification](spec/TYPE_SPEC.md) — the type system

→ [Warp-Compatible Guide](spec/COMPATIBLE_GUIDE.md) — build
  an adapter for your platform

→ [.warp Syntax Reference](docs/WARP_DSL_SYNTAX.md) — the grammar

## The Commerce Model

The formal specification is in [`spec/COMMERCE_MODEL.md`](spec/COMMERCE_MODEL.md).

It answers one question: what is commerce, stated formally.

Not what Shopify thinks commerce is. Not what SAP thinks commerce
is. What commerce **is** — stated precisely enough that two
independent implementations produce compatible results.

## Warp-Compatible

If your platform implements the Warp type spec, add this to your
README:

```
Warp-compatible
```

See the [compatibility guide](spec/COMPATIBLE_GUIDE.md) for what
this means and how to get there.

## Status

The five primitives are stable. The type system is in active
development. The compiler enforces six commerce invariants in
production.

| Component | Status |
|-----------|--------|
| Commerce Model | v0.2 — stable |
| Type Specification | v0.3 — active development |
| Compiler | Live — 6 invariant checks |
| Runtime | Live at warp.aimer.ma |

## License

MIT — see [LICENSE](LICENSE).

---

*Built by [Lamar Tech Solutions](https://warp.aimer.ma). Casablanca, Morocco.*
