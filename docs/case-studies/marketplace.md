> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/marketplace/marketplace.json`](../../conformance/case-studies/marketplace/marketplace.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Marketplace Platforms

> **Adversarial test corpus — executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below is a real fixture under
> [`conformance/case-studies/marketplace/`](../../conformance/case-studies/marketplace/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs conformance/case-studies/marketplace`.

**Reference platforms:** Airbnb, Etsy, Amazon Marketplace, Jumia (3P sellers), Ketshop.
**Fixture:** [`double-sided-commission.json`](../../conformance/case-studies/marketplace/double-sided-commission.json)

---

## The domain and the hard cases it stresses

Marketplace platforms introduce a three-party structure that breaks the
simple buyer-seller model: a **platform intermediary** stands between
initiator and counterparty, charges both sides simultaneously, and holds
funds in escrow until delivery is confirmed before disbursing to the seller.

The hard cases this domain puts on the model:

- **Double-sided commission** — the platform charges the buyer a service
  fee on top of the item price AND deducts a commission from the seller's
  payout. Two fee flows, one commerce operation.
- **Platform holds funds** — the buyer pays the platform, not the seller.
  The platform is not the counterparty (it does not own the good); it is an
  intermediary. Money sits with the platform between payment capture and
  payout disbursement. The model must express this without inventing an
  escrow primitive.
- **Delayed disbursement** — payout to the seller happens only after
  delivery confirmation. The Commitment must pass through
  `partially_fulfilled` (payment captured, goods not yet delivered) before
  reaching `fulfilled` (goods delivered AND payout released).
- **Value conservation across three parties** — the invariant now spans
  three parties rather than two. The arithmetic must hold exactly.

## The commission arithmetic — verified

Scenario: Karima (buyer) purchases a handcrafted tagine from Hassan (seller)
on SouqMaroc, a Moroccan goods marketplace.

```
Item price (seller's listed price):      400.00 MAD
Buyer service fee (7.5 % of item price):  30.00 MAD
──────────────────────────────────────────────────
Buyer total charged (Karima pays):       430.00 MAD

Seller commission (10 % of item price):   40.00 MAD
──────────────────────────────────────────────────
Seller payout (Hassan receives):         360.00 MAD

Platform total retained:                  70.00 MAD
  = buyer fee (30.00) + seller commission (40.00)

Conservation check:
  Karima paid       430.00 MAD
  Hassan received   360.00 MAD
  Platform retained  70.00 MAD
  430.00 = 360.00 + 70.00  ✓
```

The platform's 70.00 MAD is the sum of two deductions taken from opposite
sides of the transaction. This is the `CommissionSplit::DoubleSided` structure
from the spec v0.3 `CommitmentTerms.payment.timing` extension. The model has
no first-class field for commission arithmetic — it is expressed through the
money Values and money\_transfer Fulfillments, which together satisfy
Invariant 1 (Value Conservation). The arithmetic is prose-level; the fixture
enforces it through reference integrity.

## The model objects

The cart is an `Intent`; checkout converts it to a `Commitment`; payment,
physical delivery, and seller payout are three `Fulfillment`s of that one
Commitment.

The platform appears in the Commitment's `intermediaries` array with its
capacity verified (`can_guarantee: true`). The buyer is `initiator`, the
seller is `counterparty`.

**The Commitment:**

```json
{
  "id": "ORD-MKT-1",
  "parties": {
    "initiator": "buyer_karima",
    "counterparty": "seller_hassan",
    "intermediaries": ["platform_souqmaroc"]
  },
  "state": "fulfilled",
  "history": [
    { "from": "draft",    "to": "proposed",  ... "reason": "buyer placed order; item price 400.00 MAD + buyer service fee 30.00 MAD = 430.00 MAD total" },
    { "from": "proposed", "to": "accepted",  ... "reason": "seller confirmed availability; platform verified buyer capacity" },
    { "from": "accepted", "to": { "partially_fulfilled": { "fulfilled_item_ids": ["val_buyer_payment"], "remaining_item_ids": ["val_handcraft_tagine", "val_seller_payout"] } }, ... "reason": "platform captured 430.00 MAD from buyer; funds held pending delivery" },
    { "from": { "partially_fulfilled": {...} }, "to": "fulfilled", ... "reason": "item delivered; platform disbursed 360.00 MAD to seller" }
  ]
}
```

The transition `accepted → partially_fulfilled` records the moment the
platform captures payment. The funds are now held by the platform — but the
seller has not yet fulfilled their obligation (shipping the tagine). Two items
remain: the physical good and the seller payout.

The transition `partially_fulfilled → fulfilled` fires only after delivery
confirmation, simultaneously closing both remaining items. This is the
delayed-disbursement guarantee the marketplace model requires.

## Lifecycle as a transition sequence

```
Intent INT-MKT-1:       active → converted(ORD-MKT-1)

Commitment ORD-MKT-1:   draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-BUYER-PAY-1   (money_transfer, buyer → platform, 430.00 MAD):
      planned → in_progress → completed
  Fulfillment F-DELIVERY-1    (physical_delivery, seller → buyer, tagine):
      planned → in_progress → completed
  Fulfillment F-SELLER-PAYOUT-1 (money_transfer, platform → seller, 360.00 MAD):
      planned → in_progress → completed
```

The three Fulfillments all hang off the same Commitment (`ORD-MKT-1`).
The model does not need a separate "escrow commitment" or a distinct
"payout commitment" — the single Commitment's `partially_fulfilled` state
holds all three obligations open until they are all satisfied.

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | `val_buyer_payment` (430.00 MAD) transfers to platform; `val_seller_payout` (360.00 MAD) transfers to seller. Platform retains 70.00 MAD. All Value references resolve to real objects. 430.00 = 360.00 + 70.00 (verified in prose above). |
| **I-2 State Monotonicity** | `ORD-MKT-1` progresses strictly forward: draft → proposed → accepted → partially\_fulfilled → fulfilled. No backward transition. `auditCommerce` enforces the valid transitions table. |
| **I-3 Capacity Verification** | `buyer_karima` and `seller_hassan` both carry `verified_at` timestamps before `ORD-MKT-1` reaches `accepted`. The platform (`platform_souqmaroc`) is in `intermediaries` with `can_guarantee: true` verified. |
| **I-4 Temporal Integrity** | All history timestamps are non-decreasing across all Commitments and Fulfillments. The payout Fulfillment (`F-SELLER-PAYOUT-1`) starts only after delivery is completed. |
| **I-5 Identity Permanence** | `ORD-MKT-1`, `INT-MKT-1`, `F-BUYER-PAY-1`, `F-DELIVERY-1`, `F-SELLER-PAYOUT-1`, and all three Value ids are globally unique within the fixture. |

## Extensions relied upon

**CommissionSplit (DoubleSided)** — spec v0.3 `PaymentTiming::CommissionSplit`
with `structure::DoubleSided`. This is a prose-level extension: the fixture
represents the commission arithmetic through concrete Money Values and
money\_transfer Fulfillments. The spec structure names the concept; the
fixture carries the arithmetic.

**Platform holds funds / delayed disbursement** — the platform's role as
fund-holder is expressed through the `intermediaries` array and the
`partially_fulfilled` state. Funds flow buyer → platform (F-BUYER-PAY-1)
and later platform → seller (F-SELLER-PAYOUT-1). No escrow primitive is
needed; the Commitment's `partially_fulfilled` state is the hold period.

## Findings — genuine gaps

**F-1: No first-class commission term in the executable schema.**
The `CommissionSplit::DoubleSided` structure described in the prose model
(`WARP_COMMERCE_MODEL.md` v0.3 changelog) has no corresponding field in
`schema/commerce.schema.json` or in the fixture JSON. The schema's
`Commitment` object has no `terms` field at all — only `parties`, `state`,
`history`, `parent`, `children`, `originated_from`, `created_at`, and
`expires_at`. The commission arithmetic (buyer fee rate, seller commission
rate, item price) is therefore carried in prose and in the Money amounts of
the money\_transfer Fulfillments, not as a structured executable term.
Runtime consequence: a Warp rule engine cannot enforce commission rates from
the model alone — it must read the prose spec or the Commitment's description
field. This is acceptable for the current schema version (the spec explicitly
separates prose-level extensions from P1–P3 runtime fields) but is a known
gap for a future `CommitmentTerms` addition to the schema.

**F-2: Platform party capacity flags do not model the intermediary role precisely.**
The `PartyCapacity` fields (`can_buy`, `can_sell`, `can_fulfill`, `can_guarantee`)
do not include a `can_intermediate` flag. The platform is modelled with
`can_guarantee: true` as the closest available signal that it is a trusted
third party. A future `can_intermediate: bool` capacity flag would express
this more precisely.

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/marketplace
# ✓ conformance/case-studies/marketplace/double-sided-commission.json
# ────────────────────────────────────────────────────────────
# auditCommerce: 1 passed, 0 failed, 0 warnings, 1 fixtures
```
