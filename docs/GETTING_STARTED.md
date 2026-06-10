# Getting Started with Warp

Zero to a running commerce workflow in ~15 minutes, using the hosted
instance at **`https://warp.aimer.ma`**. No local setup.

> This guide is for **developers** — you can read JSON and run `curl`.
> Merchants use the visual canvas, which has its own onboarding.

---

## What Warp Is

Warp is a typed commerce workflow runtime. You write workflows in `.warp`
files and compile them; the compiler catches commerce mistakes (wrong types,
missing inputs, broken references) before they ever touch a customer.

---

## Prerequisites

- `curl` and a terminal (any OS). `jq` and `python3` are handy but optional.
- Network access to `https://warp.aimer.ma` — nothing to install or run locally.
- A commerce platform with webhooks (Shopify, WooCommerce, OpenCart, Magento,
  or Agora) **for Step 3 only**. Steps 1–2 and 4 need nothing but `curl`.

Confirm the service is up:

```bash
curl -s https://warp.aimer.ma/health
```

```json
{"status":"ok","version":"0.1.0","node_count":11,"template_count":2}
```

### Get your credentials (30 seconds)

Every `/api/v1/*` call needs an API key. Sign up to mint a tenant + key
(this is the only public, unauthenticated endpoint):

```bash
curl -s -X POST https://warp.aimer.ma/signup \
  -H 'content-type: application/json' \
  -d '{"store_name":"Acme Demo","email":"dev@acme-demo.test","platform":"shopify"}'
```

Real response:

```json
{
  "tenant_id": "ten_a3xaVdPoejgZ",
  "api_key": "warp_5c781f85…e69e47",
  "webhook_url": "/ShopifyEventBridge/events",
  "setup_instructions": {
    "step1": "Add the webhook URL /ShopifyEventBridge/events in Shopify Settings → Notifications → Webhooks",
    "step2": "Set the first webhook topic to: orders/create",
    "step3": "Set the second webhook topic to: checkouts/create",
    "step4": "Your first event will trigger your workflow automatically"
  },
  "plan": "starter",
  "trial_ends_at": "2026-07-10T14:37:03Z"
}
```

The `api_key` is shown **once** — keep it. Export both values so the rest of
the guide is copy-paste:

```bash
export TENANT_ID="ten_a3xaVdPoejgZ"          # ← use YOUR tenant_id
export WARP_API_KEY="warp_5c781f85…e69e47"   # ← use YOUR api_key
```

All authenticated requests carry the key as `X-Warp-API-Key`. Without it you
get `401`.

---

## Step 1 — Compile your first workflow (5 minutes)

Create `cart_recovery.warp` — when a cart worth ≥ 200 MAD is abandoned for
30 minutes, look up the customer and send a WhatsApp reminder:

```bash
cat > cart_recovery.warp <<EOF
project "cart_recovery" {
  version = "1.0.0"
  tenant  = "$TENANT_ID"

  CartAbandoned trigger {
    min_value: Currency(200, MAD)
    after:     Duration(30, minutes)
  }

  ACPGetCustomerProfile profile {
    customer_id: trigger.customer_id
  }

  WhatsAppSend reminder {
    to:       profile.phone
    template: "cart_reminder"
    lang:     profile.language
  }
}
EOF
```

Compile it (`jq` turns the file into a JSON string safely):

```bash
jq -Rs --arg t "$TENANT_ID" '{tenant_id:$t, warp_source:.}' cart_recovery.warp \
  | curl -s -X POST https://warp.aimer.ma/api/v1/workflows/compile \
      -H "content-type: application/json" \
      -H "X-Warp-API-Key: $WARP_API_KEY" \
      --data @-
```

Real response:

```json
{
  "workflow_name": "cart_recovery",
  "tenant_id": "ten_a3xaVdPoejgZ",
  "node_count": 3,
  "source_hash": "4a77f20cc3a44404c93f663db4202b18d13b0c0086df63d12c6c603b9fbf1470",
  "registered_at": "2026-06-10T14:37:04Z",
  "rust_source_path": "<generated>/cart_recovery.rs",
  "status": "compiled",
  "warnings": []
}
```

**What just happened.** The compiler lexed and parsed your `.warp`, checked
that every node type (`CartAbandoned`, `ACPGetCustomerProfile`, `WhatsAppSend`)
exists in the catalog, that every reference (`trigger.customer_id`,
`profile.phone`, `profile.language`) resolves to a node declared earlier, and
that every required input is present. `status: "compiled"` means it passed and
the workflow was registered. (See [What the compiler checks](#what-the-compiler-checks).)

---

## Step 2 — Install a ready-made workflow (3 minutes)

Step 1 proved *your* source compiles. To get a workflow that's already wired to
your store's webhooks, install a catalog template. `cart_recovery_v1` is the
productionized cart-recovery chain (profile → WhatsApp → wait → strategy →
follow-up):

```bash
curl -s -X POST https://warp.aimer.ma/api/v1/workflows/install \
  -H "content-type: application/json" \
  -H "X-Warp-API-Key: $WARP_API_KEY" \
  -d "{
    \"tenant_id\": \"$TENANT_ID\",
    \"template_id\": \"cart_recovery_v1\",
    \"config\": {
      \"min_cart_value_mad\": 200,
      \"delay_minutes\": 30,
      \"follow_up_delay_hours\": 24,
      \"acp_base_url\": \"https://acp.aimer.ma\",
      \"mock_mode\": true
    }
  }"
```

Real response:

```json
{
  "workflow_id": "wf_5b6847fb-70c8-44a8-ab70-f7dbf4fda442",
  "template_id": "cart_recovery_v1",
  "tenant_id": "ten_a3xaVdPoejgZ",
  "status": { "state": "active" },
  "installed_at": "2026-06-10T14:37:04Z"
}
```

Your `workflow_id` is now `active`. The other shipped template is
`post_purchase_v1` (`template_count: 2` in `/health`).

---

## Step 3 — Connect your store (5 minutes)

Use the `webhook_url` and `setup_instructions` from your signup response. The
adapter underneath is invisible — your workflow sees `CartAbandoned` regardless
of platform.

**Shopify** (`"platform":"shopify"` → `webhook_url: /ShopifyEventBridge/events`):
1. Shopify admin → **Settings → Notifications → Webhooks**.
2. Add webhook, topic **`checkouts/create`**, URL = your `webhook_url`.
3. Add a second webhook, topic **`orders/create`**, same URL.

**WooCommerce** (sign up with `"platform":"woocommerce"` → `/WooCommerceEventBridge/events`):
1. **WooCommerce → Settings → Advanced → Webhooks → Add webhook**.
2. Topic **`cart.abandoned`** (and **`order.created`**), Delivery URL = your `webhook_url`.

**Any HTTP source** (OpenCart, Magento, Agora, or your own backend): sign up
with that `platform`; signup returns the matching bridge path
(`/OpenCartEventBridge/events`, `/AgoraEventBridge/events`, …). POST your
platform's native event there and the adapter translates it into a typed Warp
event.

> The bridge URL is a path on the Warp ingress; your platform's webhook config
> is where you paste the full `https://…` URL your deployment fronts it with.

---

## Step 4 — Validate a test event (2 minutes)

Before wiring a live webhook, dry-run your event payload through the validator —
it runs the exact boundary checks the adapters run, **without** invoking a
workflow:

```bash
curl -s -X POST https://warp.aimer.ma/api/v1/validate-event \
  -H "content-type: application/json" \
  -H "X-Warp-API-Key: $WARP_API_KEY" \
  -d "{
    \"event_type\": \"cart.abandoned\",
    \"payload\": {
      \"tenant_id\": \"$TENANT_ID\",
      \"session_id\": \"sess_42\",
      \"customer_id\": \"cust_007\",
      \"cart_value\": \"750.00\",
      \"currency\": \"MAD\",
      \"abandoned_at\": \"2026-06-10T12:34:56Z\"
    }
  }"
```

Real response:

```json
{"valid":true,"event_type":"cart.abandoned"}
```

Break it on purpose (unparseable amount, unsupported currency, non-ISO
timestamp) and the validator tells you exactly what's wrong:

```json
{
  "valid": false,
  "event_type": "cart.abandoned",
  "errors": [
    "cart_value: cannot parse \"lots\" as a Currency amount (expected a decimal like \"100.00\")",
    "currency: unknown currency code \"GBP\" — Warp v0.1 accepts MAD, EUR, USD"
  ],
  "warnings": [
    "abandoned_at: \"2026-06-10 12:34:56\" does not look like ISO 8601 (expected YYYY-MM-DDThh:mm:ssZ or with offset). The adapter should translate to ISO 8601 at the boundary; dashboards may misparse otherwise."
  ]
}
```

**Verify a real run.** Once your platform fires an actual webhook at the bridge
(Step 3), the execution is recorded. List your tenant's executions:

```bash
curl -s "https://warp.aimer.ma/api/v1/executions/$TENANT_ID" \
  -H "X-Warp-API-Key: $WARP_API_KEY"
```

A fresh tenant returns `[]` until the first event fires; afterwards each run
appears with its `status` and `billing_units`.

---

## What the compiler checks

These run on every `POST /api/v1/workflows/compile`. A failure returns HTTP
`400` with `{"error":"type check failed","type_errors":[…]}`; each message
names the line and how to fix it.

**1. The node type exists.** Every `PascalCase` node must be in the catalog.
```warp
Frobnitz boom { foo: "bar" }
```
> `Line 2: Unknown node type 'Frobnitz'.`

**2. Required inputs are present.** Each node declares its required config keys.
```warp
WhatsAppSend s { template: "x" }     // missing `to`
```
> `Line 3: WhatsAppSend 's' is missing required input 'to'.`

**3. References resolve.** `instance.field` must name a node declared *above* it
(or the keyword `trigger`).
```warp
WhatsAppSend s { to: customer.phone  template: "x" }   // `customer` never declared
```
> `Line 2: Reference 'customer.phone' points at instance 'customer', which is not declared above this node. Declare it earlier or use the keyword 'trigger'.`

### Commerce-model invariant checks

The compiler also enforces the invariants of the
[Warp Commerce Model](../spec/COMMERCE_MODEL.md) — these reject (`400`) or warn,
live on `warp.aimer.ma`. Each message names the line and the invariant.

- **Capacity verification (I-3)** — reaching `Commitment(Accepted)` (e.g. an
  `OrderPlaced` node) with no prior `ACPGetCustomerProfile`:
  > `Line 2: Workflow reaches Commitment(Accepted) via 'OrderPlaced' without a prior capacity verification step. Add ACPGetCustomerProfile before 'OrderPlaced' to verify Party capacity per Invariant 3 of the Warp Commerce Model.`
- **Temporal order (I-4)** — a Fulfillment-level node (e.g. `WhatsAppSend`)
  before a Commitment-level node (`OrderPlaced`):
  > `Line 4: Temporal order violation. 'm' produces a Fulfillment state but appears before 'o' which produces a Commitment state. In the Warp Commerce Model, Commitments form before Fulfillments execute. Move 'o' before 'm' in your workflow declaration.`
- **Duplicate names (I-5)** — two nodes with the same instance name:
  > `Line 3: Duplicate instance name 'dup'. Already declared at line 2. … duplicates violate Identity Permanence (Invariant 5).`
- **Commitment tree consistency (I-6)** — a child order exceeding its parent:
  > `Line 4: Commitment tree inconsistency. Child commitment 'child' has value 800 MAD which exceeds parent commitment 'parent' value 500 MAD. Per Invariant 6, child Commitment values must not exceed their parent.`
- **Currency conservation (I-1)** — a node referencing two currency codes
  *compiles* (`200`) but returns a **warning** in the `warnings` array:
  ```json
  {"kind":"CurrencyMixingWarning",
   "message":"Warning — Line 2: Node 't' (CartAbandoned) references multiple currencies: EUR, MAD. Verify that currency conversion is handled before this node…",
   "line":2}
  ```

---

## Common errors and fixes

| HTTP / error | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | Missing or malformed `X-Warp-API-Key` | Send the header; the key is `warp_` + 64 hex chars from `/signup` |
| `400 unknown template: …` (install) | `template_id` isn't a shipped template | Use `cart_recovery_v1` or `post_purchase_v1` |
| `Unknown node type 'X'` | `PascalCase` node not in the catalog (often a typo) | Check spelling/casing — the error suggests the nearest match |
| `… is missing required input 'Y'` | A node is missing a required config key | Add the key (e.g. `WhatsAppSend` needs `to` and `template`) |
| `Reference 'a.b' … not declared above this node` | A referenced instance doesn't exist or comes later | Declare it earlier, or use `trigger` for the first trigger's outputs |
| `validate-event: unknown event_type "…"` (400) | Event family Warp doesn't recognize | Use `cart.abandoned` or `order.placed` |
| `validate-event: tenant_id is required …` | Event payload has no `tenant_id` | Include `tenant_id` on every event (multi-tenancy contract C-03) |
| `validate-event: cannot parse "…" as a Currency amount` | Non-decimal money value | Send a decimal string like `"750.00"` |
| `validate-event: unknown currency code "…"` | Currency outside MAD/EUR/USD | Use `MAD`, `EUR`, or `USD` |
| `500` on every authenticated route | Server-side storage/schema problem | Operator issue — the DB schema must be applied (apply the database schema on the server) |

Commerce-model invariant errors — `Temporal order violation` (I-4),
`Duplicate instance name` (I-5), `Commitment tree inconsistency` (I-6),
and the capacity-verification rejection (I-3) — also return `400` from
compile; the currency-mixing case (I-1) returns `200` with a
`CurrencyMixingWarning` in the `warnings` array. See
[Commerce-model invariant checks](#commerce-model-invariant-checks).

---

## Next steps

- **[Commerce Model](../spec/COMMERCE_MODEL.md)** — the formal model: five primitives, six invariants.
- **[Type Specification](../spec/TYPE_SPEC.md)** — the type spec other systems implement against.
- **[Warp-Compatible Guide](../spec/COMPATIBLE_GUIDE.md)** — write an adapter so a new platform becomes Warp-compatible.
- **[.warp Syntax Reference](WARP_DSL_SYNTAX.md)** — the full `.warp` grammar.
- **The canvas** — open `https://warp.aimer.ma/canvas` for the no-code, trilingual builder (the merchant-facing path).
```
