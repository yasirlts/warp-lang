# Warp language — grammar (v0, this rung)

A `.warp` document authors the **existing frozen Warp Commerce Model**. The grammar
is deliberately small: it expresses the two things the model already has that map
one-to-one onto structures the runtime understands — a commitment **lifecycle**
and a **profile**. It adds no new states, no new invariants, and no new schema.

This document is the canonical grammar. The parser
([`src/parser.ts`](src/parser.ts)) implements exactly this.

## Grammar (EBNF)

```ebnf
document      = { declaration } ;
declaration   = lifecycle | profile ;

lifecycle     = "lifecycle" IDENT "{" { lifecycleItem } "}" ;
lifecycleItem = stateDecl | transition ;
stateDecl     = "state" IDENT ;
transition    = IDENT "->" identList ;

profile       = "profile" IDENT "{" { profileField } "}" ;
profileField  = "label"       STRING
              | "description"  STRING
              | "states"       identList
              | "value_forms"  identList ;

identList     = IDENT { "," IDENT } ;

IDENT         = ( letter | "_" ) { letter | digit | "_" } ;
STRING        = '"' { character | escape } '"' ;      (* escapes: \" \\ \n \t *)
```

### Lexical details

- **Whitespace** (spaces, tabs, newlines) is insignificant.
- **Comments** run from `//` or `#` to the end of the line.
- **Keywords** (`lifecycle`, `profile`, `state`, `label`, `description`, `states`,
  `value_forms`) are not reserved words in a separate token class — they lex as
  identifiers and are given meaning by position.
- Every token carries a **1-based line and column**; every parse or compile error
  reports `file:line:col` and, for syntax errors, what was expected.

## What each form compiles to

| `.warp` form | Compiles to (existing model structure) | Consumed by |
|---|---|---|
| `lifecycle` | a transition table `Record<StateType, StateType[]>` (+ a `TransitionFn`) | `verifyLifecycle`, `reachableStates` |
| `profile` | a `CommerceProfile` `{ id, label, description, allowedStates, allowedValueForms }` | `guardWithProfile` |

The compiled output is indistinguishable from writing those structures by hand.

## What the compiler checks (well-formedness — it keeps the language anchored)

The compiler enforces that a document describes a **well-formed author-time model**.
These checks are what stop the language from drifting away from the frozen model —
they are **not** new invariants:

- Every state named in a `lifecycle` or a `profile` must be one of the model's
  **existing commitment states** (`Draft`, `Proposed`, `Tendered`, `Accepted`,
  `Modified`, `Active`, `PartiallyFulfilled`, `Fulfilled`, `Disputed`, `Cancelled`,
  `Refunded`). You cannot invent a state. This set is read **from the model itself**
  at compile time, so it can never drift from the schema.
- A transition may only reference **declared** states; each state may have at most
  one transition line; declarations and targets are unique.
- A `profile` must supply `states` and `value_forms` (the fields `guardWithProfile`
  needs). `label` / `description` default to the profile id if omitted.

`value_forms` are carried through as a caller-side data filter (the model treats an
unlisted form as simply not traded); they are an open set and are not checked
against the model here.

## What the compiler does **not** check — the invariants still govern

The compiler does **not** decide whether an authored lifecycle is *sound*. You can
declare a transition between two real states that the model forbids (for example
`Fulfilled -> Draft`). It is well-formed, so it compiles — and then the model's own
temporal verifier (`verifyLifecycle`) rejects it, returning the counterexample
path. The language cannot smuggle an unsound model past the invariants; it only
guarantees the model is well-formed. Soundness is the model's job.

## Example

```warp
// A commitment lifecycle — the model's states and the legal moves between them.
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
  // Cancelled and Refunded are terminal — no outgoing edges.
}

// A profile — a named data subset of the model for one kind of commerce.
profile digital {
  label       "Digital goods"
  description "digital goods (software, licences, downloads) paid in money"
  states       Draft, Proposed, Accepted, Fulfilled, Cancelled, Refunded
  value_forms  DigitalGood, Money
}
```

## Scope (honest)

This is an **early rung** of the Warp language. Today it can author a lifecycle and
a profile — the two structures that already exist in the model. It is a focused
**commerce-model authoring syntax**, not a general-purpose language. It will grow
only as more of the model earns a first-class syntax.
