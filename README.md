# Warp

**A typed, compiled commerce workflow language.**

[![npm](https://img.shields.io/npm/v/@warp-lang/commerce-types)](https://www.npmjs.com/package/@warp-lang/commerce-types)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Warp is a small language for commerce automation. You write a workflow in
`.warp` — triggers, delays, communication, intelligence steps — and the Warp
compiler type-checks it against a formal commerce model before it can run.
Money carries its currency; orders move through a real state machine; the
compiler catches whole classes of commerce mistakes at compile time.

The compiler is an **original Rust implementation** — a hand-written lexer,
recursive-descent parser, type checker, and code generator. Durable execution
(workflows that survive restarts, durable timers, human-in-the-loop pauses) is
provided by [Restate](https://restate.dev)'s MIT-licensed SDK. There is no
forked upstream; the language and its tooling are written from scratch.

---

## A `.warp` workflow

```warp
project "cart_recovery" {
    version = "1.0.0"
    tenant  = "tenant_demo"

    CartAbandoned trigger {
        min_value: Currency(200, MAD)     // money carries its currency
        after:     Duration(30, minutes)
    }

    ACPGetCustomerProfile profile {
        customer_id: trigger.customer_id
    }

    WhatsAppSend first_touch {
        to:       profile.phone           // a PhoneNumber, not a String
        template: "cart_reminder"
        lang:     profile.language
    }

    DelayFor wait { duration: Duration(24, hours) }   // durable — survives restarts

    ACPEvaluateStrategy offer { customer_id: trigger.customer_id }

    WhatsAppSend followup {
        to:       profile.phone
        template: "cart_offer"
        lang:     profile.language
    }
}
```

The compiler checks the node graph, the field types, and the commerce
invariants (below) before the workflow can be installed.

---

## What the compiler actually enforces

Warp is honest about what it checks today. The compiler does **not** enforce
all six commerce invariants, and it does not make every mistake impossible —
here is exactly what it does:

| Invariant | Compile-time behavior |
|-----------|------------------------|
| **I-3 Capacity Verification** | **Blocking** — a violation fails compilation |
| **I-4 Temporal Integrity** | **Blocking** — a violation fails compilation |
| **I-5 Identity Permanence** | **Blocking** — a violation fails compilation |
| **I-6 Commitment Tree Consistency** | **Partial / best-effort** — checks literal child-vs-parent values |
| **I-1 Value Conservation** | **Warning** — currency mixing compiles *with a warning*, it does not block |
| **I-2 State Monotonicity** | **Not yet enforced at compile time** — on the roadmap |

> The honest one-liner: *the Warp compiler enforces Capacity (I-3), Temporal
> Integrity (I-4), and Identity Permanence (I-5) at compile time, blocking on
> violation; it partially checks Tree Consistency (I-6), warns on currency
> mixing (I-1), and does not yet enforce State Monotonicity (I-2).*

The five primitives (Party, Value, Intent, Commitment, Fulfillment) and the six
invariants are defined in [the Commerce Model spec](spec/COMMERCE_MODEL.md).

---

## Try it

**Hosted (easiest):** the managed Warp compiler runs at
[warp.aimer.ma](https://warp.aimer.ma).

```bash
curl -X POST https://warp.aimer.ma/api/v1/workflows/compile \
  -H "X-Warp-API-Key: your-key" -H "Content-Type: application/json" \
  -d '{"tenant_id":"your-tenant","warp_source":"project \"hello\" {\n  version = \"1.0.0\"\n  tenant  = \"your-tenant\"\n  CartAbandoned trigger {\n    min_value: Currency(200, MAD)\n    after:     Duration(30, minutes)\n  }\n}"}'
```

**Local (the source is here):** build and run the compiler from this repo.

```bash
cargo build --workspace          # builds warp-core (compiler), warp-mcp, warp-generated
cargo test  --workspace
```

---

## Repository layout

```
crates/
  warp-core/        the compiler — lexer, parser, type checker, codegen (dsl/),
                    the commerce type system (types/), AI builder, management API
  warp-mcp/         Model Context Protocol server — 8 tools that let an MCP
                    agent generate/validate workflows and commerce code
  warp-generated/   the codegen target crate (generated workflow output)
editors/vscode/     the .warp VS Code language extension
packages/
  commerce-types/   @warp-lang/commerce-types — the TypeScript vocabulary +
                    runtime validators (auditCommerce / checkI*), published to npm
docs/               type specs, type derivation, ADRs, adapter guides
spec/               the formal Commerce Model, type spec, compatible-platform guide
```

### What is *not* in this repo

This is the open **language**. The hosted compiler at warp.aimer.ma is the
managed offering, built on this `warp-core`; the commercial server (billing,
payments, tenancy, signup) and its storage layer are **not** part of the open
release.

---

## Documentation

- [Commerce Model](spec/COMMERCE_MODEL.md) — the five primitives and six invariants
- [Type Specification](spec/TYPE_SPEC.md) and the versioned specs in [docs/](docs/)
- [Architecture Decision Records](docs/adr/) — including
  [ADR-0006: Restate as the execution foundation](docs/adr/0006-restate-as-execution-foundation.md)
- [`@warp-lang/commerce-types`](https://www.npmjs.com/package/@warp-lang/commerce-types) — the npm package
- [CLAUDE.md](CLAUDE.md) — drop-in rules for AI agents writing `.warp` / commerce code

---

## License

MIT — see [LICENSE](LICENSE). Use freely, build on it, ship Warp-compatible products.
