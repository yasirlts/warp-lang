> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/carbon-credits/carbon-credits.json`](../../conformance/case-studies/carbon-credits/carbon-credits.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Carbon Credits — Environmental Markets

> **Adversarial test corpus — executable.** This is one of the domains the
> [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test claims to
> have passed. The JSON fixture under
> [`conformance/case-studies/carbon-credits/`](../../conformance/case-studies/carbon-credits/)
> validates against [schema v1.0.0](../../schema/commerce.schema.json) and passes
> `auditCommerce`. Run it: `node conformance/audit.mjs`.

**Reference platforms:** Verra, Gold Standard, ACX (AirCarbon Exchange), South Pole.
**Fixture:** [`credit-purchase-and-retirement.json`](../../conformance/case-studies/carbon-credits/credit-purchase-and-retirement.json)

---

## The domain and the hard cases it stresses

Carbon credit markets sit at the intersection of regulated environmental
instruments and commerce. The hard parts are not the payment — that is
a standard money transfer — but:

1. **Additionality verification as a gate.** Credits must be verified by an
   accredited registry (Verra VCS here) before ownership can legally transfer.
   The Commitment cannot reach Accepted without the registry confirming the
   credits represent genuine, additional emissions reductions. This is
   `CommitmentCondition::RegistryVerification` from spec v0.3.

2. **Exclusive goods using the physical-goods ValueState path.** Carbon credits
   are exclusive digital goods: only one party can hold a given serial block at
   a time. They do not use the `access_granted` / `access_revoked` lifecycle
   (that is for non-exclusive digital goods like software licences). They use
   the same `available → transferred` path as physical goods.

3. **ValueState::Retired is terminal — the value ceases to exist.** When a buyer
   retires credits to offset their emissions, the value is not transferred to
   another party. It is **extinguished** — permanently consumed by mutual
   agreement with the registry. Invariant 1 (Value Conservation) specifically
   covers this case: for exclusive digital goods, retirement is the one event
   where value is not conserved by transfer but is instead consumed and recorded
   as such. No transition out of `retired` is valid. This is the defining stress
   of this domain.

4. **Registry as three-way intermediary.** The registry is not a passive record.
   It actively verifies before Acceptance and executes the retirement. It appears
   in `parties.intermediaries` of the purchase Commitment and as `counterparty`
   of the retirement Commitment.

---

## The model objects

### Parties

| ID | Type | Role |
|----|------|------|
| `org_stellar_corp` | organization | Buyer — purchases and retires the credits |
| `org_reforesta` | organization | Project developer — sells the credits |
| `sys_verra_registry` | system | Registry — verifies additionality, records transfer, executes retirement |

### Values

Two values participate:

- **`val_carbon_credits`** — 500 tCO2e, `digital_good`, exclusive, with
  `CarbonCredit` access model properties: standard `"Verra VCS"`, vintage 2024,
  `project_id "VCS-PRJ-4812"`, `additionality_verified: true`. Final state:
  `ValueState::Retired` (terminal).

- **`val_payment`** — USD 7,500 (500 tCO2e × USD 15.00), `money`. Final state:
  `transferred` to `org_reforesta`.

### Intent

The buyer's procurement desk creates an Intent (`INT-CC-1`) before negotiating.
It converts to the purchase Commitment once the deal is agreed.

### Commitments

**`PUR-CC-1` — Purchase Commitment** (buyer → project developer, with registry as intermediary):

```
draft → proposed → accepted → partially_fulfilled → fulfilled
```

- `draft → proposed`: buyer submits purchase proposal
- `proposed → accepted`: Verra registry confirms additionality
  (RegistryVerification condition met); project developer co-accepts
- `accepted → partially_fulfilled`: USD 7,500 payment completed; credit delivery
  pending
- `partially_fulfilled → fulfilled`: registry transfers 500 tCO2e to buyer account

**`RET-CC-1` — Retirement Commitment** (buyer → registry, child of `PUR-CC-1`):

```
draft → proposed → accepted → partially_fulfilled → fulfilled
```

- The buyer submits retirement instructions to the registry
- Registry validates that the credits are in the buyer's account
- Registry permanently retires the credits — `val_carbon_credits` enters
  `ValueState::Retired`
- No value flows out; the retirement commitment's fulfillment is the extinction
  event itself

The retirement Commitment is a child of the purchase Commitment (`parent: "PUR-CC-1"`,
`children: ["RET-CC-1"]`), recording that the retirement is causally linked to
the original purchase.

### Fulfillments

| ID | Commitment | Method | Purpose |
|----|-----------|--------|---------|
| `F-PAY-CC-1` | `PUR-CC-1` | `money_transfer` (wire) | USD 7,500 to project developer |
| `F-CREDITS-CC-1` | `PUR-CC-1` | `digital_delivery` (registry account transfer) | 500 tCO2e to buyer account |
| `F-RET-CC-1` | `RET-CC-1` | `internal_transfer` (buyer account → retirement ledger) | Permanent retirement |

---

## The retirement is value extinguished, not transferred

This is the key point the model must handle correctly. When Stellar Corp retires
the 500 tCO2e:

- No party receives the credits. There is no `transferred.to`.
- The credits do not "go back" to the project developer.
- The credits do not become available again.
- The Verra registry moves them from the buyer's active account to a permanent
  retirement ledger — a one-way operation.

`ValueState::Retired` captures this exactly:

```json
{
  "retired": {
    "retired_at": "2026-06-12T14:00:00+00:00",
    "retired_by": "org_stellar_corp",
    "reason": "offset 2026 emissions — Stellar Corp annual carbon neutrality commitment",
    "certificate": "VCS-RET-12345"
  }
}
```

Invariant 1 (Value Conservation) holds because the spec explicitly carves out
retirement: *"When an exclusive digital good is retired (ValueState::Retired), it
is permanently consumed. No transfer occurs — the value is extinguished by mutual
agreement and recorded as such."* The `certificate` field (`"VCS-RET-12345"`) is
the reference to the external RetirementCertificate document issued by the
registry. That document cannot be carried inside the schema's Evidence closed
set — see Findings below.

---

## Lifecycle as a transition sequence

```
Intent INT-CC-1:         active → converted(PUR-CC-1)

Commitment PUR-CC-1:     draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-PAY-CC-1 (money_transfer):          planned → in_progress → completed
  Fulfillment F-CREDITS-CC-1 (digital_delivery):    planned → in_progress → completed

Commitment RET-CC-1:     draft → proposed → accepted → partially_fulfilled → fulfilled
  Fulfillment F-RET-CC-1 (internal_transfer):       planned → in_progress → completed

Value val_carbon_credits:  available → [transferred → ] retired (terminal)
Value val_payment:         available → transferred (to org_reforesta)
```

(The credit Value is shown as `retired` in the final snapshot. The intermediate
`transferred` state — representing Stellar Corp holding the credits between
purchase completion and retirement — is the logical predecessor; the fixture
captures the terminal snapshot after retirement.)

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | Credits are extinguished (not transferred) at retirement — the spec's explicit carve-out for exclusive digital goods. Payment transfers exactly USD 7,500 to the seller. All Value references resolve. |
| **I-2 State Monotonicity** | Both Commitments follow legal transition chains. The retired Value has no outbound transitions — the audit rejects any attempt to transition out of `retired`. |
| **I-3 Capacity Verification** | Both `PUR-CC-1` and `RET-CC-1` reach Accepted. All parties (`org_stellar_corp`, `org_reforesta`, `sys_verra_registry`) carry verified capacity. |
| **I-4 Temporal Integrity** | All history timestamps are non-decreasing within each Commitment and Fulfillment. |
| **I-5 Identity Permanence** | Every id (`org_stellar_corp`, `val_carbon_credits`, `PUR-CC-1`, `RET-CC-1`, `F-PAY-CC-1`, `F-CREDITS-CC-1`, `F-RET-CC-1`, `INT-CC-1`, party ids) is unique across the fixture. |

---

## Extensions exercised

| Extension | Where used |
|-----------|-----------|
| `CarbonCredit (Exclusive DigitalGood)` | `val_carbon_credits.form` carries `access_model: "CarbonCredit"` with standard, vintage, project_id, additionality_verified |
| `ValueState::Retired (terminal)` | `val_carbon_credits.state` ends in `{"retired": {...}}` with no valid onward transition |
| `RegistryVerification (additionality)` | Prose condition on `PUR-CC-1`; registry's acceptance signals verification; recorded in `F-CREDITS-CC-1` evidence as `trigger_verification` |
| `RegistryRetirement method` | The retirement act; represented via `internal_transfer` — see Findings |

---

## Findings — representability gaps in the schema closed sets

This domain reveals two gaps between the spec v0.3 prose model and the
executable schema v1.0.0 closed sets.

### FINDING 1 — `RetirementCertificate` evidence type is missing

**Spec v0.3** defines `RetirementCertificate` as an Evidence type:
```
RetirementCertificate {
  reference: String
  issued_by: PartyID
  quantity: Quantity
  retired_at: Timestamp
  project_id: String
}
```

**Schema closed set** for Evidence:
```
{proof_of_delivery, payment_receipt, access_grant, service_completion, trigger_verification}
```

`RetirementCertificate` is absent. The fixture records the certificate reference
(`"VCS-RET-12345"`) inside `ValueState::Retired.certificate` (which IS in the
schema) and uses `service_completion` and `trigger_verification` in the
retirement Fulfillment's evidence array as the nearest representable
alternatives. The prose notes the gap explicitly.

**Required schema change:** Add `retirement_certificate` to the Evidence oneOf:
```json
{
  "retirement_certificate": {
    "type": "object",
    "required": ["reference", "issued_by", "quantity_amount", "quantity_unit", "retired_at", "project_id"],
    "properties": {
      "reference": { "type": "string" },
      "issued_by": { "$ref": "#/$defs/Id" },
      "quantity_amount": { "type": "string" },
      "quantity_unit": { "type": "string" },
      "retired_at": { "$ref": "#/$defs/Timestamp" },
      "project_id": { "type": "string" }
    }
  }
}
```

### FINDING 2 — `RegistryRetirement` FulfillmentMethod is missing

**Spec v0.3** defines `RegistryRetirement` as a DeliveryMethod variant:
```
RegistryRetirement {
  registry: PartyID
  retirement_reference: String
}
```

**Schema closed set** for FulfillmentMethod:
```
{physical_delivery, in_person_handover, digital_delivery, money_transfer,
 service_performance, internal_transfer}
```

`registry_retirement` is absent. The fixture uses `internal_transfer` (from the
buyer's active account to the registry's permanent retirement ledger) as the
nearest representable alternative.

**Required schema change:** Add `registry_retirement` to FulfillmentMethod oneOf:
```json
{
  "registry_retirement": {
    "type": "object",
    "required": ["registry", "retirement_reference"],
    "properties": {
      "registry": { "$ref": "#/$defs/Id" },
      "retirement_reference": { "type": "string" }
    }
  }
}
```

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/carbon-credits
# ✓ conformance/case-studies/carbon-credits/credit-purchase-and-retirement.json
# auditCommerce: 1 passed, 0 failed, 0 warnings, 1 fixtures
```
