# @warp-lang/commerce-lang

A focused **syntax for authoring the current Warp Commerce Model**.

Warp-the-language is a nicer way to **write** a Warp model — it is not a new model.
A `.warp` file describes a commitment **lifecycle** (named states and the legal
transitions between them), a **profile** (a named data subset of the model), and an
**auction** (the market-making form: an `AuctionProcess` and the `Tendered`
commitments it collects). This package parses that source and compiles it **down to
the exact structures the model already uses** — a transition table, a
[`CommerceProfile`](https://www.npmjs.com/package/@warp-lang/commerce-types), an
`AuctionProcess`, `Tendered` commitment states, and the `UnderAuction` value state.
It introduces **no new states, no new invariants, and no new schema**.

The compiled output is checked by the model's **own** guard and temporal
verifier. The language authors the model; the model does the work.

> This is an **early rung** of the Warp language. It can express a lifecycle, a
> profile, and an auction — the structures the model already has, including the
> market-making constructs added in Commerce Model v0.2/v0.3. It is a
> commerce-model authoring language, **not** a general-purpose one.

## Install

```sh
npm install @warp-lang/commerce-lang
```

It depends on [`@warp-lang/commerce-types`](https://www.npmjs.com/package/@warp-lang/commerce-types)
(≥ 1.5.0 — it uses that release's `verifyLifecycle` / `reachableStates`). Within
this repository it links the in-repo `commerce-types` build.

## Author a lifecycle, compile it, and let the model check it

```ts
import { compile } from "@warp-lang/commerce-lang";
import { verifyLifecycle } from "@warp-lang/commerce-types";

const source = `
  lifecycle commitment {
    state Draft
    state Proposed
    state Accepted
    state Fulfilled
    state Cancelled
    state Refunded

    Draft     -> Proposed, Cancelled
    Proposed  -> Accepted, Cancelled
    Accepted  -> Fulfilled, Cancelled
    Fulfilled -> Refunded
  }
`;

const { lifecycles } = compile(source);

// The compiled lifecycle IS a transition table — the shape verifyLifecycle takes.
const verdict = verifyLifecycle({ from: "Draft", transitions: lifecycles[0].transitionFn });
// verdict.verdict === "fixpoint-sound"  (identical to hand-writing the model)
```

## The invariants still govern — the language cannot smuggle an unsound model

A `.warp` file is free to *claim* a transition the model forbids. It is well-formed
(the states are real), so it compiles — and then the model's own temporal verifier
catches it, with the exact counterexample path:

```ts
const { lifecycles } = compile(`
  lifecycle sneaky {
    state Draft
    state Fulfilled
    Draft     -> Fulfilled
    Fulfilled -> Draft      // forbidden by the current model
  }
`);

const v = verifyLifecycle({ from: "Draft", transitions: lifecycles[0].transitionFn });
// v.verdict === "violation-found"
// v.violations[0].path === ["Draft", "Fulfilled", "Draft"]   (I-2: State Monotonicity)
```

The compiler checks that a model is **well-formed** (only real states, resolved
references); the model's verifier decides whether it is **sound**. The language
only ever narrows what you can write; it can never widen what the model allows.

## Precise, positioned errors

Good errors are a core reason to have a language at all. Every failure reports
`file:line:col` and what was expected:

```ts
import { compile, WarpLangError } from "@warp-lang/commerce-lang";

try {
  compile("lifecycle c {\n  state Draft\n  Draft Proposed\n}", { file: "cart.warp" });
} catch (e) {
  if (e instanceof WarpLangError) {
    console.error(e.format());
    // cart.warp:3:9: Expected '->' after the source state but found 'Proposed'.
  }
}
```

## Profiles

A `profile` authors a `CommerceProfile` — a named data subset of the model (which
states and value forms a kind of commerce uses). It compiles to the same object
`guardWithProfile` consumes, so an authored profile and a hand-written one give
identical verdicts through the guard:

```warp
profile physical {
  label       "Physical goods"
  description "physical, shippable goods paid in money"
  states       Draft, Proposed, Accepted, Fulfilled, Cancelled, Disputed, Refunded, PartiallyFulfilled, Tendered
  value_forms  PhysicalGood, Money
}
```

## Auctions and tenders — the market-making form

The model handles market-making with two existing pieces: the `Tendered` commitment
state (an **open offer** whose counterparty a mechanism will determine) and the
`AuctionProcess` **auxiliary coordination record** that collects those offers and
records which one won. `AuctionProcess` is not a sixth primitive, and the `auction`
form authors a *reference* to it rather than reinventing it.

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

That compiles to an `AuctionProcess` identical to the hand-written record, plus each
tender as the model's real `Tendered` state — so an authored tender and a
hand-written one get **identical verdicts through the guard**:

```ts
const { auctions } = compile(source);

auctions[0].process;            // AuctionProcess { id, subject, seller, mechanism, ... }
auctions[0].tenders[1].state;   // { type: "Tendered", offer_amount: 1100000, ... }
auctions[0].subjectState;       // null here — the auction has closed
```

While an auction is **`Open`**, its subject carries the model's `UnderAuction` value
state (`{ type: "UnderAuction", auction_process_id, closes_at }`) — the state in
which a value is under an active auction and so cannot be reserved or committed
elsewhere. A `Scheduled` or `Closed` auction yields `null`.

All five mechanisms the model defines are authorable — `English`, `Dutch`,
`SealedBid`, `Vickrey`, and `ScoredSelection` (which names its weighted criteria one
per line, `criterion "price" 0.6 100`). Each takes exactly the fields the schema
gives that variant; a field belonging to a different variant is a compile error.

## API

| Export | What it does |
|---|---|
| `parse(source, opts?)` | `.warp` source → AST (throws `WarpSyntaxError` with line/col) |
| `compile(source, opts?)` | source → compiled model structures (parse + lower) |
| `compileDocument(doc)` | AST → compiled model structures |
| `WarpLangError` / `WarpSyntaxError` / `WarpCompileError` | positioned errors (`.line`, `.column`, `.format()`) |
| `knownCommitmentStates()` | the model's commitment state names (read from the model) |
| `AUCTION_MECHANISM_KINDS` / `AUCTION_STATE_TYPES` / `AUCTION_CLOSE_REASONS` | the auction vocabularies the compiler accepts (held to the schema by a drift test) |

The compiled shape:

- `CompiledLifecycle` — `{ name, states, transitions, transitionFn }`. `transitions`
  is the `Record<from, to[]>` table; `transitionFn` plugs straight into
  `verifyLifecycle({ transitions })` / `reachableStates(from, { transitions })`.
- `CompiledProfile` — a `CommerceProfile` `{ id, label, description, allowedStates, allowedValueForms }`.
- `CompiledAuction` — `{ process, tenders, subjectState }`. `process` is an
  `AuctionProcess`; `tenders` are `CompiledTender` `{ commitment, state }` pairs
  whose `state` is the model's `Tendered`; `subjectState` is the `UnderAuction`
  `ValueState` while the auction is open, else `null`.

## The round-trip, runnable

```sh
npm run build && npm run example          # examples/lang.mjs
npm run build && npm run example:auction  # examples/lang-auction.mjs
```

`examples/lang.mjs` authors a lifecycle and a profile in `.warp`, compiles them,
runs the compiled output through the model's temporal verifier and guard with
results **identical to hand-writing** the model, shows an **unsound** authored
lifecycle being **caught** by the verifier, and shows a syntax error pointing at
the exact character.

`examples/lang-auction.mjs` does the same for the **market-making** half: it authors
a lifecycle that runs through `Tendered`, authors a full auction with two tenders,
shows the compiled `AuctionProcess` and `UnderAuction` value state, runs an authored
tender and a hand-written one through the guard for **identical** verdicts on a
legal and an illegal move, then authors `Tendered -> Fulfilled` — which compiles,
because it is well-formed — and shows the temporal verifier **catching** it with
the counterexample path.

## Grammar

The canonical grammar (and exactly what the compiler checks — and deliberately does
not check) is in [`GRAMMAR.md`](GRAMMAR.md).

## Scope (honest)

`commerce-lang` is a **front-end** onto the current model. It adds no semantics: the
model's 11 commitment states, its transition table, and its six invariants are
exactly as the schema defines them. What this package does is let you **write** that
model in a small, checkable syntax and lower it to the structures the runtime
already runs. It authors a lifecycle, a profile, and an auction — including the
market-making constructs — and that is the whole of this rung. The compiler judges
**well-formedness**; the model judges **soundness**.

## License

MIT
