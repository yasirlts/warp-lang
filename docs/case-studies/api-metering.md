> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/api-metering/api-metering.json`](../../conformance/case-studies/api-metering/api-metering.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: API Metering

> **Adversarial test corpus — executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below is a real fixture under
> [`conformance/case-studies/api-metering/`](../../conformance/case-studies/api-metering/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs conformance/case-studies/api-metering`.

**Reference platforms:** Stripe Metered Billing, Twilio, OpenAI API, AWS API Gateway.  
**Fixture:** [`api-plan-with-overage.json`](../../conformance/case-studies/api-metering/api-plan-with-overage.json)

---

## The domain and the hard cases it stresses

API access with metered billing is in the "Digital commerce" category. The hard
parts are:

1. **A subscription plan does not reach `fulfilled`** — it reaches `active`
   and stays there. `Accepted → Active` is the correct transition. Every
   recurring billing period is a `Fulfillment` with a `period` field, not a
   new Commitment. The model's `active` state was designed precisely for
   subscriptions and ongoing services.

2. **Usage measurement is NOT a schema object** — `EntitlementConsumption` is
   described in prose in the spec and not represented as a Fulfillment. Creating
   one Fulfillment per API call would be architecturally wrong: a developer
   making 135,000 calls would generate 135,000 schema objects. Instead, call
   measurement is a lightweight side-record outside the commerce model. Periodic
   billing Fulfillments summarise the period; the model records outcomes, not
   every measurement event.

3. **Overage creates a child Commitment automatically** — when period-end
   measurement detects that consumption exceeded the included quota, the billing
   system (`sys_billing`, `PartyType::System`) creates a child Commitment
   (`OVERAGE-1`). The child carries `parent: "PLAN-1"` and the plan lists it in
   `children: ["OVERAGE-1"]`. Invariant 6 requires this bidirectional link.

4. **Money always carries currency** — every amount here is `USD`; there are no
   bare decimal numbers.

---

## The scenario

**RapidData Inc.** sells an API Pro plan to **DevCorp**:

| Plan attribute | Value |
|---|---|
| Included calls | 100,000 / month |
| Monthly fee | $100.00 USD |
| Overage rate | $0.001 / call |
| API endpoint | `https://api.rapiddata.io/v2` |

In June 2026, DevCorp consumes **135,000 calls** — 35,000 over the included
quota. At period end (2026-07-01T00:00:00), the billing system closes the month
and creates an overage child Commitment for **$35.00 USD** (35,000 × $0.001).

---

## EntitlementConsumption — prose-level record (not a schema object)

The spec (§ Primitive 5, "EntitlementConsumption") defines a lightweight
measurement record for metered digital services:

```
EntitlementConsumption {
  id:                        "ec-20260615-call-batch-88"
  commitment:                "PLAN-1"
  entitlement:               "api-calls"
  consumed_this_event:       500          // calls in this batch measurement
  total_consumed_this_period: 68_420      // running total at measurement time
  total_allowed_this_period:  100_000
  period:                    DateRange(2026-06-01, 2026-06-30)
  timestamp:                 "2026-06-15T14:22:00+00:00"
  overage:                   false
}
```

These records are written by the API gateway on every metering window (e.g.,
every minute or every N calls). They live in a time-series store, not in the
commerce model. They are not `Fulfillment` objects, not `Value` objects, and
not `Commitment` children. They inform when to create an overage child
Commitment, but they are not commerce events in themselves.

**FINDING F-1:** `EntitlementConsumption` has a well-specified prose definition
in the spec (§ Primitive 5) but there is no corresponding `$defs/EntitlementConsumption`
entry in `schema/commerce.schema.json`. This is the correct design decision —
per-call consumption records are a runtime concern, not a commerce-state concern.
The schema validates commerce primitives; a separate metering schema or
time-series sink is the right place for consumption records. The absence is
intentional, not an omission.

---

## The model objects

### Plan Commitment (PLAN-1) — `accepted → active`

The developer's signup forms an `Intent`. Checkout converts it to the plan
`Commitment`. The Commitment follows `draft → proposed → accepted → active`.
It does **not** reach `fulfilled` while the subscription is live.

Two `Fulfillment`s execute immediately:

- **F-ACCESS-1** (`digital_delivery`): provisions the API key and moves
  `val_api_access` to `access_granted`.
- **F-MONTHLY-FEE-1** (`money_transfer`): collects the first month's fee ($100).
  This Fulfillment carries `period: ["2026-06-01T00:00:00+00:00", "2026-06-30T23:59:59+00:00"]`.

```json
{
  "id": "PLAN-1",
  "parties": { "initiator": "party_devcorp", "counterparty": "party_rapiddata", "intermediaries": ["sys_billing"] },
  "state": "active",
  "history": [
    { "from": "draft",     "to": "proposed", "at": "2026-06-01T00:00:00+00:00", "actor": "party_devcorp" },
    { "from": "proposed",  "to": "accepted",  "at": "2026-06-01T00:01:00+00:00", "actor": "party_rapiddata" },
    { "from": "accepted",  "to": "active",    "at": "2026-06-01T00:05:00+00:00", "actor": "party_rapiddata",
      "reason": "first monthly fee collected; API key provisioned; subscription live" }
  ],
  "children": ["OVERAGE-1"]
}
```

### Access Value — `access_granted`

The API plan is a non-exclusive `digital_good`. Granting DevCorp access does
not remove anything from RapidData's catalog. Invariant 1 applies to access
rights (the quota), not to the service itself.

```json
{
  "id": "val_api_access",
  "form": { "type": "digital_good", "identifier": "RAPIDDATA-API-PRO-100K",
            "access_model": "api_access", "calls_per_period": 100000 },
  "state": { "access_granted": { "to": "party_devcorp", "granted_at": "2026-06-01T00:00:00+00:00", "expires_at": null } }
}
```

`expires_at: null` signals that access continues month-to-month for as long as
the plan `Commitment` stays `active`. If the subscription is cancelled,
`access_revoked` is the correct next state — never `transferred`.

### Overage child Commitment (OVERAGE-1) — auto-created at period end

At 2026-07-01T00:00:00, the billing system closes June. Measurement shows
135,000 calls consumed against a 100,000-call quota. `sys_billing` (a
`PartyType::System` party acting on behalf of RapidData) creates `OVERAGE-1`:

```json
{
  "id": "OVERAGE-1",
  "parties": { "initiator": "party_rapiddata", "counterparty": "party_devcorp", "intermediaries": ["sys_billing"] },
  "state": "fulfilled",
  "history": [
    { "from": "draft",    "to": "proposed",   "at": "2026-07-01T00:00:00+00:00", "actor": "sys_billing",
      "reason": "period closed; 35,000 overage calls at $0.001/call = $35.00; child Commitment created automatically" },
    { "from": "proposed", "to": "accepted",   "at": "2026-07-01T00:01:00+00:00", "actor": "party_rapiddata",
      "reason": "overage billing terms pre-accepted in plan sign-up; auto-accepted per metered billing policy" },
    { "from": "accepted", "to": { "partially_fulfilled": { "fulfilled_item_ids": [], "remaining_item_ids": ["val_overage_charge"] } },
      "at": "2026-07-01T02:00:00+00:00", "actor": "sys_billing" },
    { "from": { "partially_fulfilled": { ... } }, "to": "fulfilled",
      "at": "2026-07-01T02:10:00+00:00", "actor": "sys_billing",
      "reason": "overage payment collected; $35.00 transferred to RapidData" }
  ],
  "parent": "PLAN-1",
  "children": []
}
```

The roles are **reversed** from the plan: here `party_rapiddata` is the
initiator (they are billing the customer), and `party_devcorp` is the
counterparty. This mirrors the physical-ecommerce return pattern: when value
flows in the opposite direction, the initiator/counterparty swap, not the
model.

**Invariant 6 — bidirectional link:**

| Object | Field | Value |
|---|---|---|
| `PLAN-1` | `children` | `["OVERAGE-1"]` |
| `OVERAGE-1` | `parent` | `"PLAN-1"` |

Both sides are present. `auditCommerce` checks this explicitly. A missing link
in either direction is a hard error.

### Overage Fulfillment (F-OVERAGE-PAY-1) — with `period`

The overage payment Fulfillment carries the billing period it covers:

```json
{
  "id": "F-OVERAGE-PAY-1",
  "commitment": "OVERAGE-1",
  "state": "completed",
  "period": ["2026-06-01T00:00:00+00:00", "2026-06-30T23:59:59+00:00"],
  "method": { "money_transfer": { "mechanism": "card_on_file", "reference": "stripe-ovg-9a4k2r-jun2026" } },
  "evidence": [{ "payment_receipt": { "reference": "stripe-ovg-9a4k2r-jun2026", "amount": "35.00", "currency": "USD", "timestamp": "2026-07-01T02:10:00+00:00" } }]
}
```

The `period` field (a two-element ISO 8601 array) identifies which billing
window this payment covers. This allows auditability: "which overage was paid
for which period" is answerable from the model alone.

---

## Lifecycle as a transition sequence

```
Intent intent_devcorp_api_plan:   active → converted(PLAN-1)

Commitment PLAN-1 (subscription):
  draft → proposed → accepted → active    [stays active; subscription ongoing]

  Fulfillment F-ACCESS-1      (digital_delivery):  planned → in_progress → completed
  Fulfillment F-MONTHLY-FEE-1 (money_transfer):    planned → in_progress → completed
                                                    period: [2026-06-01, 2026-06-30]

  [EntitlementConsumption records accumulate throughout June — lightweight
   measurement, NOT schema objects; total reaches 135,000/100,000 at period end]

  [2026-07-01T00:00:00 — billing system detects 35,000 overage calls]

  ──── auto-creates OVERAGE-1 (child of PLAN-1) ────

Commitment OVERAGE-1 (overage child):
  draft → proposed → accepted → partially_fulfilled → fulfilled

  Fulfillment F-OVERAGE-PAY-1 (money_transfer):    planned → in_progress → completed
                                                    period: [2026-06-01, 2026-06-30]
```

---

## Why `accepted → active`, not `accepted → partially_fulfilled → fulfilled`

A subscription plan is perpetually in progress. It produces recurring
Fulfillments (one per billing period) but it does not "run out" of items to
deliver. The `fulfilled` state means "all obligations met by all parties" — a
terminal condition. For a subscription that never terminates on its own, this
state is never reached while the subscription is live.

The `active` state is the correct model for any subscription or ongoing service.
The plan Commitment stays `active` until the customer cancels (`active →
cancelled`) or a dispute arises (`active → disputed`).

Each month's Fulfillment reports on a period; the Commitment itself does not
advance. This is load-bearing for metered billing: the audit trail for "what did
DevCorp pay in June" lives in Fulfillment `period` fields, not in Commitment
history.

---

## Metered payment timing — prose extension

The spec's `PaymentTiming::Metered` variant reads:

```
Metered {
  rate: Money    // per unit
  unit: String
  period: Duration
  cap: Option<Money>
}
```

For the RapidData plan:

| Field | Value |
|---|---|
| `rate` | `{ "amount": "0.001", "currency": "USD" }` per call |
| `unit` | `"api_call"` |
| `period` | monthly |
| `cap` | null (uncapped overage) |

These terms are agreed at plan sign-up (when the Commitment transitions
`proposed → accepted`). The acceptance records "overage billing terms
pre-accepted." This is why `OVERAGE-1` can be auto-accepted by the billing
system — consent was given upfront, not at overage time.

The metered rate is a prose-level term on the plan Commitment. The schema's
`Commitment` object does not have a `terms` field with typed `PaymentTiming`
(the schema carries the structural state machine, not the full term vocabulary
from the spec). The rate and unit are documented in the case study prose and
referenced in transition reasons.

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | API access is a non-exclusive digital good. Conservation applies to access rights (the call quota), not the service itself. The overage child Commitment records the monetary obligation for calls beyond quota — the value `val_overage_charge` is transferred to RapidData. All Value references resolve: `val_api_access` references no Commitment (it is `access_granted`, not `committed`), `val_monthly_fee` and `val_overage_charge` are transferred. |
| **I-2 State Monotonicity** | `PLAN-1` runs `draft → proposed → accepted → active`; it never goes backward. `OVERAGE-1` runs `draft → proposed → accepted → partially_fulfilled → fulfilled`; forward throughout. Every transition in both histories is in the valid transitions table. |
| **I-3 Capacity Verification** | All parties carry verified capacity before `PLAN-1` reaches `accepted`. `party_rapiddata.capacity.can_sell = true`; `party_devcorp.capacity.can_buy = true`; `sys_billing.capacity.can_fulfill = true`. All `verified_at` timestamps precede the `accepted` transition. |
| **I-4 Temporal Integrity** | All timestamps in all histories are non-decreasing. June 2026 timestamps appear in `PLAN-1`; July 2026 timestamps appear in `OVERAGE-1` (created after period close). The `F-OVERAGE-PAY-1` Fulfillment `period` field spans June even though the payment itself occurs in July — this is correct: the period names the billing window, not the payment date. |
| **I-5 Identity Permanence** | All seven IDs (`party_rapiddata`, `party_devcorp`, `sys_billing`, `val_api_access`, `val_monthly_fee`, `val_overage_charge`, `intent_devcorp_api_plan`, `PLAN-1`, `OVERAGE-1`, `F-ACCESS-1`, `F-MONTHLY-FEE-1`, `F-OVERAGE-PAY-1`) are unique across the fixture. |
| **I-6 Commitment Tree Consistency** | `PLAN-1.children = ["OVERAGE-1"]` and `OVERAGE-1.parent = "PLAN-1"`. Both directions present. `auditCommerce` validates both. A missing link in either direction is a hard error. |

---

## Extensions exercised

### Metered payment timing

`PaymentTiming::Metered` (spec § Primitive 4, CommitmentTerms) captures
usage-based billing: a rate per unit, a period, and an optional cap. The plan's
acceptance terms include the metered rate ($0.001/call). At period end the
billing system can calculate the exact overage amount without requiring any new
negotiation — the rate was agreed at plan sign-up.

### EntitlementConsumption

Per the spec (§ Primitive 5): "When a digital service is accessed on a metered
basis every access is recorded as EntitlementConsumption rather than as a
Fulfillment. Creating a Fulfillment per API call would be architecturally
incorrect and computationally prohibitive."

DevCorp's 135,000 calls generate 135,000 `EntitlementConsumption` records in
a side store (e.g., a time-series database). The commerce model only ever sees
two `Fulfillment` objects for the June period: `F-MONTHLY-FEE-1` (subscription
fee) and `F-OVERAGE-PAY-1` (overage charge). The consumption records are
invisible to the commerce model — they are metering infrastructure.

### Overage child Commitment

When `total_consumed_this_period` exceeds `total_allowed_this_period` in an
`EntitlementConsumption` record, the billing system creates an overage child
Commitment. The child:

- Has `parent` set to the plan Commitment
- Is listed in the plan Commitment's `children` array
- Is created by `sys_billing` (a `PartyType::System` party)
- Carries the overage amount as a `money` Value
- Runs its own full `draft → proposed → accepted → [partially_fulfilled] → fulfilled` lifecycle
- Has a `money_transfer` Fulfillment with a `period` identifying the billing window

This is the correct way to model "an obligation that was discovered after the
fact." The overage is not a modification of the plan Commitment; it is a new
forward-moving Commitment that is a child of the plan. State Monotonicity holds.
The plan stays `active`.

---

## Findings

**FINDING F-1 (schema gap — intentional):** `EntitlementConsumption` is
specified in detail in `docs/WARP_COMMERCE_MODEL.md` (§ Primitive 5) but has
no entry in `schema/commerce.schema.json`. This is correct by design: per-call
consumption is metering infrastructure, not commerce state. The schema validates
commerce primitives. A separate metering schema is the appropriate home for
`EntitlementConsumption`. No schema change is needed; the absence is
intentional.

**FINDING F-2 (rate_limit and calls_per_period as open properties):** The
`ValueForm.digital_good` type is intentionally open (`required: ["type"]` only;
no `additionalProperties: false`). The `calls_per_period`, `period`, `endpoint`,
and `features` fields on `val_api_access` are expressible as form properties but
are not structurally enforced by the schema. They are prose-level model
extensions — present in the fixture, named in `extensions_exercised`, documented
in case-study prose. A future schema tightening could add a structured
`api_access` branch without changing the five primitives.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/api-metering
# ✓ conformance/case-studies/api-metering/api-plan-with-overage.json
# auditCommerce: 1 passed, 0 failed, 0 warnings, 1 fixtures
```
