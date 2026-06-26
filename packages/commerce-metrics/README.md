# @warp-lang/commerce-metrics

Structured metrics for Warp's commerce-integrity guardrail.

Wrap the published
[`@warp-lang/commerce-types`](https://www.npmjs.com/package/@warp-lang/commerce-types)
`guardAction` with `withMetrics`, and every block the guard returns is counted —
by **rule** (the invariant ids `I-1`..`I-6`, plus the guard's own rules such as
`version-conflict`) and by **scope** (by default the proposed target state type,
e.g. `Refunded`, `Cancelled`).

This package is an **observability layer only**. The wrapper calls the published
`guardAction` and returns its verdict unchanged; it records the verdict it sees.
It does not change, re-derive, or weaken any invariant, transition, or guard
logic. If you remove the wrapper, the verdicts are byte-for-byte the same.

## Install

```sh
npm install @warp-lang/commerce-metrics
```

It depends on `@warp-lang/commerce-types@^1.3.0`.

## Use

```ts
import { guardAction } from "@warp-lang/commerce-types";
import { withMetrics, MetricsCollector } from "@warp-lang/commerce-metrics";

const collector = new MetricsCollector();
const guard = withMetrics(guardAction, collector);

// `guard` has the SAME signature and returns the SAME verdict as guardAction.
const verdict = guard(world, action);
if (!verdict.ok) {
  // verdict.violations — the guard's own actionable reasons, untouched
}

// Read the tally at any time:
collector.snapshot();
// {
//   totalAllowed: 12,
//   totalBlocks: 3,
//   byRule:  { "I-1": 2, "I-2": 1 },
//   byScope: { "Refunded": 2, "Draft": 1 },
// }
```

`withMetrics(guard?, collector?, options?)`:

- `guard` — the guard function to wrap; defaults to the published `guardAction`.
- `collector` — the `MetricsCollector` to record into; defaults to a fresh one.
  The returned function also carries it as `.collector`.
- `options.scopeOf(world, action)` — derive the scope label; defaults to the
  action's target state type.

A block that cites more than one rule increments each cited rule, so the sum of
`byRule` can exceed `totalBlocks`. Each block increments exactly one `byScope`
bucket.

## What it does not do

- It does not produce verdicts — it observes the wrapped guard's verdicts.
- It does not persist, export, or aggregate over time. `MetricsCollector` is an
  in-memory, process-local tally; a caller that needs a time series or an
  exporter can read `snapshot()` and forward it.
- It makes no network calls and holds no credentials.

## Example

```sh
npm install
npm run build
node examples/metrics.mjs
```

Runs several actions (valid refunds, an `I-1` over-refund, an `I-2` illegal
backward move) through the wrapped guard and prints the tally by rule and scope.

## Develop

```sh
npm install
npm run build      # tsup -> dist (esm + cjs + d.ts)
npm test           # vitest
npm run typecheck  # tsc --noEmit
```
