# Changelog — @warp-lang/commerce-lang

All notable changes to this package are documented here.

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
