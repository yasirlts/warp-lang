# ADR-0007: Warp DSL Syntax — v0.1

Date: 2026-05-25
Status: ACCEPTED
Accepted: 2026-05-25
Deciders: Yasir Ahmad (CTO)

## Context

CLAUDE.md frames Warp as "the ABAP of commerce" — a typed,
compiled language merchants and operators write workflows in. The
existing runtime (Phases 0–2) is Rust-only: every workflow is a
hand-written file using the Restate SDK macros. That's fine for
shipping the first catalog, but it cannot be Warp's external
surface. The merchant canvas (Phase 3) and the trilingual AI
builder (Phase 3+) both need an intermediate representation that:

- Is **textual** (so the AI builder, source control, and copy-paste
  all work).
- Has a **type system** the compiler enforces (per C-01 and C-06 —
  AI-generated workflows must not ship if they would fail at
  runtime).
- Is **stable enough to put in front of merchants** as the
  canonical form their canvas serializes to.

This ADR locks the syntax for v0.1. The lexer + parser ship this
session; the type checker and code generator land in subsequent
sessions. Once accepted, breaking syntax changes require a new ADR
that supersedes this one.

## Decision

### 1. File extension

`.warp`

A single-purpose extension makes editor tooling, MIME types, and
"is this a Warp file?" lookups unambiguous. `.workflow` was
considered and rejected — it collides with several existing
ecosystems (n8n exports, GitHub Actions, etc.) and dilutes the
brand. `.warp` is on the rare-extensions list and effectively
unowned today.

### 2. Project syntax

A Warp file declares exactly one `project`. Inside the project, a
sequence of typed node declarations form the workflow graph. The
canonical example:

```warp
project "cart_recovery" {
  version = "1.0.0"
  tenant  = "tenant_aimer_prod_001"

  CartAbandoned trigger {
    min_value: Currency(200, MAD)
    after:     Duration(30, minutes)
  }

  ACPGetCustomerProfile profile {
    customer_id: trigger.customer_id
  }

  WhatsAppSend first_touch {
    to:       profile.phone
    template: "cart_reminder"
    lang:     profile.language
  }

  DelayFor wait {
    duration: Duration(24, hours)
  }

  ACPEvaluateStrategy offer {
    customer_id: trigger.customer_id
    cart_state:  trigger.cart_state
  }

  WhatsAppSend followup {
    to:       profile.phone
    template: "cart_offer"
    lang:     profile.language
    params:   { discount_code: offer.discount_code }
  }
}
```

The structure mirrors what merchants will see on the canvas:

- The `project` block is the workflow they're editing.
- Each declaration is one node on the canvas.
- The pair `<NodeType> <instance_name>` is how every node
  identifies itself — the node type tells the compiler which
  catalog entry to type-check against; the instance name is what
  later declarations dot-reference to read the node's output.

Order of declarations is significant for **readability only**;
the compiler will lift the wiring from the dot-references inside
node bodies and reconstruct the dependency graph from those. A
human reads top-to-bottom; the compiler reads the references.

### 3. Token types

The v0.1 lexer recognizes exactly these tokens:

| Token       | Form                                          | Example                          |
|-------------|-----------------------------------------------|----------------------------------|
| `KEYWORD`   | `project`, `version`, `tenant`                | `project`                        |
| `NODE_TYPE` | PascalCase identifier matching a registry id  | `CartAbandoned`, `WhatsAppSend`  |
| `IDENTIFIER`| `snake_case` identifier                       | `trigger`, `first_touch`         |
| `STRING`    | Double-quoted, supports `\"` and `\\`         | `"cart_reminder"`                |
| `CURRENCY`  | `Currency(<amount>, <CODE>)`                  | `Currency(200, MAD)`             |
| `DURATION`  | `Duration(<amount>, <unit>)`                  | `Duration(30, minutes)`          |
| `REFERENCE` | `<identifier>.<field>`                        | `profile.phone`                  |
| `LBRACE`    | `{`                                           | `{`                              |
| `RBRACE`    | `}`                                           | `}`                              |
| `COLON`     | `:`                                           | `:`                              |
| `COMMA`     | `,`                                           | `,`                              |
| `EQUALS`    | `=`                                           | `=`                              |

The compiler distinguishes `NODE_TYPE` from `IDENTIFIER` by case:
PascalCase is reserved for node types, snake_case for instance
names and field accesses. The lexer does not enforce that the
PascalCase token names a real node (that's the type checker's
job in a later session) — it only classifies by shape.

`CURRENCY` and `DURATION` are first-class lexical tokens, not
function calls. The lexer recognizes the full
`Currency(200, MAD)` / `Duration(24, hours)` form as a single
token and lifts the amount + unit/code onto the
`ConfigValue::Currency { amount, code }` / `ConfigValue::Duration
{ amount, unit }` AST nodes. This is the design that makes
commerce types first-class in the language — they are syntax,
not stdlib calls.

Duration units accepted in v0.1: `seconds`, `minutes`, `hours`,
`days`. Currency codes accepted in v0.1: any 3-letter uppercase
sequence — validation against the `CurrencyCode` enum
(`MAD`/`EUR`/`USD`) is the type checker's job, not the lexer's.

Whitespace is insignificant outside of token separation. Line
comments start with `//` and run to end-of-line. Block comments
are reserved syntax (not in v0.1).

### 4. Error philosophy

Every parse error MUST name:

1. The token that was found.
2. The token (or class of token) that was expected.
3. The 1-based line number.

A v0.1 parse error renders as:

    parse error at line 14: expected RBRACE, found NODE_TYPE("WhatsAppSend")

This is P-2 ("The compiler is the user's ally") in lexer/parser
form. There is no "parse error near `<unknown>`" — if the lexer
emits a token, the parser knows what it is and where it is.

Lexer errors follow the same shape, naming the offending
character or sequence:

    lex error at line 8: unterminated string literal starting at column 23

Errors do not attempt fix-it suggestions in v0.1. P-2's "tell the
merchant exactly how to fix it" is a Phase 3 type-checker feature,
not v0.1 lexer scope.

## Consequences

**Positive.**

- The AI builder (P-6, ADR-0004) has a concrete target: it
  generates `.warp` text, runs the compiler, and either ships the
  workflow or feeds the compile error back into the next
  generation pass.
- The merchant canvas (Phase 3) has a serialization format that
  round-trips: canvas → DSL → compiler → graph → canvas.
- Commerce types are first-class syntax, not buried in a stdlib
  prelude. `Currency(200, MAD)` looks like commerce, not like a
  function call.
- The compiler can be implemented incrementally: lexer this
  session, parser this session, type checker next session, code
  generator after that. Each layer has a clean handoff.

**Negative.**

- The grammar is intentionally narrow. Loops, conditionals, and
  string interpolation are out of scope for v0.1 — when a merchant
  needs branching, the answer today is "compose with a multi-node
  workflow like CartRecoveryFull." Later versions widen the
  surface; this one stays small enough to ship and prove.
- Comments are line-only. Block comments and doc comments are
  reserved syntax.
- The lexer doesn't know about the node registry; an undefined
  node type only fails at type-check time, not at lex/parse time.
  That keeps the parser pure but means parse errors look
  syntactically correct for misspelled node names like
  `WhatappSend`. This is a deliberate layering: parser checks
  shape, type checker checks meaning.

## Status

**ACCEPTED 2026-05-25.** Locks the v0.1 syntax for the lexer and
parser shipping this session. The type checker (next session) and
the code generator (after that) consume the AST defined here. Any
breaking syntax change requires a superseding ADR.
