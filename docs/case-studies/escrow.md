> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/escrow/escrow.json`](../../conformance/case-studies/escrow/escrow.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Escrow

> **Adversarial test corpus — now executable.** This is one of the domains the
> [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test claims to
> have passed. The JSON below is real fixtures under
> [`conformance/case-studies/escrow/`](../../conformance/case-studies/escrow/)
> that validate against [schema v1.0.0](../../schema/commerce.schema.json) and
> pass `auditCommerce`. Run them: `node conformance/audit.mjs conformance/case-studies/escrow`.

**Reference platforms:** Malt (freelance escrow), Payoneer Escrow, local
marketplace platforms in MENA that hold funds until buyer confirmation.  
**Fixtures:**
- [`happy-path.json`](../../conformance/case-studies/escrow/happy-path.json)
- [`dispute-and-refund.json`](../../conformance/case-studies/escrow/dispute-and-refund.json)

---

## The domain and the hard cases it stresses

Escrow is the canonical **three-party, conditional-release** commerce pattern.
A buyer and seller distrust each other enough that neither will move first:
the seller will not ship without payment assurance, and the buyer will not pay
without delivery assurance. A Guarantor (the escrow agent) solves this by:

1. Holding the buyer's payment in trust.
2. Releasing funds to the seller only when a specified condition is met.

The condition here is **`AfterGoodsReceived`** — the buyer must confirm receipt
before the escrow agent releases funds. This is a v0.3 `PaymentTiming` variant.

The hard cases this domain puts on the model:

- **Three parties in one Commitment.** Every prior case study uses two parties
  (initiator + counterparty). Escrow adds the escrow agent as an
  `intermediaries` member. The `CommitmentParties.intermediaries` array carries
  it; there is no separate primitive needed.
- **Value passes through an intermediary, not directly.** The buyer pays the
  escrow agent (not the seller); the escrow agent pays the seller on condition.
  This requires two `money_transfer` Fulfillments — one in, one out — and two
  corresponding Values to track each leg. Conservation (I-1) is verified by
  checking that money-in equals money-out.
- **The release condition is a trigger, not a timer.** The escrow agent releases
  funds only when the buyer fires a `trigger_verification` evidence of type
  `AfterGoodsReceived`. This is prose-level in the model spec (no
  `CommitmentCondition` object exists in the current schema) and is expressed
  here via `extensions_exercised` + trigger evidence on the release Fulfillment.
- **Dispute blocks release.** In the dispute fixture, the buyer disputes before
  confirming receipt. The escrow release Fulfillment is `reversed` (never
  completed), and the Commitment proceeds `fulfilled → disputed → refunded`.
  The escrow agent exercises its Guarantor capacity to return funds unilaterally.

## The model objects

### Happy path

Three parties: buyer, seller, escrow agent (Guarantor). One Commitment
(`ESC-COMM-1`) covers the entire escrow lifecycle. Four Fulfillments:

| Fulfillment | Method | What it moves |
|---|---|---|
| `F-ESC-PAY-1` | `money_transfer` | Buyer → Escrow (3200 MAD in) |
| `F-ESC-DEL-1` | `physical_delivery` | Seller → Buyer (rug) |
| `F-ESC-CONFIRM-1` | `digital_delivery` | Buyer confirmation portal fires `AfterGoodsReceived` trigger |
| `F-ESC-RELEASE-1` | `money_transfer` | Escrow → Seller (3200 MAD out) |

The Commitment shape that matters — how the escrow intermediary appears:

```json
{
  "id": "ESC-COMM-1",
  "parties": {
    "initiator": "buyer_hassan",
    "counterparty": "seller_fatima",
    "intermediaries": ["escrow_warp_pay"]
  },
  "state": "fulfilled",
  "history": [
    { "from": "draft", "to": "proposed", ... },
    { "from": "proposed", "to": "accepted", ... },
    { "from": "accepted", "to": { "partially_fulfilled": { "fulfilled_item_ids": ["val_buyer_payment"], "remaining_item_ids": ["val_rug", "val_escrow_release"] } }, ... },
    { "from": { "partially_fulfilled": { ... } }, "to": "fulfilled", ... }
  ]
}
```

The escrow agent party has `can_guarantee: true`:

```json
{
  "id": "escrow_warp_pay",
  "party_type": "organization",
  "capacity": {
    "can_buy": false, "can_sell": false, "can_fulfill": true,
    "can_guarantee": true,
    "verified_at": "2026-01-01T00:00:00+00:00"
  }
}
```

The release Fulfillment carries both the `payment_receipt` (money out) and a
`trigger_verification` evidence (AfterGoodsReceived = true), proving the
condition was satisfied before funds were released:

```json
{
  "id": "F-ESC-RELEASE-1",
  "method": { "money_transfer": { "mechanism": "bank_transfer", "reference": "ESC-TXN-OUT-00412" } },
  "evidence": [
    { "payment_receipt": { "reference": "ESC-TXN-OUT-00412", "amount": "3200.00", "currency": "MAD", ... } },
    { "trigger_verification": { "trigger_type": "AfterGoodsReceived", "fired": true, ... } }
  ]
}
```

### Dispute path

The buyer receives the rug but disputes before confirming receipt. The
Commitment reaches `fulfilled` (both the payment-into-escrow and the
physical delivery have completed), then the buyer raises a dispute before
the escrow agent has released funds. The valid transition sequence is:

```
accepted → partially_fulfilled → fulfilled → disputed → refunded
```

The escrow release Fulfillment (`F-ESC-RELEASE-D-1`) is `reversed` — it was
`in_progress` (escrow agent was about to disburse) when the dispute froze it.
A new refund Fulfillment (`F-ESC-REFUND-D-1`) returns 3200 MAD to the buyer.

## Lifecycle as a transition sequence

### Happy path

```
Intent INT-ESC-1:       active → converted(ESC-COMM-1)

Commitment ESC-COMM-1:  draft → proposed → accepted → partially_fulfilled → fulfilled
  F-ESC-PAY-1     (money_transfer):    planned → in_progress → completed  [buyer → escrow]
  F-ESC-DEL-1     (physical_delivery): planned → in_progress → completed  [seller → buyer]
  F-ESC-CONFIRM-1 (digital_delivery):  planned → in_progress → completed  [buyer confirmation]
  F-ESC-RELEASE-1 (money_transfer):    planned → in_progress → completed  [escrow → seller]
```

### Dispute path

```
Intent INT-ESC-D-1:     active → converted(ESC-COMM-D-1)

Commitment ESC-COMM-D-1: draft → proposed → accepted → partially_fulfilled
                           → fulfilled → disputed → refunded
  F-ESC-PAY-D-1      (money_transfer):    planned → in_progress → completed   [buyer → escrow]
  F-ESC-DEL-D-1      (physical_delivery): planned → in_progress → completed   [seller → buyer]
  F-ESC-RELEASE-D-1  (money_transfer):    planned → in_progress → reversed    [blocked by dispute]
  F-ESC-REFUND-D-1   (money_transfer):    planned → in_progress → completed   [escrow → buyer]
```

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | Happy path: 3200 MAD flows buyer → escrow (val_buyer_payment), then escrow → seller (val_escrow_release). Dispute path: 3200 MAD flows buyer → escrow (val_buyer_payment_d), then escrow → buyer (val_escrow_refund). All Value references resolve to known commitments/fulfillments. |
| **I-2 State Monotonicity** | Both fixtures have valid, non-repeating state sequences. The dispute path uses `fulfilled → disputed → refunded` — a forward chain, never a regression. |
| **I-3 Capacity Verification** | Both buyer and seller are verified before the Commitment reaches `accepted`. The escrow agent is verified with `can_guarantee: true`. |
| **I-4 Temporal Integrity** | All Commitment and Fulfillment histories are timestamp-monotonic. |
| **I-5 Identity Permanence** | Every id is unique across both fixtures independently (each fixture is validated independently by `auditCommerce`). |

## Extensions relied upon

### `AfterGoodsReceived` release condition (v0.3 `PaymentTiming`)

The model spec defines `PaymentTiming::AfterGoodsReceived` as the escrow
release condition. In the runtime schema, this is expressed as:

- **Prose-level commitment term**: described in the `description` field and
  `extensions_exercised` list of the fixture.
- **Evidence-level enforcement**: the escrow release Fulfillment carries a
  `trigger_verification` evidence item (`trigger_type: "AfterGoodsReceived"`,
  `fired: true`). The escrow agent must observe this evidence before completing
  the release.
- **Dispute path**: when the buyer disputes instead of confirming, the trigger
  fires as `fired: false` on the reversed release Fulfillment, proving the
  condition was not satisfied and the funds were correctly withheld.

### `Guarantor` role (`PartyRole::Guarantor`)

The model spec defines `PartyRole::Guarantor` for parties that back a
Commitment with their own capacity. In the runtime schema, this is expressed
as `capacity.can_guarantee: true` on the escrow agent party, combined with
the escrow agent appearing in `CommitmentParties.intermediaries`. There is no
separate `PartyRole` field in the schema — capacity flags carry the semantic.

## Representability findings

| Gap | Assessment |
|-----|------------|
| No `CommitmentCondition` object | The `AfterGoodsReceived` condition is prose + `extensions_exercised` + trigger evidence. The schema has no first-class `CommitmentCondition` structure to formally encode the conditional release. This means the runtime cannot automatically enforce the condition — it is a workflow-layer concern (Warp nodes check trigger evidence before proceeding). **FINDING**: `CommitmentCondition` is a genuine model gap for financial escrow, letter of credit, and contingent-release domains. Workaround: `trigger_verification` evidence on the release Fulfillment is sufficient for audit trail purposes. |
| Escrow fee not modelled | Real escrow services charge a fee. This fixture omits the escrow fee for clarity. To model it: add a third `money_transfer` Fulfillment (escrow deducts fee before releasing), and two Values — `val_escrow_fee` (transferred to escrow) and `val_seller_proceeds` (released amount minus fee). Conservation still holds: buyer_payment = seller_proceeds + escrow_fee. |
| Partial release not modelled | Some escrow services allow milestone-based partial releases (e.g., 50% on delivery, 50% on inspection pass). This is expressible as a child Commitment tree with `accepted → active → partially_fulfilled` per milestone, but would require `active` state usage and child Commitments. Out of scope for this fixture. |

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/escrow
# ✓ conformance/case-studies/escrow/dispute-and-refund.json
# ✓ conformance/case-studies/escrow/happy-path.json
```
