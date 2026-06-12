> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/real-estate/real-estate.json`](../../conformance/case-studies/real-estate/real-estate.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Real Estate Commerce

> **Adversarial test corpus — now executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below are real fixtures under
> [`conformance/case-studies/real-estate/`](../../conformance/case-studies/real-estate/)
> that validate against [schema v1.0.0](../../schema/commerce.schema.json) and
> pass `auditCommerce`. Run them: `node conformance/audit.mjs conformance/case-studies/real-estate`.

**Reference jurisdictions:** Morocco (notarial civil-law system), France, Canada.
**Fixtures:**
- [`purchase-happy-path.json`](../../conformance/case-studies/real-estate/purchase-happy-path.json)
- [`financing-contingency-failure.json`](../../conformance/case-studies/real-estate/financing-contingency-failure.json)

---

## The domain and the hard cases it stresses

Real estate is one of the most legally choreographed commerce domains in
existence. The hard cases are not the property itself — it is a
`physical_good` Value — but the **contingency gates** and the **legal
mechanism of title transfer**:

- **Financing contingency:** the buyer's obligation is conditional on a
  lender approving a mortgage by a deadline. If the lender declines, the
  Commitment cancels and the deposit must be returned — *without penalty to
  the buyer*. The model must express this without inventing a new state.
- **Inspection contingency:** the buyer's obligation is conditional on the
  property passing a physical inspection. If it fails, the Commitment
  cancels or enters a repair negotiation (Modified).
- **Title transfer via notarial deed:** in civil-law systems (Morocco,
  France) legal ownership does not transfer on handover of keys — it
  transfers on signature of an *acte authentique* before a licensed notary,
  followed by registration at the *Conservation Foncière* (land registry).
  The model must express this without a sixth primitive.
- **Multi-party closing:** buyer, seller, notary (intermediary), and lender
  (intermediary/guarantor) all act in a coordinated sequence. Money from
  the lender flows directly to the seller via the notary's escrow. The
  deposit paid earlier is credited against the final purchase price.

### What the model handles cleanly

- The property is a `physical_good` Value (I-1 value conservation applies).
- Contingency conditions are `CommitmentCondition` extensions
  (`FinancingContingency`, `InspectionContingency`) at the spec v0.3 prose
  level. They are expressed in `extensions_exercised` on the fixture.
- The `accepted→cancelled` transition correctly expresses the
  contingency-triggered cancellation. `cancelled.reason` carries the human
  explanation.
- The deposit return is a *new forward Commitment* (`DEPOSIT-RETURN-1`)
  where the notary is the initiating party and the buyer is the
  counterparty — the same direction-reversal pattern as a merchandise
  return in physical e-commerce.
- The `draft→proposed` step exists in `DEPOSIT-RETURN-1` (the notary
  proposes the return, the seller accepts), keeping the record auditable.

### FINDINGS — gaps between spec v0.3 and schema v1.0.0

These are real representability gaps. They are not hidden or papered over.

#### FINDING 1 — No `title_transfer` FulfillmentMethod in schema v1.0.0

Spec v0.3 defines `DeliveryMethod::TitleTransfer { mechanism: NotarialDeed | WarrantyDeed | LandRegistration, registry, title_number, notary }`. This variant does not exist in the schema's closed `FulfillmentMethod` set, which contains:
`physical_delivery`, `in_person_handover`, `digital_delivery`,
`money_transfer`, `service_performance`, `internal_transfer`.

**Workaround used:** The title-handover Fulfillment (`F-TITLE-TRANSFER-1`)
uses `in_person_handover` with `location` set to the notary's office
address. This captures the physical signing event. The `service_completion`
evidence carries a note explaining that this represents a notarial deed
signing.

**Impact:** The `mechanism` field (`NotarialDeed` vs `WarrantyDeed` vs
`LandRegistration`) and the `registry`/`title_number` fields are not
machine-readable in the current schema. A system checking whether the
correct title-transfer mechanism was used must read the prose note, not
a structured field.

**Recommendation:** Add `title_transfer` as a `FulfillmentMethod` variant
in schema v2.0.0, matching the spec v0.3 definition.

#### FINDING 2 — No `registry_recording` Evidence type in schema v1.0.0

Spec v0.3 defines `Evidence::RegistryRecording { registry, reference, recorded_at, notary }` as the proof that title was registered at the land
registry (Conservation Foncière). This Evidence type does not exist in
the schema's closed `Evidence` set, which contains:
`proof_of_delivery`, `payment_receipt`, `access_grant`,
`service_completion`, `trigger_verification`.

**Workaround used:** The registry recording is expressed as
`trigger_verification { trigger_type: "RegistryRecording", fired: true, timestamp }`. This preserves the fact that recording occurred and when,
but loses the structured `registry`, `reference`, and `notary` fields that
make the evidence legally traceable.

**Impact:** Without a structured `registry_recording` Evidence type, an AI
agent or auditor cannot mechanically extract the land registry reference
number or confirm which specific registry the title was filed with. The
evidence exists but is opaque to automated processing.

**Recommendation:** Add `registry_recording` as an `Evidence` variant in
schema v2.0.0, matching the spec v0.3 definition.

---

## The model objects

The property is a `Value` with `form.type: "physical_good"`. The buyer's
desire to purchase is an `Intent` that converts to a `Commitment` (the
purchase agreement). The purchase agreement has four parties:

```
buyer_karim          individual   initiator
seller_fatima        individual   counterparty
notary_office_casablanca  org     intermediary
lender_bmce          org          intermediary + guarantor
```

### Fixture 1 — Happy path lifecycle

```
Intent INT-RE-1:  active → converted(PURCHASE-1)

Commitment PURCHASE-1:
  draft → proposed → accepted
        → partially_fulfilled (deposit paid; financing approved)
        → fulfilled (closing: final payment + title handover)

  Fulfillment F-DEPOSIT-1        (money_transfer):    planned → in_progress → completed
  Fulfillment F-INSPECTION-1     (service_performance): planned → in_progress → completed
  Fulfillment F-FINAL-PAYMENT-1  (money_transfer):    planned → in_progress → completed
  Fulfillment F-TITLE-TRANSFER-1 (in_person_handover): planned → in_progress → completed
```

The `accepted→partially_fulfilled` transition fires when three conditions
are simultaneously satisfied: the `FinancingContingency` (mortgage
approved), the `InspectionContingency` (no material defects), and the
deposit payment (`F-DEPOSIT-1` completed). This is expressed in the
transition `reason` field; the Commitment has no `terms/conditions`
schema field in v1.0.0 (see extensions_exercised).

The `partially_fulfilled→fulfilled` transition fires at closing when
`F-FINAL-PAYMENT-1` (1,400,000 MAD from lender) and
`F-TITLE-TRANSFER-1` (notarial deed + registry recording) are both
completed.

### Fixture 2 — Contingency failure lifecycle

```
Intent INT-RE-2:  active → converted(PURCHASE-2)

Commitment PURCHASE-2:
  draft → proposed → accepted → cancelled { by: buyer_nadia,
                                             reason: "financing contingency not met",
                                             at: 2026-05-20 }

  Fulfillment F-DEPOSIT-ESCROW-2 (money_transfer): planned → in_progress → completed
    [deposit paid into escrow — this Fulfillment completes before the cancellation]

Commitment DEPOSIT-RETURN-1  [new forward Commitment, parties reversed]:
  draft → proposed → accepted
        → partially_fulfilled (escrow release initiated)
        → fulfilled (deposit returned to buyer)

  Fulfillment F-DEPOSIT-RETURN-1 (money_transfer): planned → in_progress → completed
```

The original `PURCHASE-2` Commitment reaches `accepted` before cancelling.
This is the correct model: the FinancingContingency is a condition on
the already-accepted Commitment, not a precondition for reaching
`accepted`. The Commitment is accepted (binding on both parties),
contingency triggers, buyer exercises the right to cancel, Commitment
moves to `cancelled`.

The `DEPOSIT-RETURN-1` is a *new* Commitment where `seller_corp_realty`
is the initiator and `buyer_nadia` is the counterparty. This preserves
Invariant 2 (State Monotonicity): `PURCHASE-2` stays `cancelled` forever
and is never touched again. The return is a new forward arc.

---

## Contingency mechanics (prose model)

Because the schema v1.0.0 `Commitment` object has no `terms.conditions`
field, the two contingency extensions are expressed at the prose level
in `extensions_exercised` and in transition `reason` strings. Here is the
spec v0.3 vocabulary they map to:

### FinancingContingency

```
FinancingContingency {
  lender: lender_bmce / lender_cih
  amount: Money(1,400,000 MAD) / Money(1,800,000 MAD)
  rate_cap: 5.5%
  approval_deadline: 2026-05-30 / 2026-05-15
  if_not_met: CommitmentState::Cancelled
}
```

In the happy path the contingency is satisfied on 2026-04-15 when
`lender_bmce` approves the mortgage. In the failure fixture the
contingency deadline passes unsatisfied on 2026-05-15, giving the buyer
contractual right to cancel without forfeiting the deposit.

### InspectionContingency

```
InspectionContingency {
  inspector: notary_office_casablanca
  deadline: 2026-05-10
  if_failed: CommitmentState::Modified (repair negotiation)
             or CommitmentState::Cancelled (buyer walks)
}
```

In the happy path the inspection passes (`F-INSPECTION-1` completed
2026-05-05, no material defects). In the failure fixture the inspection
is irrelevant because the FinancingContingency failed first.

### TitleTransfer (NotarialDeed)

```
TitleTransfer {
  mechanism: NotarialDeed
  registry: "Conservation Foncière Casablanca" / "Conservation Foncière Rabat"
  title_number: "TF 42817/C" / "TF 88341/R"
  notary: notary_office_casablanca
}
```

The notarial deed is the legally constitutive act of property transfer in
Morocco. The model captures this via `in_person_handover` (workaround —
see FINDING 1) with `trigger_verification` evidence for the registry
recording (workaround — see FINDING 2).

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | The property (`val_property_apt42`) transfers from seller to buyer at closing. Money values transfer from buyer/lender to seller in two stages (deposit then final payment). In the failure fixture the deposit (`val_deposit_nadia`) is returned to the buyer — all value references resolve. |
| **I-2 State Monotonicity** | `PURCHASE-2` stays `cancelled` forever. The deposit return is a new forward Commitment, never a backward state change on `PURCHASE-2`. The original purchase agreement in the happy path stays `fulfilled`. |
| **I-3 Capacity Verification** | All four parties carry `verified_at` timestamps before any Commitment reaches `accepted`. The lender's `can_guarantee: true` capacity is verified. |
| **I-4 Temporal Integrity** | All history timestamps are strictly non-decreasing within each object. The deposit escrow in Fixture 2 completes before the cancellation timestamp. |
| **I-5 Identity Permanence** | All IDs are unique within each fixture: no ID is reused across parties, values, intents, commitments, or fulfillments. |

## Extensions exercised

| Extension | Fixture | How expressed |
|-----------|---------|---------------|
| `FinancingContingency` | Both | Prose in `extensions_exercised` + `reason` strings on transitions. Spec v0.3 structure not in schema v1.0.0. |
| `InspectionContingency` | Fixture 1 | Prose in `extensions_exercised` + `service_completion` evidence on `F-INSPECTION-1`. Spec v0.3 structure not in schema v1.0.0. |
| `TitleTransfer (NotarialDeed)` | Fixture 1 | `in_person_handover` workaround + `service_completion` evidence note. See FINDING 1. |

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/real-estate
# ✓ conformance/case-studies/real-estate/financing-contingency-failure.json
# ✓ conformance/case-studies/real-estate/purchase-happy-path.json
# auditCommerce: 2 passed, 0 failed, 0 warnings, 2 fixtures
```
