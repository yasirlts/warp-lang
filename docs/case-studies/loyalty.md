> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/loyalty/loyalty.json`](../../conformance/case-studies/loyalty/loyalty.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Loyalty and Rewards Programs

> **Adversarial test corpus — executable.** This case study covers the
> [Commerce Model](../WARP_COMMERCE_MODEL.md) domain claim for loyalty
> programs. The JSON fixtures below are real conformance objects under
> [`conformance/case-studies/loyalty/`](../../conformance/case-studies/loyalty/)
> that validate against [schema v1.0.0](../../schema/commerce.schema.json)
> and pass `auditCommerce`. Run them: `node conformance/audit.mjs conformance/case-studies/loyalty`.

**Reference programs:** aimer.ma, Marjane FidélitéCard, Carrefour MyClub.
**Fixtures:**
- [`purchase-with-earn.json`](../../conformance/case-studies/loyalty/purchase-with-earn.json)
- [`redeem-split-payment.json`](../../conformance/case-studies/loyalty/redeem-split-payment.json)

---

## The domain and what makes it hard

Loyalty programs look simple — buy something, get points, spend points — but
they stress the model at a specific seam: **value creation**. Every other
ValueForm in the model moves value between parties. Loyalty points are the one
case where value is *created from nothing* by the issuing merchant. That
creation is not a transfer, and the model must say so honestly.

The hard cases this domain puts on the model:

### Hard case 1 — Points creation is not transfer

When a merchant awards 349 AIMER-POINTS on a 349 MAD purchase, those points
did not exist before. They are not transferred from a pool. The merchant
incurs a new liability: a future obligation to accept those points as partial
or full payment. Invariant 1 (Value Conservation) would be violated if we
modelled this as a transfer from a "points pool" — no such pool was debited.

The model handles this via **Invariant 1 fourth clause (v0.3)**: loyalty points
and merchant-issued currency are the only ValueForm where creation, not
transfer, is the primary operation. Conservation applies to the issuer's total
outstanding liability, not to a per-transaction balance. A merchant cannot
issue more points than their business can sustain as redeemable value.

**In the fixture:** The earn is modelled as a child Commitment (`EARN-1`) of
the purchase Commitment (`ORD-LYL-1`). When delivery completes, `EARN-1` is
fulfilled via a `digital_delivery` Fulfillment (`F-EARN-PTS-1`) that credits
the customer's loyalty ledger. The Value `val_points_earned` (form: money,
quantity: 349 AIMER-POINTS) enters state `access_granted` — the customer has
been given access to those points as redeemable credit, with an expiry date.
The merchant's outstanding liability increases by 349 AIMER-POINTS.

### Hard case 2 — Redemption is standard transfer with custom currency

When the customer redeems 200 AIMER-POINTS as part of a split payment, the
points *transfer* from customer to merchant in the normal way — the same
`money_transfer` Fulfillment that handles MAD payments, but with
`currency: "AIMER-POINTS"`. After the transfer completes, the merchant
extinguishes those points (reduces their outstanding liability). The
redemption is conservation-correct: the customer loses 200 points, the
merchant receives and destroys 200 points.

**In the fixture:** The split payment is two Fulfillments on one Commitment
(`ORD-REDEEM-1`): `F-PAY-MAD-SPLIT-1` (149 MAD, mechanism: card) and
`F-PAY-POINTS-REDEEM-1` (200 AIMER-POINTS, mechanism:
`loyalty_points_redemption`). The `partially_fulfilled` state on the
Commitment lists both payment Values as fulfilled, with the goods still
remaining — the standard two-phase lifecycle.

### Hard case 3 — Points expiry

A prior batch of 75 points that expired before the redemption is represented
as `val_points_expired_batch` in `ValueState::access_expired`. This is a
terminal state: the customer lost access to those points at the expiry
timestamp, with no transfer occurring. The issuer's outstanding liability
decreased at that moment.

---

## The model objects

### Fixture 1: `purchase-with-earn.json`

The purchase Intent converts to Commitment `ORD-LYL-1`. On acceptance, the
merchant automatically creates a child earn Commitment `EARN-1` that commits
to crediting points on delivery. Two lifecycles run in parallel:

```
Intent INT-LYL-1:    active → converted(ORD-LYL-1)

Commitment ORD-LYL-1:  draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-PAY-LYL-1 (money_transfer, MAD):           planned → in_progress → completed
  Fulfillment F-DEL-LYL-1 (physical_delivery):             planned → in_progress → completed

Commitment EARN-1 (child of ORD-LYL-1):
               draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-EARN-PTS-1 (digital_delivery, loyalty_ledger_credit):
                                                            planned → in_progress → completed
```

The `EARN-1` Commitment runs its own history. The merchant is both the
initiator (creating the earn obligation) and the fulfiller (crediting the
points). The customer is the counterparty — they accepted the earn terms at
checkout.

The earn Fulfillment uses `digital_delivery` with mechanism
`loyalty_ledger_credit`, and produces an `access_grant` Evidence record
(token, granted_at, expires_at). The points Value ends in `access_granted`,
not `transferred`, because the merchant has not transferred an existing asset —
they have granted the customer access to a new obligation.

### Fixture 2: `redeem-split-payment.json`

A single purchase Commitment (`ORD-REDEEM-1`) carries two payment
Fulfillments and one delivery Fulfillment. The Commitment moves through:

```
Intent INT-REDEEM-1:    active → converted(ORD-REDEEM-1)

Commitment ORD-REDEEM-1:
  draft → proposed → accepted → partially_fulfilled(payments done) → fulfilled(goods delivered)
  Fulfillment F-PAY-MAD-SPLIT-1 (money_transfer, MAD 149):          planned → in_progress → completed
  Fulfillment F-PAY-POINTS-REDEEM-1 (money_transfer, AIMER-POINTS): planned → in_progress → completed
  Fulfillment F-DEL-REDEEM-1 (physical_delivery):                   planned → in_progress → completed
```

The redeemed-points Value (`val_payment_points_redeemed`) ends in
`transferred` state to `org_aimer` — standard transfer conservation. The
merchant then extinguishes those points (reducing their outstanding liability),
but extinguishment is a ledger operation, not a new commitment or state
transition in the model: the Value has reached a terminal `transferred` state
and the merchant records the liability reduction in their own system.

The expired-points Value (`val_points_expired_batch`) sits in
`access_expired` with `expired_at` set. This Value was never transferred —
it was created (via a prior earn), held, and expired without redemption.

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | Points earn creates a new Value (no transfer source); redemption is a standard transfer. Both preserve conservation: earn increases issuer liability, redemption decreases it. All Value state references resolve to existing commitments and fulfillments. |
| **I-2 State Monotonicity** | Both purchase commitments run forward-only histories. The expired points Value never returns to `available`; the redeemed points Value ends at `transferred`. |
| **I-3 Capacity Verification** | Both parties carry verified capacity records before any Commitment reaches `accepted`. `org_aimer.capacity.verified_at` predates all acceptance timestamps. |
| **I-4 Temporal Integrity** | All history timestamps are non-decreasing within each object. The earn Fulfillment starts no earlier than delivery completion (14:30 ≤ 14:35 in Fixture 1). |
| **I-5 Identity Permanence** | All IDs (`cust_nadia`, `org_aimer`, `ORD-LYL-1`, `EARN-1`, `ORD-REDEEM-1`, all Values and Fulfillments) are unique across both fixtures. |
| **I-6 Commitment Tree Consistency** | `EARN-1.parent = "ORD-LYL-1"` and `ORD-LYL-1.children = ["EARN-1"]`. Both directions agree. `ORD-REDEEM-1` has no children. |

---

## Extensions relied upon

| Extension | Where |
|-----------|-------|
| **LoyaltyEarnTerm** | Noted in prose on `ORD-LYL-1` acceptance: `earn_rate: 1 pt/MAD, points_earned: 349, credited_on: FulfillmentComplete`. This is a v0.3 `CommitmentTerms` extension. The field does not yet appear structurally in the fixture JSON (see Findings). |
| **CurrencyCode::Custom (AIMER-POINTS)** | `val_points_earned.quantity.unit = "AIMER-POINTS"`, `val_payment_points_redeemed.quantity.unit = "AIMER-POINTS"`, and both matching `payment_receipt.currency` fields. Money.currency is a free string; custom codes are representable without schema change. |
| **Invariant 1 fourth clause — controlled value creation** | `EARN-1` and `F-EARN-PTS-1` model the creation event. The Value enters `access_granted` (not `transferred`), making the creation origin structurally visible from the state shape. |

---

## Findings

Two genuine model gaps surfaced by this domain:

**FINDING 1: No `LoyaltyEarnTerm` structured field on Commitment.**
The v0.3 spec defines `CommitmentTerms.loyalty: Option<LoyaltyEarnTerm>` with
fields `program`, `earn_rate`, `points_earned`, `credited_on`, and `currency`.
This is a prose-level spec extension — there is no corresponding field in
`schema/commerce.schema.json` or the fixture JSON. The earn rate and
trigger are recorded only in the acceptance `reason` string in Fixture 1.
Consequence: validators cannot machine-check earn-rate arithmetic or
enforce `credited_on` trigger discipline. Structural `LoyaltyEarnTerm`
on Commitment would close this gap.

**FINDING 2: Points creation is not structurally distinguishable from transfer.**
The earn Fulfillment uses `digital_delivery` (mechanism:
`loyalty_ledger_credit`), and the points Value reaches `access_granted` rather
than `transferred`. This is the closest representable shape, and the
`access_granted` state does signal "granted by issuer" rather than "moved
between existing holders." However, the schema does not have a dedicated
`created` or `issued` ValueState variant. A future `ValueState::issued` (with
`by` and `issued_at` fields) would make creation unambiguously distinct from
transfer at the structural level, eliminating the need to rely on
`FulfillmentMethod.mechanism` strings to explain the creation semantics.

Both findings are representability limits, not model failures: the two
fixtures validate and pass `auditCommerce` without requiring any schema
changes.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/loyalty
# ✓ conformance/case-studies/loyalty/purchase-with-earn.json
# ✓ conformance/case-studies/loyalty/redeem-split-payment.json
# auditCommerce: 2 passed, 0 failed, 0 warnings, 2 fixtures
```
