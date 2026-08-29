# Warp language — grammar (rung 3)

A `.warp` document authors structures of the **current Warp Commerce Model**
(Commerce Model v0.3, schema v1.0.0). The grammar is deliberately small: it
expresses four things the model already has, each mapping one-to-one onto a
structure the runtime understands — a commitment **lifecycle** (all 11 states,
market-making included), a **profile**, an **auction**, and a **policy** (commerce
rules). Party, Value, Intent, Fulfillment, commitment terms, and settlement
breakdowns have no syntax yet. It adds no new states, no new invariants, and no
new schema.

Rungs 1–2 author the model's **shape**; rung 3 adds its **logic**. The language
**authors** rules; the model **enforces** them.

This document is the canonical grammar. The parser
([`src/parser.ts`](src/parser.ts)) implements exactly this.

## Grammar (EBNF)

```ebnf
document      = { declaration } ;
declaration   = lifecycle | profile | auction | policy ;

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

policy        = "policy" IDENT "{" { policyField } "}" ;
policyField   = "label"            STRING
              | "description"      STRING
              | "applies_to"       IDENT
              | "forbid_states"    identList
              | "concession_floor" money
              | "committed_price"  money
              | "tax_rates"        STRING numberList
              | "assert"           identList ;

identList     = IDENT { "," IDENT } ;
numberList    = NUMBER { "," NUMBER } ;
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

### The policy form, in full

A `policy` authors commerce **rules**. Each field lowers to a rule structure the
model already defines and already enforces — nothing here is a new rule type,
because a rule the model cannot enforce would be fiction.

```warp
policy house_rules {
  label       "House rules for digital sales"
  description "Never discount below 150 MAD; digital sales do not enter dispute."

  applies_to     digital          # a profile declared in this document
  forbid_states  Disputed         # narrows that profile

  concession_floor 150 MAD        # the lowest price the merchant will accept
  committed_price  200 MAD        # the opening price the floor is measured against

  tax_rates "MA" 0, 0.1, 0.2      # permitted tax_rate fractions for a jurisdiction

  assert I1, I6                   # the invariants this policy reports on
}
```

| `policy` field | Lowers to | Enforced by |
|---|---|---|
| `concession_floor`, `committed_price` | `NegotiationBounds` | `guardConcession` |
| `applies_to` + `forbid_states` | a narrowed `CommerceProfile` | `guardWithProfile` |
| `tax_rates` | `RegulatoryPolicyPack` | `checkSettlementPolicy` |
| `assert` | `InvariantId[]` | selects from `auditCommerce` output |

Because each compiled field is exactly the value its function already takes, an
authored rule and a hand-written one are the **same value** — so they agree by
construction, not because a second implementation happens to concur.

Notes on the individual forms:

- **`applies_to`** names a `profile` declared **anywhere** in the same document —
  before or after the policy. Policies are lowered in a second pass, once every
  profile is known. An unresolved name is a compile error naming the profiles that
  *are* declared.
- **`forbid_states`** removes states from the referenced profile's `allowedStates`.
  A profile only ever **narrows** the model, so `guardWithProfile` can never
  approve something `guardAction` would reject. `forbid_states` without
  `applies_to` is a compile error — there would be nothing to narrow.
- **`concession_floor`** is the lowest acceptable price; the concession budget is
  `committed_price − concession_floor`. A floor above the committed price, or in a
  different currency, is a compile error (mirroring `guardConcession`'s own
  preconditions).
- **`tax_rates`** carries its rates **verbatim** as authored fractions
  (`0.2` = 20%). The language does not compute, validate, or vouch for tax law;
  `checkSettlementPolicy` compares a settlement's declared rates against this data.
- **`assert`** takes `I1`…`I6` and lowers to the model's `InvariantId`s. It
  **selects** which invariants a caller reports on. It does **not** gate what the
  model checks: an invariant a policy never mentions is still checked, and still
  violated. A language that could switch invariants off would be a way to smuggle
  unsound commerce past them.

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
- A `policy`'s `applies_to` must name a **profile the document declares**; a state
  in `forbid_states` must be a real model state; an asserted invariant must be one
  of the model's six (`I1`…`I6`). Each is a positioned compile error naming the
  legal alternatives.
- A policy's `concession_floor` and `committed_price` must share a currency, and
  the floor may not exceed the committed price — mirroring `guardConcession`'s own
  preconditions, so the failure surfaces at compile time rather than as a thrown
  error at enforcement time. `committed_price` without `concession_floor`, and
  `forbid_states` without `applies_to`, are both rejected: each would be a rule
  fragment with nothing to act on.
- Policy ids are unique within a document, and each `tax_rates` jurisdiction is
  listed once.

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

This is rung 3 of the Warp language.

- **Rungs 1–2 — shape.** A lifecycle, a profile, and an auction, including the
  market-making constructs the model gained in Commerce Model v0.2/v0.3.
- **Rung 3 — logic.** A `policy`: negotiation bounds, a narrowed profile, a
  jurisdiction rate pack, and the invariants a deal reports on.

What that does **not** mean: the language does not enforce anything. It authors
rules the **model** enforces, using structures and functions that already shipped.
A rule the model has no way to enforce has deliberately been left unauthorable —
syntax for one would be fiction.

Still without syntax: Party, Value, Intent and Fulfillment as first-class
declarations, commitment terms, settlement breakdowns, and negotiation *sequences*
(rung 3 authors the bounds a negotiation runs under, not the steps themselves).

It is a focused **commerce-model authoring syntax**, not a general-purpose
language. It will grow only as more of the model earns a first-class syntax.
