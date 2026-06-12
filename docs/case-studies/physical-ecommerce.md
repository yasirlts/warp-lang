> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/physical-ecommerce/physical-ecommerce.json`](../../conformance/case-studies/physical-ecommerce/physical-ecommerce.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Physical E-Commerce

> **Adversarial test corpus — now executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below is a real fixture under
> [`conformance/case-studies/physical-ecommerce/`](../../conformance/case-studies/physical-ecommerce/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs`.

**Reference platforms:** Amazon (1P), Marjane, Jumia, Net-a-Porter.
**Fixture:** [`order-with-return.json`](../../conformance/case-studies/physical-ecommerce/order-with-return.json)

---

## The domain and the hard cases it stresses

First-party physical-goods commerce is the canonical case, but the *hard* part
is not the happy path — it is the **return**. Naively, a return looks like a
backward state change: a `Fulfilled` order "un-fulfilling" back to a refunded
state. The model forbids this (Invariant 2, State Monotonicity). The stress
this domain puts on the model:

- **A return must not reverse the original Commitment.** The original order
  stays `Fulfilled` forever. The return is a *new* forward Commitment in which
  the direction of value flow is reversed (goods go buyer → seller, money goes
  seller → buyer).
- **Payment and delivery are distinct Fulfillments of one Commitment.** The
  Commitment passes through `PartiallyFulfilled` (money received) before
  reaching `Fulfilled` (goods delivered) — there is no `Accepted → Fulfilled`
  shortcut.
- **Money always carries currency.** Every amount here is `MAD`; the model has
  no bare numbers.

## The model objects

The cart is an `Intent`; checkout converts it to a `Commitment`; payment and
delivery are two `Fulfillment`s. See the fixture for the full JSON — the
shape that matters most is the order Commitment and how it reaches `Fulfilled`:

```json
{
  "id": "ORD-1",
  "parties": { "initiator": "cust_amina", "counterparty": "org_marjane", "intermediaries": [] },
  "state": "fulfilled",
  "history": [
    { "from": "draft", "to": "proposed", "at": "2026-06-01T10:00:00+00:00", "actor": "cust_amina" },
    { "from": "proposed", "to": "accepted", "at": "2026-06-01T10:05:00+00:00", "actor": "org_marjane" },
    { "from": "accepted", "to": { "partially_fulfilled": { "fulfilled_item_ids": ["val_payment"], "remaining_item_ids": ["val_kettle"] } }, "at": "2026-06-01T10:06:00+00:00", "actor": "org_marjane" },
    { "from": { "partially_fulfilled": { "fulfilled_item_ids": ["val_payment"], "remaining_item_ids": ["val_kettle"] } }, "to": "fulfilled", "at": "2026-06-03T14:20:00+00:00", "actor": "org_marjane" }
  ],
  "originated_from": "INT-1"
}
```

The **return** is a second Commitment, `RET-1`, between the *same parties* but
with the value flow reversed — the customer returns the kettle and the merchant
refunds the money. It runs its own `draft → proposed → accepted →
partially_fulfilled → fulfilled` lifecycle and produces its own refund
`Fulfillment` (`F-REFUND-1`). The original `ORD-1` is never touched.

## Lifecycle as a transition sequence

```
Intent INT-1:        active → converted(ORD-1)

Commitment ORD-1:    draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-PAY-1 (money_transfer):     planned → in_progress → completed
  Fulfillment F-DEL-1 (physical_delivery):  planned → in_progress → completed

Commitment RET-1:    draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-REFUND-1 (money_transfer):  planned → in_progress → completed
```

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-2 State Monotonicity** | The return cannot move `ORD-1` backward; it is a new forward Commitment. `auditCommerce` rejects any `Fulfilled → *` regression. |
| **I-4 Temporal Integrity** | Every Commitment/Fulfillment history is timestamp-monotonic. |
| **I-5 Identity Permanence** | `ORD-1`, `RET-1`, and every value/fulfillment id is unique. |
| **I-3 Capacity Verification** | Both parties carry a verified capacity before `ORD-1` reaches `Accepted`. |
| **I-1 Value Conservation** | The kettle transfers to the buyer; the payment transfers to the seller; the refund moves money back under `RET-1`. All Value references resolve. |

## Extensions relied upon

**None.** This domain is expressible in the base five primitives with no v0.3
extension. That is the point of starting here: the hardest everyday case (a
return) needs no new vocabulary — only the discipline of modelling it as a new
Commitment.

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/physical-ecommerce
# ✓ conformance/case-studies/physical-ecommerce/order-with-return.json
```
