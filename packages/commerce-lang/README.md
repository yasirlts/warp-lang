# @warp-lang/commerce-lang

A focused **syntax for authoring the current Warp Commerce Model**.

Warp-the-language is a nicer way to **write** a Warp model — it is not a new model.
A `.warp` file describes a commitment **lifecycle** (named states and the legal
transitions between them), a **profile** (a named data subset of the model), an
**auction** (the market-making form: an `AuctionProcess` and the `Tendered`
commitments it collects), and a **policy** (commerce rules: a negotiation floor, a
narrowed profile, a jurisdiction rate pack, the invariants a deal reports on). This
package parses that source and compiles it **down to the exact structures the model
already uses** — a transition table, a
[`CommerceProfile`](https://www.npmjs.com/package/@warp-lang/commerce-types), an
`AuctionProcess`, `Tendered` commitment states, the `UnderAuction` value state,
`NegotiationBounds`, and a `RegulatoryPolicyPack`. It introduces **no new states,
no new invariants, and no new schema**.

The compiled output is checked by the model's **own** guard, temporal verifier, and
rule checkers. **The language authors; the model enforces.**

> This is **rung 4** of the Warp language. Rungs 1–2 author the model's **shape**
> (lifecycle, profile, auction); rung 3 adds its **logic** (policies); rung 4
> compiles a whole file into the one `CommerceModel` the engine runs. It is a
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

## Policies — authoring commerce rules

A `policy` authors **rules**, where the other declarations author **structure**.
Every field lowers to a rule structure the model already defines, enforced by a
function that already shipped:

```warp
profile digital {
  label       "Digital goods"
  description "digital goods paid in money"
  states Draft, Proposed, Accepted, Fulfilled, Disputed, Refunded, Cancelled
  value_forms DigitalGood, Money
}

policy house_rules {
  label       "House rules for digital sales"
  description "Never discount below 150 MAD; digital sales do not enter dispute."

  applies_to     digital
  forbid_states  Disputed

  concession_floor 150 MAD
  committed_price  200 MAD

  tax_rates "MA" 0, 0.1, 0.2

  assert I1, I6
}
```

| `policy` field | Lowers to | Enforced by |
|---|---|---|
| `concession_floor`, `committed_price` | `NegotiationBounds` | `guardConcession` |
| `applies_to` + `forbid_states` | a narrowed `CommerceProfile` | `guardWithProfile` |
| `tax_rates` | `RegulatoryPolicyPack` | `checkSettlementPolicy` |
| `assert` | `InvariantId[]` | selects from `auditCommerce` output |

```ts
import { compile } from "@warp-lang/commerce-lang"
import { guardConcession } from "@warp-lang/commerce-types"

const policy = compile(source).policies[0]

// policy.bounds IS a NegotiationBounds — the same value you would have written
// by hand. So the authored rule and the hand-written one cannot disagree.
const verdict = guardConcession(world, deal.id, policy.bounds)
  .step({ kind: "offer", price: { amount: 120, currency: "MAD" }, by: seller })

verdict.ok // false — 120 is below the authored 150 MAD floor (I-1)
```

**The language authors the rule; the model enforces it.** Nothing in this package
decides an outcome: each compiled policy field is exactly the parameter its
function already took, so an authored rule and a hand-written one agree by
construction rather than because a second implementation happens to concur.

Two consequences worth being explicit about:

- **A policy can only narrow.** `guardWithProfile` delegates to the unmodified
  `guardAction`, so no authored profile can approve an action the model rejects.
- **`assert` does not gate what the model checks.** It selects which invariants a
  caller reports on. An invariant a policy never mentions is still checked and
  still violated — a language that could switch invariants off would be a way to
  smuggle unsound commerce past them.

And what it deliberately will **not** do: author a rule the model has no way to
enforce. Syntax for one would be fiction, so there is none.

## Derived logic — computed policy values

A policy value may be a **pure arithmetic expression** over the commerce context,
not only a literal:

```warp
policy house {
  concession_floor committed * 0.75
}

policy subscription {
  concession_floor committed * (remaining_days / term_days)
}
```

One authored rule, a different floor for every deal. The context is a **closed
list** — referencing anything else is a compile error naming these:

| Variable | Meaning |
|---|---|
| `committed` | the commitment's committed amount (Money) |
| `quantity` | total quantity across the requested values (number) |
| `term_days` | whole days from `created_at` to a fixed `terms.duration.ends_at` |
| `elapsed_days` | whole days from `created_at` to the `now` you supply |
| `remaining_days` | `term_days − elapsed_days`, floored at 0 |

Operators are `+ - * /`, grouping, and `min` / `max`. Money is currency-safe:
`MAD + EUR` is an error rather than a silent coercion, and `money * money` is
refused because a squared currency is meaningless.

```ts
const system = compileSystem(source)
const resolved = resolveForCommitment(system, commitment, now)   // → { ok, model } | { ok: false, failures }
if (resolved.ok) runModel(resolved.model, world, hostEvents, { clock })
```

Evaluation is **pure and total**: the same context always yields the same value,
and failures (an unknown variable, division by zero, a currency mismatch, a
variable with no value for this commitment) come back as **data** rather than
thrown. A variable that is unavailable is an error, never a silent zero — a
prorated refund computed against a zero term looks fine and is badly wrong.

### The computed value is checked exactly like a literal

This is the property the rung is built around. **An expression changes how a value
is produced; it never changes whether that value is checked.** The computed number
populates the same `NegotiationBounds` a literal populates, and the same
`guardConcession` and the same six invariants judge it.

`examples/derived.mjs` demonstrates it rather than asserting it: a computed floor
and the identical literal floor go through the same guard at four prices, and the
verdicts match **down to the message text**. An over-refund is still `I-1` under a
computed policy. A computed floor above the committed price is refused by the same
check a constant gets.

The language gained functions. It gained no way past its own guarantees.

**Scope, honestly.** Arithmetic over commerce quantities — no loops, no
user-defined functions, no assignment, no side effects, no I/O, and no way to read
a clock (`now` is passed in). It is not general-purpose computation and is not
meant to become it.

## A whole system — `compileSystem` → `runModel`

A `.warp` file authors the **system**: the standing model a business runs under.
`compileSystem` gathers its declarations into the one `CommerceModel` the engine's
`runModel` takes, and the **host supplies the events**.

```ts
import { compileSystem } from "@warp-lang/commerce-lang"
import { runModel } from "@warp-lang/commerce-types"

const { model } = compileSystem(source, { file: "shop.warp" })
const { world, effects, verdicts } = runModel(model, initialWorld, hostEvents, { clock })

verdicts[0].layer   // "profile" | "policy" | "base" — which layer refused
verdicts[0].policy  // the policy id, when a policy refused
```

Nothing is hand-wired between those two calls: `compileSystem(...).model` **is**
the `CommerceModel` `runModel` takes, and the compiled model deep-equals the
hand-built one for the same system (tested). **The language produces the model;
the engine runs it; the host does the I/O.**

**Events are deliberately not authorable.** They are runtime input. A file with
its events baked in would be a fixture, not a system definition.

`compileSystem` also resolves references *across* declarations, with the same
positioned errors: a policy applying to a profile the file does not declare, a
profile permitting a state its own lifecycle omits, or an ambiguous choice of base
profile (`runModel` applies every profile it holds to every action, so two
profiles permitting different states would together permit only what both allow —
better a compile error than a system that blocks everything).

### Three things authoring does NOT do

These are properties of the engine, stated here so the language does not describe
itself as more than it is. All three are asserted in `examples/system.mjs`.

1. **An authored `assert` is declared intent, not a gate.** `guardAction` already
   audits **all six** invariants over the whole resulting world on every action.
   Writing `assert I1` does not cause the engine to check I-1 — it already does —
   and omitting it does not stop the engine checking. Removing the assert changes
   no verdict.
2. **An authored lifecycle is provenance.** It populates `model.transitions` for
   the record and for separate checking with `verifyLifecycle`, but the table that
   governs a move is the model's own, inside `guardAction`. A lifecycle claiming
   `Draft -> Fulfilled` compiles, and the engine still refuses the move (I-2).
3. **The audit is world-wide, not per-commitment.** A pre-existing violation on
   any commitment blocks every event, including one targeting a different, healthy
   commitment. There is no per-commitment isolation to rely on.

### Auctions run

An authored `auction` populates `model.auction`, and `runModel`'s **auction layer**
checks its **resolution** on every event: the winner was a bid the auction
collected, only one bid is awarded, losing bids are released (Cancelled, or still
`Tendered` with `superseded_by` set), and the clearing price is in the winner's
currency and no higher than their offer.

These are **not** re-expressions of the six invariants. An unsound resolution is
invariant-clean: a world with a dangling losing bid, and a world with two awarded
bids, both return **zero** violations from `auditCommerce`. That is asserted in
`examples/auction-run.mjs` before anything else, because it is the reason the
layer is worth having.

It is **not** a seventh invariant and changes no schema — it is a data-driven
check over an auxiliary record the schema already defines, the same category as a
profile or a policy pack. It does **not** judge whether a mechanism produced a
good price: a Vickrey auction clearing *below* the winning bid is sound and
passes; only being charged *more* than you bid is refused.

## API

| Export | What it does |
|---|---|
| `parse(source, opts?)` | `.warp` source → AST (throws `WarpSyntaxError` with line/col) |
| `compile(source, opts?)` | source → compiled model structures (parse + lower) |
| `compileDocument(doc)` | AST → compiled model structures |
| `compileSystem(source, opts?)` | a whole `.warp` file → `{ model, lifecycle?, profiles, policies, auctions }`; `model` is the `CommerceModel` the engine's `runModel` takes |
| `systemFromDocument(doc, compiled, opts?)` | the same gather, from an AST you already parsed |
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
- `CompiledPolicy` — `{ id, label, description, bounds?, profile?, appliesTo?, pack?, asserts }`.
  Each optional field is the model's own rule structure: `bounds` is a
  `NegotiationBounds`, `profile` a narrowed `CommerceProfile`, `pack` a
  `RegulatoryPolicyPack`, and `asserts` the model's `InvariantId`s.

## The round-trip, runnable

```sh
npm run build && npm run example          # examples/lang.mjs
npm run build && npm run example:auction  # examples/lang-auction.mjs
npm run build && npm run example:policy   # examples/lang-policy.mjs
npm run build && npm run example:system   # examples/system.mjs
npm run build && npm run example:auction-run  # examples/auction-run.mjs
npm run build && npm run example:derived  # examples/derived.mjs
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

`examples/lang-policy.mjs` does the same for **policies**: it authors a profile and
a policy over it, shows the four model structures the policy compiled to, then runs
a concession **within** and **below** the authored floor through `guardConcession`
for verdicts **identical** to the hand-written bounds — message text included —
shows a forbidden state refused by `guardWithProfile`, a tax rate the pack does not
permit refused by `checkSettlementPolicy`, a dangling `applies_to` caught at
**compile** time with a precise position, and finally an invariant the policy never
asserted **still** being reported by the model. It asserts every verdict and exits
non-zero if any of them changes.

`examples/system.mjs` is the end-to-end run: a complete `.warp` file (lifecycle +
profile + policy) compiled by `compileSystem` into one `CommerceModel`, then run
through the engine's `runModel` with host-supplied events — a policy block, a
profile block and a base invariant block, with nothing hand-wired. It also asserts
the three honesty properties above rather than claiming them.

`examples/auction-run.mjs` proves the auction layer both ways: it first shows the
six invariants catching neither a dangling losing bid nor a double award, then
shows the layer refusing each unsound resolution with its specific rule and
letting a sound one through.

## Grammar

The canonical grammar (and exactly what the compiler checks — and deliberately does
not check) is in [`GRAMMAR.md`](GRAMMAR.md).

## Scope (honest)

`commerce-lang` is a **front-end** onto the current model. It adds no semantics: the
model's 11 commitment states, its transition table, and its six invariants are
exactly as the schema defines them. What this package does is let you **write** that
model in a small, checkable syntax and lower it to the structures the runtime
already runs.

- **Rungs 1–2 — shape.** A lifecycle, a profile, an auction (including the
  market-making constructs).
- **Rung 3 — logic.** A `policy`: negotiation bounds, a narrowed profile, a
  jurisdiction rate pack, and the invariants a deal reports on.
- **Rung 4 — the whole system.** `compileSystem` gathers a file into the one
  `CommerceModel` the engine runs, and the host supplies the events.

The compiler judges **well-formedness**; the model judges **soundness**. The
language **authors** rules; the model **enforces** them.

Still without syntax: Party, Value, Intent and Fulfillment as first-class
declarations, commitment terms, settlement breakdowns, and negotiation *sequences*
(rung 3 authors the bounds a negotiation runs under, not its steps).

## License

MIT
