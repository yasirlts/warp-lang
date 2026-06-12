> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/fx/fx.json`](../../conformance/case-studies/fx/fx.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Currency Exchange (FX)

> **Adversarial test corpus — executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON fixture at
> [`conformance/case-studies/fx/currency-exchange.json`](../../conformance/case-studies/fx/currency-exchange.json)
> validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs conformance/case-studies/fx`.

**Reference operations:** Bureau de change counter, bank FX desk,
hawala/informal exchange, crypto on-ramp at a physical kiosk.
**Fixture:** [`currency-exchange.json`](../../conformance/case-studies/fx/currency-exchange.json)

---

## The domain and the hard cases it stresses

A currency exchange is the most direct stress-test for the model's money
representation. Two different currencies change hands. The operation succeeds
only if both legs settle: neither party releases their currency until the other
does. This exposes three hard questions:

1. **Can the model hold two Money values with different currencies without
   conflating them?** Any system that treats money as a bare number will
   produce a nonsensical sum. The model's answer: every Money carries its
   currency code; MAD and EUR are permanently distinct; they can never be
   added without an explicit conversion. This is Invariant I-1 operating at
   the type level rather than the arithmetic level.

2. **How does simultaneous settlement map to state transitions?** There is no
   "first" and "second" leg in a true simultaneous exchange; either both happen
   or neither does. Yet the state machine requires at least one intermediate
   state between `accepted` and `fulfilled`. The model resolves this by
   allowing `accepted → partially_fulfilled → fulfilled` where both
   Fulfillments share an identical `completed_at` timestamp. The
   `partially_fulfilled` state records that the first cash handover has been
   observed, and `fulfilled` fires the moment the teller confirms the second —
   both in the same clock second at the counter. The simultaneity is preserved
   in the data: both `completed_at` fields are `2026-06-12T09:15:00+00:00`.

3. **Where does the exchange rate live?** The model has no schema field for
   `ExchangeRate` in Fulfillment or Commitment — and that is the right design.
   The rate is a term of the agreement, not a property of the transfer itself.
   It is captured in the Commitment's history `reason` field (human-readable)
   and declared in `extensions_exercised` as `currency_conversion / ExchangeRate`.
   The rate annotation is prose-level; the model's job is to prevent the
   _mistake_ of adding MAD and EUR, not to perform the arithmetic. See the
   FINDINGS section for a discussion of whether a structured rate field should
   be promoted to the schema.

---

## Scenario

Fatima is travelling to France and visits a Wafa Change bureau de change in
Casablanca to exchange 11 000 MAD for euros. The bureau quotes 11.00 MAD/EUR
(mid-rate from Bank Al-Maghrib plus a spread). Fatima agrees. The teller
counts out 11 000 MAD from Fatima, simultaneously counts out 1 000 EUR from
the bureau's till, and both handovers complete at the same moment at the
counter.

The exchange rate and its validity window are embedded in the Commitment's
`proposed → accepted` transition reason:
`"rate 11.00 MAD/EUR (rate valid until 2026-06-12T10:00:00+00:00, source: BAM mid-rate + spread)"`.

---

## The model objects

### Parties

| ID | Type | Role |
|----|------|------|
| `cust_fatima` | `individual` | Customer — initiator; hands over MAD, receives EUR |
| `org_wafachange` | `organization` | Bureau de change — counterparty; hands over EUR, receives MAD |

Both parties carry verified capacity before `FX-1` reaches `accepted`
(satisfying I-3).

### Values

| ID | Form | Quantity | Final state |
|----|------|----------|-------------|
| `val_mad_11000` | `money` | 11 000.00 MAD | `transferred` → `org_wafachange` at 09:15 |
| `val_eur_1000` | `money` | 1 000.00 EUR | `transferred` → `cust_fatima` at 09:15 |

The two Values use different currency codes. The model never produces a sum of
MAD and EUR; the conservation check (I-1) verifies only that every referenced
ID resolves, not that 11 000 == 1 000. The economic equivalence is asserted by
the exchange rate, which is human-readable prose in the Commitment history —
exactly where a term of the agreement belongs.

### Intent

`INT-FX-1` records Fatima's intent to exchange, created when she approached
the counter and valid until the rate expires (`expires_at:
2026-06-12T10:00:00+00:00`). It converts to `FX-1` the moment she accepts
the quote.

### Commitment: FX-1

One Commitment represents the entire swap. It progresses through four states:

```
draft → proposed → accepted → partially_fulfilled → fulfilled
```

The `proposed → accepted` transition is where the rate is locked. From that
point the bureau is bound to deliver 1 000 EUR when Fatima delivers 11 000 MAD.

The `accepted → partially_fulfilled` transition fires when the teller observes
Fatima's cash on the counter (MAD leg in progress). The `partially_fulfilled →
fulfilled` transition fires when the bureau's EUR is handed over — at the same
clock second, 09:15. The fulfilled state lists both value IDs as having been
delivered:

```json
{
  "from": "accepted",
  "to": {
    "partially_fulfilled": {
      "fulfilled_item_ids": ["val_mad_11000"],
      "remaining_item_ids": ["val_eur_1000"]
    }
  },
  "at": "2026-06-12T09:15:00+00:00"
}
```

Both transitions share timestamp `09:15:00` — the model faithfully records the
simultaneous nature of the settlement.

### Fulfillments

Two Fulfillments, both `money_transfer`, both completing at
`2026-06-12T09:15:00+00:00`:

| ID | Direction | Amount | Method | Evidence |
|----|-----------|--------|--------|----------|
| `F-MAD-OUT` | `cust_fatima` → `org_wafachange` | 11 000.00 **MAD** | `cash_handover` | `payment_receipt` (MAD) |
| `F-EUR-IN` | `org_wafachange` → `cust_fatima` | 1 000.00 **EUR** | `cash_handover` | `payment_receipt` (EUR) |

The `payment_receipt` evidence records the currency explicitly:
`"currency": "MAD"` for `F-MAD-OUT` and `"currency": "EUR"` for `F-EUR-IN`.
There is no ambiguity about which amount is which.

---

## Lifecycle as a transition sequence

```
Intent INT-FX-1:          active → converted(FX-1)

Commitment FX-1:          draft → proposed → accepted
                                           → partially_fulfilled (MAD leg observed)
                                           → fulfilled (EUR leg simultaneous)

  Fulfillment F-MAD-OUT (money_transfer):  planned → in_progress → completed  [09:15]
  Fulfillment F-EUR-IN  (money_transfer):  planned → in_progress → completed  [09:15]
                                                                   ↑ same timestamp
```

The identical `completed_at` on both Fulfillments is the machine-readable
assertion that settlement was simultaneous. A downstream audit that finds
`F-MAD-OUT.completed_at ≠ F-EUR-IN.completed_at` can flag the exchange as
having a settlement gap — a risk-management signal.

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | `val_mad_11000` references `org_wafachange` as recipient; `val_eur_1000` references `cust_fatima`. Both Fulfillments reference `FX-1`. All IDs resolve. MAD and EUR are never combined — the model records two distinct Money values, not a single converted total. |
| **I-2 State Monotonicity** | `FX-1` progresses strictly forward: `draft → proposed → accepted → partially_fulfilled → fulfilled`. No state is revisited. Both Fulfillments progress `planned → in_progress → completed`. The audit rejects any regression. |
| **I-3 Capacity Verification** | Both `cust_fatima` and `org_wafachange` carry `verified_at` timestamps before `FX-1` reaches `accepted`. The bureau's `can_guarantee: true` reflects its licensed FX dealer status under Bank Al-Maghrib regulation. |
| **I-4 Temporal Integrity** | All history timestamps are non-decreasing. The simultaneous settlement is modelled as equal timestamps (`09:15:00`), which satisfies `≤` monotonicity. |
| **I-5 Identity Permanence** | Every ID in the fixture — `cust_fatima`, `org_wafachange`, `val_mad_11000`, `val_eur_1000`, `INT-FX-1`, `FX-1`, `F-MAD-OUT`, `F-EUR-IN` — is globally unique. The audit finds zero collisions. |

---

## Extensions relied upon

### Simultaneous payment timing (`PaymentTiming::Simultaneous`)

The Commerce Model spec defines `Simultaneous` as the payment timing for
currency exchange and atomic swaps: both sides exchange at the same instant.
The fixture models this through:

- Identical `completed_at` on both Fulfillments (`2026-06-12T09:15:00+00:00`)
- The `partially_fulfilled → fulfilled` transition occurring at the same
  timestamp as the `accepted → partially_fulfilled` transition
- The Commitment's `reason` strings explicitly describing "first leg of
  simultaneous settlement" and "second leg completes simultaneously"

The `Simultaneous` payment timing is a prose-level extension. No schema field
is needed: the simultaneity is observable from the timestamps.

### `currency_conversion / ExchangeRate`

The spec defines `CurrencyConversion` as a Commitment term carrying:
- `from` / `to` currency codes
- `ExchangeRate { rate, valid_until, source }`
- `customer_pays: Money` (the amount in the customer's currency)

In the fixture, this information lives in the Commitment history's `reason`
fields (human-readable: `"rate 11.00 MAD/EUR (rate valid until ...)"`) and is
declared in `extensions_exercised`. No dedicated schema field for
`currency_conversion` exists at v1.0.0 — see FINDINGS.

---

## FINDINGS

### FINDING-FX-1: No structured ExchangeRate field in schema v1.0.0

**Gap:** The Commerce Model spec (v0.3) defines `currency_conversion /
ExchangeRate` as a structured term (`rate: Decimal`, `valid_until: Timestamp`,
`source: String`) on the Commitment. The conformance schema v1.0.0 has no
corresponding field on `Commitment`. The exchange rate in this fixture is
therefore prose-only (embedded in history `reason` strings).

**Impact:** A validator cannot mechanically assert that the quoted rate matches
the transferred amounts (11 000 MAD ÷ 1 000 EUR = 11.00). This arithmetic check
must be done by a layer above the schema.

**Recommendation:** Add an optional `terms` object to the `Commitment` schema
(or a dedicated `fx_rate` extension field) in a future schema release. The
field would carry `{ from_currency, to_currency, rate, valid_until, source }`.
Until then, the exchange rate is a representable but unvalidated prose
annotation.

### FINDING-FX-2: No atomic-swap guarantee in FulfillmentState

**Gap:** The model cannot express the conditional atomicity of simultaneous
settlement — that `F-EUR-IN` should be rolled back if `F-MAD-OUT` fails (and
vice versa). Each Fulfillment has its own independent state machine. If the
`cash_handover` for MAD succeeds but the EUR till is empty, the model records
`F-MAD-OUT: completed` and `F-EUR-IN: failed` with no link expressing that the
MAD transfer must be reversed.

**Impact:** A dispute arising from a partial FX settlement (one leg failed)
requires the `FX-1` Commitment to enter `disputed` state and a
`ResolutionProcess` to be opened. The model handles this correctly — it is not
a gap in correctness, only a gap in expressiveness. The atomicity guarantee must
be enforced by the runtime (Restate's durable execution), not by the schema.

**Recommendation:** No schema change required. Document in the runtime spec that
simultaneous-settlement Commitments must be executed in a single durable
transaction with compensation logic for the failed-leg case.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/fx
# ✓ conformance/case-studies/fx/currency-exchange.json
# ────────────────────────────────────────────────────
# auditCommerce: 1 passed, 0 failed, 0 warnings, 1 fixtures
```
