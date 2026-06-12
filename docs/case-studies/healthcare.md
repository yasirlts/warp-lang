> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/healthcare/healthcare.json`](../../conformance/case-studies/healthcare/healthcare.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Healthcare Commerce

> **Adversarial test corpus — executable.** This is one of the domains the
> [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test claims to
> have passed. The JSON fixtures below are real files under
> [`conformance/case-studies/healthcare/`](../../conformance/case-studies/healthcare/)
> that validate against [schema v1.0.0](../../schema/commerce.schema.json) and
> pass `auditCommerce`. Run them: `node conformance/audit.mjs conformance/case-studies/healthcare`.

**Reference domains:** Insured outpatient visits (CNOPS/CNSS Morocco), regulated
pharmacy dispensing, private clinic billing.

**Fixtures:**
- [`insured-visit.json`](../../conformance/case-studies/healthcare/insured-visit.json)
- [`prescription-pharmaceutical.json`](../../conformance/case-studies/healthcare/prescription-pharmaceutical.json)

---

## Why healthcare is a hard case

Healthcare commerce inverts the standard e-commerce payment contract in two
ways that stress the model directly:

1. **Price is not known at Commitment time.** In a standard order the customer
   pays a fixed amount before or at delivery. In insured healthcare the service
   is performed first and the final price is determined afterward — when the
   insurer adjudicates the claim. At Commitment time only an estimate exists.
   The model must represent a Commitment whose price changes *after* the service
   is delivered.

2. **Value transfers before payment.** The patient receives the service (value)
   before any money moves. Payment timing is
   `PaymentTiming::PostFulfillment::InsuranceAdjudication` — a v0.3 prose
   extension. This is the structural opposite of upfront payment.

Beyond these two inversions, healthcare adds:

- **A regulatory gate (PrescriptionRequired):** a dispense Commitment cannot
  reach `Accepted` until the prescription is verified. This is not optional.
  A pharmacist who dispenses without a valid prescription violates law.

- **No-return policy (NoReturnPolicy):** dispensed medication cannot be returned.
  There is no return Commitment. The absence of a return path is as
  domain-significant as the presence of one in physical e-commerce.

- **Split payment:** insured visits are paid by two parties — the patient
  (copay) and the insurer — using two separate `money_transfer` Fulfillments.
  The total price conservation holds: copay + insurer payment = total billed.

---

## Fixture 1 — Insured Visit (`insured-visit.json`)

### Parties

| ID | Type | Role |
|----|------|------|
| `patient_sara` | individual | Initiator (receives service, pays copay) |
| `org_clinic_atlas` | organization | Counterparty (performs service, receives total) |
| `org_insurer_cnops` | organization | Intermediary (adjudicates claim, pays insurer portion) |

The insurer is an `intermediary` in the Commitment parties because it is not
the primary seller of the service — it is the financing party that determines
the final price and pays its portion. The clinic is the counterparty: it is
legally responsible for the service and for billing.

### Values

| ID | Form | Amount | Final state |
|----|------|--------|-------------|
| `val_consult_service` | service | 1 session | `transferred` to patient |
| `val_copay_money` | money | MAD 150 | `transferred` to clinic |
| `val_insurer_payment` | money | MAD 650 | `transferred` to clinic |

At Commitment time the money values are **estimated** — the total is expected
to be ~MAD 800 but the exact split is not finalized until adjudication. This
is the `MoneyAmount::Estimated` pattern from the v0.3 spec (see Findings).

### The lifecycle — price finalization AFTER service delivery

The distinguishing feature of this fixture is the `modified` state inserted
*after* the service has been performed:

```
Commitment VISIT-1:

  draft → proposed
    patient books appointment; estimated total MAD 800

  proposed → accepted
    clinic confirms; insurance membership verified with insurer

  accepted → partially_fulfilled
    [fulfilled_item_ids: val_consult_service]
    [remaining_item_ids: val_copay_money, val_insurer_payment]
    ← SERVICE IS PERFORMED HERE; money is still pending
    ← Price is still estimated at this point

  partially_fulfilled → modified        ← PRICE FINALIZATION EVENT
    modified_by: org_insurer_cnops
    reason: adjudication complete; copay MAD 150 + insurer MAD 650
    ← Insurer adjudicates AFTER service; Estimated Money becomes final_at

  modified → accepted
    patient acknowledges finalized copay MAD 150

  accepted → partially_fulfilled
    [fulfilled_item_ids: val_consult_service, val_copay_money]
    [remaining_item_ids: val_insurer_payment]
    ← Copay paid at counter

  partially_fulfilled → fulfilled
    ← Insurer remits MAD 650 to clinic
    ← All obligations met; split payment complete
```

The `modified` state is the mechanism by which post-fulfillment price
finalization is represented. The Commitment transitions:
`partially_fulfilled → modified → accepted → partially_fulfilled → fulfilled`.

This uses only valid transitions from the COMMITMENT_OK table:
`partially_fulfilled→modified`, `modified→accepted`, `accepted→partially_fulfilled`,
`partially_fulfilled→fulfilled`. All are legal. No new transition is required.

The `modified_by` field records the insurer as the price-finalizing actor —
creating an auditable trail of who changed the price and why.

### Fulfillments

Three Fulfillments execute the three obligations:

```
Fulfillment F-SERVICE-1 (service_performance):  planned → in_progress → completed
  Evidence: service_completion (45 min; notes flag MedicalRecord schema gap)

Fulfillment F-COPAY-1 (money_transfer):         planned → in_progress → completed
  Evidence: payment_receipt (MAD 150, cmi-copay-21034)

Fulfillment F-INSURER-1 (money_transfer):       planned → in_progress → completed
  Evidence: payment_receipt (MAD 650, cnops-remit-88712)
```

Two `money_transfer` Fulfillments for one Commitment is the correct model for
split payment. Each payment is a distinct movement of distinct value to the
same destination (clinic). Value conservation holds: the clinic receives
exactly MAD 800, which equals the sum of the two money Values.

---

## Fixture 2 — Prescription Pharmaceutical (`prescription-pharmaceutical.json`)

### Parties

| ID | Type | Role |
|----|------|------|
| `patient_khalid` | individual | Initiator (receives medication, pays) |
| `org_pharmacy_shifaa` | organization | Counterparty (dispenses, receives payment) |
| `individual_dr_benali` | individual | Intermediary (prescribing physician; authorizes the gate) |

The prescribing doctor is an `intermediary` — not a seller, not a buyer, but
a required authorizing party whose verification enables the Commitment to
proceed to `Accepted`. The doctor's capacity is `can_guarantee: true`,
reflecting their role as the authoritative party whose prescription is the
credential that clears the gate.

### The PrescriptionRequired gate

The central feature of this fixture is that the Commitment **cannot reach
`Accepted` until the prescription is verified**. The transition sequence is:

```
Commitment RX-DISPENSE-1:

  draft → proposed
    patient presents prescription at counter
    reason: "PrescriptionRequired gate must be verified before Accepted;
             NoReturnPolicy applies — dispensed medication cannot be returned"

  proposed → accepted                   ← GATE CLEARED HERE
    reason: "PrescriptionRequired satisfied: prescription RX-BEN-20260610-44
             verified — issued by individual_dr_benali (licence MA-MED-7714)
             2026-06-10, valid until 2026-07-10, Amoxicillin 500mg 21 caps,
             0 refills; gate cleared, Commitment may now proceed to fulfillment"

  accepted → partially_fulfilled
    [fulfilled_item_ids: val_medication_amox]
    [remaining_item_ids: val_rx_payment]
    ← Medication dispensed; NoReturnPolicy noted — no return Commitment

  partially_fulfilled → fulfilled
    ← Payment MAD 87.50 received
```

Because `PrescriptionRequired` is a prose-level CommitmentCondition with no
schema field in v1.0.0, the gate is represented via the `reason` string on the
`proposed → accepted` transition. This is the honest model: the schema records
that the transition happened and why; the prose condition is carried in the
human-readable reason. The AI Verification Protocol (see model doc) would check
this condition before accepting the transition.

### No-return policy

Once dispensed, `val_medication_amox` is in `transferred` state and **no return
Commitment exists** for this fixture. This is intentional and domain-correct:

- Moroccan pharmaceutical regulations prohibit the return of dispensed
  prescription medications for patient safety.
- The `NoReturnPolicy` condition (v0.3 prose) means `Fulfilled → Refunded`
  is structurally available in the state machine but is never exercised here
  for the medication Value.
- The absence of a return Commitment, combined with the reason strings
  documenting the policy, is the correct model representation.

The `val_rx_payment` is standard upfront payment (cash at counter). This
fixture does not use post-fulfillment pricing: the pharmacy price is known
before dispense.

### Fulfillments

```
Fulfillment F-DISPENSE-1 (in_person_handover):  planned → in_progress → completed
  Evidence: trigger_verification (PrescriptionRequired fired=true)
            proof_of_delivery (patient_khalid signature)

Fulfillment F-RXPAY-1 (money_transfer):         planned → in_progress → completed
  Evidence: payment_receipt (MAD 87.50, rcpt-shifaa-4421)
```

The `trigger_verification` evidence on `F-DISPENSE-1` records that the
prescription gate fired — a permanent, auditable proof that the
PrescriptionRequired condition was satisfied before dispense occurred.

---

## Lifecycle summary

```
Intent INT-VISIT-1:       active → converted(VISIT-1)

Commitment VISIT-1:       draft → proposed → accepted
                          → partially_fulfilled (service done, price estimated)
                          → modified (insurer adjudicates, price finalized)
                          → accepted (patient acknowledges copay)
                          → partially_fulfilled (copay paid)
                          → fulfilled (insurer pays)
  Fulfillment F-SERVICE-1 (service_performance):  planned → in_progress → completed
  Fulfillment F-COPAY-1   (money_transfer):       planned → in_progress → completed
  Fulfillment F-INSURER-1 (money_transfer):       planned → in_progress → completed

Intent INT-RX-1:          active → converted(RX-DISPENSE-1)

Commitment RX-DISPENSE-1: draft → proposed → accepted [gate: PrescriptionRequired]
                          → partially_fulfilled (medication dispensed)
                          → fulfilled (payment received)
  Fulfillment F-DISPENSE-1 (in_person_handover): planned → in_progress → completed
  Fulfillment F-RXPAY-1    (money_transfer):     planned → in_progress → completed
```

---

## Invariants exercised

| Invariant | How healthcare exercises it |
|-----------|----------------------------|
| **I-1 Value Conservation** | Service transfers to patient; copay + insurer payment (MAD 150 + MAD 650 = MAD 800) transfer to clinic. Medication transfers to patient; payment transfers to pharmacy. All Value id references resolve. |
| **I-2 State Monotonicity** | Insured visit uses `partially_fulfilled → modified → accepted → partially_fulfilled → fulfilled` — a legally valid multi-step path. Prescription uses `accepted → partially_fulfilled → fulfilled`. No backward transitions occur. |
| **I-3 Capacity Verification** | All parties carry `verified_at` timestamps. Both `initiator` and `counterparty` on both Commitments are verified before `Accepted` is reached. |
| **I-4 Temporal Integrity** | All history timestamps are non-decreasing within each object. Insurer adjudication at 13:00 follows service completion at 10:45; patient copay at 14:30 follows adjudication; insurer remittance on 2026-06-12 follows all prior steps. |
| **I-5 Identity Permanence** | All ids (`patient_sara`, `patient_khalid`, `VISIT-1`, `RX-DISPENSE-1`, `F-SERVICE-1`, `F-COPAY-1`, `F-INSURER-1`, `F-DISPENSE-1`, `F-RXPAY-1`, all value and intent ids) are globally unique within the fixture corpus. |

---

## Extensions exercised

| Extension | Where it appears | Representation in schema v1.0.0 |
|-----------|-----------------|--------------------------------|
| **PostFulfillment (InsuranceAdjudication)** | `VISIT-1`: service delivered before any payment; price finalized by insurer after service | `modified` CommitmentState with `modified_by: org_insurer_cnops`; reason strings carry the adjudication narrative |
| **Estimated Money / final_at** | `val_copay_money` and `val_insurer_payment` are estimated at Commitment time | Quantities carry the final values; estimated status and finalization trigger documented in `proposed` and `modified` reason strings |
| **PrescriptionRequired** | `RX-DISPENSE-1`: Commitment cannot reach `Accepted` without prescription verification | `proposed → accepted` reason string records verification details; `trigger_verification` evidence records gate fired |
| **NoReturnPolicy** | Both fixtures: insured service (service cannot be un-performed); dispensed medication (regulatory prohibition) | Documented in reason strings; no return Commitment is created; absence of return path is the model representation |

---

## Findings — spec-vs-schema gaps

These are genuine gaps between the prose model (`docs/WARP_COMMERCE_MODEL.md`
v0.3) and the executable schema (`schema/commerce.schema.json` v1.0.0). They
are reported here as model findings, not as fixture workarounds.

### FINDING 1 — MedicalRecord evidence type absent from schema v1.0.0

The v0.3 spec defines `Evidence::MedicalRecord` at line 1459–1464 of
`WARP_COMMERCE_MODEL.md`:
```
MedicalRecord {
  reference: String
  issued_by: PartyID
  patient: PartyID
  service_date: Timestamp
}
```
The schema's `Evidence` oneOf (lines 706–797 of `commerce.schema.json`) does
not include `medical_record`. The valid evidence types in schema v1.0.0 are:
`proof_of_delivery`, `payment_receipt`, `access_grant`, `service_completion`,
`trigger_verification`.

**Impact:** Healthcare service fulfillment evidence must use `service_completion`
as a proxy. `service_completion.notes` carries the clinical reference. This is
weaker than a proper `medical_record` because it does not capture `patient`
and `service_date` as typed fields.

**Resolution needed:** Add `medical_record` to the schema's Evidence oneOf.

### FINDING 2 — Estimated Money / MoneyAmount::Estimated absent from schema v1.0.0

The v0.3 spec defines `Money::amount` as `MoneyAmount` with two variants:
`Exact { amount: Decimal }` and `Estimated { amount, basis, final_at, cap }`.
The schema's `Money` object (lines 40–50) has only `amount: string` and
`currency: string` — there is no mechanism to represent estimated amounts,
estimation basis, or the finalization trigger.

**Impact:** Post-fulfillment price finalization (the core of insured healthcare
commerce) cannot be precisely represented in the schema. The fixture carries
the estimated amount as a plain string quantity and uses commitment history
reason strings to document the estimation and finalization. This means a
validator cannot programmatically distinguish an estimated price from a
confirmed price.

**Resolution needed:** Extend the schema's `Money` object with optional
`estimated: boolean` and `final_at_trigger: string` fields, or restructure
`amount` as a `MoneyAmount` oneOf.

### FINDING 3 — PrescriptionRequired CommitmentCondition absent from schema v1.0.0

The v0.3 spec defines `CommitmentCondition::PrescriptionRequired` with fields
for the prescription document, issuer, validity, and the `must_verify_before`
transition gate. The schema's `Commitment` object has no `conditions` field
at all — CommitmentTerms/Conditions are not represented in the schema.

**Impact:** The prescription gate is represented only via reason strings, with
no machine-checkable enforcement in the schema. An audit tool cannot verify
that a Commitment reaching `Accepted` had its `PrescriptionRequired` condition
satisfied.

**Resolution needed:** Add a `conditions` array to the `Commitment` schema
object with at minimum a `prescription_required` condition variant.

### FINDING 4 — NoReturnPolicy CommitmentCondition absent from schema v1.0.0

Symmetric with Finding 3. `CommitmentCondition::NoReturnPolicy` is defined in
the v0.3 spec with `basis: String` and `jurisdiction: JurisdictionCode`. It is
not present in the schema. The no-return constraint is documented only in
reason strings and by the absence of a return Commitment.

**Resolution needed:** Add `no_return_policy` to the schema's Commitment
conditions vocabulary.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/healthcare
# ✓ conformance/case-studies/healthcare/insured-visit.json
# ✓ conformance/case-studies/healthcare/prescription-pharmaceutical.json
# auditCommerce: 2 passed, 0 failed, 0 warnings, 2 fixtures
```
