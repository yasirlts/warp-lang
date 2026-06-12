> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/group-buying/group-buying.json`](../../conformance/case-studies/group-buying/group-buying.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Group Buying

> **Adversarial test corpus — now executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below is a real fixture under
> [`conformance/case-studies/group-buying/`](../../conformance/case-studies/group-buying/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs conformance/case-studies/group-buying`.

**Reference platforms:** Groupon, Pinduoduo, Agora Group Deals, Hmizate.  
**Fixtures:**
- [`threshold-met.json`](../../conformance/case-studies/group-buying/threshold-met.json) — deal unlocks, all pledges activate and fulfil
- [`threshold-not-met.json`](../../conformance/case-studies/group-buying/threshold-not-met.json) — deadline passes with too few participants, all pledges cancel

---

## The domain and the hard cases it stresses

Group buying ("flash group deals") is a coordination problem: a seller offers
a steep discount only if enough buyers commit within a time window. The hard
part for any commerce model is that **no individual buyer's commitment is
binding until a collective threshold is crossed** — and that transition must
happen simultaneously for all participants, not sequentially.

The three tensions this domain puts on the model:

- **Simultaneous multi-party activation.** When the threshold is met, every
  pending pledge must transition to `accepted` at the same instant. The model
  has no "batch transition" operator — simultaneity is encoded as identical
  timestamps across independent Commitments, with the activating actor being
  a system party (`sys_agora_group`). This is the ThresholdActivation
  extension operating through coordinated transitions rather than a declarative
  schema field.

- **Price tiers as group size increases.** The agreed price depends on how
  many participants joined at activation time. This is a GroupPriceTier
  extension: the price locked in for all participants is determined by the
  tier bracket the final participant count falls into. There is no schema
  field for this; the operative price appears as the `offer_amount` in each
  pledge's `tendered` state and in the payment `Evidence`.

- **Simultaneous multi-party cancellation.** When the threshold is not met,
  every pending pledge must cancel at the same deadline timestamp. The
  `cancelled` state carries `by`, `reason`, and `at` — identical across
  all cancelled pledges. No fulfillments occur; any pre-authorised card holds
  are released by the payment processor outside the model.

---

## Price tier structure (GroupPriceTier extension)

For the Breville coffee machine deal (retail price 370 MAD):

| Participants | Price per unit | Discount |
|:---:|:---:|:---:|
| 10–29 | 300 MAD | 19% |
| 30–49 | 280 MAD | 24% |
| 50+ | 260 MAD | 30% |

The tiers are a prose-level commitment condition (`GroupPriceTier`). In the
fixture, the activated price (260 MAD, 50+ tier) appears as the
`offer_amount` in every pledge's `tendered` state and confirmed as the
`amount` in each `payment_receipt` evidence. There is no schema field for
tier lookup; the buyer sees the applicable price at pledge time and the model
records the agreed amount.

---

## Finding: ThresholdActivation has no declarative schema field

`ThresholdActivation` is a CommitmentCondition at the spec v0.3 prose level
(see `docs/WARP_COMMERCE_MODEL.md`, the `CommitmentCondition` section). It
describes activation logic: if participant count >= `minimum_participants` by
`activation_deadline`, all pledges activate; otherwise all cancel.

**The schema has no field for this condition.** The executable model encodes
ThresholdActivation entirely through coordinated Commitment transitions:

- Activation: all pledges carry `tendered → accepted` history entries at the
  same timestamp, with `actor = sys_agora_group` and a `reason` string that
  names the condition and outcome.
- Cancellation: all pledges carry `tendered → cancelled` history entries at
  the same timestamp, with `reason = "threshold not met"`.

The simultaneity is an assertion in the data (identical `at` fields), not an
enforced invariant. `auditCommerce` verifies state monotonicity and temporal
integrity for each pledge individually; it cannot verify cross-commitment
simultaneity. A runtime implementing ThresholdActivation must enforce this
atomically (e.g. via a Restate workflow that fans out over all pledge IDs and
writes the same activation timestamp). The model is sufficient for
representability but not for enforcement — this is a correct boundary.

---

## Fixture 1 — Threshold met

### Lifecycle

```
Buyer intents (3 shown of 52):
  INT-GBY-A:  active → converted(PLEDGE-A)     [2026-06-10T09:15]
  INT-GBY-B:  active → converted(PLEDGE-B)     [2026-06-10T11:30]
  INT-GBY-C:  active → converted(PLEDGE-C)     [2026-06-11T14:00]

Commitments — all 52 activate simultaneously at threshold:
  PLEDGE-A:   draft → tendered → accepted → partially_fulfilled → fulfilled
  PLEDGE-B:   draft → tendered → accepted → partially_fulfilled → fulfilled
  PLEDGE-C:   draft → tendered → accepted → partially_fulfilled → fulfilled
                                  ↑ all at 2026-06-12T16:00 (ThresholdActivation)

Fulfillments per pledge (3 × 2):
  F-PAY-GBY-A  (money_transfer):    planned → in_progress → completed
  F-DEL-GBY-A  (physical_delivery): planned → in_progress → completed
  (same shape for B and C)
```

### The activation moment

When participant 50 joins (here the 52nd joins with time to spare), the
`sys_agora_group` system party fires the ThresholdActivation. Every pledge
moves `tendered → accepted` at `2026-06-12T16:00:00+00:00`. The `reason`
field on each transition records the participant count, the threshold, and
the price tier that was unlocked:

```json
{
  "from": { "tendered": { "offer_amount": "260.00", "offer_currency": "MAD", "closes_at": "2026-06-12T16:00:00+00:00", "superseded_by": null } },
  "to": "accepted",
  "at": "2026-06-12T16:00:00+00:00",
  "actor": "sys_agora_group",
  "reason": "ThresholdActivation: 52 participants reached threshold of 50 by deadline; 50+ tier unlocked at 260 MAD; all pledges activate simultaneously"
}
```

Payment is captured immediately (each commitment moves to
`partially_fulfilled` at `16:05`); physical delivery follows over the next
six days.

---

## Fixture 2 — Threshold not met

### Lifecycle

```
Buyer intents (3 shown of 18):
  INT-GBY-D:  active → converted(PLEDGE-D)     [2026-06-12T10:00]
  INT-GBY-E:  active → converted(PLEDGE-E)     [2026-06-12T14:30]
  INT-GBY-F:  active → converted(PLEDGE-F)     [2026-06-13T09:00]

Commitments — all 18 cancel simultaneously at deadline:
  PLEDGE-D:   draft → tendered → cancelled
  PLEDGE-E:   draft → tendered → cancelled
  PLEDGE-F:   draft → tendered → cancelled
                                  ↑ all at 2026-06-14T16:00 (threshold not met)

Fulfillments: none (empty array — no goods, no payments, nothing to fulfil)
```

### The cancellation moment

At deadline, `sys_agora_group` fires the cancellation sweep. Every pledge
moves `tendered → cancelled` at the same timestamp:

```json
{
  "from": { "tendered": { "offer_amount": "260.00", "offer_currency": "MAD", "closes_at": "2026-06-14T16:00:00+00:00", "superseded_by": null } },
  "to": { "cancelled": { "by": "sys_agora_group_2", "reason": "threshold not met", "at": "2026-06-14T16:00:00+00:00" } },
  "at": "2026-06-14T16:00:00+00:00",
  "actor": "sys_agora_group_2",
  "reason": "ThresholdActivation: deadline reached with only 18 of 50 required participants; all pledges cancelled simultaneously; any pre-authorised card holds released"
}
```

No fulfillments exist. Values in this fixture are modelled as
`contingent_value` slots in `available` state — they were never reserved to
a specific commitment because the threshold condition was never satisfied.

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | All `val_*` Value references resolve to existing Commitments and Fulfillments. Cancelled commitments leave their contingent Values in `available` state — no dangling references. |
| **I-2 State Monotonicity** | Each pledge follows the legal chain: `draft → tendered → accepted → partially_fulfilled → fulfilled` (met) or `draft → tendered → cancelled` (not met). The validator rejects any attempt to move a cancelled pledge to `accepted` or vice versa. |
| **I-3 Capacity Verification** | Exercised in Fixture 1 only (where pledges reach `accepted`): all buyer and seller parties carry a `verified_at` timestamp. Fixture 2 pledges never reach `accepted`, so I-3 is satisfied vacuously. |
| **I-4 Temporal Integrity** | All history timestamps are non-decreasing within each pledge. Simultaneous activation/cancellation uses identical timestamps across pledges — no pledge moves backward. |
| **I-5 Identity Permanence** | All ids are globally unique within each fixture. Fixture 1 and Fixture 2 use distinct party ids (`org_breville_ma` vs `org_breville_ma_2`, etc.) to prevent cross-fixture id collisions if fixtures are ever merged for testing. |

---

## Extensions exercised

| Extension | Status | Encoding |
|-----------|--------|----------|
| **ThresholdActivation** | Prose-level CommitmentCondition (spec v0.3). No schema field exists. | Coordinated `tendered → accepted` or `tendered → cancelled` transitions at a common timestamp; activation logic and participant count in `reason` string. |
| **GroupPriceTier** | Prose-level extension of ThresholdActivation. No schema field exists. | Price tier operative at activation time appears as `offer_amount` in the `tendered` state and confirmed in `payment_receipt` evidence. Tier table is documented in prose (this file) and in `extensions_exercised`. |

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/group-buying
# ✓ conformance/case-studies/group-buying/threshold-met.json
# ✓ conformance/case-studies/group-buying/threshold-not-met.json
# auditCommerce: 2 passed, 0 failed, 0 warnings, 2 fixtures
```
