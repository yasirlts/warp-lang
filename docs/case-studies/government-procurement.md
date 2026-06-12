> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/government-procurement/government-procurement.json`](../../conformance/case-studies/government-procurement/government-procurement.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Government Procurement

> **Adversarial test corpus — executable.** This is one of the domains the
> [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test claims
> to have passed. The JSON below is a real fixture under
> [`conformance/case-studies/government-procurement/`](../../conformance/case-studies/government-procurement/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs conformance/case-studies/government-procurement`.

**Reference platforms:** Morocco Marchés Publics (Portail des Marchés de l'État), EU TED (Tenders Electronic Daily), GCC government procurement portals.
**Fixture:** [`public-tender-with-protest.json`](../../conformance/case-studies/government-procurement/public-tender-with-protest.json)

---

## The domain and the hard cases it stresses

Government procurement is not a price auction. A public tender selects among
suppliers on *weighted multi-criteria scoring* — technical capability, price,
local content, past performance — not on who bid lowest. This is the most
important structural difference from the auction domains already modelled.

The *hard cases* this domain puts on the model:

- **Scored selection, not price maximisation.** Bids are evaluated by a
  committee against a published scoring matrix. The "winner" is the highest
  *composite score*, which may not be the lowest or highest price.
- **Minimum technical threshold.** A bid that scores below a minimum on
  technical criteria is disqualified regardless of price. This is a gate, not
  a criterion.
- **Award protest.** A losing supplier can formally challenge the award
  decision before contract signature. If upheld, the initial award is
  rescinded and a re-evaluation or re-award follows. This creates a fork in
  the commitment lifecycle: an accepted commitment that later transitions to
  cancelled.
- **Compliance documentation.** Suppliers must submit statutory documents
  (tax clearance, criminal record, professional qualification certificates)
  before the contract can be activated. Missing documents block execution even
  if the bid was winning.
- **Phased payment against service milestones.** Government contracts
  typically release payment tranches tied to delivery milestones (mobilisation,
  interim acceptance, final acceptance), not as a single lump sum.

---

## Extensions relied upon (schema gaps — the central finding of this domain)

This domain exposes three concrete gaps between the v0.3 prose spec and the
v1.0.0 executable schema. These are **not modelling choices** — they are
cases where the spec defines vocabulary that does not exist in the schema.

### Extension 1 — ScoredSelection: UNREPRESENTABLE in schema v1.0.0

The v0.3 spec defines:

```
AuctionMechanism::ScoredSelection {
  criteria: Vec<ScoringCriterion> { name, weight, max_points }
  minimum_threshold: Option<u32>
  evaluation_committee: Vec<PartyID>
  publication_required: bool
}
```

The schema v1.0.0 `AuctionMechanism` is a **closed** `oneOf` with exactly
four variants: `english`, `dutch`, `sealed_bid`, `vickrey`. There is no
`scored_selection` variant. Any fixture that sets
`"mechanism": {"scored_selection": {...}}` fails schema validation.

**Resolution in this fixture:** The tender is encoded with
`"mechanism": {"sealed_bid": {...}}` — the closest available variant
(bids are submitted privately and evaluated before revelation, which is
structurally similar). The scoring criteria, weights, minimum threshold,
and evaluation committee exist only in the `subject_description` prose field.

**Impact:** The spec's claim that "government procurement passed" the Formal
Sufficiency Test cannot be demonstrated with an *executable* schema fixture.
The prose model is richer than the schema.

The scoring for this tender was:

| Criterion | Weight | Supplier A | Supplier B | Supplier C | Supplier D |
|-----------|--------|------------|------------|------------|------------|
| Technical capability | 50% | 44/50 | 29/50 | 38/50 | 32/50 |
| Price (MAD) | 30% | 24/30 | 15/30 | 26/30 | 20/30 |
| Local content | 20% | 14/20 | 17/20 | 15/20 | 16/20 |
| **Total** | **100%** | **82** | **61** | **79** | **68** |
| Minimum threshold met? | ≥65 | Yes | **No — disqualified** | Yes | Yes |

Supplier B (BID-B) is disqualified for failing the minimum technical
threshold (61 < 65). This threshold logic has no schema representation.

### Extension 2 — AwardProtest: no schema object

The v0.3 spec defines an `AwardProtest` auxiliary record:

```
AwardProtest {
  id: ProtestID
  filed_by: PartyID
  against: CommitmentID
  auction_process: AuctionProcessID
  grounds: Vec<String>
  filed_at: Timestamp
  deadline_for_response: Timestamp
  reviewing_body: Option<PartyID>
  state: ProtestState { Filed | UnderReview | Upheld { remedy } | Dismissed }
}
```

Schema v1.0.0 has no `award_protests` array in `Fixture` and no
`AwardProtest` schema object. The protest cannot be represented as a
first-class object.

**Resolution in this fixture:** The upheld protest (AP-001) is modelled
through its *effect* on commitments:

```
BID-C: tendered → accepted → cancelled
  (reason: "award protest upheld — AwardProtest AP-001 — original award rescinded")

BID-A-REAWARDED: draft → tendered → accepted → ... → fulfilled
  (re-tender of Supplier A's terms following protest)
```

The protest narrative, grounds, reviewer, and remedy are in prose. The
commitment lifecycle correctly captures the outcome (accepted → cancelled),
but the regulatory record of *why* — the protest document itself — has no
schema home.

### Extension 3 — ComplianceDocumentation: no CommitmentCondition schema object

The v0.3 spec defines:

```
CommitmentCondition::ComplianceDocumentation {
  required_documents: Vec<String>
  submission_deadline: Timestamp
  verified_by: PartyID
  if_not_submitted: CommitmentState
}
```

Schema v1.0.0 has no `conditions` array on `Commitment` and no
`CommitmentCondition` schema at all. The pre-award compliance check —
tax clearance certificate, company registration, professional licence — is
a regulatory requirement that blocks contract execution if not satisfied.

**Resolution in this fixture:** Compliance verification is noted in the
re-award acceptance transition's `reason` field:
`"compliance documents verified"`. There is no structured enforcement.

---

## The scenario

The **Ministry of Digital Transformation** (Morocco) issues a public tender
for IT infrastructure deployment and 24-month managed services. Reference:
MDT-2026-007. Budget ceiling: 12,000,000 MAD. Reserve price: 7,000,000 MAD.

**Timeline:**

| Date | Event |
|------|-------|
| 2026-02-15 | Tender notice published |
| 2026-02-20 | Bid submission period opens |
| 2026-04-10 | Bid submission deadline |
| 2026-05-05 | Evaluation committee announces initial award: Supplier C (BID-C, 8,750,000 MAD, score 79/100) |
| 2026-05-06 | Supplier A files AwardProtest AP-001: scoring error in technical evaluation |
| 2026-05-12 | Protest upheld — corrected score: Supplier A 82/100, Supplier C 79/100 — re-award to Supplier A |
| 2026-05-13 | BID-A-REAWARDED contract formalised |
| 2026-06-01 | Mobilisation phase begins |
| 2026-06-15 | Mobilisation accepted; tranche 1 payment (4,500,000 MAD) released |
| 2026-09-18 | Full deployment accepted |
| 2026-09-20 | Final payment (tranche 2, 4,500,000 MAD) released; contract fulfilled |

Total paid: 9,000,000 MAD = 4,500,000 (T1) + 4,500,000 (T2). All MAD.

---

## The model objects

### Parties (6)

| ID | Role |
|----|------|
| `party_ministry` | Buyer — the contracting authority |
| `party_supplier_a` | Supplier A — protestor, re-awardee |
| `party_supplier_b` | Supplier B — disqualified (below technical threshold) |
| `party_supplier_c` | Supplier C — initial awardee, cancelled on protest |
| `party_supplier_d` | Supplier D — not selected |
| `party_procurement_committee` | Evaluation intermediary |

### Values (3)

| ID | Form | Final state |
|----|------|-------------|
| `val_it_services_contract` | service | committed to BID-A-REAWARDED |
| `val_contract_payment_tranche_1` | money (4,500,000 MAD) | transferred to Supplier A |
| `val_contract_payment_tranche_2` | money (4,500,000 MAD) | transferred to Supplier A |

### Intent (1)

`INT-TENDER-001` — the Ministry's procurement intent, active from tender
publication, converted to `BID-A-REAWARDED` once the re-award decision is final.

### Commitments (5)

| ID | Supplier | Offer (MAD) | Final state | Reason |
|----|----------|-------------|-------------|--------|
| `BID-A` | Supplier A | 9,000,000 | cancelled | Initial evaluation — not selected (ranked 2nd with score 76; re-evaluated to 82 after protest — but this bid is superseded by BID-A-REAWARDED) |
| `BID-B` | Supplier B | 11,200,000 | cancelled | Not selected — disqualified (score 61, below threshold 65) |
| `BID-C` | Supplier C | 8,750,000 | cancelled | Initially accepted, then cancelled — AwardProtest AP-001 upheld |
| `BID-D` | Supplier D | 10,100,000 | cancelled | Not selected — score 68, ranked 3rd |
| `BID-A-REAWARDED` | Supplier A | 9,000,000 | **fulfilled** | Re-award — score 82 on corrected evaluation; proceeds through service delivery to fulfillment |

### AuctionProcess (1)

`TENDER-MDT-2026-007` — the public tender coordination record.

- Mechanism: `sealed_bid` (schema representation) — see Extension 1 above
- State: `closed`, `winning_commitment: "BID-C"` (initial award before protest;
  the auction record is not updated for the re-award since no re-opening occurred)
- All four bids are in `tendered_commitments`

Note: The auction's `winning_commitment` reflects the initial award to BID-C,
which is the state at `normal_close`. The protest and re-award are a
post-close administrative process. The actual contract (BID-A-REAWARDED) is
correct, but the auction object cannot express the protest mechanism or the
re-award — another consequence of the AwardProtest gap.

### Fulfillments (4)

| ID | Commitment | Method | Amount |
|----|------------|--------|--------|
| `FUL-MOBILISATION` | BID-A-REAWARDED | service_performance | — |
| `FUL-PAYMENT-TRANCHE-1` | BID-A-REAWARDED | money_transfer | 4,500,000 MAD |
| `FUL-IT-SERVICES` | BID-A-REAWARDED | service_performance | — |
| `FUL-PAYMENT-TRANCHE-2` | BID-A-REAWARDED | money_transfer | 4,500,000 MAD |

---

## Lifecycle as a transition sequence

```
Intent INT-TENDER-001:       active → converted(BID-A-REAWARDED)

AuctionProcess TENDER-MDT-2026-007:
  scheduled → open → closed(winning: BID-C, normal_close)
  [protest and re-award are post-close; not representable in AuctionState]

Commitment BID-A:            draft → tendered → cancelled (not selected initially)
Commitment BID-B:            draft → tendered → cancelled (disqualified)
Commitment BID-C:            draft → tendered → accepted → cancelled (protest upheld)
Commitment BID-D:            draft → tendered → cancelled (not selected)

Commitment BID-A-REAWARDED:  draft → tendered → accepted
                             → partially_fulfilled → fulfilled

  Fulfillment FUL-MOBILISATION (service_performance):
    planned → in_progress → completed

  Fulfillment FUL-PAYMENT-TRANCHE-1 (money_transfer):
    planned → in_progress → completed

  Fulfillment FUL-IT-SERVICES (service_performance):
    planned → in_progress → completed

  Fulfillment FUL-PAYMENT-TRANCHE-2 (money_transfer):
    planned → in_progress → completed
```

The critical transition: `BID-C: accepted → cancelled`. This is a valid
transition in the Commitment table (`accepted > cancelled`) and is how
the protest outcome is expressed. State monotonicity (I-2) is preserved
because `cancelled` is a forward transition, not a reversal.

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | `val_contract_payment_tranche_1` and `_tranche_2` reference `BID-A-REAWARDED` (via committed/transferred states). All fulfillment `commitment` fields point to existing commitments. The auction's `tendered_commitments` and `winning_commitment` all resolve. No dangling references. |
| **I-2 State Monotonicity** | The protest path is modelled as `BID-C: accepted → cancelled` — a forward transition, never a reversal. `BID-A-REAWARDED` follows the canonical path through `partially_fulfilled` to `fulfilled`. All five commitment histories and four fulfillment histories chain correctly. |
| **I-3 Capacity Verification** | `BID-C` reached `accepted` (initial award), so `party_supplier_c` and `party_ministry` must both carry `verified_at`. `BID-A-REAWARDED` also reached `accepted`, requiring `party_supplier_a` and `party_ministry` to be verified. All verified parties carry `verified_at` timestamps set before their first acceptance. |
| **I-4 Temporal Integrity** | Bid submission timestamps (April) precede evaluation timestamps (May), which precede service delivery timestamps (June–September). All history arrays are monotonically non-decreasing. |
| **I-5 Identity Permanence** | Six parties, three values, one intent, five commitments, four fulfillments, one auction process — 20 objects, each with a distinct `id`. No reuse detected. |

---

## What the model can express without extensions

The five base primitives handle the procurement *lifecycle* correctly:

- Multiple competing bids as parallel Tendered commitments
- Loser bids transitioning to cancelled with `reason` carrying the evaluation rationale
- An initial winner's commitment going `accepted → cancelled` (protest effect)
- A re-award modelled as a fresh Tendered → accepted lifecycle
- Phased service delivery through `partially_fulfilled`
- Milestone-linked payments as separate Fulfillments with `money_transfer` method
- `service_completion` Evidence confirming acceptance at each milestone

---

## What the model cannot express — schema gaps

The following v0.3 spec constructs are **not representable** in schema v1.0.0:

| Construct | Spec location | Schema status | Workaround |
|-----------|---------------|---------------|------------|
| `AuctionMechanism::ScoredSelection` | v0.3 changelog, §AuctionProcess | **Missing** — closed set {english, dutch, sealed_bid, vickrey} | Use `sealed_bid`; put scoring criteria in `subject_description` prose |
| `AwardProtest` auxiliary record | v0.3 §AwardProtest | **Missing** — no `award_protests` in Fixture | Model via `accepted → cancelled` on the awarded commitment; protest narrative in `reason` string |
| `CommitmentCondition::ComplianceDocumentation` | v0.3 §CommitmentConditions | **Missing** — no `conditions` array on Commitment | Note in acceptance transition `reason`; no structural enforcement |

These are not minor gaps. `ScoredSelection` is the *defining mechanism* of
government procurement — every public tender in Morocco, the EU, and the GCC
uses weighted multi-criteria scoring, not a price auction. Without it, any
schema-valid government procurement fixture is structurally misrepresented
as a price-only sealed bid. The spec's claim to have "passed" government
procurement cannot be reproduced as an executable fixture that correctly
names the mechanism.

The `AwardProtest` gap means the regulatory audit trail — which procurement
authorities are legally required to maintain — has no first-class schema
object. The protest can be inferred from commitment state transitions but
cannot be queried, validated, or tracked as a structured record.

The `ComplianceDocumentation` gap means the gate that protects against
non-compliant suppliers (those who did not submit tax clearance, professional
licences, etc.) has no enforcement path in the schema. A fixture could model
a non-compliant supplier reaching `accepted` without any validator catching it.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/government-procurement
# ✓ conformance/case-studies/government-procurement/public-tender-with-protest.json
# auditCommerce: 1 passed, 0 failed, 0 warnings, 1 fixtures
```

Full suite (all domains):

```bash
node conformance/audit.mjs
# auditCommerce: 22 passed, 0 failed, 0 warnings, 22 fixtures
```
