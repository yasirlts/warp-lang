# ADR-0001: Commerce Type System — Location and Isolation

Date: 2026-05-22
Status: ACCEPTED (foundation later refined by [ADR-0006](0006-restate-as-execution-foundation.md))
Deciders: Yasir Ahmad (CTO)

## Context

Warp's primary differentiator is a commerce-native type system: `Currency(MAD)`,
`PhoneNumber`, `OrderID`, `CustomerProfile`, `CartState`, and the five model
primitives. These types must be enforced by the compiler at connection time —
wrong types fail before execution, not during.

The question this ADR settles is **where these types live and how they stay
isolated** from the rest of the runtime as the system grows, so that changes to
the execution layer cannot accidentally break `Currency(MAD)`.

## Decision

Commerce types live in their **own module from day one** —
`warp-core/src/types/commerce.rs` (and, later, `types/model.rs` for the five
primitives) — separate from the DSL, the runtime, and the node catalog. The
file/module boundary is the isolation boundary.

As the public surface matured, the commerce types were additionally extracted
into a standalone, independently versioned package —
[`@warp-lang/commerce-types`](https://www.npmjs.com/package/@warp-lang/commerce-types)
— so other systems can adopt the vocabulary and its runtime validators without
depending on the Warp runtime.

The types are enforced by **Warp's own compiler** (`warp-core/src/dsl`), which
type-checks a `.warp` workflow before it can be installed. (How much of each
invariant the compiler enforces today — blocking vs. warning vs. roadmap — is
documented in the type spec and the README; this ADR concerns only *where the
types live*.)

## Consequences

### Positive

- The module boundary keeps commerce types insulated from runtime churn — a
  change to the execution layer cannot silently alter `Currency(MAD)`.
- The clean boundary made the later extraction into a standalone npm package
  mechanical rather than a rewrite.
- A single, owned definition of each commerce type, reused by the compiler and
  the published package alike.

### Negative

- A little upfront discipline (keeping commerce types out of runtime modules)
  before the payoff of the package split.

## Relationship to ADR-0006

This ADR fixes *where the commerce types live and how they are isolated*.
[ADR-0006](0006-restate-as-execution-foundation.md) settles the separate
question of the *execution foundation* (Restate, used directly). The two are
independent decisions: the type system is Warp's own code regardless of the
execution engine underneath it.

## Enforcement

- Commerce types stay in `types/` modules; they do not leak into DSL or runtime
  modules. A change to a commerce type is a deliberate, reviewed change.
