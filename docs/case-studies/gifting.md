> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/gifting/gifting.json`](../../conformance/case-studies/gifting/gifting.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Multi-Recipient Gifting

> **Adversarial test corpus — now executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below is a real fixture under
> [`conformance/case-studies/gifting/`](../../conformance/case-studies/gifting/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs`.

**Reference platforms:** Floward, Cadeaux.ma, Not On The High Street, Amazon Gift Orders.
**Fixture:** [`multi-recipient-gift-with-stock-failure.json`](../../conformance/case-studies/gifting/multi-recipient-gift-with-stock-failure.json)

---

## The domain and the hard cases it stresses

Multi-recipient gifting looks simple — one customer, several shipping addresses
— but it exposes two structural challenges the model must handle without
bending its rules.

The first challenge is the **commitment tree**. One customer pays once and
has one overall agreement with the shop, but each recipient's delivery is
independently trackable, can fail independently, and has a different address,
a different delivery window, and potentially a different vendor. Naively
bundling them into a single flat Commitment would require inventing ad-hoc
"sub-items" outside the model; splitting them into four unrelated Commitments
would lose the fact that they are one customer journey. The correct shape is a
**parent Commitment** (the overall order and payment) with **three child
Commitments** (one per recipient), all traced back to one Intent. Invariant 6
(Commitment Tree Consistency) enforces this linkage mechanically.

The second challenge is **per-child stock failure**. When one of the three
gift items is out of stock, only that child Commitment enters
`PartiallyFulfilled`; the other two proceed normally. A ResolutionProcess
opens on the affected child, offering a substitute. The customer accepts,
and that child resumes its path to `Fulfilled`. The parent Commitment and the
other two children are entirely unaffected. This stresses Invariant 2 (the
parent cannot be moved backward, the resolved child must proceed forward)
and the ResolutionProcess extension.

The concrete scenario: Karim orders gifts for three family members — his
mother Fatima in Casablanca (argan oil set, MAD 380), his daughter Nadia in
Rabat (silk scarf, MAD 350), and his son Youssef in Marrakech (chess set,
MAD 320). Total: MAD 1 050, paid in one transaction. After payment,
the silk scarf for Nadia is found to be out of stock. A ResolutionProcess
opens and proposes a pashmina substitute at no price change. Karim accepts;
Nadia's delivery is dispatched two days later than the others. All three
children fulfill; the parent Commitment fulfills.

## The model objects

One Intent converts to one parent Commitment. Payment is a single
Fulfillment on the parent. Each of the three child Commitments carries its
own physical-delivery Fulfillment. The parent and child structure:

```json
{
  "id": "GIFT-PARENT",
  "parties": { "initiator": "cust_karim", "counterparty": "org_giftshop", "intermediaries": [] },
  "state": "fulfilled",
  "children": ["GIFT-CHILD-1", "GIFT-CHILD-2", "GIFT-CHILD-3"],
  "originated_from": "INT-GIFT-1"
}
```

Each child points back:

```json
{
  "id": "GIFT-CHILD-2",
  "parent": "GIFT-PARENT",
  "children": [],
  "originated_from": "INT-GIFT-1"
}
```

The stock-failure child (`GIFT-CHILD-2`) reaches `PartiallyFulfilled` when
the silk scarf is found unavailable. A ResolutionProcess references this child:

```json
{
  "id": "RES-GIFT-1",
  "parent_commitment": "GIFT-CHILD-2",
  "unresolved_item_description": "Silk scarf SKU-SCARF-SILK ordered for Nadia — out of stock",
  "original_value_str": "350.00",
  "original_value_currency": "MAD",
  "candidates": [
    {
      "id": "RC-1",
      "description": "Pashmina scarf — same price, immediate dispatch",
      "price_delta_str": "0.00",
      "delivery_window_change_hours": 24,
      "state": "accepted"
    }
  ],
  "state": { "resolved": { "outcome": { "substitute_accepted": { "candidate_id": "RC-1" } } } }
}
```

Once RC-1 is accepted, `GIFT-CHILD-2` transitions from `PartiallyFulfilled`
to `Fulfilled`. The parent follows when all three children are done.

## Lifecycle as a transition sequence

```
Intent INT-GIFT-1:    active → converted(GIFT-PARENT)

Commitment GIFT-PARENT (whole order):
  draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-GIFT-PAY (money_transfer):    planned → in_progress → completed

Commitment GIFT-CHILD-1 (Fatima / Casablanca):
  draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-GIFT-DEL-1 (physical_delivery):  planned → in_progress → completed

Commitment GIFT-CHILD-2 (Nadia / Rabat — stock failure):
  draft → proposed → accepted → partially_fulfilled → fulfilled
    ResolutionProcess RES-GIFT-1:  awaiting_customer_decision → resolved(substitute_accepted)
  Fulfillment F-GIFT-DEL-2 (physical_delivery):  planned → in_progress → completed

Commitment GIFT-CHILD-3 (Youssef / Marrakech):
  draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-GIFT-DEL-3 (physical_delivery):  planned → in_progress → completed
```

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-6 Commitment Tree Consistency** | `GIFT-PARENT.children` lists all three child ids; each child's `parent` points back to `GIFT-PARENT`. `auditCommerce` rejects any mismatch in this bidirectional linkage. |
| **I-2 State Monotonicity** | `GIFT-CHILD-2` reaches `PartiallyFulfilled` on stock failure and advances forward to `Fulfilled` after the substitute is accepted — no backward transition, no re-opening of `GIFT-PARENT`. |
| **I-1 Value Conservation** | Every Value referenced in a Fulfillment or ResolutionProcess resolves: `val_gift_nadia_original` is the unresolved item; `val_gift_nadia_substitute` is what was ultimately delivered. All cross-object references check out. |
| **I-4 Temporal Integrity** | Each Commitment and Fulfillment history is timestamp-monotonic. Nadia's delivery completing on 2026-06-13 is correctly later than Fatima's and Youssef's on 2026-06-12. |
| **I-5 Identity Permanence** | All ids — five parties, five values, one intent, four commitments, four fulfillments, one resolution process — are globally unique within the fixture. |
| **I-3 Capacity Verification** | Both `cust_karim` (initiator) and `org_giftshop` (counterparty) carry `verified_at` before any Commitment reaches `Accepted`. Recipient parties are present but do not hold initiator/counterparty roles. |

## Extensions relied upon

**ResolutionProcess (multi-vendor stock failure resolution).** When
`GIFT-CHILD-2` reaches `PartiallyFulfilled` because the silk scarf is
unavailable, a `ResolutionProcess` object is created referencing that child
Commitment. The shop proposes one `ResolutionCandidate` (the pashmina
substitute). Karim accepts it; the process reaches
`resolved { substitute_accepted: { candidate_id: "RC-1" } }`. The child
Commitment then transitions from `PartiallyFulfilled` to `Fulfilled` using
the substitute value. This is a first-class schema object, not prose — the
fixture carries the full `resolution_processes` array and the audit validates
the `parent_commitment` reference under Invariant 1.

## Schema-representability findings

The gifting domain does not require any schema extension. The commitment tree
(`parent` / `children` fields on Commitment), the ResolutionProcess with
substitute candidate, and per-child physical-delivery Fulfillments are all
native schema v1.0.0 constructs. The rich notion of "gift message" or
"gift wrapping option" lives naturally in the ValueForm's open `properties`
field (the schema intentionally leaves ValueForm open beyond the `type`
discriminator), and does not require a new schema field.

One observation: the model currently has no first-class "recipient" role on a
child Commitment separate from `counterparty`. Here `recip_fatima`,
`recip_nadia`, and `recip_youssef` are modelled as parties present in the
fixture but not as initiator/counterparty of the child Commitments (the shop
is both). The delivery address per recipient is carried in the Fulfillment
`method.physical_delivery.destination` field. This is representable but the
address lives in Fulfillment rather than in Commitment — a reasonable fit for
the schema's current shape.

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/gifting
# ✓ conformance/case-studies/gifting/multi-recipient-gift-with-stock-failure.json
```
