# Warp

**A formally specified, language-neutral model of commerce — with currency-safe,
state-validated types proven equivalent across four language bindings.**

[![npm](https://img.shields.io/npm/v/@warp-lang/commerce-types?label=npm)](https://www.npmjs.com/package/@warp-lang/commerce-types)
[![PyPI](https://img.shields.io/pypi/v/warp-commerce-types?label=PyPI)](https://pypi.org/project/warp-commerce-types/)
[![CI](https://github.com/yasirlts/warp-lang/actions/workflows/ci.yml/badge.svg)](https://github.com/yasirlts/warp-lang/actions/workflows/ci.yml)
[![Conformance](https://img.shields.io/badge/conformance-51%2F51%20(schema%20v1.0.0)-success)](conformance/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Warp is a model of what commerce *is* — five primitives, six invariants, and one
frozen schema — written down precisely enough that independent implementations
produce the same answers. From that one schema it generates four bindings —
TypeScript, Python, Rust, and Go — and a conformance suite checks that they agree
on every fixture.

It is for anyone who writes commerce logic and wants the structure to be checked
rather than assumed: commerce engineers modelling orders, payments, and
fulfillment; teams sharing a vocabulary across services in different languages;
and developers building AI agents that generate commerce code and need a typed
contract to generate against.

---

## The problem

Commerce code is full of mistakes that look correct. A total is added across two
currencies. An order is moved from `Fulfilled` back to `Accepted`. A refund
exceeds the amount that was captured. A parent order's children no longer sum to
the parent. None of these throw on a happy path — they pass review, ship, and
surface later as reconciliation bugs.

The failure mode gets sharper when code is *generated*: an AI agent producing
commerce logic has no innate sense that MAD and EUR cannot be added, or that a
state machine forbids a transition. It needs a model to generate against, and a
way to be told when it gets it wrong.

---

## What Warp is

Warp is a **formal commerce model**, not a framework. The *conceptual* surface is
deliberately small and language-neutral — five primitives, six invariants, one
frozen schema — and the packages expose a small **core API** (~10 start-here
exports) with the rest tiered as advanced:

- **5 primitives** — `Party`, `Value`, `Intent`, `Commitment`, `Fulfillment`.
  Every commerce operation is expressed in terms of these. The model has been
  exercised adversarially across **22 commerce domains** — physical goods,
  services, BNPL and lending, digital licensing, auctions, real estate,
  healthcare, government procurement, trade finance, loyalty, group buying,
  carbon markets, and more.
- **6 invariants** — value conservation, state monotonicity, capacity
  verification, temporal integrity, identity permanence, and commitment-tree
  consistency. These are the rules an implementation can be checked against.
- **One frozen schema** — the structural types and the behavioral rules
  (transition tables, invariant definitions) live in [`schema/`](schema/) at a
  single versioned source of truth (currently **v1.0.0**, see
  [`schema/VERSION`](schema/VERSION)).
- **Four bindings, generated from that schema** — the TypeScript and Python
  packages plus Rust and Go bindings, all produced from the same `schema/`, not
  hand-maintained in parallel.

**The headline property: the four bindings are proven to agree.** A cross-language
conformance check runs every shared fixture through the TypeScript, Python, Rust,
and Go implementations and compares the verdicts. Today that is **45 of 45**
fixtures runnable in all four — **45 agreements, 0 disagreements**. When any two
bindings disagree on whether a commerce object is valid, CI fails. (Six further
fixtures are catalog enumerations that the behavioral bindings do not run, and are
reported separately as not-applicable.)

The model is specified in full in
[the Commerce Model spec](spec/COMMERCE_MODEL.md).

---

## Install

```bash
npm install @warp-lang/commerce-types     # TypeScript / JavaScript
```

```bash
pip install warp-commerce-types           # Python
```

Both packages are published at **1.1.0** and built from the same schema.

### Quickstart — TypeScript

The fastest path is the `order()` builder: compose a history-complete order and
run the headline audit in a few lines.

```ts
import { order } from "@warp-lang/commerce-types";

// Build a valid order: buyer, seller, a priced item, paid + fulfilled.
const built = order()
  .from("buyer_1")
  .to("seller_1")
  .item({ sku: "TSHIRT-RED-M", price: { amount: 200, currency: "MAD" } })
  .paid()
  .fulfilled()
  .build();   // Result<AuditedOrder> = { ok: true, value } | { ok: false, error }

if (built.ok) {
  const violations = built.value.audit();   // []  — the headline check, clean
}

// A buggy order — two currencies in one order — is surfaced as a Result,
// not coerced into a broken object.
const mixed = order()
  .from("buyer_1").to("seller_1")
  .value({ amount: 200, currency: "MAD" })
  .value({ amount: 30, currency: "EUR" })
  .build();

if (mixed.ok === false) {
  mixed.error;   // "Order mixes currencies (MAD, EUR)… (Invariant 1: Value Conservation)"
}
```

> `order()` is a TypeScript convenience (in the published npm package); the
> Python package exposes the same primitives, transitions, and invariant
> checkers, but not this builder.

Or work with the primitives directly:

```ts
import {
  partyId, newCommitment, transitionCommitment, add,
} from "@warp-lang/commerce-types";

// Money always carries its currency — no bare numbers for money.
const price    = { amount: 200, currency: "MAD" };
const shipping = { amount: 30,  currency: "MAD" };
const total    = add(price, shipping);           // { amount: 230, currency: "MAD" }
console.log("total:", total.amount, total.currency);

// A commitment moves through a validated state machine.
const commitment = newCommitment(partyId("buyer"), partyId("seller"));

// Valid: Draft -> Proposed. The result is a discriminated union.
const proposed = transitionCommitment(commitment, { type: "Proposed" }, partyId("buyer"));
if (proposed.ok) {
  console.log("state:", proposed.value.state.type);   // "Proposed"
}

// Invalid: Draft -> Fulfilled is not in the table. Caught, not thrown.
const bad = transitionCommitment(commitment, { type: "Fulfilled" }, partyId("buyer"));
if (bad.ok === false) {
  console.log("rejected:", bad.error);                // explains the violation
}
```

### Quickstart — Python

```python
from warp_commerce_types import (
    Money, party_id, new_commitment, transition_commitment, add,
)

# Money always carries its currency — Decimal alone is not valid Money.
price    = Money(amount=200, currency="MAD")
shipping = Money(amount=30,  currency="MAD")
total    = add(price, shipping)               # Money(amount=230, currency="MAD")
print("total:", total.amount, total.currency)

# A commitment moves through a validated state machine.
order = new_commitment(party_id("buyer"), party_id("seller"))

# Valid: Draft -> Proposed. The result carries ok / value / error.
proposed = transition_commitment(order, {"type": "Proposed"}, party_id("buyer"))
if proposed.ok:
    print("state:", proposed.value.state.type)    # "Proposed"

# Invalid: Draft -> Fulfilled is not in the table. Caught, not raised.
bad = transition_commitment(order, {"type": "Fulfilled"}, party_id("buyer"))
if not bad.ok:
    print("rejected:", bad.error)                 # explains the violation
```

Both snippets print the running total, the new state, and an explained rejection
for the invalid transition. `add()` raises on a currency mismatch rather than
silently producing a wrong number.

---

## Putting an AI agent near money? Validate its actions before they execute

An LLM agent processing refunds or orders can propose something dangerous — revert
a shipped order, double-refund, accept a sale it never verified. Your options today
are "don't let the agent touch money" or "hand-write a validation guard for every
action." The **agent guardrail** is a third option: a drop-in check that says
**safe** or **not-safe-with-an-actionable-reason** *before* the action runs — so you
ship the agent feature without writing the guards. (Available in all four bindings
— TypeScript, Python, Rust, and Go.)

```ts
import { guardAction, newCommitment, applyCommitmentPath, partyId } from "@warp-lang/commerce-types";

// A real, shipped (Fulfilled) order in your system.
const shipped = applyCommitmentPath(newCommitment(partyId("buyer_1"), partyId("seller_1")), { type: "Fulfilled" }, partyId("seller_1"));
const world = { commitments: [shipped], fulfillments: [], parties: [] };

// The agent "helpfully" reverts a shipped order. The guard rejects it first.
const verdict = guardAction(world, { commitment: shipped.id, to: { type: "Accepted" }, actor: "support_agent" });

if (verdict.ok === false) {
  const v = verdict.violations[0];
  console.log(`BLOCKED [${v.rule}] ${v.message}`);   // I-2: Fulfilled → Accepted is not a valid transition…
  console.log(`FIX: ${v.fix}`);                        // …model a reversal as a new forward commitment
}
```

`guardAction(world, proposedAction)` returns
`{ ok: true, next }` (the resulting valid world) **or**
`{ ok: false, violations: [{ rule, message, fix }], alternatives? }` — it never
throws on a rejected action and never coerces an unsafe one into looking safe. The
reasons are written for an agent to read and self-correct (the auto-correct loop). A
second entry point, `guardObject(commitments, fulfillments, parties)`, is the thin
"the agent built the whole world, check it" case.

The guard does not *reimplement* any checks — it **composes** the proven
`transitionCommitment` (the transition table = Invariant 2) and `auditCommerce`
(the six-invariant audit) that the cross-check holds equivalent across all four
bindings. So it validates a proposed action against the model's invariants and
explains any rejection; it makes unsafe actions easy to **catch**, not impossible
to express. Runnable:
[`examples/agent-guardrail.mjs`](packages/commerce-types/examples/agent-guardrail.mjs).

### The planning oracle — "no, and here are your valid moves"

A gate that only says **no** makes an agent guess again. When `guardAction`
rejects a move, it also returns `alternatives`: the **legal transitions from the
current state**, read from the same generated table the bindings agree on (exposed
directly as `validTransitions(state)`). The agent reads the list and picks a valid
move instead of blindly retrying.

```ts
const verdict = guardAction(world, { commitment: shipped.id, to: { type: "Accepted" }, actor: "agent" });
if (verdict.ok === false) {
  verdict.alternatives; // [{ to: "Disputed", label: "open a dispute" }, { to: "Refunded", label: "refund the commitment" }]
  // the agent picks one and retries — guided, not blind.
}
```

These are **legal transitions, not guaranteed-safe actions**: a listed move is a
valid state transition, but reaching it with particular data may still be rejected
by another invariant. Where a move is legal yet the *data* is the problem — an
over-refund is a valid `Fulfilled → Refunded` transition that fails I-1 on amount —
that target is returned with a `bounded` note ("refund at most the committed
amount"), so the agent corrects the amount rather than picking a different state.
The field is additive: consumers that read only `violations` are unaffected.
Available in all four bindings (TypeScript, Python, Rust, Go). Runnable:
[`examples/planning-oracle.mjs`](packages/commerce-types/examples/planning-oracle.mjs).

### Sessions — catching violations that only emerge across steps

`guardAction` validates one action against the current world. Some violations are
invisible to any single check and only appear across a **sequence**. The headline
case is a **cumulative over-refund**: three partial refunds of 80 MAD against a 200
MAD order each pass on their own (80 ≤ 200), but they sum to 240 > 200. The
point-in-time I-1 check looks at a commitment's *current* `Refunded` state, so a
naive `guardAction`-in-a-loop catches none of them.

`createSession(world)` accumulates. Its `propose(action)` validates against the
running world *and* a cross-step refund ledger, advances only on success, and
returns the same `{ ok, ... }` shape (with planning-oracle `alternatives`).

```ts
import { createSession } from "@warp-lang/commerce-types";

const session = createSession({ commitments: [order /* committed 200 MAD, Fulfilled */], fulfillments: [], parties: [] });
const refund = (amount) => ({ commitment: order.id, to: { type: "Refunded", amount: { amount, currency: "MAD" }, at }, actor: "agent" });

session.propose(refund(80)); // ok — refunded so far 80
session.propose(refund(80)); // ok — refunded so far 160
const v = session.propose(refund(80)); // BLOCKED [I-1]: cumulative 240 > committed 200
v.alternatives; // [{ to: "Refunded", bounded: "…40 MAD remains refundable" }]
```

The cumulative check is **derived from the canonical I-1**, not a second copy: the
session probes the same `checkI1ValueConservation` with the running total. It is a
**composition** over `guardAction` + that check — the per-action transition table
and audit still run unchanged.

**What is covered, precisely:**

- **Cumulative refund conservation** — the sum of refunds against an order may not
  exceed its committed amount (same currency). This is the property single-action
  checks miss.
- **Refund-before-capture ordering** — a refund on an order that was never
  fulfilled is rejected, because `Refunded` is not a legal transition from a
  pre-fulfilment state; `guardAction` supplies the legal alternatives.

**Known limits (not faked):**

- The schema models a refund as a single terminal `Refunded` state with one
  amount — there is no partial-refund state. The session therefore tracks partial
  refunds in its **own ledger** (a TypeScript-layer accumulation, not a schema
  change) and keeps the order in `Fulfilled` until it is fully refunded.
- Cross-*object* ordering (e.g. coordinating sequence across independent
  commitments) is covered only to the extent the per-action audit (I-4 temporal
  integrity) already expresses it. Properties the data model cannot express are
  left as limits rather than emitting false violations.

Available in all four bindings (TypeScript, Python, Rust, Go). Runnable:
[`examples/agent-session.mjs`](packages/commerce-types/examples/agent-session.mjs).

#### Idempotency — a retried action does not double-apply

Agents retry and networks duplicate, so the **same action applied twice must not
double-apply** — a retried refund must not refund twice. The session records the
identity of each accepted action and treats a repeat as a **replay**: it does not
re-apply, does not advance the world, and returns `{ ok: true, replay: true }` so
the caller learns *already done*, not *applied again*.

```ts
const r1 = session.propose({ commitment, to: refunded(50), actor, idempotencyKey: "rk-1" });
// r1.ok === true, r1.replay !== true — applied (refunded 50)
const r2 = session.propose({ commitment, to: refunded(50), actor, idempotencyKey: "rk-1" });
// r2.ok === true, r2.replay === true — a no-op; still refunded 50, not 100
```

Identity is the caller-supplied `idempotencyKey` (the unambiguous, standard
approach), or a derived **fingerprint** (commitment + target type + amount + actor)
when none is given. So two *genuinely distinct* but structurally-identical refunds
need **distinct keys** to apply separately; an identical retry with the same key (or
no key) is deduped. This composes with the cumulative check: three distinct refunds
of 80 still accumulate to 240 and are caught, but the same refund retried counts
once.

> **Scope:** per-session and **in-memory**. Durable, cross-session idempotency would
> need a persistent store and is **not** provided here — a known limit, not a
> guarantee the session makes. Available in **all four bindings** (TypeScript,
> Python, Rust, Go).

Runnable: [`examples/idempotency.mjs`](packages/commerce-types/examples/idempotency.mjs).

#### Optimistic-conflict — reject an action planned against a stale version

Two actors (two agents, or an agent and a human) act on the **same** commitment.
Each action is individually valid, but one was **planned against a stale version**:
actor A advanced the commitment while actor B was still planning. Supply the version
you planned against (`commitmentVersion(commitment)`, derived from the commitment's
append-only history + state — not a schema field) and Warp rejects the stale action
as a **conflict**, distinct from an invariant violation, so you re-read and re-plan.

```ts
const planned = commitmentVersion(commitment);     // e.g. "2:Accepted"
// …another actor advances the commitment to "3:Active"…
const v = session.propose({ commitment: id, to: { type: "Disputed", /* … */ }, actor, expectedVersion: planned });
// v.ok === false, v.conflict === true, v.expected "2:Accepted", v.actual "3:Active"
// → re-read, recompute commitmentVersion(), and re-plan against the current version.
```

A **conflict** (planned-against-stale) is distinct from an **invariant violation**
(the action is unsafe) and from a **replay** (the same action retried — that dedups,
it does not conflict). With no `expectedVersion`, behaviour is unchanged
(unconditional). Pair the conflict signal with the planning-oracle alternatives
where useful.

> **Scope:** this is **optimistic** concurrency over the caller's world view — it
> detects that a planned-against version no longer matches. It is **not** a lock,
> distributed consensus, or a transaction manager, and Warp does **not** serialize
> concurrent writers; those need infrastructure Warp is not. Available in **all four
> bindings** (TypeScript, Python, Rust, Go) — the version *string* differs in form
> between the history-appending bindings (TS/Python: `"2:Accepted"`) and the
> conformance-shaped ones (Rust/Go advance state without re-appending history, so the
> version moves via the state fingerprint: `"0:Accepted"` → `"0:Active"`); the
> conflict verdict is identical.

Runnable: [`examples/concurrency.mjs`](packages/commerce-types/examples/concurrency.mjs).

### Interop — Warp as the neutral model between platforms

The inbound adapters (`platforms/shopify`, `platforms/stripe`, `platforms/woocommerce`)
already map one platform object into a Warp commitment. The interop layer adds the two
pieces that make Warp a canonical intermediate representation — **map each platform in
once, reason in one model, emit a validated platform payload out** — by composing those
adapters with the validators.

**Inbound — `unify(sources)`** merges several platform objects that the **caller asserts
correspond** (a Shopify order + the Stripe charge that paid it) into one Warp commitment,
and checks that value is conserved across them. A disagreement — the order total is 200
but the charge is 150 — is surfaced as an **I-1 (Value Conservation)** violation; the
merged commitment is then validated by the full six-invariant audit.

```ts
const u = unify([
  { platform: "shopify", commitment: fromShopifyOrder(order) },   // 200 MAD
  { platform: "stripe",  commitment: fromStripePaymentIntent(pi) }, // 200 MAD
], { id: "order_123" });
// u.ok → one validated commitment; a 200-vs-150 mismatch → { ok: false, violations: [I-1] }
```

> **Mechanism, not discovery.** The correspondence is an **input** — the caller passes the
> objects together. Warp does **not** auto-reconcile or infer which order matches which
> charge; that is application glue. A mismatch is surfaced, never silently reconciled.

**Outbound — `toStripeAction` / `toShopifyAction` / `toWooCommerceAction`** translate a
**validated** Warp action into a structured, platform-shaped **descriptor** of the call
the application should make:

```ts
toStripeAction(refundAction); // { ok: true, descriptor: { kind: "stripe.refund", payment_intent, amount: 4000, currency: "mad" } }
```

> **Description, not execution.** The emitters return a descriptor object only — **no
> network calls, no credentials, nothing executed** on any platform. Sending it is the
> application's job. Per-platform coverage is explicit: **Refunded → refund** and
> **Cancelled → cancel** on all three; any other action returns a clear *not representable
> on `<platform>`* result rather than a lossy guess.

**Where this sits.** Payment-authorization protocols for AI agents (Google's AP2, the
Agentic Commerce Protocol, and MCP for tool access) answer *"is this agent authorized to
act/pay?"* Warp answers a **different, complementary** question: *"is this commerce action
internally consistent?"* — value conserved, the transition legal, no over-refund across
the session. Warp sits **beneath** those protocols as the integrity check on the action
itself; it does not authorize agents, move money, or replace them.

Available in all four bindings (TypeScript, Python, Rust, Go). Runnable:
[`examples/cross-platform.mjs`](packages/commerce-types/examples/cross-platform.mjs).

---

## What the model checks — and what it does not

The runtime validators check commerce objects against the six invariants. They do
**not** enforce all six the same way, and passing them is **not** a guarantee that
a workflow is correct or safe — it is a set of specific, named checks. Here is the
honest picture of how the bundled DSL **compiler** treats each invariant at
compile time:

| Invariant | Compile-time behavior |
|-----------|------------------------|
| **I-1 Value Conservation** | **Blocking** — a node mixing currencies without an explicit conversion fails compilation; declaring a conversion (the sanctioned path) compiles |
| **I-2 State Monotonicity** | **Blocking (stage-level)** — a workflow that regresses across the Intent → Commitment → Fulfillment lifecycle fails compilation; finer per-commitment-state edges are enforced by the type/audit layer |
| **I-3 Capacity Verification** | **Blocking** — a violation fails compilation |
| **I-4 Temporal Integrity** | **Blocking** — a violation fails compilation |
| **I-5 Identity Permanence** | **Blocking** — a violation fails compilation |
| **I-6 Commitment Tree Consistency** | **Partial / best-effort** — checks literal child-vs-parent values |

> In one line: the compiler blocks on Value Conservation (I-1, un-converted
> currency mixing), Capacity (I-3), Temporal Integrity (I-4), and Identity
> Permanence (I-5); blocks State Monotonicity (I-2) at the lifecycle-stage
> granularity the DSL exposes (Intent → Commitment → Fulfillment, no regression),
> with finer per-commitment-state transition validity enforced by the type/audit
> layer; and partially checks Tree Consistency (I-6). It does not enforce all six
> identically, and passing it is not a proof of correctness.

The library validators (`auditCommerce` / `audit_commerce` and the `checkI*`
functions) cover all six invariants as *runtime* checks; the table above is
specifically about the DSL compiler's static behavior.

---

## The conformance suite

The conformance suite is what makes "independent implementations agree" a
checkable claim rather than a hope. It is a set of language-neutral fixtures —
valid objects that must be accepted, invalid objects that must be rejected — run
through every binding.

- **51 / 51 fixtures pass** against the canonical schema.
- **45 / 45** fixtures runnable in all four bindings (TypeScript, Python, Rust,
  Go) **agree**, with **0 disagreements** (6 catalog-enumeration fixtures are
  reported as not-applicable to the behavioral bindings).
- The **three original audit bugs are locked as permanent regression fixtures**,
  so they cannot return:
  1. **Three-decimal currencies** (TND/BHD/KWD/OMR/JOD) were treated as
     two-decimal, making amounts 10× wrong.
  2. **Adapter empty histories** — synthesized objects with empty histories that
     falsely passed (or failed) the auditor.
  3. **Invariant 6 float equality** — tree consistency used exact float equality,
     so `0.1 + 0.2` children falsely failed a `0.3` parent.

Because the fixtures are schema-bound and language-neutral, **any other stack can
generate its own types from [`schema/`](schema/) and run the same fixtures to
prove it agrees** with the reference bindings — emit per-fixture verdicts and
score them with `conformance/tooling/score-adapter.mjs`. The step-by-step guide,
including the compatibility badge and what a pass does and does **not** prove, is
[**docs/CONFORMANCE.md — Build a Warp-compatible binding**](docs/CONFORMANCE.md).

Run it locally:

```bash
node conformance/runner/run.mjs          # 51/51 fixtures vs the canonical schema
node conformance/tooling/crosscheck.mjs  # TS / Python / Rust / Go agreement
```

See [`conformance/README.md`](conformance/README.md) for the full layout.

---

## The DSL and Rust compiler

The model is the foundation; the `.warp` workflow language is **one application
built on it**. A `.warp` workflow describes a commerce automation — triggers,
delays, communication, intelligence steps — and the Warp compiler type-checks it
against the commerce model before it can run.

```warp
project "cart_recovery" {
  version = "1.0.0"
  tenant  = "your-tenant-id"

  CartAbandoned trigger {
    min_value: Currency(200, MAD)        // money carries its currency
    after:     Duration(30, minutes)
  }

  ACPGetCustomerProfile profile {
    customer_id: trigger.customer_id
  }

  WhatsAppSend message {
    to:       profile.phone              // a PhoneNumber, not a String
    template: "cart_reminder"
    lang:     profile.language
    params:   { cart_value: trigger.cart_value }
  }
}
```

The compiler is an **original Rust implementation** — a hand-written lexer,
recursive-descent parser, type checker, and code generator. There is **no forked
upstream**. Durable execution — workflows that survive restarts, durable timers,
and human-in-the-loop pauses — is provided by [Restate](https://restate.dev)'s
MIT-licensed SDK; see
[ADR-0006](docs/adr/0006-restate-as-execution-foundation.md).

Build and run the compiler from this repo:

```bash
cargo build --workspace      # warp-core (compiler), warp-mcp, warp-generated
cargo test  --workspace
```

A **managed compiler** is hosted at [warp.aimer.ma](https://warp.aimer.ma) as the
easiest way to try compilation without a local build (the API is key-gated). The
commercial server — billing, payments, tenancy, signup — is not part of this open
release.

---

## Roadmap

**Recently shipped:** the conformance cross-check now proves **four** bindings
equivalent — TypeScript, Python, Rust, and Go — all generated from the schema. The
DSL compiler now **blocks** I-1 (un-converted currency mixing; declaring a
conversion is the sanctioned escape) and **blocks** I-2 state monotonicity at the
lifecycle-stage granularity the DSL exposes (see the invariant table above).

The items below are **planned, not present**. They are listed here so the line
between what ships today and what is intended is unambiguous.

- **Per-commitment-state I-2 in the compiler** — extend the static I-2 check from
  lifecycle-stage granularity to per-commitment-state transitions (Draft → … →
  Refunded, the dispute/refund reversals) once the node registry carries per-node
  commitment-state annotations. Until then the type/audit layer enforces those
  edges via `validate_commitment_transition`.
- **More platform adapters** — beyond the current Shopify / WooCommerce / Stripe
  type mappings.
- **A profile system** — schema profiles for subsets of the model.
- **A playground** — a hosted, no-install way to explore the model and the DSL.
- **Agentic-commerce integration** — positioning the model as a language-neutral
  integrity layer *beneath* agent-driven commerce protocols (e.g. ACP / AP2), so
  generated commerce actions can be validated against the invariants before they
  execute.

---

## Documentation

- [Commerce Model](spec/COMMERCE_MODEL.md) — the five primitives and six invariants
- [Type Specification](spec/TYPE_SPEC.md) and the versioned specs in [`docs/`](docs/)
- [Compatible-platform guide](spec/COMPATIBLE_GUIDE.md)
- [Build a Warp-compatible binding](docs/CONFORMANCE.md) — generate types, run the fixtures, prove agreement
- [Conformance suite](conformance/README.md) and the [case studies](docs/case-studies/)
- [Architecture Decision Records](docs/adr/)
- [`@warp-lang/commerce-types`](https://www.npmjs.com/package/@warp-lang/commerce-types) (npm) ·
  [`warp-commerce-types`](https://pypi.org/project/warp-commerce-types/) (PyPI)
- [`.warp` VS Code extension](editors/vscode/) — language support for `.warp` files
- [CLAUDE.md](CLAUDE.md) — drop-in rules for AI agents writing `.warp` / commerce code

---

## Contributing

Issues and pull requests are welcome. The bar for any change is the conformance
suite: `node conformance/runner/run.mjs` and `node conformance/tooling/crosscheck.mjs`
must stay green, and `cargo test --workspace` plus the package test suites must
pass. New commerce behavior should come with a fixture that locks it in.

## License

MIT — see [LICENSE](LICENSE). Use it freely, build on it, ship Warp-compatible
products.
