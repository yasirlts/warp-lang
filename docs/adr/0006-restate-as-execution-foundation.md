# ADR-0006: Restate as Execution Foundation

Date: 2026-05-23
Status: ACCEPTED
Accepted: 2026-05-23
Deciders: Yasir Ahmad (CTO)
Refines: [ADR-0001](0001-commerce-type-system-extension-strategy.md) (type-system location)

## Context

Warp needs a durable workflow execution engine — workflows that survive
process restarts, durable timers, human-in-the-loop pauses, and parallel
fan-out, all without Warp owning the hard distributed-systems machinery.

Two options were seriously considered:

1. **Restate-direct** — build Warp's DSL, compiler, and runtime directly on
   the [Restate](https://restate.dev) SDK (`restatedev/sdk-rust`, MIT), which
   provides durable execution as a library.
2. **Build from scratch** — write our own durable execution engine
   (journaling, replay, timer persistence, exactly-once side effects).

## Decision

**Warp uses the Restate SDK (`restatedev/sdk-rust`, MIT-licensed) directly as
its execution foundation.**

The Restate SDK provides Warp's load-bearing infrastructure primitives:

- Durable execution (workflows that survive any restart)
- Durable sleep (`ctx.sleep` — no threads held, no state lost)
- Awakeables (durable promises — the substrate for human-in-the-loop steps)
- Virtual Objects (per-key isolation — the substrate for tenant isolation)
- Parallel fan-out (each invocation is independently durable)

Everything *above* the execution layer is Warp's own, original code:

- The commerce type system (`OrderID`, `Currency(MAD)`, `PhoneNumber`, the
  five model primitives, …) — `warp-core/src/types`.
- The `.warp` DSL and its compiler — a hand-written lexer, recursive-descent
  parser, type checker, and code generator in `warp-core/src/dsl`.
- The node catalog and platform adapters.

The Restate **server binary** is Business Source Licensed (BSL). Warp
self-hosts it as part of its own infrastructure, which the BSL explicitly
permits — the BSL restriction is only against offering Restate *itself* as a
managed service. Warp does not resell Restate; it embeds it the way a product
embeds PostgreSQL or a web server.

## Consequences

### Positive

- **License clarity.** The SDK is MIT — no ambiguity, no legal review needed
  to build on it.
- **Full ownership of the language layer.** Warp's DSL is designed for
  commerce from line one — every primitive and every error message is
  commerce-shaped, not adapted from a general-purpose workflow language.
- **No upstream-sync burden.** The Restate SDK is a normal Cargo dependency.
  Releases are additive; updates are `cargo update` gated by `cargo test`.
- **Strong technical foundation.** Restate is a funded, production-grade
  durable-execution system; building on it removes the need to reimplement
  journaling, replay, and timer persistence ourselves.

### Negative

- **Engineering cost to build the DSL and compiler ourselves** rather than
  adopting an off-the-shelf workflow language. Accepted — this is
  well-understood compiler construction, not novel research, and owning the
  language layer is a permanent benefit.
- **Coupling to Restate's evolution.** Mitigation: the SDK is API-stable
  across minor versions and MIT-licensed (forkable if ever necessary).

## Enforcement

- The Restate SDK is the **only external execution dependency.** No second
  workflow engine, no message queue, no separate retry framework. A
  contributor proposing one must open an ADR explaining why a Restate
  primitive doesn't suffice.
- `Cargo.toml` pins `restate-sdk` to a known-good version range. Bumps go
  through `cargo test` and a brief smoke test against a local Restate server.

## Open implementation questions (deferred, not blocking)

- Restate SDK version policy: pin patch, pin minor, or follow latest? Decide
  at the first breaking SDK change.
- Restate server version pinning: which Docker tag of
  `ghcr.io/restatedev/restate` is the reference? Document in the POC.
- Multi-region Restate deployment: deferred until actually needed.
