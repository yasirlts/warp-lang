> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/streaming/streaming.json`](../../conformance/case-studies/streaming/streaming.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Streaming — Monthly Subscription with Access Suspension

> **Adversarial test corpus — executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below is a real fixture under
> [`conformance/case-studies/streaming/`](../../conformance/case-studies/streaming/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs conformance/case-studies/streaming`.

**Reference platforms:** Netflix, Shahid, OSN+, Spotify, Apple TV+.  
**Fixture:** [`subscription-with-failed-payment.json`](../../conformance/case-studies/streaming/subscription-with-failed-payment.json)

---

## The domain and the hard cases it stresses

Digital streaming subscriptions are the canonical example of **non-exclusive
digital goods with recurring billing**. The hard part is not the happy path —
it is the **failed payment → access suspension → recovery** cycle.

The model stresses this domain in three ways:

- **Active Commitment that never reaches Fulfilled.** A subscription is an
  ongoing relationship, not a one-time exchange. The Commitment transitions
  `accepted → active` and then stays `active` indefinitely while billing cycles
  run. It reaches `fulfilled` only if it were ever to complete all obligations
  — which for an open-ended subscription never happens while running.
  `auditCommerce` accepts `active` as a terminal snapshot state.

- **Monthly billing as periodic Fulfillments with `period`.** Each billing
  cycle produces two Fulfillments under the same parent Commitment: a
  `money_transfer` (payment) and a `digital_delivery` (access token refresh).
  Each carries a `period` field — the `[start, end]` billing window the
  Fulfillment covers. This models the subscription billing pattern: one
  Commitment, many timed Fulfillments.

- **Failed payment triggers `access_suspended`; recovery restores
  `access_granted`.** When month-2 billing fails, the subscriber's stream
  access is suspended (not revoked — the subscription is still in good
  standing, just paused). The Value moves to `access_suspended` with a
  `restore_condition`. The failed Fulfillment carries `recoverable: true`.
  When the subscriber updates their payment method and the retry succeeds,
  the Fulfillment retries via the `failed → planned → in_progress → completed`
  path, and access is restored with a fresh `access_granted` state.

---

## The model objects

The subscriber's signup forms an `Intent`. Checkout converts it to a
`Commitment`. The Commitment follows `draft → proposed → accepted → active`
and stays `active`. Each billing cycle under the active Commitment produces:

1. A `money_transfer` Fulfillment for the monthly fee (99 MAD), carrying
   a `period` covering the billing month.
2. A `digital_delivery` Fulfillment granting a stream access token, also
   carrying a `period`.

The shape of the active Commitment:

```json
{
  "id": "SUB-1",
  "parties": {
    "initiator": "party_subscriber_youssef",
    "counterparty": "party_streamco",
    "intermediaries": ["sys_billing_engine"]
  },
  "state": "active",
  "history": [
    { "from": "draft",    "to": "proposed", "at": "2026-05-01T09:58:00+00:00", "actor": "party_subscriber_youssef" },
    { "from": "proposed", "to": "accepted", "at": "2026-05-01T10:00:00+00:00", "actor": "party_streamco" },
    { "from": "accepted", "to": "active",   "at": "2026-05-01T10:05:00+00:00", "actor": "party_streamco",
      "reason": "first billing cycle collected; subscription running" }
  ]
}
```

### The stream Value — access lifecycle

The stream access Value (`val_stream_access`) carries the `Stream` access
model as open form properties — `simultaneous_streams: 2`, `catalog`, and
`offline_downloads` — the "Stream access model" extension named in
`extensions_exercised`. The current state in the fixture is `access_granted`
(after month-2 recovery):

```json
{
  "id": "val_stream_access",
  "form": {
    "type": "digital_good",
    "identifier": "STREAMCO-STANDARD-MONTHLY",
    "exclusivity": "non_exclusive",
    "access_model": "stream",
    "simultaneous_streams": 2,
    "offline_downloads": 5,
    "catalog": "streamco-standard-catalog-v1"
  },
  "state": {
    "access_granted": {
      "to": "party_subscriber_youssef",
      "granted_at": "2026-06-05T11:00:00+00:00",
      "expires_at": null
    }
  }
}
```

`expires_at: null` signals an open-ended grant that renews each cycle;
suspension/revocation is how access ends, not timestamp expiry.

### The failed payment — `recoverable: true` and retry

Month-2 billing fails on the first attempt (card declined). The Fulfillment
`F-PAY-M2` reaches `failed` with `recoverable: true`. Four days later the
subscriber updates their payment method. The billing engine retries: the
Fulfillment transitions `failed → planned → in_progress → completed`.
This is the only path `failed → planned` is valid — the audit checks that
the `failed` state in the `from` field carries `recoverable: true`.

```json
{
  "id": "F-PAY-M2",
  "state": "completed",
  "history": [
    { "from": "planned",   "to": "in_progress", "at": "2026-06-01T10:00:00+00:00", "actor": "sys_billing_engine" },
    { "from": "in_progress", "to": { "failed": { "reason": "Card declined: insufficient funds", "recoverable": true } },
      "at": "2026-06-01T10:01:00+00:00", "actor": "sys_billing_engine" },
    { "from": { "failed": { "reason": "Card declined: insufficient funds", "recoverable": true } },
      "to": "planned", "at": "2026-06-05T10:55:00+00:00", "actor": "sys_billing_engine" },
    { "from": "planned",   "to": "in_progress", "at": "2026-06-05T10:57:00+00:00", "actor": "sys_billing_engine" },
    { "from": "in_progress", "to": "completed", "at": "2026-06-05T11:00:00+00:00", "actor": "sys_billing_engine" }
  ],
  "period": ["2026-06-01T00:00:00+00:00", "2026-06-30T23:59:59+00:00"]
}
```

---

## Lifecycle as a transition sequence

```
Intent INT-STREAM-1:        active → converted(SUB-1)

Commitment SUB-1:           draft → proposed → accepted → active  [stays active]

  ── Month 1 (May 2026) ──────────────────────────────────────────
  Fulfillment F-PAY-M1    (money_transfer, period=May):   planned → in_progress → completed
  Fulfillment F-ACCESS-M1 (digital_delivery, period=May): planned → in_progress → completed
  ValueState val_stream_access: available → access_granted

  ── Month 2 (June 2026) — payment fails ─────────────────────────
  Fulfillment F-PAY-M2    (money_transfer, period=Jun):
      planned → in_progress → failed(recoverable:true)
      → planned → in_progress → completed           [retry after card update]

  ── Month 2 — access suspended during grace period ───────────────
  ValueState val_stream_access: access_granted → access_suspended
                                (restore_condition: "billing retry succeeds")

  ── Month 2 — payment recovers, access restored ──────────────────
  Fulfillment F-ACCESS-M2 (digital_delivery, period=Jun):
      planned → in_progress → completed
  ValueState val_stream_access: access_suspended → access_granted
```

---

## Why the Commitment stays `active` rather than reaching `fulfilled`

The model defines `Active` as the state for subscriptions and ongoing
services that are perpetually in progress. A subscription Commitment is
never `Fulfilled` while it runs — `Fulfilled` would imply all obligations
are complete, which contradicts a subscription that renews next month.

The valid path is `accepted → active`; the Commitment stays `active`
until the subscriber cancels (`active → cancelled`) or a dispute opens
(`active → disputed`). The individual billing-cycle Fulfillments reach
`completed` — but their parent Commitment does not.

This is the structural discipline the streaming domain imposes on the model:
the Commitment-level lifecycle and the Fulfillment-level lifecycle are
independent. Many `completed` Fulfillments can coexist under one `active`
Commitment.

---

## Why `access_suspended` rather than `access_revoked`

`access_revoked` is terminal — there is no return from revocation.
`access_suspended` carries a `restore_condition`, signalling that the
grant can be restored. This distinction matters operationally:

- `access_suspended(restore_condition: "billing retry succeeds")` —
  the subscription is in a grace period; the account is recoverable.
- `access_revoked` — the subscription is terminated (used when a
  subscriber cancels or when a fraud/ToS violation is confirmed).

The GracePeriod commitment condition (a v0.3 spec extension, expressible
as prose in the Commitment's terms) governs how long the system waits
between the failed payment and suspension, and between suspension and
escalation to revocation. This case study exercises a 4-day grace window:
billing failed June 1; subscriber updated card by June 5; access was
suspended in the interim and restored on recovery. No escalation to
revocation occurred.

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | Non-exclusive digital goods: `val_stream_access` records access rights, not a transferred physical unit. The provider retains the stream catalog. Conservation applies to the access grants pool — the provider cannot grant more streams than their licensing permits. Monthly payment Values each transfer to the provider; the amounts carry `MAD` currency throughout. |
| **I-2 State Monotonicity** | Subscription Commitment reaches `active` and stays there — no backward transition. `F-PAY-M2` goes `failed → planned → in_progress → completed` — all forward. The `access_suspended → access_granted` value-state arc is also forward (not a rollback). `auditCommerce` rejects any history gap or out-of-table transition. |
| **I-3 Capacity Verification** | Both `party_subscriber_youssef` and `party_streamco` carry `verified_at` timestamps before the Commitment reaches `accepted`. The billing system party (`sys_billing_engine`) carries `verified_at` for its fulfiller capacity. |
| **I-4 Temporal Integrity** | Every history in every Commitment and Fulfillment is timestamp-monotonic. The month-2 retry timestamps (June 5) are strictly later than the initial failure (June 1). |
| **I-5 Identity Permanence** | All IDs — `SUB-1`, `INT-STREAM-1`, the three party IDs, the three value IDs, and the four fulfillment IDs — are globally unique within the fixture. No ID is reused. |

---

## Extensions exercised

**Stream access model (`simultaneous_streams`):** The `val_stream_access`
form carries `access_model: "stream"` with `simultaneous_streams: 2` and
`offline_downloads: 5`. These are open form properties (the schema requires
only `type` on `ValueForm`; additional fields are permitted). They are the
conservation bound for Invariant 1: the provider cannot grant more than 2
simultaneous streams per subscription seat. Stream catalog detail and
per-device limits are prose-level metadata; the model carries them on the
form without structural enforcement.

**GracePeriod / AccessSuspended:** The gap between payment failure (June 1)
and access suspension, and the restoration path when the subscriber pays,
exercises the `GracePeriod` commitment condition from v0.3. The condition
is a prose-level term on the subscription Commitment (not serialized in the
P1-P3 fixture fields, which are schema-constrained). Its effect is visible
in the Value lifecycle: `access_suspended` with `restore_condition: "billing
retry succeeds within grace period"` records the operational semantics.
The `extensions_exercised` array names this extension for traceability.

---

## FINDINGS

**F-1 (ValueState history not modelled):** The schema has no `history`
array on `Value` — only a current `state` snapshot. The transition
`access_granted → access_suspended → access_granted` is therefore
reconstructible from the Fulfillment timestamps and the current Value state
but is not recorded as a first-class history chain on the Value object.
For audit purposes the Fulfillment histories serve as the authoritative
record of when each state change occurred. A future schema extension
could add a `ValueStateHistory` array to the Value primitive to make
the access lifecycle directly queryable without joining through Fulfillments.

**F-2 (GracePeriod not structurally serialized):** The GracePeriod
commitment condition (`duration`, `trigger`, `restore_condition`,
`if_not_restored`) is defined in the spec's prose model but has no
corresponding field in the serialized Commitment object. It is captured
in `extensions_exercised` and described in the case-study prose. The
operational effect — suspension with a restore condition — is fully
expressible via the `access_suspended` ValueState. The condition's
parameters (grace duration, escalation policy) are not structurally
queryable from the fixture alone.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/streaming
# ✓ conformance/case-studies/streaming/subscription-with-failed-payment.json
# auditCommerce: 1 passed, 0 failed, 0 warnings, 1 fixtures
```
