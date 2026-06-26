# Warp Commerce Model — Domain Case Studies (reconciled at canonical v1.0.0)

**These are the adversarial test corpus referenced in the Commerce Model spec's
Formal Sufficiency Test — now executable against the _canonical_ schema.**

The spec claims the five primitives were "tested adversarially across 22
commerce domains." This directory turns that claim into evidence: one worked
case study per domain — backed by an **executable canonical `scene`
fixture** that validates + audits clean against the canonical Warp Commerce
Model schema v1.0.0 (`schema/structure/*.schema.json`) via the canonical runner.

It also includes a focused **generality** demonstration (F18-20): three
domains — **insurance**, **healthcare**, and **procurement** — each shown twice,
as an accept scene (the domain expressed in the five primitives) *and* a
violation scene where a domain-specific error is caught by one of the six
invariants. See [Generality beyond commerce](#generality-beyond-commerce-f18-20).

```bash
node conformance/runner/run.mjs            # all fixtures vs canonical schema
node conformance/case-studies/validate-aux.mjs   # 5/5 auxiliary records vs canonical
```

## What "reconciled" means

The case studies were authored by Agent D (PR #1) against a **bespoke minimal
schema** and a standalone `audit.mjs`. Both are superseded. This corpus was
re-pointed at the canonical schema:

- Each domain is re-authored as a canonical `scene` fixture (PascalCase `.type`
  states, numeric `Money`, `subject.{offered,requested}`, `{kind,payload}`
  envelope) by `conformance/case-studies/_generate.mjs`.
- They are judged by the canonical runner — the same one that judges the core
  conformance suite. No bespoke schema or runner is used.
- Auxiliary records (AuctionProcess incl. ScoredSelection, AwardProtest,
  ResolutionProcess, EntitlementConsumption) are validated against the canonical
  schema by `conformance/case-studies/validate-aux.mjs`.

The per-domain markdown files below are D's original narratives (lifecycle
walkthroughs). **Where a markdown says a construct is "UNREPRESENTABLE in schema
v1.0.0" or "pending-v1.1", that was true of D's bespoke schema, not the
canonical one** — see the banner at the top of each file and the Findings below.

## Result

| | |
|---|---|
| Commerce domains documented + lifecycle-walked | **22** (+ insurance = 23 accept scenes) |
| Executably validated against canonical v1.0.0 | all accept scenes pass |
| Blocked / pending-v1.1 (cannot express against canonical) | **0** |
| Unmodelable by the five primitives | **0** |
| Non-commerce generality domains (accept + violation) | **3** (insurance, healthcare, procurement) |
| Auxiliary records validated vs canonical | **5 / 5** |

The honest split is **22 conformant / 0 pending / 0 unmodelable** — because the
**canonical schema already expresses every v0.3 construct D had flagged as a
gap**. Two genuinely new follow-ups surfaced ([BACKLOG](../../schema/BACKLOG-v1.1.md)
B-2, B-3); neither blocks any domain.

## Status table — domain → validates v1.0.0? → signature constructs exercised

All fixtures are `kind: scene`, `expect: accept`, under
`conformance/case-studies/<domain>/<domain>.json`.

| Domain | Validates v1.0.0 | Signature canonical constructs exercised |
|--------|:---:|------------------------------------------|
| physical-ecommerce | ✅ | base five primitives; return as new role-reversed Commitment (I-2) |
| gifting | ✅ | parent→3-children tree (I-6 sum); ResolutionProcess (aux) |
| pos | ✅ | `InPersonHandover`; `StaffDiscount`; split tender (loyalty+card+cash) |
| services | ✅ | `ServicePerformance`; `NoShowPolicy`; `GracePeriod`; subscription `Active` |
| bnpl | ✅ | `PaymentTiming::Installments`; financing child (I-6) |
| escrow | ✅ | `PaymentTiming::AfterGoodsReceived`; Guarantor intermediary |
| fx | ✅ | two single-currency Commitments; `Simultaneous`; `currency_conversion` |
| saas | ✅ | `DigitalGood` NonExclusive `License`; `DigitalDelivery`; `AccessGrant` |
| streaming | ✅ | `AccessModel::Stream`; `GracePeriod`; subscription `Active` (see B-2) |
| api-metering | ✅ | `AccessModel::APIAccess`; `Metered`; overage Commitment; `EntitlementConsumption` (aux) |
| nft | ✅ | `DigitalGood` Exclusive `NFT`; `RoyaltyDistribution` condition |
| auction-family | ✅ | `Tendered` bids; supersession; `AuctionProcess`/`English` (aux) |
| real-estate | ✅ | `FinancingContingency`; `InspectionContingency`; `TitleTransfer`; `RegistryRecording` |
| healthcare | ✅ | `PostFulfillment(InsuranceAdjudication)`; `PrescriptionRequired`; `NoReturnPolicy`; `MedicalRecord` |
| government-procurement | ✅ | `ComplianceDocumentation`; `ScoredSelection` + `AwardProtest` (aux) |
| wholesale | ✅ | `RecurringDelivery`; `Net`; `VolumePricing`; blanket-PO tree (I-6) |
| marketplace | ✅ | `CommissionSplit` (DoubleSided); payout+commission tree (I-6) |
| trade-finance | ✅ | `DocumentaryCollection`; `DocumentsAgainstPayment`; `CustomsRelease`; `BillOfLading`+`CustomsClearance` |
| events | ✅ | `EventAccess`; `CascadeCancellation`; `EventCancellationPolicy`; ticket tree (I-6) |
| loyalty | ✅ | `LoyaltyEarnTerm`; custom-currency points (`PTS`); split cash/points |
| group-buying | ✅ | `ThresholdActivation`; simultaneous activation |
| carbon-credits | ✅ | `AccessModel::CarbonCredit`; `ValueState::Retired`; `RegistryVerification`; `RegistryRetirement`; `RetirementCertificate` |
| insurance | ✅ | coverage as a Commitment; claim as a settlement payout (`Refunded`) within the coverage limit (I-1) |

"(aux)" = the signature record is an auxiliary record, validated by
`validate-aux.mjs` against the canonical schema (the scene runner has no `kind`
for standalone auxiliary records — [BACKLOG B-3](../../schema/BACKLOG-v1.1.md)).

## Findings — what the reconciliation revealed

1. **The model spine is sound and now executable against the canonical schema.**
   All 22 domains express as canonical `scene` fixtures and audit clean
   (I-1..I-6). No domain needed a sixth primitive; **0 unmodelable**.

2. **D's "pending-v1.1" gaps were artifacts of D's bespoke schema, not the
   canonical one.** ScoredSelection, the full CommitmentCondition layer,
   CascadeCancellation, AwardProtest, and the v0.3 Evidence / DeliveryMethod /
   PaymentTiming / AccessModel variants are **all present in canonical v1.0.0** —
   proven by the re-authored fixtures (which carry them in `terms`) and by
   `validate-aux.mjs`. **0 of D's listed constructs is a real v1.1 gap.**

3. **One genuine schema gap surfaced — [B-2](../../schema/BACKLOG-v1.1.md):**
   canonical `ValueState` has no digital-access lifecycle (AccessGranted /
   AccessSuspended / AccessRevoked / AccessExpired). `streaming`/`saas` model
   access suspension/revocation at the Commitment level instead. This does **not**
   block those domains (they validate); it is a candidate v1.1 refinement.

4. **One conformance-coverage item — [B-3](../../schema/BACKLOG-v1.1.md):** the
   runner has no fixture `kind` for standalone auxiliary records; they are covered
   by `validate-aux.mjs` as a supplement. Not a schema gap.

The claim, stated precisely: **every domain is documented and lifecycle-walked;
all 22 are executably validated against the canonical schema v1.0.0; 0 await a
v1.1 schema construct to be expressible; the only enumerated follow-ups are one
optional ValueState refinement (B-2) and one runner-coverage enhancement (B-3).**

## Generality beyond commerce (F18-20)

The 22 domains above are all commerce. This section demonstrates that the five
primitives (Party, Value, Intent, Commitment, Fulfillment) and the six
invariants also describe **non-commerce economic domains** — without any schema
change. Generality is shown on **three** domains, each mapped onto the existing
primitives and each paired with a violation fixture where a domain-specific
error is caught by an invariant. This is a demonstration on these three domains,
not a proof of universality.

| Domain | Mapped onto primitives | Accept scene | Violation scene | Invariant the violation triggers |
|--------|------------------------|--------------|-----------------|----------------------------------|
| **insurance** | coverage = Commitment (requested = the limit); a claim = a settlement payout (`Refunded`) against it | `insurance/insurance.json` — claim 7000 ≤ coverage 10000 MAD | `insurance/insurance-violation.json` — claim 15000 > coverage 10000 MAD | **I-1 Value Conservation** — a payout cannot exceed the captured/committed value |
| **healthcare** | authorization = Commitment; the dispense = a Fulfillment that may only execute after the commitment is Accepted | `healthcare/healthcare.json` — adjudicated visit, dispense after auth | `healthcare/healthcare-violation.json` — dispense Completed while auth only Proposed | **I-4 Temporal Integrity** — the commitment (authorization) must form before the fulfillment (dispense) executes |
| **procurement** | PO = Commitment (requested = receipt-matched amount); the invoice settlement = a payout against it (three-way match) | `government-procurement/government-procurement.json` — scored tender, award protest | `procurement/procurement-violation.json` — invoice 9500 > receipt 8000 MAD | **I-1 Value Conservation** — the disbursement (invoice) cannot exceed the captured value (goods received) |

How the mapping works, stated precisely:

- **insurance over-claim and procurement invoice>receipt** both reuse the I-1
  amount-conservation clause already in the model (a `Refunded` settlement whose
  amount exceeds the same-currency committed amount). An insurance payout above
  the coverage limit, and an invoice above the receipt-matched PO, are both
  "paying out more than was captured" — the same shape as a commerce over-refund.
- **healthcare dispense-before-authorization** reuses I-4: a Completed
  fulfillment against a commitment that never reached Accepted.

Each violation fixture is wired into the manifest as `expect: reject` with the
triggering `rule`, with a `.expected.json` sidecar, exactly like the core
`conformance/invalid/*` fixtures. The runner asserts the declared rule actually
fires, and the four-way TS↔Python↔Rust↔Go cross-check
(`conformance/tooling/crosscheck.mjs`) asserts all four bindings agree on each
verdict.

**Bounded-generality note.** These three domains map onto the primitives with no
schema change because each domain-specific error reduces to an *existing*
invariant clause (I-1 amount conservation, I-4 temporal ordering). That is the
scope of what is demonstrated here: three non-commerce economic domains, each
with one invariant catching one domain-specific violation. It is not a claim that
every conceivable economic domain is expressible without schema work.

## Regenerating

```bash
node conformance/case-studies/_generate.mjs   # rewrites fixtures + manifest block
node conformance/runner/run.mjs               # all fixtures must stay green
node conformance/case-studies/validate-aux.mjs
```
