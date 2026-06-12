> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/pos/pos.json`](../../conformance/case-studies/pos/pos.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Physical Retail POS

> **Adversarial test corpus — executable.** This is one of the domains the
> [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test claims to
> have passed. The fixtures below live under
> [`conformance/case-studies/pos/`](../../conformance/case-studies/pos/)
> and validate against [schema v1.0.0](../../schema/commerce.schema.json),
> passing `auditCommerce`. Run them: `node conformance/audit.mjs`.

**Reference platforms:** Marjane (Morocco hypermarket chain), Carrefour MAR,
Label'Vie, any multi-branch retail POS.  
**Fixtures:**
- [`counter-sale-split-payment.json`](../../conformance/case-studies/pos/counter-sale-split-payment.json)
- [`inter-store-transfer.json`](../../conformance/case-studies/pos/inter-store-transfer.json)

---

## The domain and the hard cases it stresses

Physical retail POS is the oldest commerce pattern in the world, but it is
deceptively hard to model correctly when the model must also handle returns,
split tenders, and multi-store inventory. Three specific POS stresses are
exercised here:

**1. Split payment.** A POS transaction may be settled with multiple tenders
simultaneously — a common pattern in Moroccan retail where Marjane's loyalty
card, a bank card, and cash are all accepted at the same counter. The Commerce
Model has no `split` field on a Commitment; it has no `terms.payment.split`
runtime field in the serialized primitives. Split payment is therefore
represented as **multiple `money_transfer` Fulfillments on the same
Commitment**, one per tender, each carrying its own `Value` and evidence. The
loyalty tender uses a custom currency code (`MARJANE-POINTS`) — the schema's
`Money.currency` field explicitly allows non-ISO-4217 codes for loyalty
programs.

**2. Same-visit return with partial refund.** In under an hour, the customer
returns a defective unit. The naive approach — reversing the original sale
Commitment — is forbidden by Invariant 2 (State Monotonicity). The model
requires a **new role-reversed Commitment** (`RET-POS-1`) in which the customer
is the initiator of a return of goods and the merchant is the initiator of a
refund. The original `SALE-1` stays `fulfilled` forever. The partial refund
(cash only; loyalty points are non-refundable per policy) is a single
`money_transfer` Fulfillment on the return Commitment.

**3. Inter-store stock transfer.** A customer requests a unit that is
out-of-stock at their preferred branch but available at another branch of the
same chain. This produces two Commitments: an internal chain-to-chain transfer
Commitment (`XFER-1`) whose Fulfillment uses `internal_transfer`, and the
customer-facing sale Commitment (`SALE-XFER-1`) which uses `in_person_handover`
for goods handover on pickup day. The two Commitments are linked via the
parent/child tree (I-6).

---

## Fixture 1: Counter sale with split payment and same-visit return

### Parties

| ID | Role |
|----|------|
| `cust_karim` | Customer — individual buyer |
| `org_marjane_casa_ain_diab` | Merchant — the Aïn Diab Marjane store |
| `sys_pos_terminal_07` | POS terminal — system actor recording transactions |

### Values

| ID | Form | Quantity | Final state |
|----|------|----------|-------------|
| `val_blender` | physical_good | 1 unit | returned (same-visit defect return) |
| `val_payment_points` | money | 50 MARJANE-POINTS | transferred to merchant |
| `val_payment_card` | money | 200.00 MAD | transferred to merchant |
| `val_payment_cash` | money | 99.00 MAD | transferred to merchant |
| `val_refund_cash` | money | 299.00 MAD | transferred to customer |

The refund amount is 299 MAD (= 200 card + 99 cash). The 50-point loyalty
tender is non-refundable per Marjane policy. This is a policy fact, not a
model fact — the model does not enforce it; the model simply records that the
return Commitment's Fulfillments cover 299 MAD cash only.

### Lifecycle

```
Intent INT-POS-1:       active → converted(SALE-1)

Commitment SALE-1:      draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-PAY-POINTS-1 (money_transfer / loyalty_points_redemption): planned → in_progress → completed
  Fulfillment F-PAY-CARD-1   (money_transfer / card_chip_and_pin):          planned → in_progress → completed
  Fulfillment F-PAY-CASH-1   (money_transfer / cash):                       planned → in_progress → completed
  Fulfillment F-HANDOVER-1   (in_person_handover):                          planned → in_progress → completed

Commitment RET-POS-1:   draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-RET-GOODS-1  (in_person_handover — reverse direction):      planned → in_progress → completed
  Fulfillment F-REFUND-POS-1 (money_transfer / cash_refund):                planned → in_progress → completed
```

The split-payment: all three payment Fulfillments are planned against `SALE-1`
and complete within minutes. The Commitment moves `accepted →
partially_fulfilled` (all payments cleared, goods pending) → `fulfilled`
(goods handed over). Listing all three payment `Value` ids in
`fulfilled_item_ids` and the goods `Value` id in `remaining_item_ids` is the
natural way to represent "money in, goods pending" at a POS.

The key Commitment history entry for split payment:

```json
{
  "from": "accepted",
  "to": {
    "partially_fulfilled": {
      "fulfilled_item_ids": ["val_payment_points", "val_payment_card", "val_payment_cash"],
      "remaining_item_ids": ["val_blender"]
    }
  },
  "at": "2026-06-12T10:05:00+00:00",
  "actor": "sys_pos_terminal_07",
  "reason": "all three payment tenders cleared; goods handover pending"
}
```

---

## Fixture 2: Inter-store stock transfer for customer pickup

### Parties

| ID | Role |
|----|------|
| `cust_fatima` | Customer — individual buyer |
| `org_marjane_ain_diab` | Requesting store — sells to customer, requests transfer |
| `org_marjane_maarif` | Supplying store — holds stock, fulfils internal transfer |

### Values

| ID | Form | Quantity | Final state |
|----|------|----------|-------------|
| `val_blender_transfer` | physical_good | 1 unit | transferred to customer |
| `val_sale_payment` | money | 349.00 MAD | transferred to Aïn Diab store |

### Lifecycle

```
Intent INT-XFER-1:      active → converted(SALE-XFER-1)

Commitment XFER-1 [internal, parent]:
  draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-XFER-INTERNAL-1 (internal_transfer Maarif→AïnDiab): planned → in_progress → completed

Commitment SALE-XFER-1 [customer sale, child of XFER-1]:
  draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-PAY-XFER-1    (money_transfer / card_chip_and_pin): planned → in_progress → completed
  Fulfillment F-HANDOVER-XFER-1 (in_person_handover):               planned → in_progress → completed
```

The parent/child relationship (`XFER-1` parent, `SALE-XFER-1` child) is
validated by I-6. The customer-facing Commitment cannot be fulfilled until the
internal transfer Commitment is fulfilled — this sequencing is a runtime
concern expressed in Warp workflow logic, not in the model primitives
themselves.

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | Every `Value` references a real Commitment via its state; every Fulfillment references a real Commitment. Loyalty-point value (`MARJANE-POINTS`) is conserved: it moves from customer to merchant once and is not present in the refund path. |
| **I-2 State Monotonicity** | The same-visit return does not move `SALE-1` backward. `RET-POS-1` is a new forward Commitment. `auditCommerce` rejects any `fulfilled → *` regression. |
| **I-3 Capacity Verification** | All parties in both fixtures carry a `verified_at` timestamp before any Commitment reaches `accepted`. |
| **I-4 Temporal Integrity** | All history entries are timestamp-monotonic. The entire sale cycle (10:01–10:06) and return cycle (10:45–11:05) are within the same morning. |
| **I-5 Identity Permanence** | Every `id` across both fixtures is globally unique. |
| **I-6 Commitment Tree Consistency** (fixture 2) | `XFER-1.children` includes `SALE-XFER-1`; `SALE-XFER-1.parent` points back to `XFER-1`. |

---

## Extensions relied upon

| Extension | How it is modelled |
|-----------|-------------------|
| **SplitPayment** | Multiple `money_transfer` Fulfillments on one Commitment, one per tender. The `Commitment` has no `terms` field in the runtime serialization, so split-payment metadata (tender breakdown) lives in the Fulfillment `method.money_transfer.mechanism` and `evidence.payment_receipt` fields. |
| **LoyaltyPointsTender** | A `money_transfer` Fulfillment whose `payment_receipt.currency` is `MARJANE-POINTS`. The schema `Money.currency` field allows custom codes. |
| **SameVisitReturn** | Modelled identically to a standard return — a new role-reversed Commitment — with all timestamps within the same hour. No new primitives required. |
| **InterStoreTransfer** | A `Fulfillment` with `method.internal_transfer` (schema-native). The two-Commitment parent/child tree (`XFER-1` / `SALE-XFER-1`) represents the chain-internal arrangement backing the customer sale. |

---

## Representability findings

**FINDING 1 — Staff discount is prose-only.** A staff discount alters the
price of a sale. The Commerce Model's runtime primitives carry no `terms` field
on the serialized `Commitment`; the discount is therefore invisible to the
model except as a lower `Money` amount in the payment Fulfillment's evidence.
To make the discount explicit a future `terms` field would be needed, or a
custom extension field. For now, record it in Warp workflow metadata; the
model's Value conservation holds regardless of the discount size.

**FINDING 2 — Non-refundability of loyalty points is policy, not model.** The
partial refund (299 MAD cash, 0 points) correctly omits the loyalty-tender
Value from the return Commitment's Fulfillments. The model does not enforce
this rule — it neither prevents nor requires refunding points. The policy lives
in the Warp workflow logic that generates `RET-POS-1`.

**FINDING 3 — Split-payment atomicity.** POS tenders in reality succeed or
fail together (a three-tender transaction either commits or rolls back in full).
The model represents them as three independent Fulfillments, each of which can
individually reach `failed` and be retried if `recoverable: true`. A
non-atomic failure (e.g. card approved, then cash declined) would require a
partial-rollback workflow in Warp. The model's Fulfillment state machine
supports this via `in_progress → failed { recoverable: true } → planned →
in_progress → completed`, but the orchestration logic lives outside the
model primitives.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/pos
# ✓ conformance/case-studies/pos/counter-sale-split-payment.json
# ✓ conformance/case-studies/pos/inter-store-transfer.json
# auditCommerce: 2 passed, 0 failed, 0 warnings, 2 fixtures
```
