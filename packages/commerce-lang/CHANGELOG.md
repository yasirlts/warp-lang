# Changelog — @warp-lang/commerce-lang

All notable changes to this package are documented here.

## 0.7.0 — rung 5B: composed systems (multi-party commitment trees)

A `.warp` file can author a **composition** — the legs a commitment splits into,
and how each leg's amount is computed from the parent:

```warp
composition marketplace_order {
  leg payout     { amount committed - 70 MAD }
  leg commission { amount 70 MAD }
}
```

`buildComposition` instantiates it against a parent commitment, producing the
model's own `parent` / `children` tree. 430 becomes 360 + 70; 1070 becomes
1000 + 70 — one authored rule, a tree per order.

**The language authors the structure; the model enforces the coherence.** The
tree a composition builds is ORDINARY commitments, which is exactly why
`checkI6TreeConsistency` and the session's per-tree cumulative refund ledger apply
to it unchanged. `packages/commerce-types` has **zero diff**.

**The compiler deliberately does not check reconciliation.** A composition whose
legs over-sum the parent compiles and builds, and I-6 then refuses it. Value
conservation has one implementation, in the model; a second copy in the compiler
would be one more thing to keep in step, for no gain. The example and tests show
I-6 refusing an over-sum, an under-sum and a mixed-currency split, and the session
ledger refusing a cumulative over-refund across the authored tree.

- **`composition` declaration** with named `leg` blocks; leg amounts are rung-5A
  expressions over the SAME closed context — composition needed no new context
  variable, which was the design-slip signal to watch for.
- **`buildComposition(composition, parent, opts?)`** → `{ parent, children }` or
  failures as data. Party ids are supplied per leg at build time, because they are
  runtime data, not authored structure.
- **Compile errors**, positioned: no legs, a duplicate leg name, a leg with no
  amount, an unknown variable, a duplicate composition id.
- **21 new tests**; a file with no composition is unchanged, and a composition
  does not enter `CommerceModel` — it describes commitments, not engine config.

**The limit, honestly.** This authors a TREE — one parent and its children —
because that is what `parent`/`children` express and what I-6 and the session
ledger check. Arbitrary cross-order graphs (a leg with two parents, cycles) are
not authorable: the model does not represent them, and syntax for a structure
nothing enforces would be authoring fiction.

## 0.6.0 — rung 5A: derived logic (computed policy values)

A policy value may be a **pure arithmetic expression** over the commerce context,
not only a literal — `concession_floor committed * 0.75`, or a floor prorated by
`remaining_days / term_days`. One authored rule, a different floor per deal: the
step from authoring VALUES to authoring FUNCTIONS.

**The safety property this rung is built around.** An expression changes how a
value is PRODUCED. It never changes whether that value is CHECKED. The computed
number populates exactly the `NegotiationBounds` a literal populates, and the same
`guardConcession` and the same six invariants judge it. `packages/commerce-types`
has **zero diff** — the enforcement layer is untouched, which is the strongest
form of that claim available.

It is demonstrated, not asserted: `examples/derived.mjs` and `tests/derived.test.ts`
run a computed floor and the identical literal floor through the same guard at four
prices and require the verdicts to match **down to the message text**.

- **Expression grammar** in policy value positions. `+ - * /`, grouping, `min`,
  `max`. A money literal is the trivial expression, so every pre-5A policy parses
  and compiles exactly as before.
- **Closed context**: `committed`, `quantity`, `term_days`, `elapsed_days`,
  `remaining_days`. Anything else is a positioned compile error naming the list.
  A variable with no value for a commitment is an ERROR, never a silent zero — a
  proration against a zero term looks fine and is badly wrong.
- **Pure, total evaluator**: same context → same value; failures are data, never
  throws. Currency-safe — `MAD + EUR` is refused, and `money * money` too.
- **`resolveSystem` / `resolveForCommitment` / `deriveContext`** turn a derived
  system into the plain `CommerceModel` `runModel` takes. The two checks a constant
  gets at compile time (floor ≤ committed, one currency) are applied to the
  evaluated numbers, so a derived value is held to the identical standard.
- **Constant folding**: a policy with no context references compiles to exactly the
  `bounds` it always did, with nothing derived.

**Two error behaviours changed**, both toward better guidance, both recorded in
the tests that assert them:

- A lone `-` is now a token (subtraction), so `Draft - Proposed` is caught by the
  parser wanting a transition arrow rather than by the lexer rejecting the
  character. Same position, more contextual message.
- `concession_floor 150` (no currency) was a syntax error; it is now a compile
  error saying a floor must be a money amount, not the plain number 150.

**Money literals are disambiguated by currency shape.** `1500 MAD` is money
because `MAD` is uppercase; field keys are lower_snake_case, so `committed * 2`
followed by the field `committed_price` reads correctly. A lowercase code is not
money, and the compiler says so.

**Not in this rung:** loops, user-defined functions, assignment, side effects, I/O,
or any way to read a clock (`now` is passed in). Arithmetic over commerce
quantities, and no new enforcement of any kind.

## 0.4.0 — rung 4: a whole system, compiled and run

`compileSystem(source)` gathers a complete `.warp` file into the ONE
`CommerceModel` the engine's `runModel` takes (rung 4a). The language produces the
model; the engine runs it; the **host supplies the events**.

This rung is a GATHER, not new lowering. Every piece is produced by the rung-1/2/3
compilers unchanged; nothing here computes a new structure. No new states, no new
invariants, no schema change.

- **`compileSystem(source, opts?)`** → `{ model, lifecycle?, profiles, policies, auctions }`.
  `model` is the `CommerceModel` `runModel` takes, with no adaptation step.
- **`systemFromDocument(doc, compiled, opts?)`** — the same gather from an AST you
  already parsed.
- **Cross-declaration checks**, positioned like every other error: a policy
  applying to an undeclared profile; a profile permitting a state its own lifecycle
  omits; an ambiguous base profile or lifecycle when a file declares several
  (`opts.profile` / `opts.lifecycle` select one). The ambiguous-profile case is an
  error rather than a guess because `runModel` applies every profile it holds to
  every action — two profiles permitting different states would together permit
  only what both allow.
- **`examples/system.mjs`** — the end-to-end run, in CI: authored file →
  `compileSystem` → `runModel` with host events, with a policy block, a profile
  block and a base invariant block, nothing hand-wired.
- **20 new tests** (`tests/system.test.ts`), including the model-object
  equivalence: the compiled model deep-equals the hand-built one, which is what
  makes "authored and hand-written behave identically" true by construction —
  identical input to identical function.

**Events are deliberately not authorable.** They are runtime I/O. A `.warp` file
carrying its own events would be a fixture, not a system definition.

**Three things authoring does NOT do**, each a property of the engine, each
asserted in the example rather than claimed:

1. An authored `assert` is declared intent, not a gate — `guardAction` audits all
   six invariants on every action regardless. Removing the assert changes no
   verdict.
2. An authored lifecycle is provenance — it populates `model.transitions` for the
   record, but the governing table is the model's own inside `guardAction`. A
   lifecycle claiming `Draft -> Fulfilled` compiles and the engine still refuses
   the move.
3. The audit is world-wide — a pre-existing violation on any commitment blocks
   every event, including one aimed at a different, healthy commitment.

**Auctions compile but are not run.** `CommerceModel` has no auction field and
`runModel` no auction layer, so an authored auction is returned on
`CompiledSystem.auctions` as compiled data, not as something the engine enforces.

## 0.3.0 — rung 3: authoring commerce policies (structure → logic)

Rungs 1–2 author the model's **shape**. This rung adds its **logic**: a `policy`
declaration that authors commerce **rules** — and lowers every one of them to a
rule structure the model already defines and already enforces.

The frame is unchanged and load-bearing: **the language authors; the model
enforces.** Each compiled policy field is exactly the parameter its function
already took, so an authored rule and a hand-written one are the *same value* and
agree by construction rather than because a second implementation concurs. No new
states, no new invariants, no schema change.

- **`policy` declaration** — parsed by the same hand-written recursive-descent
  parser, with the same positioned `line:col` errors.
- **Four lowerings, each to an existing structure:**
  | `policy` field | Lowers to | Enforced by |
  |---|---|---|
  | `concession_floor`, `committed_price` | `NegotiationBounds` | `guardConcession` |
  | `applies_to` + `forbid_states` | a narrowed `CommerceProfile` | `guardWithProfile` |
  | `tax_rates` | `RegulatoryPolicyPack` | `checkSettlementPolicy` |
  | `assert` | `InvariantId[]` | selects from `auditCommerce` output |
- **Two-pass compilation** — profiles are lowered first, so a policy may
  `applies_to` a profile declared before *or* after it. An unresolved reference is
  a positioned compile error naming the profiles the document does declare.
- **Compiler checks extended** — `applies_to` must resolve; a forbidden state must
  be a real model state; an asserted invariant must be one of the six; a floor and
  its committed price must share a currency and the floor may not exceed the
  committed price (mirroring `guardConcession`'s own preconditions, so it fails at
  compile time rather than throwing at enforcement time). `committed_price` without
  `concession_floor` and `forbid_states` without `applies_to` are both rejected.
- **`examples/lang-policy.mjs`** — the round-trip, run verbatim in CI. It asserts
  every verdict and exits non-zero if any changes.
- **24 new tests** (`tests/policy.test.ts`) covering parse, compile, reference
  resolution, enforcement equivalence, and the safety property.

**What a policy still cannot do**, deliberately: express a rule the model has no
way to enforce (syntax for one would be fiction), or switch an invariant off.
`assert` selects what a caller reports on; an invariant a policy never mentions is
still checked and still violated. A profile only ever narrows, so no authored
policy can approve an action `guardAction` rejects — both are tested.

Still without syntax: Party, Value, Intent and Fulfillment as first-class
declarations, commitment terms, settlement breakdowns, and negotiation *sequences*
(this rung authors the bounds a negotiation runs under, not its steps).

## 0.2.0 — rung 2: the whole commitment lifecycle, incl. market-making

Extends the grammar to cover the **whole commitment lifecycle of the current
Commerce Model (v0.3)** — every one of its 11 states, including the market-making
constructs added in v0.2/v0.3 — plus the `AuctionProcess` auxiliary record.

Scope, precisely: this authors the **lifecycle**, the **profile**, and the
**auction**. It does not author Party, Value, Intent, Fulfillment, commitment
terms, settlement, negotiation, or the other model structures — those have no
syntax yet. Still a front-end: it adds no states, no invariants, and no schema, and
the compiled output is judged by the model's own guard and temporal verifier.

- **`auction` declaration** — authors the model's `AuctionProcess` auxiliary
  coordination record (not a sixth primitive). All five mechanisms are expressible:
  `English`, `Dutch`, `SealedBid`, `Vickrey`, and `ScoredSelection` with weighted
  `criterion` lines; all three auction states, and all five close reasons.
- **`tender` blocks** — each lowers to the model's existing `Tendered` commitment
  state (`offer_amount`, `offer_currency`, `closes_at`, optional `superseded_by`).
  An auction's `tendered_commitments` are its tenders' ids, in source order.
- **`UnderAuction` value state** — an auction whose state is `Open` compiles its
  subject to the model's `UnderAuction` `ValueState`; `Scheduled` and `Closed`
  yield `null`.
- **Money literals** (`1050000 MAD`) and unsigned number tokens. `-` remains
  arrow-only, so a money amount cannot be authored negative.
- **Compiler checks extended** — mechanism kind, auction state, and close reason
  must be ones the model defines; each mechanism carries exactly the fields the
  schema gives that variant (the schema marks each `additionalProperties: false`);
  a declared `winner` must be one of the auction's own tenders; tender and auction
  ids are unique. These are well-formedness and reference-resolution checks, **not**
  new invariants.
- **Schema-drift gate** (`tests/schema-drift.test.ts`) — the three auction
  vocabularies have no runtime form to read (unlike the commitment states, which
  `knownCommitmentStates` reads from the model), so the compiler mirrors them. This
  test reads `schema/structure/auxiliary.schema.json` and fails if the mirror
  drifts, including each mechanism's required and permitted field sets.
- **Round-trip** (`examples/lang-auction.mjs`, `tests/auction.test.ts`) — an
  authored market-making lifecycle verifies `fixpoint-sound`; an authored auction
  compiles to an `AuctionProcess` equal to the hand-written record; an authored
  tender and a hand-written one get identical guard verdicts on a legal
  (`Tendered -> Accepted`) and an illegal (`Tendered -> Fulfilled`) move, down to
  the alternatives the planning oracle offers. An authored `Tendered -> Fulfilled`
  edge compiles — it is well-formed — and the temporal verifier catches it with the
  counterexample path.
- **Wording** — the package no longer describes the model as "frozen": the Commerce
  Model is versioned and evolves only through an accepted, changelogged model
  change. This release authors the existing model; it does not evolve it. The
  schema and `commerce-types` are untouched.

## 0.1.0 — first rung: grammar + parser authoring the current model

The first rung of the Warp language: a small, checkable **syntax for authoring the
existing current Warp Commerce Model**. It adds no new semantics — it compiles down
to the same structures the runtime already uses, and its output is checked by the
model's own guard and temporal verifier.

- **Grammar** (`GRAMMAR.md`) for a commitment **lifecycle** (named states + legal
  transitions) and a **profile** (a named data subset of the model). One-to-one
  with structures the model already has.
- **Parser** (`.warp` → AST) — hand-written recursive descent with a positional
  lexer. Every syntax error reports `file:line:col` and what was expected.
- **Compiler** (AST → model structures) — lowers a lifecycle to the transition
  table `verifyLifecycle` / `reachableStates` consume, and a profile to the
  `CommerceProfile` `guardWithProfile` consumes. Enforces well-formedness (only the
  model's real states, resolved references, unique declarations); it does **not**
  judge soundness — the model's temporal verifier does.
- **Round-trip** (`examples/lang.mjs`, tests) — an authored `.warp` lifecycle and
  profile compile to a model that runs through the existing verifier and guard with
  results identical to hand-writing it. An authored **illegal transition** still
  compiles (it is well-formed) but is caught by the temporal verifier — the language
  cannot smuggle an unsound model past the invariants.

Depends on `@warp-lang/commerce-types` (≥ 1.5.0, for `verifyLifecycle` /
`reachableStates`). Schema and commerce-types core are untouched.
