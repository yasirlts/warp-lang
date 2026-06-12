> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/events/events.json`](../../conformance/case-studies/events/events.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Event and Entertainment Commerce

> **Adversarial test corpus — now executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below is a real fixture under
> [`conformance/case-studies/events/`](../../conformance/case-studies/events/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs conformance/case-studies/events`.

**Reference platforms:** Eventbrite, Ticketmaster, Weezevent, local Moroccan event ticketing.
**Fixture:** [`force-majeure-cascade.json`](../../conformance/case-studies/events/force-majeure-cascade.json)

---

## The domain and the hard cases it stresses

Event commerce is deceptively simple on the happy path — sell a ticket, scan
it at the door, done. The hard cases are:

- **Perishable access.** An event ticket is not a perpetual license. It
  expires the moment the event ends. The model must express this without
  inventing a new primitive — it uses `digital_good` with `AccessModel::EventAccess`
  and `ValueState::access_expired` or `access_revoked` at `EventEnd`.

- **Non-transferability.** Many event tickets are tied to a named buyer.
  Resale or transfer is contractually prohibited. This is a prose-level
  restriction on the `ValueForm` (an open property of `DigitalGood`). The
  schema does not enforce it with a dedicated field — the restriction is a
  `CommitmentCondition` in the prose model and documented as a property of
  the `EventAccess` access model.

- **Cascade cancellation.** This is the hardest case: the organiser
  cancels the event. One action must atomically cancel every sold ticket
  and trigger a refund for every buyer. The model handles this through
  the **CascadeCancellation** extension — but critically, **there is no
  schema field for it** (see FINDING-1 below). The cascade is encoded by
  explicitly transitioning every child Commitment to its correct terminal
  state. The automatic propagation is a runtime behaviour documented in
  prose; the fixture encodes the result, not the mechanism.

- **Force majeure mid-event.** One attendee has already entered (ticket
  scanned, `TICKET-1` at `fulfilled`). The event is forcibly halted by
  civil authorities partway through. Two attendees never entered. The
  model must handle both terminal states simultaneously: `fulfilled →
  refunded` for the partial-show victim; `accepted → cancelled` for the
  buyers who never attended.

---

## The model objects

The fixture models the event as a **parent Commitment** (`EVENT-JAZZ-2026`)
whose `children` list the three ticket Commitments. Each ticket Commitment
has `parent` set to `EVENT-JAZZ-2026`. This bidirectional linkage satisfies
**Invariant 6 (Commitment Tree Consistency)**.

Each ticket is a `digital_good` Value with `access_model: EventAccess` —
a v0.3 extension that carries the event identifier, venue, entry window,
`transferable: false`, and the `expiry` property pointing to `EventEnd`.
These are open properties on `ValueForm`; the schema's `ValueForm` object
permits additional keys beyond `type`. The non-transferable restriction and
expiry at `EventEnd` are thus representable in the conformance fixture
without schema changes, but **no dedicated schema field enforces them** —
enforcement is a runtime concern in the Warp compiler.

```
Parties:
  org_warp_events     — event organiser (seller, fulfiller)
  cust_youssef        — Ticket-1 buyer (attended, then refunded)
  cust_fatima         — Ticket-2 buyer (never entered, cancelled + refund)
  cust_omar           — Ticket-3 buyer (never entered, cancelled + refund)
  sys_ticketing       — system intermediary (gate scanner, token issuer)

Values:
  val_ticket_youssef  — digital_good / EventAccess / state: access_expired
  val_ticket_fatima   — digital_good / EventAccess / state: access_revoked
  val_ticket_omar     — digital_good / EventAccess / state: access_revoked
  val_payment_{x}     — money / state: transferred(to: org_warp_events)
```

---

## Lifecycle as a transition sequence

```
Intent INT-YOUSSEF:   active → converted(TICKET-1)
Intent INT-FATIMA:    active → converted(TICKET-2)
Intent INT-OMAR:      active → converted(TICKET-3)

Commitment EVENT-JAZZ-2026 (parent):
  draft → proposed → accepted → cancelled(force majeure)

Commitment TICKET-1 (child — happy path + refund):
  draft → proposed → accepted
        → partially_fulfilled(payment done, ticket pending)
        → fulfilled(QR scanned, entry granted)
        → refunded(350.00 MAD — EventCancellationPolicy)
  Fulfillment F-PAY-YOUSSEF   (money_transfer):   planned → in_progress → completed
  Fulfillment F-ACCESS-YOUSSEF (digital_delivery): planned → in_progress → completed
  Fulfillment F-REFUND-YOUSSEF (money_transfer):   planned → in_progress → completed

Commitment TICKET-2 (child — cascade cancellation + refund):
  draft → proposed → accepted
        → cancelled(force majeure cascade)
  Fulfillment F-PAY-FATIMA    (money_transfer):   planned → in_progress → completed
  Fulfillment F-REFUND-FATIMA (money_transfer):   planned → in_progress → completed

Commitment TICKET-3 (child — cascade cancellation + refund):
  draft → proposed → accepted
        → cancelled(force majeure cascade)
  Fulfillment F-PAY-OMAR      (money_transfer):   planned → in_progress → completed
  Fulfillment F-REFUND-OMAR   (money_transfer):   planned → in_progress → completed
```

**TICKET-1 note:** The transition `accepted → fulfilled` is not in the valid
transition table. The ticket Commitment therefore passes through
`accepted → partially_fulfilled → fulfilled`. The first item to complete
is the payment (`val_payment_youssef`); the remaining item is the ticket
access itself (`val_ticket_youssef`), fulfilled when the QR is scanned at
the gate. This is semantically correct: money is received six weeks before
the event; the digital access delivery is a separate Fulfillment on the night.

---

## CascadeCancellation — how the extension is encoded

The `CascadeCancellation` extension is defined in the prose model
(`WARP_COMMERCE_MODEL.md`, `CommitmentTerms::cascade`) as an optional term
that, when the parent Commitment is cancelled, automatically transitions all
child Commitments to `child_transition`. The extension name and its runtime
semantics appear in the spec.

**There is no corresponding schema field.** The `Commitment` object in
`schema/commerce.schema.json` has no `cascade` or `terms` property. The
cascade cannot be declared in the fixture; it can only be *executed*. The
fixture encodes the cascade result:

1. `EVENT-JAZZ-2026` transitions `accepted → cancelled` at `2026-07-15T21:15:00+00:00`.
2. `TICKET-2` and `TICKET-3` each independently record `accepted → cancelled`
   at the same timestamp, with `reason: "cascade cancellation from EVENT-JAZZ-2026"`.
3. `TICKET-1` (already `fulfilled`) records `fulfilled → refunded`, the only
   valid forward transition from `fulfilled` that represents a money return.

Each cancelled/refunded child receives an automatic refund Fulfillment
(`money_transfer`, `card_reversal`) executing the `EventCancellationPolicy`
auto-refund clause.

See **FINDING-1** below for the schema gap this reveals.

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | All Value references resolve: each `val_payment_*` points to no commitment (already transferred); each `val_ticket_*` reaches `access_expired` or `access_revoked`. All Fulfillment `commitment` fields resolve to real Commitments. No dangling references. |
| **I-2 State Monotonicity** | TICKET-1 cannot move `fulfilled → cancelled`; the only valid forward path is `fulfilled → refunded`. The cascade encodes the correct transitions: children in `accepted` go `accepted → cancelled`; the fulfilled child goes `fulfilled → refunded`. |
| **I-3 Capacity Verification** | All three ticket Commitments reach `accepted`. Their initiators (`cust_youssef`, `cust_fatima`, `cust_omar`) each carry a `verified_at` timestamp in their `capacity`. The counterparty `org_warp_events` is also verified. |
| **I-4 Temporal Integrity** | All history timestamps are non-decreasing per object. Sale timestamps (June) precede event night timestamps (July 15). Refund timestamps (July 16) follow the cancellation (July 15). |
| **I-5 Identity Permanence** | All IDs are globally unique within the fixture: 5 party IDs, 6 value IDs, 3 intent IDs, 4 commitment IDs, 7 fulfillment IDs — 25 objects, zero collisions. |
| **I-6 Commitment Tree Consistency** | `EVENT-JAZZ-2026.children = ["TICKET-1","TICKET-2","TICKET-3"]`. Each child has `parent = "EVENT-JAZZ-2026"`. Linkage is bidirectional and consistent. |

---

## Extensions relied upon

### EventAccess (AccessModel variant — v0.3)

Tickets are `digital_good` Values with `access_model: EventAccess`. This
access model carries `event`, `location`, `date`, `entry_window`,
`transferable`, and `expiry`. The `expiry` points to `EventEnd` — a
`FinalizationTrigger` variant in the prose model. When the event ends
(or is cancelled), the ticket value transitions to `access_expired` (if
the holder attended) or `access_revoked` (if cancelled before entry).

The schema's `ValueForm` is intentionally open (`"required": ["type"]`,
no `additionalProperties: false` at the form level), so `EventAccess`
properties are representable in conformance fixtures as open fields on
the `ValueForm` object without schema changes.

### CascadeCancellation (CommitmentTerms extension — v0.3)

Defined in the prose model as an optional term on a parent Commitment that
declares the trigger, scope, and target state for children when the parent
is cancelled. The runtime executes the cascade automatically.

In the fixture: the cascade is expressed as simultaneous `cancelled`
transitions on all child Commitments, each carrying the same timestamp and
reason as the parent cancellation. **No schema field declares the cascade
intent** — see FINDING-1.

### EventCancellationPolicy (CommitmentCondition — v0.3)

Defined in the prose model as a `CommitmentCondition` variant specifying
what happens `if_cancelled` (auto-refund with `FullRefund | PartialRefund`)
and `if_postponed` (customer choice among postponement options). In this
fixture, the force-majeure invokes the `if_cancelled: AutoRefund` clause:
all three buyers receive full refunds within 24 hours of cancellation.
The auto-refund is modelled as `money_transfer` Fulfillments on each
ticket Commitment.

---

## FINDINGS

### FINDING-1: CascadeCancellation has no schema field — cascade is manual, not declarative

**Observation:** The prose model defines `CommitmentTerms::cascade` as a
structured term (trigger, scope, child_transition, auto_refund). The schema
(`schema/commerce.schema.json`) does not include a `cascade` or `terms`
property on the `Commitment` object. A fixture cannot declare its intention
to cascade — it can only record the outcome.

**Consequence:** Two conformant fixtures can produce identical object states
through entirely different mechanisms — one by a declared CascadeCancellation
term executing automatically, another by a human operator manually cancelling
each child. The conformance harness cannot distinguish them.

**Implications for the runtime:** The Warp compiler and runtime must enforce
CascadeCancellation at the workflow level, not at the schema level. When a
parent Commitment with a `CascadeCancellation` term is cancelled, the runtime
must automatically drive each child to the declared `child_transition`. This
is correct behaviour — schema is a structural contract, not a behavioural
contract — but it means CascadeCancellation is **a runtime invariant, not a
schema invariant**. The gap is intentional but should be documented at the
schema level with an `$comment` field or a separate behavioural spec
to prevent silent non-compliance.

**Recommendation:** Add a `$comment` to the `Commitment` schema definition
noting that `CascadeCancellation`, `EventCancellationPolicy`, and other
prose-level `CommitmentTerms` extensions are enforced by the runtime, not
the structural schema. This prevents implementors from assuming schema
validity implies full behavioural compliance.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/events
# ✓ conformance/case-studies/events/force-majeure-cascade.json
```
