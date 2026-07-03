# @warp-lang/commerce-lang

A focused **syntax for authoring the frozen Warp Commerce Model**.

Warp-the-language is a nicer way to **write** a Warp model — it is not a new model.
A `.warp` file describes a commitment **lifecycle** (named states and the legal
transitions between them) and, optionally, a **profile** (a named data subset of
the model). This package parses that source and compiles it **down to the exact
structures the model already uses**: a transition table and a
[`CommerceProfile`](https://www.npmjs.com/package/@warp-lang/commerce-types). It
introduces **no new states, no new invariants, and no new schema**.

The compiled output is checked by the model's **own** guard and temporal
verifier. The language authors the model; the model does the work.

> This is an **early rung** of the Warp language. Today it can express a lifecycle
> and a profile — the two things that map one-to-one onto structures the model
> already has. It is a commerce-model authoring language, **not** a general-purpose
> one.

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
    Fulfilled -> Draft      // forbidden by the frozen model
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

## API

| Export | What it does |
|---|---|
| `parse(source, opts?)` | `.warp` source → AST (throws `WarpSyntaxError` with line/col) |
| `compile(source, opts?)` | source → compiled model structures (parse + lower) |
| `compileDocument(doc)` | AST → compiled model structures |
| `WarpLangError` / `WarpSyntaxError` / `WarpCompileError` | positioned errors (`.line`, `.column`, `.format()`) |
| `knownCommitmentStates()` | the model's commitment state names (read from the model) |

The compiled shape:

- `CompiledLifecycle` — `{ name, states, transitions, transitionFn }`. `transitions`
  is the `Record<from, to[]>` table; `transitionFn` plugs straight into
  `verifyLifecycle({ transitions })` / `reachableStates(from, { transitions })`.
- `CompiledProfile` — a `CommerceProfile` `{ id, label, description, allowedStates, allowedValueForms }`.

## The round-trip, runnable

```sh
npm run build && npm run example      # examples/lang.mjs
```

`examples/lang.mjs` authors a lifecycle and a profile in `.warp`, compiles them,
runs the compiled output through the model's temporal verifier and guard with
results **identical to hand-writing** the model, shows an **unsound** authored
lifecycle being **caught** by the verifier, and shows a syntax error pointing at
the exact character.

## Grammar

The canonical grammar (and exactly what the compiler checks — and deliberately does
not check) is in [`GRAMMAR.md`](GRAMMAR.md).

## Scope (honest)

`commerce-lang` is a **front-end** onto the frozen model. It adds no semantics: the
model's 11 commitment states, its transition table, and its six invariants are
exactly as the schema defines them. What this package does is let you **write** that
model in a small, checkable syntax and lower it to the structures the runtime
already runs. It authors a lifecycle and a profile today; that is the whole of this
rung.

## License

MIT
