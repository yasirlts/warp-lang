> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/saas/saas.json`](../../conformance/case-studies/saas/saas.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: SaaS — Software License Commerce

> **Adversarial test corpus — executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below are real fixtures under
> [`conformance/case-studies/saas/`](../../conformance/case-studies/saas/)
> that validate against [schema v1.0.0](../../schema/commerce.schema.json) and
> pass `auditCommerce`. Run them: `node conformance/audit.mjs conformance/case-studies/saas`.

**Reference platforms:** Stripe Billing, Paddle, FastSpring, Gumroad, GitHub Sponsors.  
**Fixtures:**
- [`perpetual-license-sale.json`](../../conformance/case-studies/saas/perpetual-license-sale.json) — one-time perpetual license sale
- [`license-revocation-breach.json`](../../conformance/case-studies/saas/license-revocation-breach.json) — ToS breach triggers revocation and dispute

---

## The domain and the hard cases it stresses

SaaS software licensing is the canonical non-exclusive digital goods domain.
The *hard* part is not the sale — it is the **access lifecycle** and
**Invariant 1 for non-exclusive goods**.

Physical goods conserve by transfer: a kettle shipped to a buyer leaves the
seller's warehouse. A software license does not work that way. StellarSoft
grants TechCorp access to Warp DevTools Pro; StellarSoft retains its product
unchanged. **No transfer of the good occurs — access rights are granted.**

This is the refined clause of Invariant 1:

> For non-exclusive digital goods, conservation applies to *access rights*,
> not to the goods themselves. The provider retains their copy. A provider
> cannot grant more access rights than their license permits them to sub-license.

For a 5-seat perpetual license, that bound is concrete: StellarSoft cannot
issue TechCorp a token entitling them to 10 seats when only 5 were purchased.
TechCorp cannot install on 14 machines when 5 seats are licensed. The
seat count is the conservation unit for access rights.

The model stresses this domain in two ways:

- **Happy path:** A perpetual, seat-limited license is sold. The Value's state
  moves to `access_granted` (to the buyer org). Delivery is `digital_delivery`;
  Evidence is an `access_grant` (license key token). The Commitment reaches
  `fulfilled` — one-time, no recurring billing.

- **Breach and revocation:** The buyer installs beyond the seat limit.
  The provider revokes access. The Value's state moves to `access_revoked`.
  The original `fulfilled` Commitment becomes `disputed` when the buyer
  contests the revocation.

---

## Invariant 1 — Non-exclusive digital goods in detail

For physical goods, the test is simple: after transfer, the seller no
longer holds the item. The model enforces this via `ValueState::transferred`.

For a non-exclusive digital good the same question — "where is the value?"
— has a different answer. The provider's catalog entry for Warp DevTools Pro
is unchanged after granting TechCorp access. The provider retains everything.
What moves is an *access right*, not the good itself.

The model represents this with `ValueState::access_granted`:

```json
{
  "access_granted": {
    "to": "party_techcorp",
    "granted_at": "2026-06-10T14:05:00+00:00",
    "expires_at": null
  }
}
```

Conservation applies to the *cardinality of access rights*:

- StellarSoft holds a license to distribute Warp DevTools Pro in
  5-seat increments. Each grant of a 5-seat license is one access right.
  StellarSoft cannot grant a 10-seat license from a 5-seat entitlement.
- TechCorp holds one 5-seat access right. They cannot operate 14
  concurrent installations. The seat count is the conservation bound.
- If TechCorp installs on 14 machines, they have exceeded their licensed
  access rights. The provider's right to revoke is the enforcement of
  this conservation rule.

This is the key distinction from exclusive goods: the provider's copy
is not diminished by the grant, but the access rights pool *is* bounded.

---

## The model objects — Fixture 1: Perpetual License Sale

The buyer's product evaluation forms an `Intent`. Checkout converts it to
a `Commitment`. Two `Fulfillment`s execute under the Commitment: payment
(`money_transfer`) and license delivery (`digital_delivery`). The Commitment
follows `draft → proposed → accepted → partially_fulfilled → fulfilled`.

The `partially_fulfilled` step mirrors the physical-ecommerce pattern exactly:
payment completes first (one value item fulfilled), then the license key is
delivered (second value item fulfilled), reaching `fulfilled`.

```json
{
  "id": "commit_license_sale",
  "parties": { "initiator": "party_techcorp", "counterparty": "party_stellarsoft", "intermediaries": [] },
  "state": "fulfilled",
  "history": [
    { "from": "draft", "to": "proposed", "at": "2026-06-10T09:30:00+00:00", "actor": "party_techcorp" },
    { "from": "proposed", "to": "accepted", "at": "2026-06-10T10:00:00+00:00", "actor": "party_stellarsoft" },
    { "from": "accepted", "to": { "partially_fulfilled": { "fulfilled_item_ids": ["val_payment_license_fee"], "remaining_item_ids": ["val_license_devtools_pro_5seat"] } }, "at": "2026-06-10T14:00:00+00:00", "actor": "party_stellarsoft" },
    { "from": { "partially_fulfilled": { ... } }, "to": "fulfilled", "at": "2026-06-10T14:05:00+00:00", "actor": "party_stellarsoft" }
  ]
}
```

The license Value's final state:

```json
{
  "id": "val_license_devtools_pro_5seat",
  "form": { "type": "digital_good", "identifier": "DEVTOOLS-PRO-PERPETUAL-5SEAT", "seats": 5 },
  "state": {
    "access_granted": { "to": "party_techcorp", "granted_at": "2026-06-10T14:05:00+00:00", "expires_at": null }
  }
}
```

`expires_at: null` is the perpetual signal — no expiry date.

---

## The model objects — Fixture 2: License Revocation for Breach

Thirty-eight days after purchase, StellarSoft telemetry detects 14 active
installations against a 5-seat license. The access lifecycle terminates:

```
ValueState:  access_granted → [access_suspended] → access_revoked
Commitment:  fulfilled → disputed
```

The Value records the terminal `access_revoked` state:

```json
{
  "state": {
    "access_revoked": {
      "reason": "Seat-count breach: 14 active installations detected against a 5-seat perpetual license.",
      "revoked_at": "2026-07-18T16:00:00+00:00"
    }
  }
}
```

TechCorp contests the revocation (claiming CI runners and inactive VMs
were counted). The Commitment transitions from `fulfilled → disputed`:

```json
{
  "from": "fulfilled",
  "to": {
    "disputed": {
      "by": "party_techcorp_rev",
      "reason": "TechCorp contests revocation ...",
      "opened_at": "2026-07-19T10:00:00+00:00"
    }
  },
  "at": "2026-07-19T10:00:00+00:00",
  "actor": "party_techcorp_rev"
}
```

This is a valid transition (`fulfilled → disputed` is in the table).
The original `fulfilled` state is never rewound — State Monotonicity holds.
Resolution produces one of `disputed → fulfilled` (revocation stands),
`disputed → refunded` (buyer prevails), or `disputed → cancelled`
(mutual termination). The fixture captures the open-dispute snapshot.

---

## Lifecycle as transition sequences

```
Fixture 1 — Perpetual Sale:

Intent intent_techcorp_license:   active → converted(commit_license_sale)

Commitment commit_license_sale:   draft → proposed → accepted
                                  → partially_fulfilled → fulfilled

  Fulfillment fulfill_payment          (money_transfer):    planned → in_progress → completed
  Fulfillment fulfill_license_delivery (digital_delivery):  planned → in_progress → completed

ValueState val_license_devtools_pro_5seat:  [available implicit] → access_granted

─────────────────────────────────────────────────────────────────

Fixture 2 — Revocation for Breach:

Commitment commit_license_sale_rev:
  draft → proposed → accepted → partially_fulfilled → fulfilled → disputed

ValueState val_license_devtools_pro_revoked:
  access_granted (at sale) → access_revoked (at breach enforcement)
```

---

## Why `access_granted` rather than `transferred`

The `transferred` state records a physical or exclusive-digital change of
custody: "TechCorp now holds the kettle; Marjane no longer does."

For a non-exclusive digital good `transferred` would be incorrect — it
implies the provider lost the item. `access_granted` is precise: it records
*who* holds the access right, *when* it was granted, and *when* (if ever)
it expires. It does not imply the provider's catalog entry changed.

This distinction is load-bearing for Invariant 1. An auditor reading
`transferred` would incorrectly infer a conservation-by-transfer constraint
(provider lost one unit). An auditor reading `access_granted` correctly
infers a conservation-by-access-rights constraint (provider's entitlement
pool decremented by one grant; provider's copy unchanged).

---

## Seat count and territory as prose extensions

The model's `ValueForm.digital_good` carries `identifier`, `exclusivity`,
and basic access-model metadata as open properties on the JSON form object.
The seat count (`seats: 5`) and use restriction (`use_restriction:
commercial_allowed`) are recorded as additional fields on the form — they
are not validated by the schema's structural type system but are documented
in the fixture and referenced in the Commitment's acceptance condition
("license entitlement verified").

**FINDING F-1:** The schema's `ValueForm` type is intentionally open
(`required: ["type"]` only; no `additionalProperties: false`). Seat count,
territory, and use-restriction detail are expressible as form properties but
are not structurally enforced by the schema. They are prose-level model
extensions — the fixture carries them, `extensions_exercised` names them,
and the case-study prose specifies their conservation semantics. A future
schema tightening could add a `digital_good` branch with explicit seat/
territory fields without changing the five primitives.

---

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | Non-exclusive digital goods: conservation applies to access rights, not the good itself. Provider cannot grant more seats than licensed. Seat-count breach in Fixture 2 is an Invariant 1 violation — the model's revocation mechanism enforces the bound. |
| **I-2 State Monotonicity** | `fulfilled → disputed` is a valid forward transition; there is no backward move on the original Commitment. Access lifecycle goes `access_granted → access_revoked` — also forward. `auditCommerce` rejects any `fulfilled → accepted` regression. |
| **I-3 Capacity Verification** | Both parties carry verified capacity before either Commitment reaches `accepted`. StellarSoft verifies its sell/fulfill capacity; TechCorp verifies its buy capacity. |
| **I-5 Identity Permanence** | All IDs across both fixtures are unique. The two fixtures use distinct party and value IDs to avoid cross-fixture collision. |
| **I-6 Commitment Tree Consistency** | Both Commitments have no parent/child structure (`parent: null`, `children: []`). The invariant holds trivially; no tree validation required for a flat license sale. |

## Extensions exercised

- **License access model (Perpetual, seats):** `DigitalGood.access_model = license`, `license_type = perpetual`, `seats = 5`. Perpetual means the Commitment reaches `fulfilled` once; `expires_at: null` on the `access_granted` state carries the perpetual signal.
- **DigitalGood NonExclusive:** The license is `exclusivity = non_exclusive`. The provider retains their copy. `ValueState::access_granted` (not `transferred`) is the correct terminal state. Invariant 1 applies to the access-rights pool, not to a physical unit.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/saas
# ✓ conformance/case-studies/saas/license-revocation-breach.json
# ✓ conformance/case-studies/saas/perpetual-license-sale.json
# auditCommerce: 2 passed, 0 failed, 0 warnings, 2 fixtures
```
