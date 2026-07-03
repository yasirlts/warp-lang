# Changelog — @warp-lang/commerce-lang

All notable changes to this package are documented here.

## 0.1.0 — first rung: grammar + parser authoring the frozen model

The first rung of the Warp language: a small, checkable **syntax for authoring the
existing frozen Warp Commerce Model**. It adds no new semantics — it compiles down
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
