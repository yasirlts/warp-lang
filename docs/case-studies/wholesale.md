> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/wholesale/wholesale.json`](../../conformance/case-studies/wholesale/wholesale.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Wholesale and Distribution

> **Adversarial test corpus — executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below is a real fixture under
> [`conformance/case-studies/wholesale/`](../../conformance/case-studies/wholesale/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs`.

**Reference platforms:** SAP S/4HANA (Blanket POs), Odoo Purchase, Agora (Warp-native).
**Fixture:** [`blanket-po-with-calloffs.json`](../../conformance/case-studies/wholesale/blanket-po-with-calloffs.json)

---

## The domain and the hard cases it stresses

Wholesale commerce is structurally different from retail: a buyer does
not place individual discrete orders. A buyer signs a **blanket purchase
order** that covers the entire year's supply, then issues monthly
**call-offs** (also called releases or delivery orders) against that
master agreement. The hard part for any commerce model is that there
are now *two levels of Commitment with different lifecycles*:

- **The blanket PO** is an obligation to supply over a period. Once
  both parties sign it the PO doesn't get "fulfilled" delivery by
  delivery — it transitions `accepted→active` and stays active until
  the contract year ends or the full quantity is drawn down.
- **Each call-off** is a discrete mini-commitment — a request for a
  specific quantity in a specific month. It has its own lifecycle:
  goods ship, invoice is issued, payment arrives 30 days later.
- **Volume pricing and year-end true-up** — the per-unit price may
  change if cumulative volume crosses a tier boundary. The model
  cannot represent the pricing calculation (pricing is outside the
  model boundary), but it can represent the Commitment values that
  price determination produces. The true-up is a future child
  Commitment adjusting the delta.
- **Net 30/60/90 payment terms** — B2B credit: goods ship today,
  money moves 30 days later. Every call-off is therefore
  `partially_fulfilled` (goods delivered, payment pending) before
  reaching `fulfilled` (payment cleared). No B2B shortcut is allowed.

The stresses this domain puts on the model:

- **Invariant 6 (Commitment Tree)**: BPO-1 must list CO-1/CO-2/CO-3 in
  `children`; each call-off must point back to `parent: BPO-1`. The
  auditor enforces both directions of the link.
- **Invariant 2 (State Monotonicity)**: The blanket PO reaches `active`
  and stays there — it must not jump to `fulfilled` each month. The
  children go through their own `partially_fulfilled→fulfilled` cycles
  independently.
- **Invariant 3 (Capacity Verification)**: Every call-off reaches
  `accepted`, so both `org_retailer_atlas` and `org_dist_maghreb` must
  carry non-empty `verified_at` in their capacity records.
- **Invariant 5 (Identity Permanence)**: 4 commitments, 6 values, 6
  fulfillments, 1 intent — all IDs unique across the fixture.

## The model objects

Atlas Retail signs a 12-month blanket PO with Maghreb Distribution for
premium olive oil — 120 cartons/month standard, with seasonal flex up to
150 cartons. Three monthly call-offs are modelled: CO-1 (February,
120 cartons), CO-2 (March, 120 cartons), and CO-3 (April, 150 cartons —
Ramadan-season uplift within the flex range).

The Intent captures the annual supply decision; checkout converts it to
BPO-1. The blanket PO's history:

```json
{
  "id": "BPO-1",
  "state": "active",
  "history": [
    { "from": "draft",    "to": "proposed", "at": "2026-01-20T10:00:00+00:00", "actor": "org_retailer_atlas" },
    { "from": "proposed", "to": "accepted", "at": "2026-01-22T14:00:00+00:00", "actor": "org_dist_maghreb" },
    { "from": "accepted", "to": "active",   "at": "2026-02-01T00:00:00+00:00", "actor": "org_dist_maghreb" }
  ],
  "children": ["CO-1", "CO-2", "CO-3"]
}
```

The transition `accepted→active` is the key wholesale pattern: the master
agreement does not move to `fulfilled` on a delivery — it moves to `active`
and remains there while child call-offs execute.

Each child call-off follows the B2B credit pattern: goods deliver first,
payment follows 30 days later. CO-1 abbreviated:

```json
{
  "id": "CO-1",
  "state": "fulfilled",
  "history": [
    { "from": "draft",    "to": "proposed",  "at": "2026-01-28T09:00:00+00:00", "actor": "org_retailer_atlas" },
    { "from": "proposed", "to": "accepted",  "at": "2026-01-29T11:00:00+00:00", "actor": "org_dist_maghreb" },
    { "from": "accepted", "to": { "partially_fulfilled": { "fulfilled_item_ids": ["val_olive_oil_co1"], "remaining_item_ids": ["val_payment_co1"] } }, "at": "2026-02-05T14:00:00+00:00", "actor": "org_dist_maghreb" },
    { "from": { "partially_fulfilled": { ... } }, "to": "fulfilled", "at": "2026-03-07T10:30:00+00:00", "actor": "org_retailer_atlas" }
  ],
  "parent": "BPO-1"
}
```

CO-3 uses 150 cartons (the Ramadan uplift), demonstrating quantity
flexibility within the blanket PO's agreed range. The payment amount
scales accordingly (MAD 54,000 vs MAD 43,200 for standard months).

## Lifecycle as a transition sequence

```
Intent INT-BPO-1:    active → converted(BPO-1)

Commitment BPO-1 (parent — blanket PO):
  draft → proposed → accepted → active  [stays active for 12 months]

Commitment CO-1 (child — February call-off):
  draft → proposed → accepted → partially_fulfilled → fulfilled
    Fulfillment F-DEL-CO1 (physical_delivery):   planned → in_progress → completed
    Fulfillment F-PAY-CO1 (money_transfer):       planned → in_progress → completed

Commitment CO-2 (child — March call-off):
  draft → proposed → accepted → partially_fulfilled → fulfilled
    Fulfillment F-DEL-CO2 (physical_delivery):   planned → in_progress → completed
    Fulfillment F-PAY-CO2 (money_transfer):       planned → in_progress → completed

Commitment CO-3 (child — April call-off, Ramadan uplift 150 cartons):
  draft → proposed → accepted → partially_fulfilled → fulfilled
    Fulfillment F-DEL-CO3 (physical_delivery):   planned → in_progress → completed
    Fulfillment F-PAY-CO3 (money_transfer):       planned → in_progress → completed
```

## Volume pricing and year-end true-up (prose extension)

The blanket PO carries tiered pricing negotiated at signing:

| Annual volume (cartons) | Unit price (MAD/carton) |
|------------------------|------------------------|
| 0 – 999                | 360                    |
| 1,000 – 1,439          | 355                    |
| 1,440+                 | 350                    |

Atlas Retail committed to 1,440 cartons (120/month × 12 months),
qualifying for the MAD 350 tier from the start. Monthly invoices are
issued at this rate: MAD 43,200 for 120-carton months, MAD 54,000 for
the 150-carton Ramadan month.

If cumulative deliveries cross into a lower tier mid-year (e.g., due to
cancelled call-offs), Maghreb Distribution issues a year-end true-up
child Commitment adjusting the difference. If volume exceeds the 1,440
tier at year-end, Atlas Retail receives a credit note (a role-reversed
child Commitment from distributor to retailer for the overpayment delta).

**Why the model cannot carry this as a field:** `VolumePricing` is a
spec v0.3 extension to `CommitmentTerms`. The runtime schema (P1–P3)
records only Money values — the pricing calculation that produced those
values is pre-model. The extension is recorded in
`extensions_exercised` and documented here; no schema field violation
occurs.

## Net 30 payment terms (prose extension)

Every call-off invoice is payable Net 30 from delivery date. This is a
spec v0.3 `PaymentTiming::Net` extension:

```
Net {
  days: 30
  from: NetTermsAnchor::DeliveryDate
  early_payment_discount: Some(0.01)  // 1% if paid within 10 days
}
```

The 30-day gap is why every child Commitment passes through
`partially_fulfilled` (goods delivered, payment not yet received) rather
than jumping directly to `fulfilled`. The auditor enforces that
`partially_fulfilled→fulfilled` is a valid transition and that the goods
fulfillment timestamp precedes the payment fulfillment timestamp
(Invariant 4, Temporal Integrity).

**Why this is prose:** `Net` is a `PaymentTiming` extension at the spec
level. The P1–P3 runtime schema does not carry a dedicated `payment_terms`
field on Commitment; the semantics are fully expressed through the
`partially_fulfilled` state and the timestamp gap between delivery and
payment fulfillments.

## RecurringDelivery (prose extension)

The blanket PO carries a `RecurringDelivery` delivery method at the
spec v0.3 level:

```
RecurringDelivery {
  schedule: Frequency::Monthly
  quantity_per_delivery: Quantity { amount: "120", unit: "carton" }
  first_delivery: 2026-02-01
  last_delivery:  Some(2027-01-31)
  flexibility: Some({
    min_per_delivery: Quantity { amount: "80",  unit: "carton" },
    max_per_delivery: Quantity { amount: "150", unit: "carton" }
  })
}
```

Each child call-off Fulfillment carries its own `physical_delivery`
method with carrier, tracking number, and destination — the
RecurringDelivery schedule is the master template; individual
deliveries are discrete runtime objects.

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-2 State Monotonicity** | BPO-1 reaches `active` and stays there. Call-off children follow `partially_fulfilled→fulfilled`; neither can regress. `auditCommerce` would reject any attempted `fulfilled→accepted` or `active→fulfilled` on BPO-1. |
| **I-3 Capacity Verification** | All four commitments reach `accepted`. Both parties carry non-empty `verified_at` before that transition. The auditor enforces this per commit. |
| **I-4 Temporal Integrity** | Delivery timestamps precede payment timestamps by exactly 30 days per call-off. All history arrays are monotonically increasing. |
| **I-5 Identity Permanence** | 4 commitments, 6 values, 6 fulfillments, 1 intent, 2 parties — 19 IDs, all unique. The auditor rejects any reuse. |
| **I-6 Commitment Tree Consistency** | BPO-1.children = [CO-1, CO-2, CO-3]; each CO-x.parent = BPO-1. The auditor checks both directions of the link. |

## Extensions relied upon

| Extension | Spec reference | How used |
|-----------|---------------|----------|
| **RecurringDelivery** | v0.3 `DeliveryMethod::RecurringDelivery` | Blanket PO delivery schedule: monthly, 120 cartons base, 80–150 flex range. Individual call-offs carry `physical_delivery` method. |
| **VolumePricing (year-end true-up)** | v0.3 `CommitmentTerms::volume_pricing` | Three tiers; Atlas Retail qualified for the 1,440+ carton tier at contract signing. Year-end true-up adjusts if cumulative volume crosses a tier boundary. |
| **Net payment timing (Net30/60/90)** | v0.3 `PaymentTiming::Net` | Net 30 from delivery date. 1% early-payment discount if settled within 10 days. Expressed in the model as `partially_fulfilled` (goods in, payment pending) → `fulfilled` (payment cleared). |

## FINDINGS — genuine schema gaps

1. **`PaymentTiming::Net` has no runtime field.** The 30-day payment
   delay is fully expressible through state transitions and timestamps
   but the Net terms themselves (days, anchor, early-payment discount)
   cannot be recorded in a structured field in the P1–P3 fixture. A
   future `payment_terms` property on Commitment (or an `extensions`
   free-form map) would allow machine-readable Net term verification
   without requiring custom parsing of `reason` strings.

2. **`VolumePricing` tier table has no runtime field.** The tiered
   price schedule and true-up policy live only in prose. An
   `extensions` free-form map on Commitment (similar to `metadata` in
   other schemas) would allow attaching the tier table to the fixture
   without requiring a schema change for every extension variant.

3. **`RecurringDelivery` schedule not on Fulfillment.** The delivery
   schedule (frequency, first/last delivery, flex range) is a spec
   construct with no corresponding field on the runtime Fulfillment
   object. Individual deliveries reference their call-off Commitment,
   not the blanket PO — the recurring pattern is visible only via the
   parent→children tree, not as an explicit schedule field.

None of these gaps prevent executable conformance — the fixture passes
`auditCommerce` cleanly. They are model-layer extensions whose prose
semantics are fully preserved in `extensions_exercised` and this
document.

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/wholesale
# ✓ conformance/case-studies/wholesale/blanket-po-with-calloffs.json
```
