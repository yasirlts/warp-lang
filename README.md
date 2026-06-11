# Warp

**The formal commerce layer for AI-generated code.**

[![npm](https://img.shields.io/npm/v/@warp-lang/commerce-types)](https://www.npmjs.com/package/@warp-lang/commerce-types)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## The Problem

AI coding models generate plausible commerce code. Not correct commerce code.
Plausible.

```typescript
// AI generates this. It looks right.
const order = {
  id: generateId(),
  status: "pending",
  total: 150,           // what currency?
  items: [...]
}

// Later, somewhere else, also AI-generated:
order.status = "fulfilled"  // was it ever accepted?
order.total += 50           // mixed currencies silently
order.status = "pending"    // backward transition — now what?
```

These bugs are invisible at generation time. They surface in production, and
they are hard to find because the code looks correct.

The root cause: AI models have no formal commerce vocabulary to reason against.
They pattern-match against informal examples and reproduce informal bugs.

---

## The Solution

Warp is a formal commerce specification with a typed vocabulary and runtime
validators. Five primitives that hold across every commerce domain. Six
invariants you can validate at runtime. TypeScript types where the compiler
catches what types can catch — money that can't exist without a currency —
and runtime validators catch the rest.

```typescript
import { type Money, transitionCommitment } from "@warp-lang/commerce-types"

// Money always carries currency — this IS a compile-time guarantee:
// `{ amount: 150 }` is a type error. You cannot construct money without a currency.
const total: Money = { amount: 150, currency: "MAD" }

// State transitions ARE enforced — by the transition functions, at runtime.
// transitionCommitment rejects any move not in the 26-transition table.
const result = transitionCommitment(order, { type: "Fulfilled" }, actorId)
// result.ok === false for an invalid transition (Draft → Fulfilled,
// Fulfilled → Proposed, …); result.error explains why
```

When AI coding models see these types in your project, they generate code that
satisfies them. The transition functions reject illegal state moves; the
`auditCommerce` / `checkI*` validators report invariant violations on demand.
Correct commerce code becomes the path of least resistance.

> **What this package is:** a typed commerce vocabulary with runtime validators.
> It is **not** a compiler, and it does not make every invariant impossible to
> violate — invariants 1, 3, 4, 5, and 6 are *runtime audits* you invoke, not
> compile-time guarantees. The hosted Warp compiler at
> [warp.aimer.ma](https://warp.aimer.ma) enforces the invariants at compile time
> for `.warp` workflows; this package gives you the types and the runtime checks
> to use the same model directly in TypeScript.

---

## Install

```bash
npm install @warp-lang/commerce-types
```

> Python types (`warp-commerce-types`) are planned — see [Status](#status).

---

## For AI Coding Agents

Add to your project root — **pin to a reviewed commit SHA**, not `main`:

```bash
# Replace <COMMIT_SHA> with a commit you've reviewed:
curl -o CLAUDE.md https://raw.githubusercontent.com/yasirlts/warp-lang/<COMMIT_SHA>/CLAUDE.md
```

> **Why a SHA, not `main`:** CLAUDE.md becomes part of your AI agent's standing
> instructions. Fetching it from an unpinned branch hands whoever can push to
> that branch unreviewed write access to those instructions — a supply-chain /
> prompt-injection risk. Pin to a commit you've read, and bump it deliberately.

Claude Code, Cursor, and any CLAUDE.md-aware agent will then validate commerce
code against the Warp model automatically.

---

## For Vibe Coders

Tell your AI:

> "Use the Warp Commerce Model for all commerce types in this project.
> Reference: https://github.com/yasirlts/warp-lang/blob/main/spec/COMMERCE_MODEL.md"

Your AI now generates formally correct commerce code instead of plausible
commerce code.

---

## For Developers

The five Warp primitives cover every commerce domain:

| Primitive | What it is | Example |
|-----------|-----------|---------|
| Party | Any entity in commerce | Customer, Vendor, AI Agent |
| Value | What moves between parties | Product, Money, License |
| Intent | Desire before commitment | Shopping cart, Wishlist |
| Commitment | Formal agreement | Order, Subscription, Contract |
| Fulfillment | Execution of commitment | Shipment, Payment, Access grant |

These five have been tested adversarially across physical goods, services,
financial commerce, and digital goods. No sixth primitive has been found
necessary.

---

## The Six Invariants

This package provides the types and **runtime validators** for these — call
`auditCommerce(...)` or the individual `checkI*` functions to validate a set of
commerce objects and get back a list of violations. (State transitions, I-2, are
additionally enforced *as you build* by the `transition*` functions.) The hosted
Warp compiler at [warp.aimer.ma](https://warp.aimer.ma) enforces all six at
compile time for `.warp` workflows.

```
I-1  Value Conservation     Money always carries currency.
                            No silent currency mixing.

I-2  State Monotonicity     Orders follow directed state paths.
                            No backward transitions.

I-3  Capacity Verification  Party capacity verified before Accepted.
                            No accepting without checking.

I-4  Temporal Integrity     Fulfillment follows Commitment.
                            No shipping before accepting.

I-5  Identity Permanence    IDs are immutable after creation.
                            No reassigning or reusing.

I-6  Tree Consistency       Child order values sum to parent.
                            No split-order accounting errors.
```

---

## Live

The Warp compiler is running at [warp.aimer.ma](https://warp.aimer.ma).

```bash
curl -X POST https://warp.aimer.ma/api/v1/workflows/compile \
  -H "X-Warp-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_id": "your-tenant-id",
    "warp_source": "project \"hello\" {\n  version = \"1.0.0\"\n  tenant  = \"your-tenant-id\"\n  CartAbandoned trigger {\n    min_value: Currency(200, MAD)\n    after:     Duration(30, minutes)\n  }\n}"
  }'

# Response
{"workflow_name":"hello","node_count":1,"status":"compiled","warnings":[]}
```

Get a tenant id and key in 30 seconds — see the
[Getting Started guide](docs/GETTING_STARTED.md).

---

## Documentation

- [Getting Started](docs/GETTING_STARTED.md) — zero to running in 15 minutes
- [Commerce Model](spec/COMMERCE_MODEL.md) — the formal specification
- [Type Specification](spec/TYPE_SPEC.md) — the complete type system
- [Warp-Compatible Guide](spec/COMPATIBLE_GUIDE.md) — build a platform adapter
- [.warp Syntax Reference](docs/WARP_DSL_SYNTAX.md) — the grammar
- [CLAUDE.md Template](CLAUDE.md) — drop into any project for AI-aware commerce

---

## Status

| Component | Status |
|-----------|--------|
| Commerce Model | v0.3 stable |
| TypeScript types | [v0.3.1 — live on npm](https://www.npmjs.com/package/@warp-lang/commerce-types) |
| Python types | planned |
| Compiler | Hosted at warp.aimer.ma — 6 invariant checks (separate from this package) |
| Runtime | Live at warp.aimer.ma |

---

## License

MIT — use freely, build on it, ship Warp-compatible products.
