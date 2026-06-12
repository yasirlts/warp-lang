> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/nft/nft.json`](../../conformance/case-studies/nft/nft.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: NFT Commerce

> **Adversarial test corpus — executable.** This is one of the domains
> the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test
> claims to have passed. The JSON below is a real fixture under
> [`conformance/case-studies/nft/`](../../conformance/case-studies/nft/)
> that validates against [schema v1.0.0](../../schema/commerce.schema.json) and
> passes `auditCommerce`. Run it: `node conformance/audit.mjs`.

**Reference platforms:** OpenSea, Blur, Foundation, SuperRare.  
**Fixture:** [`primary-sale-and-resale-with-royalty.json`](../../conformance/case-studies/nft/primary-sale-and-resale-with-royalty.json)

---

## The domain and the hard cases it stresses

NFT commerce is the canonical test of **exclusive digital goods** in the model.
An NFT is a `DigitalGood` with `exclusivity: Exclusive`: one party holds the
token at a time, and every transfer means the originating party loses it. This
is structurally identical to a physical good — ownership follows the
physical-goods `ValueState` path.

The *hard* parts are not the primary sale. They are:

- **Invariant 1, exclusive clause.** When collector A buys from the artist,
  the artist no longer holds the token. When collector A later sells to
  collector B, collector A no longer holds the token. The `val_nft_token`
  value has one final `transferred` state pointing to the last owner
  (`collector_b`). This is conservation by transfer: the originator loses,
  the recipient gains, and there is exactly one holder at any moment.

- **Exclusive digital goods use the physical-goods `ValueState` path.** The
  NFT token's state is `available → committed → transferred` — *not*
  `access_granted`. An `access_granted` state would be correct for a
  non-exclusive digital good (a music streaming licence), where the provider
  retains the ability to grant the same access to many parties simultaneously.
  An NFT is not that. The model enforces this distinction explicitly: using
  `access_granted` for an exclusive digital good is a modelling error.

- **Resale royalty as a child Commitment.** When collector A resells to
  collector B for 800 USD, 10 % (80 USD) flows back to the original artist
  under the `RoyaltyTerm` embedded in the NFT's smart contract. This is not
  a refund. It is not a discount. It is a *new obligation* arising from
  the secondary sale. The model expresses it as `ROYALTY-1`, a child
  `Commitment` of the secondary sale `SALE-RESALE-1`, whose sole subject is
  the 80 USD money transfer to `artist_laila`. The child is automatically
  accepted — no party can refuse it, because the royalty is enforced
  on-chain — and it runs its own `draft → proposed → accepted →
  partially_fulfilled → fulfilled` lifecycle in parallel with the
  NFT token transfer.

- **Two complete Commitments, not a reversal.** `SALE-PRIMARY-1` (artist →
  collector A) and `SALE-RESALE-1` (collector A → collector B) are two
  independent, fully fulfilled Commitments. Invariant 2 (State Monotonicity)
  holds: neither is ever put in reverse. The secondary sale is a new
  forward-moving Commitment where the roles of seller and buyer shift.

## NFTOwnership extension

`NFTOwnership` is a `DigitalGood` `AccessModel` variant documented in
[WARP\_COMMERCE\_MODEL.md §DigitalGood](../WARP_COMMERCE_MODEL.md). Its
fields — `blockchain`, `contract_address`, `token_id`, `transferable`,
`royalty` — are not P1 runtime fields and have no dedicated slots in the
executable schema. They live in `ValueForm`'s open-properties zone
(`form.type = "digital_good"` plus additional keys). This is the correct
boundary: the schema enforces structural invariants; domain-specific
metadata is carried in the open props and verified at the application layer.

## RoyaltyTerm / RoyaltyDistribution

`RoyaltyTerm` is specified in the model as a nested field of `NFTOwnership`:

```
royalty: Option<RoyaltyTerm> {
  rate: Decimal           // 0.0 to 1.0
  beneficiary: PartyID
  applies_to: Vec<TransactionType>
}
```

`RoyaltyDistribution` is a `CommitmentCondition` variant:

```
RoyaltyDistribution {
  beneficiaries: Vec<RoyaltyPayment> {
    to: PartyID
    rate: Decimal
  }
}
```

In the executable model, the royalty is represented as `ROYALTY-1`, a child
Commitment of `SALE-RESALE-1`. This is sufficient and honest. It records:
who owes the royalty (collector A, as the seller), who receives it
(artist\_laila), the exact amount (80 USD, 10 % of 800 USD resale price), and
its own fulfillment lifecycle. The `extensions_exercised` field names both
`NFTOwnership` and `RoyaltyTerm / RoyaltyDistribution` as prose-level
extensions whose runtime encoding is the child Commitment pattern.

## The model objects

Four parties: the artist (`artist_laila`), collector A (`collector_a`),
collector B (`collector_b`), and the marketplace platform (`platform_opensea`).

Four values: the NFT token (`val_nft_token`), the primary-sale payment
(`val_primary_payment`, 500 USD), the resale payment (`val_resale_payment`,
800 USD), and the royalty (`val_royalty_payment`, 80 USD).

Three Commitments: `SALE-PRIMARY-1`, `SALE-RESALE-1`, and its child
`ROYALTY-1`. Five Fulfillments cover: primary payment, primary NFT transfer,
resale payment, resale NFT transfer, and royalty payment.

### Token state across time

```
val_nft_token lifecycle (exclusive digital good — physical-goods ValueState):

t=0  (minted by artist)     available
                               ↓
t=primary sale accepted      committed { commitment_id: SALE-PRIMARY-1 }
                               ↓
t=primary transfer done      transferred { to: collector_a, at: 2026-06-02T11:10Z }
                               ↓
t=resale sale accepted       committed { commitment_id: SALE-RESALE-1 }   ← NOT modelled
t=resale transfer done       transferred { to: collector_b, at: 2026-06-12T14:30Z }
```

The fixture captures the **terminal** state of the token — `transferred` to
`collector_b` — because we are looking at the complete story. The
intermediate `committed` state during resale is the runtime concern of the
Warp workflow; the fixture records what was true when everything settled.

### Commitment lifecycle

```
Intent INT-PRIMARY-1:   active → converted(SALE-PRIMARY-1)
Intent INT-RESALE-1:    active → converted(SALE-RESALE-1)

Commitment SALE-PRIMARY-1:   draft → proposed → accepted
                               → partially_fulfilled(payment done) → fulfilled
  Fulfillment F-PRIMARY-PAY-1 (money_transfer):    planned → in_progress → completed
  Fulfillment F-PRIMARY-NFT-1 (digital_delivery):  planned → in_progress → completed

Commitment SALE-RESALE-1:    draft → proposed → accepted
                               → partially_fulfilled(payment done) → fulfilled
  Fulfillment F-RESALE-PAY-1 (money_transfer):     planned → in_progress → completed
  Fulfillment F-RESALE-NFT-1 (digital_delivery):   planned → in_progress → completed
  └── child: ROYALTY-1

Commitment ROYALTY-1:        draft → proposed → accepted
                               → partially_fulfilled(royalty done) → fulfilled
  Fulfillment F-ROYALTY-1 (money_transfer):        planned → in_progress → completed
```

## Invariants exercised

| Invariant | How this domain exercises it |
|-----------|------------------------------|
| **I-1 Value Conservation** | The NFT is exclusive: after each transfer, only one party holds it (`transferred.to` points to current owner). All monetary values (`val_primary_payment`, `val_resale_payment`, `val_royalty_payment`) carry `transferred` states with exact recipients. No dangling references. |
| **I-2 State Monotonicity** | `SALE-PRIMARY-1` is never reversed when the resale occurs. `SALE-RESALE-1` is a new forward Commitment. Every history chain is consecutive and legal per the transition table. |
| **I-3 Capacity Verification** | All parties reaching Accepted on either Commitment carry `verified_at` timestamps. `platform_opensea` has `can_fulfill: true`. |
| **I-4 Temporal Integrity** | Timestamps are non-decreasing within every history. The resale timeline (starting 2026-06-12) is entirely after the primary sale (2026-06-02). |
| **I-5 Identity Permanence** | All six objects (4 parties, 4 values, 2 intents, 3 commitments, 5 fulfillments) carry unique IDs. No ID is reused. |
| **I-6 Commitment Tree Consistency** | `SALE-RESALE-1` lists `ROYALTY-1` in `children`. `ROYALTY-1` points back to `SALE-RESALE-1` as `parent`. The linkage is symmetric. |

## Extensions relied upon

**NFTOwnership (Exclusive DigitalGood).** The NFT token uses `form.type =
"digital_good"` with open-prop fields `blockchain`, `contract_address`,
`token_id`, `transferable`, `royalty_rate`, `royalty_beneficiary`. It uses
the physical-goods `ValueState` path (`transferred`), not `access_granted` —
because exclusivity means ownership, not access.

**RoyaltyTerm / RoyaltyDistribution.** The 10 % resale royalty is encoded as
the child Commitment `ROYALTY-1` with a `money_transfer` Fulfillment. The
prose model's `RoyaltyDistribution` condition and `NFTOwnership.royalty` field
are expressed in `extensions_exercised`; the executable runtime representation
is the child Commitment pattern, which is fully within the five primitives.

## FINDINGS — genuine gaps flagged

**No first-class `RoyaltyDistribution` condition in the runtime schema.**
The spec (`WARP_COMMERCE_MODEL.md`) documents `RoyaltyDistribution` as a
`CommitmentCondition` variant. The executable schema (`commerce.schema.json`)
does not include `CommitmentCondition` as a typed field on `Commitment` — there
is no `conditions` array in the JSON schema. Royalty enforcement is therefore
represented here by modelling the royalty as a child `Commitment`, which is the
correct workaround: it gives the royalty obligation its own state machine and
fulfillment record. The gap is that a future schema version should add a
`conditions` array to `Commitment` so that `RoyaltyDistribution` can be
expressed declaratively, with the child Commitment auto-generated from it by
the runtime.

**No `committed` → `transferred` intermediate state in the terminal fixture.**
The fixture records `val_nft_token` as `transferred { to: collector_b }` — the
final state. The intermediate `committed` state (NFT locked to
`SALE-RESALE-1` while payment settles) is a runtime concern handled by Warp's
workflow engine, not a fixture concern. This is intentional: a fixture snapshot
reflects settled state. A live execution would show the `committed` transition.

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/nft
# ✓ conformance/case-studies/nft/primary-sale-and-resale-with-royalty.json
```
