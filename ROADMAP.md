# Warp roadmap

This is an honest account of what the Warp Commerce Model is today and what is
planned next. It is sized to what exists in this repository, not to ambition.
Numbers that can drift (fixture counts, version strings) are derived from the
live tooling rather than restated here — see
[Conformance badge](#conformance-badge) below.

## What is shipped

The pieces below exist in this repository and run today.

### The model

- **Five primitives** — `Party`, `Value`, `Intent`, `Commitment`, `Fulfillment` —
  and **six invariants** (value conservation, state monotonicity, capacity
  verification, temporal integrity, identity permanence, commitment-tree
  consistency). Specified in [`spec/COMMERCE_MODEL.md`](spec/COMMERCE_MODEL.md).
- **One frozen schema** — the structural types and behavioral rules (transition
  tables, invariant definitions) live in [`schema/`](schema/) at a single
  versioned source of truth (see [`schema/VERSION`](schema/VERSION)). The schema
  is the source the bindings are generated from; it is not edited casually.
- The model has been exercised adversarially across the commerce domains
  catalogued under [`docs/case-studies/`](docs/case-studies/) and
  [`conformance/case-studies/`](conformance/case-studies/) — physical goods,
  services, BNPL/lending, digital licensing, auctions, real estate, healthcare,
  government procurement, trade finance, loyalty, group buying, carbon markets,
  and more. Across that exercise the five primitives held; no sixth primitive
  was introduced.

### Four bindings, generated from the schema

All four are produced from the same `schema/`, not hand-maintained in parallel:

- **TypeScript** — [`packages/commerce-types`](packages/commerce-types)
  (published as `@warp-lang/commerce-types`).
- **Python** — [`packages/commerce-types-py`](packages/commerce-types-py)
  (published as `warp-commerce-types`).
- **Rust** — [`crates/warp-commerce-types`](crates/warp-commerce-types).
- **Go** — [`bindings/go`](bindings/go).

Each binding has a codegen-drift check in CI so a schema change that is not
regenerated fails the build.

### The conformance suite and the four-way cross-check

- A zero-dependency reference runner
  ([`conformance/runner/run.mjs`](conformance/runner/run.mjs)) validates every
  fixture against the canonical schema (structure, behavior, invariants).
- A four-way cross-check
  ([`conformance/tooling/crosscheck.mjs`](conformance/tooling/crosscheck.mjs))
  runs every shared fixture through the TypeScript, Python, Rust, and Go
  implementations and fails if any two disagree. Catalog-enumeration fixtures
  are structural and are reported as not-applicable to the behavioral bindings
  rather than counted as disagreements.

The current counts are produced by the tooling, not asserted here — run the
badge script (below) to see them.

### MCP server

- [`packages/commerce-mcp`](packages/commerce-mcp) exposes the integrity checks
  as Model Context Protocol tools, so an MCP-capable agent can ask whether a
  proposed commerce action is structurally coherent before it is authorized or
  executed. It is a thin wrapper over the published TypeScript binding — it
  validates and returns verdicts; it does not execute payments or hold
  credentials.

### Agent demo

- [`packages/agent-demo`](packages/agent-demo) is a reference demo in which an
  LLM agent reaches for a structurally-invalid action (an over-refund) and is
  stopped by the MCP guardrail, then self-corrects from the returned guidance.

## What is next

Planned and unstarted work, roughly in priority order. None of this is shipped
yet; items will move up into "what is shipped" as they land.

- **Conformance board / public dashboard.** This repository ships a *mechanism*
  for a binding or maintainer to generate a pass/fail conformance badge from the
  live tooling (see below). Hosting a continuously-updated public board from
  that output — wiring the JSON descriptor to a shields.io endpoint or a status
  page — is maintainer work that is not done here.
- **Third-party binding conformance.** The cross-check covers the four
  first-party bindings. A documented path for an external binding to declare and
  prove conformance (run the suite, publish its badge) is partially enabled by
  the badge mechanism but not yet formalized as a process.
- **Broader platform mappings.** The TypeScript binding includes platform
  type-mappings (Shopify, WooCommerce, Stripe, PayPal, Amazon). Extending parity
  of those mappings across the other bindings is future work.
- **More published bindings.** Rust and Go are in-repo; publishing them to their
  ecosystem registries (crates.io, a Go module path) on the same release cadence
  as npm and PyPI is planned.

This list is intentionally short. It reflects work with a clear shape, not a
wish list.

## Conformance badge

A maintainer or a binding author can generate a pass/fail conformance badge that
is derived from the live tooling — the counts are read from the runner and the
cross-check, never hardcoded:

```bash
node scripts/conformance-badge.mjs               # runner only
node scripts/conformance-badge.mjs --crosscheck  # also run the four-way check
node scripts/conformance-badge.mjs --out badges  # write badge.md + badge.json
```

The cross-check mode requires the four binding toolchains (a built TypeScript
binding, `python3`, `cargo`, and `go`); when one is missing the badge falls back
to the runner result and says so, rather than failing.

Example output (runner only):

```
Conformance badge (derived from the live runner):

  runner      : 54/54 fixtures passed  (schema v1.0.0)
  verdict     : CONFORMANT

Markdown snippet:

  [![Conformance](https://img.shields.io/badge/conformance-54%2F54%20conformant%20(schema%20v1.0.0)-success)](conformance/)
```

The script also emits a small JSON descriptor in the shields.io endpoint shape,
which a maintainer can serve to drive a live badge:

```json
{
  "schemaVersion": 1,
  "label": "conformance",
  "message": "54/54 conformant (schema v1.0.0)",
  "color": "success",
  "warp": {
    "conformant": true,
    "runner": { "passed": 54, "total": 54, "schema_version": "1.0.0" },
    "crosscheck": { "runnable_in_all_four": 48, "agreements": 48, "disagreements": 0 }
  }
}
```

The `54/54` and `48` figures above are illustrative of a passing run; the script
prints whatever the live tooling reports at the time it runs.
