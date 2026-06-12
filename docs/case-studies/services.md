> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/services/services.json`](../../conformance/case-studies/services/services.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Services Commerce

> **Adversarial test corpus — executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON fixtures under
> [`conformance/case-studies/services/`](../../conformance/case-studies/services/)
> validate against [schema v1.0.0](../../schema/commerce.schema.json) and
> pass `auditCommerce`. Run them: `node conformance/audit.mjs conformance/case-studies/services`.

**Reference platforms:** Calendly, Mindbody, Stripe Billing, FitStream, local salon booking apps.

**Fixtures:**
- [`appointment-no-show.json`](../../conformance/case-studies/services/appointment-no-show.json)
- [`subscription-failed-payment-retry.json`](../../conformance/case-studies/services/subscription-failed-payment-retry.json)

---

## The domain and the hard cases it stresses

Services commerce differs from physical goods in three structural ways:

1. **The value is consumed at the moment of production.** A haircut cannot be
   warehoused. A fitness session cannot be returned. The service Value exists
   as a time-slot reservation before it is delivered, and transitions
   immediately to evidence of completion — there is no in-transit phase.

2. **Non-attendance is a commerce event.** When a client books a slot and does
   not arrive, the service Value is consumed (the slot is blocked, the
   performer is present) but the Commitment is not fulfilled. The provider's
   contractual right to a no-show fee is a *new forward Commitment* — not a
   mutation of the original booking.

3. **Subscriptions never reach `fulfilled`.** An ongoing subscription
   Commitment transitions `accepted → active` and stays `active` indefinitely.
   Each billing period is a separate `Fulfillment` with a `period` [start, end]
   pair. The Commitment closing is always an explicit cancellation or a dispute,
   never a natural fulfillment.

The hard cases this domain exercises:

- **No-show fee path:** The no-show Commitment is a child of the cancelled
  booking Commitment. This verifies Invariant 6 (parent-child tree consistency)
  and Invariant 2 (the booking reaches `cancelled` cleanly while the fee
  Commitment runs its own forward lifecycle to `fulfilled`).
- **Recoverable payment failure and retry:** A billing Fulfillment transitions
  `planned → in_progress → failed(recoverable:true) → planned → in_progress →
  completed`. The `failed → planned` arc is the only conditional transition in
  the model: it is only valid when the failure's `recoverable` flag is `true`.
  This is the executable expression of a grace period.
- **`ReservationBasis.time_slot` and `recurring_time_slot`:** Service capacity
  is not physical stock. The model uses `time_slot` (a single appointment
  window) and `recurring_time_slot` (multiple future billing windows for a
  subscription) to show that the capacity being reserved is the performer's
  time, not a unit of inventory.

---

## Fixture 1 — Appointment with no-show policy

**File:** `appointment-no-show.json`

### Scenario

Two clients book hair appointments at Salon Zaha in Casablanca on the same day:

- **Salma** attends her 10:00–11:00 appointment. Service is performed, payment
  is collected at the chair. Commitment reaches `fulfilled`.
- **Tariq** books a 14:00–15:00 slot but does not arrive. After the 15-minute
  grace period (a `NoShowPolicy` term in the booking conditions), the salon
  cancels the appointment Commitment and immediately raises a no-show fee
  Commitment for MAD 50.

### NoShowPolicy — prose, not a schema field

`NoShowPolicy` is a prose-level term from the Commerce Model spec (v0.3). It
describes terms attached to a Commitment: a grace window, a fee amount, and
what happens if the client does not appear within the window. In the model it
manifests as:

1. The booking Commitment's `reason` field at `accepted` records the policy
   terms (`grace_minutes=15, fee=MAD 50`).
2. When the no-show occurs, the booking Commitment transitions
   `accepted → cancelled` (by the salon, with reason).
3. A new child Commitment (`CMT-NSFEE-1`) is created with the salon as
   `initiator` and the client as `counterparty`. It runs its own lifecycle
   to `fulfilled` via a `money_transfer` Fulfillment.

There is no `NoShowPolicy` field in the schema. The policy's mechanical
consequence — the fee Commitment — is fully representable in the base
primitives. This is recorded as `extensions_exercised: ["NoShowPolicy"]`
to flag that the prose term is exercised here even though no new schema
keyword is required.

### Value state: `reserved` with `time_slot`

```json
{
  "id": "val_haircut_session_salma",
  "form": { "type": "service", "service_type": "hair_styling", "duration_minutes": 60 },
  "state": {
    "reserved": {
      "commitment_id": "CMT-APPT-1",
      "basis": {
        "time_slot": {
          "slot_start": "2026-06-12T10:00:00+00:00",
          "slot_end":   "2026-06-12T11:00:00+00:00",
          "capacity_unit": "stylist_chair"
        }
      }
    }
  }
}
```

`capacity_unit: "stylist_chair"` distinguishes service capacity from physical
stock (Invariant 3: capacity reservation is explicit and verifiable).

### Lifecycle

```
Intent INT-BOOK-1:   active → converted(CMT-APPT-1)
Intent INT-BOOK-2:   active → converted(CMT-APPT-2)

Commitment CMT-APPT-1 (Salma — attended):
  draft → proposed → accepted
    → partially_fulfilled(service done, payment pending)
    → fulfilled

  Fulfillment F-SERVICE-1 (service_performance): planned → in_progress → completed
  Fulfillment F-PAY-APPT-1 (money_transfer):     planned → in_progress → completed

Commitment CMT-APPT-2 (Tariq — no-show):
  draft → proposed → accepted → cancelled(by salon, NoShowPolicy)
  [children: CMT-NSFEE-1]

Commitment CMT-NSFEE-1 (no-show fee — child of CMT-APPT-2):
  draft → proposed → accepted
    → partially_fulfilled(fee pending)
    → fulfilled

  Fulfillment F-NSFEE-1 (money_transfer): planned → in_progress → completed
```

### Why the appointment Commitment goes through `partially_fulfilled`

A service appointment delivers two values: the service itself and the payment.
These are Fulfillments in sequence. The model requires `accepted →
partially_fulfilled` (service performed, payment outstanding) before
`partially_fulfilled → fulfilled` (payment received). There is no
`accepted → fulfilled` shortcut — that transition is not in the valid table.

### Evidence

The attended appointment uses `service_completion` evidence (Invariant 2:
completion evidence is part of the Fulfillment record):

```json
{
  "service_completion": {
    "confirmed_by": "party_salon_zaha",
    "timestamp": "2026-06-12T11:05:00+00:00",
    "duration_minutes": 63,
    "notes": "cut and blow-dry; client satisfied"
  }
}
```

---

## Fixture 2 — Subscription with failed payment grace period

**File:** `subscription-failed-payment-retry.json`

### Scenario

Nadia subscribes to FitStream Premium (MAD 99/month). Month 1 and Month 3 bill
cleanly. Month 2 (due 2026-05-01) fails with `card_declined:
insufficient_funds`. The platform honours a 7-day grace period and retries on
2026-05-08; the retry succeeds. The subscription Commitment remains `active`
throughout — it never pauses or cancels due to the transient failure.

### GracePeriod — prose, not a schema field

`GracePeriod` is a prose-level term: a window after a billing failure during
which the subscription remains active and the payment is retried. Its
mechanical expression in the model is the `recoverable:true` flag on the
`failed` Fulfillment state, which unlocks the otherwise-forbidden
`failed → planned` retry transition. The 7-day window itself is business
logic in the platform, not a schema constraint.

### Subscription stays `active` — it never reaches `fulfilled`

```
Commitment CMT-SUB-1:
  draft → proposed → accepted → active
  (stays active; each month is a Fulfillment)
```

The `accepted → active` transition requires the Commitment to be a subscription
or ongoing service type (per the model's transition table). `active` is the
correct terminal state for a live subscription. The Commitment only leaves
`active` via `cancelled` (cancellation), `modified` (plan change), or
`disputed`.

### RecurringTimeSlot — capacity reservation across billing windows

```json
{
  "id": "val_sub_access",
  "state": {
    "reserved": {
      "commitment_id": "CMT-SUB-1",
      "basis": {
        "recurring_time_slot": {
          "slots": [
            ["2026-04-01T00:00:00+00:00", "2026-05-01T00:00:00+00:00"],
            ["2026-05-01T00:00:00+00:00", "2026-06-01T00:00:00+00:00"],
            ["2026-06-01T00:00:00+00:00", "2026-07-01T00:00:00+00:00"]
          ]
        }
      }
    }
  }
}
```

`recurring_time_slot` signals that the reserved capacity spans multiple
future periods. Each slot corresponds to one billing Fulfillment. This makes
the capacity reservation explicit and machine-verifiable (Invariant 3).

### The failed-payment retry — the conditional transition

The Month 2 billing Fulfillment (`F-BILL-M2`) is the key state machine:

```
planned → in_progress → failed(reason:"card_declined", recoverable:true)
       → planned [RETRY — only valid because recoverable:true]
       → in_progress → completed
```

The `failed → planned` arc is the only transition in the entire model that
is conditionally valid. The auditor enforces: if a Fulfillment history shows
`failed → planned`, the `failed` state's `recoverable` flag MUST be `true`.
A terminal failure (`recoverable:false`) cannot retry — it can only be
superseded by the platform creating a new Fulfillment.

```json
{
  "from": "in_progress",
  "to": { "failed": { "reason": "card_declined: insufficient_funds", "recoverable": true } },
  "at": "2026-05-01T08:02:00+00:00",
  "actor": "party_fitstream"
},
{
  "from": { "failed": { "reason": "card_declined: insufficient_funds", "recoverable": true } },
  "to": "planned",
  "at": "2026-05-01T08:03:00+00:00",
  "actor": "party_fitstream"
}
```

### Period field on billing Fulfillments

Each billing Fulfillment carries a `period` array to identify which calendar
month it covers:

```json
"period": ["2026-05-01T00:00:00+00:00", "2026-06-01T00:00:00+00:00"]
```

This is the model's `Option<DateRange>` field — available on any Fulfillment
but mandatory for subscription billing periods where you need to know which
month a payment covers.

---

## Invariants exercised

| Invariant | Fixture | How exercised |
|-----------|---------|---------------|
| **I-2 State Monotonicity** | Both | Appointment: `partially_fulfilled` path; no-show booking reaches `cancelled` (forward, not backward). Subscription: `active` Commitment stays active; retry arc validated as conditional. |
| **I-3 Capacity Verification** | Both | `time_slot` and `recurring_time_slot` on Value make capacity reservation explicit. All parties reaching Accepted carry `verified_at`. |
| **I-4 Temporal Integrity** | Both | All history timestamps non-decreasing; retry Fulfillment timestamps across the 7-day gap are monotonic. |
| **I-5 Identity Permanence** | Both | All ids across parties, values, intents, commitments, fulfillments are unique within each fixture. |
| **I-6 Commitment Tree Consistency** | Fixture 1 | `CMT-NSFEE-1.parent = CMT-APPT-2`; `CMT-APPT-2.children = ["CMT-NSFEE-1"]`. Auditor verifies bidirectional linkage. |
| **I-1 Value Conservation** | Both | Every Value's `commitment_id` resolves; every Fulfillment's `commitment` field resolves. |

---

## Extensions exercised

| Extension | Fixture | Representation |
|-----------|---------|----------------|
| **NoShowPolicy** | Fixture 1 | Prose term in booking conditions. Mechanically expressed as: `CMT-APPT-2` cancelled (accepted→cancelled), then child `CMT-NSFEE-1` Commitment for the fee. No schema field required. |
| **GracePeriod** | Fixture 2 | Prose term. Mechanically expressed as `recoverable:true` on the failed billing Fulfillment, enabling the `failed→planned` retry transition. |
| **ServicePerformance** | Both | `FulfillmentMethod.service_performance` with performer, location, and scheduled_at fields. `Evidence.service_completion` with confirmed_by, timestamp, duration_minutes, notes. |
| **RecurringTimeSlot** | Fixture 2 | `ReservationBasis.recurring_time_slot` with three [start, end] slot pairs. |

---

## FINDINGS

**FINDING-SVC-1 (gap, minor):** The `service_completion` Evidence type has no
`no_show` flag or equivalent. When a slot is blocked and the client does not
appear, the Fulfillment for the *booking* simply does not exist — the
appointment Commitment is cancelled rather than fulfilled, so there is no
Fulfillment to attach evidence to. This is correct model behaviour (a
cancelled Commitment has no Fulfillment records), but it means the no-show
event is only recorded in the Commitment history's `reason` string, not as
structured evidence. A future extension could add `NoShowRecord` to the
Evidence set for audit purposes. Not a schema change needed for correct
modelling today.

**FINDING-SVC-2 (observation):** Subscription access delivery (the token grant
that enables platform access) is a distinct Fulfillment (`F-ACCESS-GRANT-1`)
with `digital_delivery` method and `access_grant` evidence. This is separate
from the recurring billing Fulfillments. The separation is correct — access
provisioning happens once at subscription start, billing happens monthly — but
producers should be aware that a subscription Commitment may have N+1
Fulfillments: one access grant and N billing periods.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/services
# ✓ conformance/case-studies/services/appointment-no-show.json
# ✓ conformance/case-studies/services/subscription-failed-payment-retry.json
# auditCommerce: 2 passed, 0 failed, 0 warnings, 2 fixtures
```
