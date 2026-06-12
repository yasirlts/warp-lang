> **⚠ Reconciled at canonical schema v1.0.0.** This narrative was authored
> against a *bespoke minimal schema* (Agent D, PR #1) that is now superseded.
> Any claim below that a construct is "UNREPRESENTABLE in schema v1.0.0" or
> "pending-v1.1" refers to that bespoke schema, **not** the canonical one — the
> canonical schema expresses these constructs. The executable truth for this
> domain is the canonical scene fixture
> [`conformance/case-studies/auction-family/auction-family.json`](../../conformance/case-studies/auction-family/auction-family.json),
> which validates + audits clean via `node conformance/runner/run.mjs`. See
> [case-studies/README.md](README.md) for the reconciled status table and
> [schema/BACKLOG-v1.1.md](../../schema/BACKLOG-v1.1.md) for the real findings.

# Case Study: Auction-Family Commerce

> **Adversarial test corpus — executable.** This is the auction-family domain
> in the [Commerce Model](../WARP_COMMERCE_MODEL.md) Formal Sufficiency Test.
> Two JSON fixtures live under
> [`conformance/case-studies/auction-family/`](../../conformance/case-studies/auction-family/)
> and validate against [schema v1.0.0](../../schema/commerce.schema.json) with
> zero errors. Run it: `node conformance/audit.mjs conformance/case-studies/auction-family`.

**Fixtures:**
- [`english-auction.json`](../../conformance/case-studies/auction-family/english-auction.json) — ascending-bid auction, two bidders, loser cancelled
- [`dutch-auction.json`](../../conformance/case-studies/auction-family/dutch-auction.json) — descending-price, first-accept wins

---

## The domain and the hard cases it stresses

Auction commerce is *market-making* commerce: the price is not set before
the transaction begins — it is determined by competitive bidding. The hard
problem for the model is representing a commitment whose counterparty and
final price are both unknown at the moment the bidder acts.

The spec resolves this with three interlocking pieces:

| Piece | What it models |
|---|---|
| `ValueState::under_auction` | The item cannot be reserved or sold while the auction runs — the auction process controls allocation |
| `CommitmentState::tendered` | A bidder's open offer, carrying the bid amount, the closing time, and (when outbid) a `superseded_by` pointer to the winner |
| `AuctionProcess` auxiliary record | Coordinates all tendered commitments; declares the winner; holds the mechanism parameters |

**What this domain stresses:**

- **The losing bidder must be cancelled forward, never deleted.** State
  Monotonicity (I-2) means a `tendered` → `cancelled` transition is the
  only legal resolution for a losing bid. The commitment is preserved as
  an immutable record.

- **`superseded_by` is set before cancellation.** When Bidder B outbids
  Bidder A, A's tendered state gains `superseded_by: "C-BID-B"` in the
  *source* of the cancellation transition. This lets the model trace the
  exact chain of bids that led to the outcome.

- **The winning value path is deterministic:**
  `under_auction → reserved (physical_stock) → transferred`.
  The value never becomes `available` again mid-auction; `under_auction`
  is a lock. The `reserved` state carries the winning `commitment_id`
  as the basis, making the chain I-1 verifiable.

- **Payment precedes physical delivery (partially_fulfilled bridge).**
  The winner's commitment follows the same `accepted → partially_fulfilled
  → fulfilled` path as a standard order. There is no auction-specific
  shortcut in the lifecycle.

- **AuctionMechanism is a closed set of four.** The schema defines only
  `english`, `dutch`, `sealed_bid`, and `vickrey`. This case study
  covers `english` and `dutch`. `sealed_bid` and `vickrey` differ only
  in mechanism parameters; the commitment/value lifecycle is identical.

---

## Fixture 1 — English Auction (`english-auction.json`)

This fixture mirrors the spec's worked example in full.

**Scenario:** A vintage oil painting (circa 1960, artist Hassan El Glaoui)
is listed by its owner through a Casablanca auction house. Reserve price:
8,000 MAD. Minimum increment: 500 MAD. Auction runs for six days.

**Parties:**
| id | role |
|---|---|
| `party_seller_hassan` | painting owner, seller |
| `party_bidder_a` | first bidder — loses |
| `party_bidder_b` | second bidder — wins |
| `party_auction_house` | intermediary, coordinates close |

### Step-by-step flow

```
1. Seller lists painting
   Value(val_painting_casablanca).state: available → under_auction {
     auction_process_id: "AUC-ENG-001"
     current_high_commitment: null
     closes_at: "2026-06-11T18:00:00+00:00"
   }

2. Bidder A bids 10,000 MAD
   Commitment(C-BID-A): draft → tendered {
     offer_amount: "10000", offer_currency: "MAD"
     closes_at: "2026-06-11T18:00:00+00:00"
     superseded_by: null
   }
   AuctionProcess(AUC-ENG-001).current_high_commitment: "C-BID-A"

3. Bidder B outbids at 12,000 MAD
   Commitment(C-BID-B): draft → tendered { offer_amount: "12000", superseded_by: null }
   Commitment(C-BID-A).tendered.superseded_by: "C-BID-B"  ← set before cancellation
   AuctionProcess(AUC-ENG-001).current_high_commitment: "C-BID-B"

4. Auction closes (2026-06-11T18:00:00+00:00)
   Commitment(C-BID-B): tendered → accepted
   Commitment(C-BID-A): tendered → cancelled { by: "party_auction_house", reason: "Outbid" }
   Value(val_painting_casablanca).state: under_auction → reserved {
     commitment_id: "C-BID-B", basis: "physical_stock"
   }
   AuctionProcess(AUC-ENG-001).state: closed {
     winning_commitment: "C-BID-B"
     winning_price_str: "12000", winning_currency: "MAD"
     reason: "normal_close"
   }

5. Fulfillment (same as a standard order, two-step)
   Fulfillment(F-PAY-AUCTION-1): planned → in_progress → completed  (bank transfer 12,000 MAD)
   Commitment(C-BID-B): accepted → partially_fulfilled → fulfilled
   Fulfillment(F-DEL-AUCTION-1): planned → in_progress → completed  (in-person handover at auction house)
   Value(val_painting_casablanca).state: reserved → transferred { to: "party_bidder_b" }
```

### Lifecycle as a transition table

```
Intent INT-BID-A:   active → abandoned
Intent INT-BID-B:   active → converted("C-BID-B")

Commitment C-BID-A (loser):  draft → tendered → cancelled
Commitment C-BID-B (winner): draft → tendered → accepted → partially_fulfilled → fulfilled
  Fulfillment F-PAY-AUCTION-1:  planned → in_progress → completed
  Fulfillment F-DEL-AUCTION-1:  planned → in_progress → completed
```

---

## Fixture 2 — Dutch Auction (`dutch-auction.json`)

**Scenario:** Zust x Casablanca releases a limited-edition sneaker (50 units)
via a Dutch auction on the Agora platform. Starting price: 3,000 MAD,
decrementing by 100 MAD every 30 minutes. The first buyer to accept the
current displayed price wins their unit immediately — the auction for that
unit closes the instant the first-accept fires.

**Parties:**
| id | role |
|---|---|
| `party_brand_zust` | seller and fulfiller |
| `party_buyer_youssef` | buyer — accepts at 1,500 MAD |
| `party_platform_agora` | Agora commerce OS, orchestrates the dutch clock |

### Mechanism parameters

```json
"dutch": {
  "start_price_str": "3000",
  "start_currency": "MAD",
  "decrement_str": "100",
  "interval_seconds": 1800
}
```

Price at accept: 3,000 − (100 × 15 intervals) = 1,500 MAD at T+7.5 hours.

### Step-by-step flow

```
1. Unit listed under Dutch auction
   Value(val_sneaker_limited).state: under_auction {
     auction_process_id: "AUC-DUTCH-001"
     current_high_commitment: null (Dutch: no bids until first-accept)
     closes_at: "2026-06-13T18:00:00+00:00"
   }

2. Youssef accepts at 1,500 MAD (T+7.5h after open)
   Commitment(C-DUTCH-Y): draft → tendered {
     offer_amount: "1500", offer_currency: "MAD"
     superseded_by: null
   }
   Platform immediately applies first-accept rule:
   Commitment(C-DUTCH-Y): tendered → accepted  (same timestamp)
   AuctionProcess(AUC-DUTCH-001).state: closed {
     winning_commitment: "C-DUTCH-Y"
     winning_price_str: "1500"
     reason: "normal_close"
   }

3. Fulfillment
   Fulfillment(F-PAY-DUTCH-1): planned → in_progress → completed  (card, 1,500 MAD)
   Commitment(C-DUTCH-Y): accepted → partially_fulfilled → fulfilled
   Fulfillment(F-DEL-DUTCH-1): planned → in_progress → completed  (Aramex, 7 days)
   Value(val_sneaker_limited).state: transferred { to: "party_buyer_youssef" }
```

### Dutch vs. English: model-level difference

In a Dutch auction the tendered and accepted transitions fire at the same
timestamp — the first-accept is simultaneously the bid and the acceptance.
The `superseded_by` field stays null because there is only ever one
tendered commitment per unit: the winner. There are no losers to cancel.

The value still traverses `under_auction → reserved → transferred` — the
same path as the English auction — because the item is locked during the
clock run and only released to the buyer on commitment acceptance.

---

## Invariants exercised

| Invariant | How the auction domain exercises it |
|-----------|-------------------------------------|
| **I-1 Value Conservation** | `value.under_auction.auction_process_id` resolves to a real `AuctionProcess`. `AuctionProcess.tendered_commitments` lists only commitment ids that exist in the fixture. `AuctionProcess.closed.winning_commitment` resolves to a real commitment. `value.reserved.commitment_id` resolves to the winner. |
| **I-2 State Monotonicity** | Losing bid: `draft → tendered → cancelled` (legal). Winning bid: `draft → tendered → accepted → partially_fulfilled → fulfilled` (legal). No backward transitions. The `superseded_by` pointer is set in the source state of the cancellation transition, not as a separate mutation. |
| **I-3 Capacity Verification** | Both the winning bidder and the seller have `verified_at` timestamps before the commitment reaches `accepted`. |
| **I-4 Temporal Integrity** | Every history entry's `at` timestamp is ≥ the previous entry's `at`. The English auction demonstrates multi-day non-decreasing timestamps; the Dutch auction demonstrates same-second tendered→accepted. |
| **I-5 Identity Permanence** | All ids across parties, values, intents, commitments, fulfillments, and auction processes are unique within each fixture. |

---

## Extensions relied upon

| Extension | What it adds |
|-----------|-------------|
| **AuctionProcess** | The coordination record that holds mechanism parameters, the list of tendered commitments, and the closed state with the winning commitment reference. |
| **Tendered commitment state** | Allows a commitment to express an open offer whose counterparty acceptance is contingent on a mechanism (highest bid at close, first accept). Carries `offer_amount`, `offer_currency`, `closes_at`, `superseded_by`. |
| **UnderAuction value state** | Prevents a value from being reserved or sold while an auction is active. Carries `auction_process_id`, `current_high_commitment`, `current_high_offer_amount/currency`, `closes_at`. |
| **English auction mechanism** | `reserve_price_str`, `reserve_currency`, `min_increment_str` — ascending bids, highest bid at close wins. |
| **Dutch auction mechanism** | `start_price_str`, `start_currency`, `decrement_str`, `interval_seconds` — descending clock, first-accept wins immediately. |

---

## What the model cannot represent (scope note)

The schema's `AuctionMechanism` is a closed set of four variants:
`english`, `dutch`, `sealed_bid`, `vickrey`. The spec v0.3 prose
describes a `ScoredSelection` variant for government procurement (where
bids are evaluated on technical + price criteria, not price alone). That
variant is not in schema v1.0.0 and is not exercised here — it belongs to
a separate government-procurement domain case study.

---

## Run it

```bash
node conformance/audit.mjs conformance/case-studies/auction-family
# ✓ conformance/case-studies/auction-family/dutch-auction.json
# ✓ conformance/case-studies/auction-family/english-auction.json
# auditCommerce: 2 passed, 0 failed, 0 warnings, 2 fixtures
```
