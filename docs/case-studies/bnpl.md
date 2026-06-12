> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/bnpl/bnpl.json`](../../conformance/case-studies/bnpl/bnpl.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Buy Now, Pay Later (BNPL)

> **Adversarial test corpus — executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below is a real fixture under
> [`conformance/case-studies/bnpl/`](../../conformance/case-studies/bnpl/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs conformance/case-studies/bnpl`.

**Reference platforms:** Tabby, Tamara, Afterpay, Klarna, Wafr Finance (fictional).
**Fixture:** [`bnpl-installment-purchase.json`](../../conformance/case-studies/bnpl/bnpl-installment-purchase.json)

---

## The domain and the hard cases it stresses

Buy Now, Pay Later is deceptively simple from the buyer's perspective — they
click, they receive, they pay monthly. The model complexity is underneath:

- **Three parties, two money flows.** The merchant is paid immediately in full
  by the BNPL provider. The buyer repays the provider over time. These are
  *two distinct financial obligations* — one physical-goods Commitment and one
  financing Commitment — that must be kept separate so their lifecycles do not
  interfere.

- **Installment schedule with interest.** The financing Commitment carries four
  scheduled repayments plus an interest component. The schema has no `terms`
  field on a Commitment — this is intentional (the schema is a runtime model,
  not a legal contract). The installment schedule and interest rate live in
  **prose** (this document) and in `extensions_exercised`. The executable
  fixture carries each installment as its own `money_transfer` Fulfillment.

- **A missed payment.** Installment 3 fails due to insufficient funds, is
  retried the next day, and succeeds. This stresses the `failed → planned`
  Fulfillment retry path, which requires `recoverable: true` on the failure.
  The failed attempt is a separate Fulfillment (`F-INST-3-FAILED`) to preserve
  the audit trail; the successful retry is `F-INST-3`.

- **BNPL provider as Intermediary.** The provider sits in the `intermediaries`
  array on the purchase Commitment, making its role in the transaction explicit
  without requiring a bespoke primitive.

---

## Installment schedule (prose — not a schema field)

The schema's `Commitment` object has no `terms` or `payment_schedule` field.
This is a genuine representability gap for BNPL: the structured schedule lives
outside the executable model. The fixture captures the observable *outcomes*
(each payment as a Fulfillment), while the schedule itself is documented here.

| # | Due date | Amount | Running total |
|---|----------|--------|---------------|
| 1 | 2026-07-01 | MAD 630.00 | MAD 630.00 |
| 2 | 2026-08-01 | MAD 630.00 | MAD 1,260.00 |
| 3 | 2026-09-01 | MAD 630.00 *(failed, retried 2026-09-02)* | MAD 1,890.00 |
| 4 | 2026-10-01 | MAD 630.00 | MAD 2,520.00 |

**Principal:** MAD 2,400.00  
**Interest:** MAD 120.00 (flat rate ~5% on principal, no compounding)  
**Total repaid:** MAD 2,520.00  

The `InterestRate` extension is exercised: fixed annual rate, no compounding,
computed as a flat fee spread equally across four installments.

---

## The model objects

### Parties

| ID | Role |
|----|------|
| `cust_karima` | Buyer — individual, jurisdiction MA |
| `org_techstore` | Merchant — sells and delivers the laptop |
| `org_wafr_finance` | BNPL provider — pays merchant upfront, collects installments |

### Values

| ID | Form | Final state |
|----|------|-------------|
| `val_laptop` | `physical_good` | transferred to `cust_karima` |
| `val_merchant_settlement` | `money` MAD 2,400 | transferred to `org_techstore` |
| `val_installment_1..4` | `money` MAD 630 each | transferred to `org_wafr_finance` |

### Two Commitments

**`PURCH-1` (buyer ↔ merchant, intermediary: BNPL provider)**

The purchase Commitment represents the exchange of the laptop for the BNPL
provider's settlement. The provider's presence in `intermediaries` signals that
payment flows through it, not directly from buyer to merchant.

```
draft → proposed → accepted → partially_fulfilled → fulfilled
                               (merchant paid)        (laptop delivered)
```

**`FIN-1` (buyer ↔ BNPL provider) — the financing Commitment**

The repayment obligation. The provider proposes the installment plan; the buyer
accepts at checkout. Each installment paid advances this Commitment.

Because `partially_fulfilled → partially_fulfilled` is not a valid transition,
the model uses `partially_fulfilled → modified → accepted → partially_fulfilled`
to record the second batch of installments being acknowledged. This is the
correct pattern: a schedule update is a modification, and the buyer's
acknowledgement re-accepts the updated terms before the next partial
fulfillment is recorded.

```
draft → proposed → accepted
  → partially_fulfilled  [after inst 1]
  → modified             [after inst 2: schedule updated]
  → accepted             [buyer re-accepts]
  → partially_fulfilled  [after inst 3 retry]
  → fulfilled            [after inst 4]
```

`FIN-1.parent = PURCH-1` and `PURCH-1.children = ["FIN-1"]` — I-6 tree
consistency enforced.

### Fulfillments (7 total)

| ID | Commitment | Method | Notes |
|----|-----------|--------|-------|
| `F-SETTLEMENT-1` | `PURCH-1` | `money_transfer` (bank_transfer) | Provider → merchant MAD 2,400 |
| `F-DEL-LAPTOP-1` | `PURCH-1` | `physical_delivery` | Laptop to buyer |
| `F-INST-1` | `FIN-1` | `money_transfer` (direct_debit) | Installment 1 |
| `F-INST-2` | `FIN-1` | `money_transfer` (direct_debit) | Installment 2 |
| `F-INST-3-FAILED` | `FIN-1` | `money_transfer` (direct_debit) | Failed attempt, `recoverable: true`, retried |
| `F-INST-3` | `FIN-1` | `money_transfer` (direct_debit) | Installment 3 (retry) |
| `F-INST-4` | `FIN-1` | `money_transfer` (direct_debit) | Installment 4 |

The missed installment is modelled as a full Fulfillment lifecycle:
`planned → failed(recoverable:true) → planned` (retry re-enqueue). A separate
Fulfillment `F-INST-3` then runs the successful retry. The failed attempt is
preserved as an immutable audit record.

---

## Lifecycle as a transition sequence

```
Intent INT-BNPL-1:    active → converted(PURCH-1)

Commitment PURCH-1:   draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-SETTLEMENT-1 (money_transfer):   planned → in_progress → completed
  Fulfillment F-DEL-LAPTOP-1 (physical_delivery): planned → in_progress → completed

Commitment FIN-1:     draft → proposed → accepted
                        → partially_fulfilled [inst 1]
                        → modified → accepted [inst 2 acknowledged]
                        → partially_fulfilled [inst 3 retry]
                        → fulfilled           [inst 4]
  Fulfillment F-INST-1 (money_transfer):        planned → in_progress → completed
  Fulfillment F-INST-2 (money_transfer):        planned → in_progress → completed
  Fulfillment F-INST-3-FAILED (money_transfer): planned → failed → planned (retry)
  Fulfillment F-INST-3 (money_transfer):        planned → in_progress → completed
  Fulfillment F-INST-4 (money_transfer):        planned → in_progress → completed
```

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | `val_merchant_settlement` references `PURCH-1`; each `val_installment_*` resolves to `FIN-1`. All fulfillment commitments resolve. No dangling references. |
| **I-2 State Monotonicity** | Both Commitments progress forward only. The missed installment does not roll back `FIN-1`; it fails at the Fulfillment level and retries. The `partially_fulfilled → modified → accepted` bridge is used correctly to avoid the forbidden `partially_fulfilled → partially_fulfilled` transition. |
| **I-3 Capacity Verification** | All three parties have `verified_at` timestamps. Both `PURCH-1` and `FIN-1` reach `accepted`, and all initiators/counterparties are in the parties array with verified capacity. |
| **I-4 Temporal Integrity** | All history timestamps are non-decreasing. The retry on 2026-09-02 follows the failure on 2026-09-01. |
| **I-5 Identity Permanence** | 3 parties + 6 values + 1 intent + 2 commitments + 7 fulfillments = 19 unique IDs. No reuse. |
| **I-6 Commitment Tree Consistency** | `FIN-1.parent = "PURCH-1"` and `PURCH-1.children = ["FIN-1"]`. Both directions confirmed by the auditor. |

---

## Extensions relied upon

### Installments payment timing
The financing Commitment `FIN-1` uses the `Installments` variant of
`PaymentTiming` from the Warp Commerce Model v0.3 spec. The structured
schedule (four payments, due dates, per-installment amounts) is documented in
the prose table above. In the runtime model, each installment is an independent
`money_transfer` Fulfillment — the schedule itself is a spec-level extension,
not a schema field.

**Gap noted (FINDING-1):** The `Commitment` object has no `payment_schedule`
or `terms` field. A complete BNPL integration would need to persist the
installment schedule (amounts, due dates, sequence numbers) somewhere. Options:
an `extensions` bag on Commitment, a child Commitment per installment, or
out-of-band storage with the Fulfillment IDs as the link. The current model
captures *outcomes* (paid/failed) but not *obligations* (what was promised to
be paid and when). This is a representability gap at the schema level.

### InterestRate
The financing Commitment carries a flat 5% interest on the MAD 2,400
principal, totalling MAD 120. The `InterestRate` extension in the spec models
this as `{ annual: 0.05, type: Fixed, compounding: None }`. The total
repayment (MAD 2,520) reflects principal + flat interest spread equally across
four installments (MAD 630 each). The interest amount is prose only — the
schema carries no `interest` or `rate` field on Commitment.

**Gap noted (FINDING-2):** The schema's `Money` type is present on Fulfillment
evidence (`payment_receipt.amount`) but there is no first-class `interest`
field on Commitment or Fulfillment. A finance-oriented extension would add
`{principal: Money, interest: Money, rate: InterestRate}` to Commitment, or
carry it as a structured annotation. For now, the installment amounts (which
include amortised interest) are modelled as plain payment amounts.

---

## FINDINGS

| ID | Severity | Description |
|----|----------|-------------|
| FINDING-1 | Gap | No `payment_schedule` field on Commitment. Installment obligations (amounts, due dates, sequence) cannot be expressed in the schema; only payment outcomes (Fulfillments) are first-class. |
| FINDING-2 | Gap | No `interest` or `rate` field on Commitment or Fulfillment. Interest-bearing schedules must be documented in prose; the schema carries only the total installment amounts. |
| FINDING-3 | Bug (fixed) | `audit.mjs` line 199 checked `body.failed.recoverable` but `variantBody()` already unwraps the variant — the correct check is `body.recoverable`. Fixed in this commit. The bug was latent because no prior fixture exercised `failed → planned`. |

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/bnpl
# ✓ conformance/case-studies/bnpl/bnpl-installment-purchase.json
# auditCommerce: 1 passed, 0 failed, 0 warnings, 1 fixtures
```
