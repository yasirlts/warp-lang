# Warp language — grammar (rung 2)

A `.warp` document authors structures of the **current Warp Commerce Model**
(Commerce Model v0.3, schema v1.0.0). The grammar is deliberately small: it
expresses three things the model already has, each mapping one-to-one onto a
structure the runtime understands — a commitment **lifecycle** (all 11 states,
market-making included), a **profile**, and an **auction**. Party, Value, Intent,
Fulfillment, commitment terms, and settlement have no syntax yet. It adds no new
states, no new invariants, and no new schema.

This document is the canonical grammar. The parser
([`src/parser.ts`](src/parser.ts)) implements exactly this.

## Grammar (EBNF)

```ebnf
document      = { declaration } ;
declaration   = lifecycle | profile | auction ;

lifecycle     = "lifecycle" IDENT "{" { lifecycleItem } "}" ;
lifecycleItem = stateDecl | transition ;
stateDecl     = "state" IDENT ;
transition    = IDENT "->" identList ;

profile       = "profile" IDENT "{" { profileField } "}" ;
profileField  = "label"       STRING
              | "description" STRING
              | "states"      identList
              | "value_forms" identList ;

auction       = "auction" STRING "{" { auctionItem } "}" ;
auctionItem   = auctionField | mechanism | tender | auctionState ;
auctionField  = ( "subject" | "seller" | "opens_at" | "closes_at" ) STRING ;
mechanism     = "mechanism" IDENT [ "{" { mechField } "}" ] ;
mechField     = "reserve_price"        money
              | "increment"            money
              | "start_price"          money
              | "decrement"            money
              | "interval_seconds"     NUMBER
              | "reveal_at"            STRING
              | "criterion"            STRING NUMBER NUMBER
              | "minimum_threshold"    NUMBER
              | "committee"            stringList
              | "publication_required" BOOL ;
tender        = "tender" STRING "{" { tenderField } "}" ;
tenderField   = "offer"         money
              | "closes_at"     STRING
              | "superseded_by" STRING ;
auctionState  = "state" IDENT [ "{" { closedField } "}" ] ;
closedField   = "reason"        IDENT
              | "winner"        STRING
              | "winning_price" money ;

identList     = IDENT { "," IDENT } ;
stringList    = STRING { "," STRING } ;
money         = NUMBER IDENT ;                        (* 1050000 MAD *)

IDENT         = ( letter | "_" ) { letter | digit | "_" } ;
STRING        = '"' { character | escape } '"' ;      (* escapes: \" \\ \n \t *)
NUMBER        = digit { digit } [ "." digit { digit } ] ;
BOOL          = "true" | "false" ;
```

### Lexical details

- **Whitespace** (spaces, tabs, newlines) is insignificant.
- **Comments** run from `//` or `#` to the end of the line.
- **Keywords** (`lifecycle`, `profile`, `auction`, `state`, `mechanism`, `tender`,
  `label`, `states`, …) are not reserved words in a separate token class — they lex
  as identifiers and are given meaning by position.
- **Numbers are unsigned.** `-` only ever begins the transition arrow `->`, so
  there is no negative literal and a money amount cannot be authored negative.
- A number may not run straight into an identifier: `30s` is a syntax error, not
  `30` followed by `s`.
- Every token carries a **1-based line and column**; every parse or compile error
  reports `file:line:col` and, for syntax errors, what was expected.

### Identifiers vs. strings for names

A `lifecycle` and a `profile` are named with a bare **identifier** — the name is a
local label (`commitment`, `digital`). An `auction` and a `tender` are named with a
**quoted string**, because those names are real model **ids** (`AuctionProcess.id`,
`CommitmentID`) which routinely contain characters an identifier cannot hold. Ids
are used exactly as authored and are never derived or rewritten — commitment ids
identify one commitment forever (Invariant 5, Identity Permanence).

## What each form compiles to

| `.warp` form | Compiles to (existing model structure) | Consumed by |
|---|---|---|
| `lifecycle` | a transition table `Record<StateType, StateType[]>` (+ a `TransitionFn`) | `verifyLifecycle`, `reachableStates` |
| `profile` | a `CommerceProfile` `{ id, label, description, allowedStates, allowedValueForms }` | `guardWithProfile` |
| `auction` | an `AuctionProcess` auxiliary record | the model's auxiliary-record layer |
| `tender` | a `Tendered` `CommitmentState` `{ offer_amount, offer_currency, closes_at }` | `guardAction`, `transitionCommitment` |
| an **open** auction's subject | an `UnderAuction` `ValueState` `{ auction_process_id, closes_at }` | the model's value layer |

The compiled output is indistinguishable from writing those structures by hand.

### The auction form, in full

```warp
auction "auction:spectrum-2026-a" {
  subject   "value:spectrum-block-a"
  seller    "party:regulator"
  opens_at  "2026-03-01T09:00:00.000Z"
  closes_at "2026-03-07T17:00:00.000Z"

  mechanism English {
    reserve_price 1000000 MAD
    increment       50000 MAD
  }

  tender "commitment:bid-nortel" { offer 1050000 MAD  closes_at "2026-03-07T17:00:00.000Z" }
  tender "commitment:bid-atlas"  { offer 1100000 MAD  closes_at "2026-03-07T17:00:00.000Z" }

  state Closed {
    reason        NormalClose
    winner        "commitment:bid-atlas"
    winning_price 1100000 MAD
  }
}
```

`AuctionProcess` is an **auxiliary coordination record**, not a sixth primitive:
it collects `Tendered` commitments and records which one won. The `auction` form
authors a *reference* to that existing record — it does not reinvent it.

- The auction's `tendered_commitments` are the ids of its `tender` blocks, **in
  source order**.
- `mechanism` is one of the model's five: `English`, `Dutch`, `SealedBid`,
  `Vickrey`, `ScoredSelection`. Each takes exactly the fields the schema gives that
  variant.
- `state` is one of the model's three: `Scheduled`, `Open`, `Closed`. Only
  `Closed` takes a block, and it must carry a `reason` from the model's five.
- A `ScoredSelection` names its weighted criteria one per line:
  `criterion "price" 0.6 100`.

## What the compiler checks (well-formedness — it keeps the language anchored)

The compiler enforces that a document describes a **well-formed author-time model**.
These checks are what stop the language from drifting away from the model — they
are **not** new invariants:

- Every state named in a `lifecycle` or a `profile` must be one of the model's
  **existing commitment states** (`Draft`, `Proposed`, `Tendered`, `Accepted`,
  `Modified`, `Active`, `PartiallyFulfilled`, `Fulfilled`, `Disputed`, `Cancelled`,
  `Refunded`). You cannot invent a state. This set is read **from the model itself**
  at compile time, so it can never drift from the schema.
- A transition may only reference **declared** states; each state may have at most
  one transition line; declarations and targets are unique.
- A `profile` must supply `states` and `value_forms`.
- An `auction` must supply `subject`, `seller`, `opens_at`, `closes_at`, exactly one
  `mechanism`, and exactly one `state`.
- A **mechanism kind**, an **auction state**, and a **close reason** must be one the
  model defines. Each mechanism must carry every field the schema marks required for
  that variant, and **no field belonging to a different variant** (the schema
  declares each variant `additionalProperties: false`).
- A `tender` must supply `offer` and `closes_at`; tender ids are unique within an
  auction, and auction ids are unique within a document.
- A `winner`, if given, must be one of the auction's **own declared tenders** —
  the same kind of reference-resolution check the lifecycle form makes for a
  transition target.

Unlike the commitment states, the three auction vocabularies cannot be read from
the model at runtime (they are TypeScript unions, erased at runtime), so the
compiler carries a small mirror of each. `tests/schema-drift.test.ts` reads
`schema/structure/auxiliary.schema.json` and **fails if that mirror drifts** —
including each mechanism's required and permitted field sets. The schema stays the
source of truth.

## What the compiler does **not** check — the invariants still govern

The compiler does **not** decide whether an authored model is *sound*:

- You can declare a transition between two real states that the model forbids (for
  example `Fulfilled -> Draft`, or `Tendered -> Fulfilled`, which skips the
  commitment). It is well-formed, so it compiles — and then the model's own
  temporal verifier (`verifyLifecycle`) rejects it, returning the counterexample
  path.
- **Currency codes are not validated.** The model's `CurrencyCode` is an open
  union, so `1500 XYZ` compiles exactly as hand-writing that `Money` would.
- **`value_forms` are not validated.** They are carried through as a caller-side
  data filter; the model treats an unlisted form as simply not traded.
- **No temporal or arithmetic checking of auction data.** The compiler does not
  check that `opens_at` precedes `closes_at`, that a tender's `offer` clears the
  reserve price, or that `ScoredSelection` weights sum to 1.0. These are data-level
  questions; the compiler's remit is vocabulary, required fields, and resolved
  references.

The language cannot smuggle an unsound model past the invariants; it only
guarantees the model is well-formed. **Soundness is the model's job.**

## Example

```warp
// A market-making lifecycle — an offer is tendered, a mechanism picks the winner.
lifecycle marketmaking {
  state Draft
  state Tendered
  state Accepted
  state PartiallyFulfilled
  state Fulfilled
  state Cancelled

  Draft              -> Tendered, Cancelled
  Tendered           -> Accepted, Cancelled
  Accepted           -> PartiallyFulfilled, Cancelled
  PartiallyFulfilled -> Fulfilled, Cancelled
}

// A profile — a named data subset of the model for one kind of commerce.
profile digital {
  label       "Digital goods"
  description "digital goods (software, licences, downloads) paid in money"
  states       Draft, Proposed, Accepted, Fulfilled, Cancelled, Refunded
  value_forms  DigitalGood, Money
}

// A sealed-bid procurement, still open.
auction "auction:datacentre-tender" {
  subject   "value:datacentre-build"
  seller    "party:ministry"
  opens_at  "2026-04-01T09:00:00.000Z"
  closes_at "2026-05-01T17:00:00.000Z"

  mechanism ScoredSelection {
    criterion "price"     0.6 100
    criterion "technical" 0.4 100
    minimum_threshold 70
    committee "party:eval-1", "party:eval-2"
    publication_required true
  }

  tender "commitment:bid-atlas" { offer 4200000 MAD  closes_at "2026-05-01T17:00:00.000Z" }

  state Open
}
```

## Scope (honest)

This is rung 2 of the Warp language. It can author a lifecycle, a profile, and an
auction — including the market-making constructs the model gained in Commerce
Model v0.2/v0.3. It is a focused **commerce-model authoring syntax**, not a
general-purpose language. It will grow only as more of the model earns a
first-class syntax.
