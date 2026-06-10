# Changelog

This repository tracks two versioned artifacts: the **Commerce Model** (the
formal specification) and the **Type Specification** (the type system the
compiler enforces).

## Commerce Model

### v0.2 — 2026-05-29 — Market-making commerce incorporated
- Added `CommitmentState::Tendered` for open-offer commitments where the
  counterparty is determined by a mechanism (auction) rather than direct
  negotiation.
- Added `ValueState::UnderAuction` so a value under an active auction cannot
  be reserved or committed to any party.
- Added the `AuctionProcess` auxiliary coordination record with four mechanism
  variants: English, Dutch, SealedBid, Vickrey.
- Extended the formal sufficiency test with market-making domains (auctions,
  prediction markets, derivatives, two-sided matching, collateral lending).
  The five primitives held; no sixth primitive was required.

### v0.1 — 2026-05-29 — First complete draft
- Five primitives: Party, Value, Intent, Commitment, Fulfillment.
- Six invariants.
- The commerce lifecycle state machine.
- Platform mappings: Shopify, SAP S/4HANA, Odoo, WooCommerce, Agora.
- The AI contract and the formal sufficiency test.

## Type Specification

### v0.3 — runtime / spec reconciliation
- `Occasion`, `SegmentCriteria`, and `ABTestVariant` reshaped to match the
  runtime; snake_case serialization codified.

### v0.2
- Serialization conventions, the PhoneNumber adapter-normalization contract,
  nullable-field semantics, and the offer-branch invariant.
- Added the `Occasion`, `SegmentCriteria`, and `ABTestVariant` types.

### v0.1
- First type specification: `Currency`, `PhoneNumber`, identifiers,
  `CustomerProfile`, `CartState`, and the adapter contract.
