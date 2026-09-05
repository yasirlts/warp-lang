# Deploying a Warp commerce model

You author your commerce rules in `.warp`, compile them once to a JSON artifact,
and your service loads that artifact and runs it. Your service never sees the
compiler.

```
shop.warp  ──warpc──▶  model.json  ──loaded by──▶  your host
   (source)              (data)                     (imports @warp-lang/commerce-types)
```

This is the shape the repo proves end to end in
[`examples/deploy-host/`](../examples/deploy-host/), run in CI by
[`scripts/deploy-flow.mjs`](../scripts/deploy-flow.mjs).

---

## 1. Author

```warp
profile digital {
  label       "Digital goods"
  description "digital goods paid in money"
  states Draft, Proposed, Accepted, Fulfilled, Refunded, Cancelled
  value_forms DigitalGood, Money
}

policy house_rules {
  applies_to  digital
  concession_floor 150 MAD
  committed_price  200 MAD
  tax_rates "MA" 0, 0.1, 0.2
}
```

## 2. Compile — at build time, once

```sh
npx warpc shop.warp -o model.json
```

`model.json` is a serialized `CommerceModel`: plain data, canonical JSON (sorted
keys, fixed formatting). The same source always produces byte-identical output, so
you can commit it, diff it and checksum it like any other build product. Commit it
— an artifact you cannot read in review is one you are trusting blindly.

## 3. Run — in your service

Your host installs the runtime library, loads the artifact and runs events
through it:

```js
import { readFileSync } from "node:fs"
import { runModel } from "@warp-lang/commerce-types"

const model = JSON.parse(readFileSync("model.json", "utf8"))

// Your world. Your events. Your clock. Your database, queue, HTTP handlers.
const result = runModel(model, world, [inboundEvent], { clock })

const verdict = result.verdicts[0]
if (verdict.ok) {
  world = result.world                      // commit the advance
} else {
  reject(verdict.layer, verdict.violations) // "policy", "profile", "base", "auction"
}
```

That is the whole integration surface. The host owns the I/O — the world, the
events, the clock, and what to do about a verdict. The engine decides and
describes; it performs no I/O of its own.

---

## What is honestly true today

**The model is portable data.** A `CommerceModel` is JSON. It has no code in it,
no closures, no references back to the compiler.

**The runtime today is JavaScript/TypeScript.** `runModel` lives in
`@warp-lang/commerce-types`. A Node service can load a model and run it now.

**Go, Python and Rust hosts are not yet possible.** The conformance suite proves
all four bindings agree on *verdicts* for the same fixtures — that is a real
result about the model, and it is not the same as a runtime loader. There is no
Go or Python function today that takes a `model.json` and runs events against it.
Building those loaders is future work. Until then, a non-JS service integrates by
calling a JS host, not by loading the model directly.

**The published npm release cannot run a model yet.**
`@warp-lang/commerce-types@1.5.0` predates `runModel`, which landed later. So
`npm install @warp-lang/commerce-types` today gives you a library that can guard
individual actions but **cannot** run a composed model. Deploying against the
registry needs a release containing `runModel`. Until that ships,
`scripts/deploy-flow.mjs` packs the library from source with `npm pack` and
installs the tarball — which is a genuine package boundary (the host has no path
into this repo's source) but is **not** the npm release, and the flow says so as
it runs.

**A computed rule cannot be baked into an artifact.** A rung-5A derived value like
`concession_floor committed * 0.75` depends on the commitment it applies to, and a
`model.json` holds numbers rather than expressions. `warpc` **refuses** to compile
such a system rather than emitting a model with the rule silently missing:

```
warpc: shop.warp: This system has computed values, which a static artifact cannot carry:
  - policy 'house_rules': concession_floor = committed * 0.75
```

Two ways forward, both named in the error: use a constant, or keep the compiler
in-process and call `resolveForCommitment(system, commitment)` before each run.

---

## The boundary, and why it is checked mechanically

The host in `examples/deploy-host/` imports exactly two things:
`@warp-lang/commerce-types` and `node:fs`. It has no import of the compiler, no
relative path into `packages/`, and no ability to parse `.warp`.

That claim is worth nothing as a sentence in a README, because the next edit can
quietly break it. So `packages/commerce-lang/tests/deploy.test.ts` reads the
host's actual import specifiers and fails if any of them points into this repo or
at the compiler package, and CI fails if the committed `model.json` drifts from
what the compiler produces.

## Running the flow yourself

```sh
node scripts/deploy-flow.mjs
```

It packs the library, installs it into the host, compiles the `.warp` system,
checks the artifact is deterministic, and runs the host — which accepts one event
and refuses two, exiting non-zero if that ever changes.
