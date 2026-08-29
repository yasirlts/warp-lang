# Changelog — @warp-lang/commerce-lang

All notable changes to this package are documented here.

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
