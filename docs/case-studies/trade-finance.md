> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/trade-finance/trade-finance.json`](../../conformance/case-studies/trade-finance/trade-finance.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Cross-Border Trade Finance

> **Adversarial test corpus — executable.** This domain is one of the
> cross-border commerce scenarios the [Commerce Model](../WARP_COMMERCE_MODEL.md)
> Formal Sufficiency Test covers. The JSON fixture below is a real file under
> [`conformance/case-studies/trade-finance/`](../../conformance/case-studies/trade-finance/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. This case study also surfaces **four concrete schema gaps**
> between the v0.3 spec prose and the v1.0.0 executable schema. Run it:
> `node conformance/audit.mjs conformance/case-studies/trade-finance`.

**Reference platforms:** SWIFT, Misys TI, Finastra Trade Innovation, SAP GTS, Oracle Banking.
**Fixture:** [`documentary-collection.json`](../../conformance/case-studies/trade-finance/documentary-collection.json)

---

## The domain and the hard cases it stresses

Cross-border documentary collection is one of the oldest and most
structurally demanding commerce patterns. A Moroccan industrial importer
buys machinery from a German exporter. No letter of credit is used —
instead a **collecting bank** intermediates the exchange of title documents
for payment, ensuring neither side can default without recourse.

The hard cases this domain puts on the model:

- **Four parties, two of them government/regulatory.** The model must hold
  an exporter, an importer, a collecting bank acting as guarantor/intermediary,
  and a customs authority acting as release intermediary. Four parties, one
  Commitment.

- **An exclusive DigitalGood in escrow.** The Bill of Lading and shipping
  documents are the legal title to the goods. They are modelled as an
  **exclusive** `digital_good` Value — only one party holds them at any
  moment. The bank holds them in `ValueState::committed` until payment fires;
  then they transfer to the importer. This is the documentary collection
  pattern: the bank as custodian, not owner.

- **DocumentsAgainstPayment timing.** The importer cannot receive the documents
  before paying the bank; the bank cannot forward payment to the exporter before
  releasing the documents. This mutual-release constraint is the defining
  characteristic of documentary collection. The Commitment transitions to
  `partially_fulfilled` at the moment both the payment transfer and the document
  release are simultaneously complete.

- **CustomsRelease as a government-intermediated delivery step.** After the
  importer holds the documents they can present them to customs. Customs
  releases the physical goods only when import duties are paid. Customs is
  therefore a second intermediary in the Commitment, and the customs event is
  a distinct Fulfillment.

- **Two-currency transaction.** Payment is in EUR (the exporter's currency);
  import duties are in MAD (Morocco's currency). Both are Money values with
  explicit currency codes — no bare amounts.

- **`accepted → partially_fulfilled → fulfilled` — no shortcut.** The
  Commitment cannot jump from `accepted` directly to `fulfilled`. Documents
  and payment are exchanged first (partially_fulfilled); then customs clears
  the goods (fulfilled). The invariant enforces this.

---

## The schema gap findings (key results of this case study)

This domain was designed to probe the boundary between the **v0.3 spec prose**
and the **v1.0.0 executable schema**. Four gaps were found.

### Gap 1 — `BillOfLading` Evidence type: UNREPRESENTABLE

**Spec v0.3 defines:**
```
Evidence {
  BillOfLading {
    reference: String
    issued_by: PartyID
    goods_description: String
    origin_port: String
    destination_port: String
    issued_at: Timestamp
  }
  ...
}
```

**Schema v1.0.0 Evidence oneOf is CLOSED** to exactly five variants:
`proof_of_delivery`, `payment_receipt`, `access_grant`, `service_completion`,
`trigger_verification`.

`bill_of_lading` is not present. A Bill of Lading is the foundational
document in any cross-border shipment. Its absence means the executable
schema cannot record the cargo loading event with proper structured fields
(port of origin, port of destination, issuing carrier, goods description).

**Workaround used in fixture:** `proof_of_delivery` with the Hamburg port
agent as signer and the collecting bank (`org_bnp_collect`) as `recipient`
— the bank is the legal consignee on the BoL until documents are released.

### Gap 2 — `CustomsClearance` Evidence type: UNREPRESENTABLE

**Spec v0.3 defines:**
```
Evidence {
  CustomsClearance {
    reference: String
    cleared_at: Timestamp
    jurisdiction: JurisdictionCode
  }
  ...
}
```

**Schema v1.0.0:** `customs_clearance` is absent from the Evidence oneOf.

Customs clearance is a government-issued formal release that carries a
jurisdiction code and a clearance reference. Recording it as
`service_completion` (as this fixture does) loses the `jurisdiction` field
and the structured clearance reference, replacing it with a free-text `notes`
field. Any system that needs to verify "was this shipment formally cleared
in jurisdiction MA?" cannot do so from the executable schema alone.

**Workaround used in fixture:** `trigger_verification` with
`trigger_type: "customs_clearance_approved"` to capture the boolean fact of
clearance; `service_completion` confirmed by `org_customs_ma` to capture the
completing actor and timestamp.

### Gap 3 — `CustomsRelease` FulfillmentMethod: UNREPRESENTABLE

**Spec v0.3 defines:**
```
DeliveryMethod {
  CustomsRelease {
    customs_reference: String
    cleared_at: Timestamp
    duties_paid: Option<Money>
    inspection_required: bool
  }
  ...
}
```

**Schema v1.0.0 FulfillmentMethod oneOf is CLOSED** to exactly six variants:
`physical_delivery`, `in_person_handover`, `digital_delivery`, `money_transfer`,
`service_performance`, `internal_transfer`.

`customs_release` is not present. This is the most significant structural gap
for this domain. Customs release is not a service being performed in the
commercial sense — it is a government authority releasing title to goods that
the importer already legally owns (via the BoL). Using `service_performance`
loses the `customs_reference`, `duties_paid`, and `inspection_required` fields
that make customs release auditable.

**Workaround used in fixture:** `service_performance` with `performer:
org_customs_ma` for the customs processing Fulfillment; `in_person_handover`
at the port for the final cargo collection Fulfillment.

### Gap 4 — `DocumentaryCollection` / `RequiredDocuments` terms: PROSE-ONLY

**Spec v0.3 defines** `DocumentaryCollection` as an `AccessModel` variant on
`DigitalGood` (with `held_by` and `release_condition` fields) and
`RequiredDocuments` as a `CommitmentTerms` member (with boolean flags for
BillOfLading, CommercialInvoice, PackingList, CertificateOfOrigin,
InsuranceCertificate, CustomsDeclaration).

**Schema v1.0.0 `ValueForm`** defines `digital_good` with an open `type` field
and no `additionalProperties: false` constraint — so the `access_model`,
`held_by`, and `release_condition` fields are **structurally tolerated** but
not validated. The schema's `ValueForm` is intentionally open per the spec:

> "remaining fields are form-specific and intentionally open"

Similarly `CommitmentTerms` are not modelled in the schema (Commitment has
`parties`, `state`, `history`, `children`, `created_at`, `expires_at` — no
`terms` object). The `RequiredDocuments` term is therefore not validatable.

**Fixture approach:** The `documentary_collection` access model and
`required_documents` terms are embedded as free-form fields in the `form`
object and in `history` transition `reason` strings respectively. The
validator accepts them (open `additionalProperties` on `ValueForm`) but
cannot structurally enforce them.

**Status:** These are spec-level terms that need promotion into the closed
schema before they can be enforced by `auditCommerce`.

---

## The model objects

Four parties, four Values, one Intent, one Commitment, six Fulfillments.

### Parties

| id | role | jurisdiction |
|----|------|--------------|
| `org_rhein_export` | Exporter / counterparty | DE |
| `org_atlas_import` | Importer / initiator | MA |
| `org_bnp_collect` | Collecting bank / guarantor intermediary | MA |
| `org_customs_ma` | Customs authority / release intermediary | MA |

The bank holds `can_guarantee: true` — it is the guarantor that holds
title documents as collateral against payment. Customs holds `can_fulfill:
true` — it executes the release action. Neither holds `can_buy` or `can_sell`.

### Values

| id | form | final state |
|----|------|-------------|
| `val_machinery` | `physical_good` — 50T hydraulic press | `transferred` to importer |
| `val_payment_purchase` | `money` — 185,000 EUR | `transferred` to exporter |
| `val_duties` | `money` — 32,000 MAD | `transferred` to customs |
| `val_title_docs` | `digital_good` (exclusive) — BoL + docs set | `transferred` to importer |

`val_title_docs` is the critical Value. It starts the scenario in
`committed` state (the bank holds it). The `committed` state uses the
physical-goods `ValueState` vocabulary, not the `access_granted` vocabulary,
because exclusive digital goods follow the ownership-transfer path. The
documents are **released** (transferred) to the importer once payment is
confirmed — this is the DocumentaryCollection pattern rendered in
the schema's available states.

### The Commitment: `COMM-TF-1`

```json
{
  "id": "COMM-TF-1",
  "parties": {
    "initiator": "org_atlas_import",
    "counterparty": "org_rhein_export",
    "intermediaries": ["org_bnp_collect", "org_customs_ma"]
  },
  "state": "fulfilled"
}
```

History:

```
draft → proposed (importer issues PO with documentary collection terms)
proposed → accepted (exporter accepts; bank engaged; required docs listed)
accepted → partially_fulfilled (payment + documents exchanged simultaneously)
partially_fulfilled → fulfilled (duties paid; customs clears; goods collected)
```

The `partially_fulfilled` state captures the exact split point: payment
(`val_payment_purchase`) and the title documents (`val_title_docs`) are both
transferred before the physical goods (`val_machinery`) and customs duties
(`val_duties`) are complete. This is structurally correct — two of the four
value flows are complete, two are not. The Commitment cannot reach `fulfilled`
until all four are done.

### Fulfillments

| id | what it represents | method used | evidence |
|----|-------------------|-------------|----------|
| `F-TF-SHIP-1` | Exporter loads goods; BoL issued | `physical_delivery` (Hamburg → Casablanca) | `proof_of_delivery` (BoL workaround) |
| `F-TF-PAY-1` | Importer pays bank via SWIFT | `money_transfer` | `payment_receipt` |
| `F-TF-DOCS-1` | Bank releases title docs to importer | `digital_delivery` (document release) | `trigger_verification` + `access_grant` |
| `F-TF-DUTIES-1` | Importer pays import duties | `money_transfer` | `payment_receipt` |
| `F-TF-CUSTOMS-1` | Customs processes and approves clearance | `service_performance` (CustomsRelease workaround) | `trigger_verification` + `service_completion` |
| `F-TF-CARGO-1` | Physical goods handed over at port | `in_person_handover` | `proof_of_delivery` |

The two workaround Fulfillments are `F-TF-SHIP-1` (BoL as `proof_of_delivery`)
and `F-TF-CUSTOMS-1` (customs release as `service_performance`). Both validate
correctly but lose structured fields that `bill_of_lading` and
`customs_release` would carry.

---

## Lifecycle as a transition sequence

```
Intent INT-TF-1:        active → converted(COMM-TF-1)

Commitment COMM-TF-1:   draft → proposed → accepted → partially_fulfilled → fulfilled

  Fulfillment F-TF-SHIP-1    (physical_delivery):  planned → in_progress → completed
                              [exporter loads goods; BoL issued to collecting bank]

  Fulfillment F-TF-PAY-1     (money_transfer):     planned → in_progress → completed
                              [importer pays collecting bank EUR 185,000]

  Fulfillment F-TF-DOCS-1    (digital_delivery):   planned → in_progress → completed
                              [bank releases BoL + docs to importer]
                              [Commitment transitions: accepted → partially_fulfilled]

  Fulfillment F-TF-DUTIES-1  (money_transfer):     planned → in_progress → completed
                              [importer pays customs MAD 32,000]

  Fulfillment F-TF-CUSTOMS-1 (service_performance): planned → in_progress → completed
                              [customs authority approves release; SCHEMA GAP: spec
                               calls this CustomsRelease method, not service_performance]

  Fulfillment F-TF-CARGO-1   (in_person_handover): planned → in_progress → completed
                              [physical goods handed over at Casablanca port]
                              [Commitment transitions: partially_fulfilled → fulfilled]
```

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | All four Values resolve to valid transfer targets. Payment reaches exporter; title docs reach importer; duties reach customs; machinery reaches importer. No value is created or lost — the `committed` state on `val_title_docs` references `COMM-TF-1` and that commitment exists. |
| **I-2 State Monotonicity** | `COMM-TF-1` follows `draft → proposed → accepted → partially_fulfilled → fulfilled` — each transition is in the valid table. Six Fulfillments each follow `planned → in_progress → completed`. No state is ever revisited. |
| **I-3 Capacity Verification** | Before `COMM-TF-1` reaches `accepted`, all four parties carry `verified_at` timestamps. The collecting bank (`org_bnp_collect`) holds `can_guarantee: true` — the specific capacity required for a guarantor role. Customs (`org_customs_ma`) holds `can_fulfill: true`. Both are present and verified before the Commitment is accepted. |
| **I-4 Temporal Integrity** | History timestamps are strictly non-decreasing across all six Fulfillments and the Commitment. Cargo loading (May 28–30) precedes payment (June 10) precedes document release (June 10 +30min) precedes duties (June 13) precedes customs clearance (June 13–14) precedes cargo handover (June 14). |
| **I-5 Identity Permanence** | All ids (`org_*`, `val_*`, `INT-TF-1`, `COMM-TF-1`, `F-TF-*`) are globally unique within the fixture. No id is reused across parties, values, intents, commitments, or fulfillments. |

I-6 (Commitment Tree Consistency) is not exercised — `COMM-TF-1` has no
parent or children. The trade finance pattern uses a single flat Commitment
with four intermediaries rather than a parent-child structure.

---

## Extensions relied upon

| Extension | Representable in schema v1.0.0? | How modelled |
|-----------|--------------------------------|--------------|
| **DocumentaryCollection** (Exclusive DigitalGood) | Partially — `ValueForm` is open; `digital_good` with extra fields accepted but not validated | `val_title_docs` uses `form.access_model: "documentary_collection"` and `form.held_by` as open fields; `committed` ValueState from physical-goods vocabulary |
| **DocumentsAgainstPayment** | Not as a PaymentTiming variant — modelled in `reason` strings and `trigger_verification` evidence | `F-TF-DOCS-1` uses `trigger_type: "documents_against_payment_confirmed"` |
| **CustomsRelease** | **UNREPRESENTABLE** — no `customs_release` FulfillmentMethod in schema v1.0.0 | `service_performance` (loses `customs_reference`, `duties_paid`, `inspection_required`) |
| **RequiredDocuments** | Prose-only — no `terms` object in schema v1.0.0 Commitment | Listed in Commitment `accepted` transition `reason` string |
| **BillOfLading evidence** | **UNREPRESENTABLE** — not in schema v1.0.0 Evidence oneOf | `proof_of_delivery` (loses port fields, cargo description) |
| **CustomsClearance evidence** | **UNREPRESENTABLE** — not in schema v1.0.0 Evidence oneOf | `trigger_verification` + `service_completion` (loses `jurisdiction` field) |

---

## Findings summary

The trade finance domain passes `auditCommerce` (exit 0, zero errors, zero
warnings) but exposes four actionable gaps between spec v0.3 and schema v1.0.0
that prevent full machine-verifiable representation of this domain:

**F-1 (High priority):** Add `customs_release` to `FulfillmentMethod` oneOf
in schema. Fields: `customs_reference: string`, `cleared_at: Timestamp`,
`duties_paid: Money | null`, `inspection_required: boolean`.

**F-2 (High priority):** Add `bill_of_lading` to `Evidence` oneOf in schema.
Fields: `reference: string`, `issued_by: PartyID`, `goods_description: string`,
`origin_port: string`, `destination_port: string`, `issued_at: Timestamp`.

**F-3 (High priority):** Add `customs_clearance` to `Evidence` oneOf in schema.
Fields: `reference: string`, `cleared_at: Timestamp`, `jurisdiction: string`.

**F-4 (Medium priority):** Promote `DocumentaryCollection` `AccessModel` and
`RequiredDocuments` `CommitmentTerms` from prose-level to schema-validated
fields. The `ValueForm` open-object pattern allows them through today but they
are not enforced. A `documentary_collection` oneOf branch in `ValueForm`'s
`type` enum and a structured `required_documents` object in a `CommitmentTerms`
schema definition would close this gap.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/trade-finance
# ✓ conformance/case-studies/trade-finance/documentary-collection.json
# ────────────────────────────────────────────────────────────────────
# auditCommerce: 1 passed, 0 failed, 0 warnings, 1 fixtures
```
