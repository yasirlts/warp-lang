# Warp Commerce Model — Agent Guide

This is the canonical guide for **any agent or developer** — Claude, GPT, Gemini,
a local open model, or a human — that needs to emit valid commerce objects or
`.warp` workflows against the **Warp Commerce Model**.

It is written generically: where it says "the agent," it means whatever is
generating the code. Nothing here is specific to one model provider. The neutral,
universal way to use Warp from any stack is the **frozen schema** plus the
**published packages**:

- Specification: [`spec/COMMERCE_MODEL.md`](spec/COMMERCE_MODEL.md)
- Schema (single source of truth): [`schema/`](schema/) — version in [`schema/VERSION`](schema/VERSION)
- TypeScript / JavaScript: `npm install @warp-lang/commerce-types`
- Python: `pip install warp-commerce-types`

Both published packages are generated from the same schema. The conformance
cross-check proves four bindings — TypeScript, Python, Rust, and Go — produce the
identical verdict on every shared fixture (the Rust and Go bindings live in the
repo rather than as published packages), so the rules below hold identically in
every binding.

---

## What the model checks — and what it does not

Be precise. The Warp compiler does **not** enforce all six invariants identically,
and the types do **not** make every mistake impossible. Passing the checks is
**not** a proof of correctness or safety — it is a set of specific, named checks.
Here is exactly how the DSL compiler treats each invariant at compile time:

| Invariant | Compile-time behavior |
|-----------|------------------------|
| **I-1 Value Conservation** | **Blocking** — a node mixing currencies without an explicit conversion fails compilation; declaring a conversion (the sanctioned path) compiles |
| **I-2 State Monotonicity** | **Blocking (stage-level)** — a workflow that regresses across the Intent → Commitment → Fulfillment lifecycle fails compilation; finer per-commitment-state edges are enforced by the type/audit layer |
| **I-3 Capacity Verification** | **Blocking** — a violation fails compilation |
| **I-4 Temporal Integrity** | **Blocking** — a violation fails compilation |
| **I-5 Identity Permanence** | **Blocking** — a violation fails compilation |
| **I-6 Commitment Tree Consistency** | **Partial / best-effort** — checks literal child-vs-parent values |

For finer-grained checks than the compiler makes statically (e.g. per-commitment-
state transition validity, or I-6 beyond literal values), the agent should also
use the `transition*` functions (which reject invalid state moves) and the runtime
validators (`auditCommerce` / `checkI*` in TypeScript, `audit_commerce` /
`check_i*` in Python, and the Rust/Go equivalents). The rules below are the
standard to code to regardless of what the compiler blocks.

---

## Core rule

**Every commerce operation must be expressible as a sequence of valid state
transitions on one of the five Warp primitives.**

The five primitives:
- **Party** — any entity participating in commerce
- **Value** — what moves or is accessed between parties
- **Intent** — expressed desire before commitment
- **Commitment** — formal agreement between parties
- **Fulfillment** — execution of a commitment

If the agent cannot map a commerce operation to these primitives, it must flag
that before generating code rather than inventing a sixth concept.

---

## The six invariants — code to these

Examples are shown in TypeScript; the Python package exposes the same functions
under snake_case names (`transition_commitment`, `audit_commerce`, `check_i1_*`,
etc.) and the same `Money` shape.

### Invariant 1 — Value Conservation

For physical goods and money, value transfers — the originating party loses it.
For digital goods, access rights are granted or revoked while the provider retains
their copy.

```typescript
// WRONG — amount without currency is meaningless
const price = 150

// RIGHT — money always carries its denomination
const price: Money = { amount: 150, currency: "MAD" }

// WRONG — currency mixing without conversion
const total = amountMAD + amountEUR

// RIGHT — explicit conversion required
const total = add(convert(amountEUR, "MAD", rate), amountMAD)
```

### Invariant 2 — State Monotonicity

States follow directed paths. No backward transitions. A `Fulfilled` commitment
cannot return to `Accepted`; a `Cancelled` commitment cannot become `Fulfilled`.

**Valid CommitmentState transitions — only these are allowed:**
```
Draft       → Proposed, Tendered, Cancelled
Proposed    → Accepted, Cancelled, Modified
Tendered    → Accepted, Cancelled
Accepted    → Modified, PartiallyFulfilled, Active, Cancelled, Disputed
Modified    → Accepted, Cancelled
PartiallyFulfilled → Fulfilled, Modified, Cancelled
Active      → Modified, Cancelled, Disputed
Fulfilled   → Disputed, Refunded
Disputed    → Fulfilled, Refunded, Cancelled
```

```typescript
// WRONG — assigns any string, no validation
order.status = "fulfilled"

// RIGHT — validates against the transition table; the false branch carries error
const result = transitionCommitment(order, { type: "Fulfilled" }, actorId)
if (!result.ok) throw new InvalidTransitionError(result.error)
const updated = result.value
```

### Invariant 3 — Capacity Verification

A Commitment cannot reach `Accepted` unless the capacity of all parties has been
verified.

```typescript
// WRONG — accepts without verifying party capacity
order.status = "accepted"

// RIGHT — verify capacity first
if (!party.capacity.can_buy) throw new CapacityError("Party cannot buy")
const result = transitionCommitment(order, { type: "Accepted" }, actorId)
```

### Invariant 4 — Temporal Integrity

State transitions happen in time order. No backdating; history is append-only;
fulfillment cannot precede commitment.

```typescript
// WRONG — fulfillment before commitment
await shipOrder(orderId)
await acceptOrder(orderId)

// RIGHT — commitment before fulfillment
await acceptOrder(orderId)    // Commitment(Accepted)
await shipOrder(orderId)      // Fulfillment(InProgress)
```

### Invariant 5 — Identity Permanence

IDs are globally unique and never reused. A `CommitmentID` maps to exactly one
Commitment forever.

```typescript
// WRONG — reusing or reassigning IDs
order.id = newId

// RIGHT — IDs are immutable after creation
const order = newCommitment(buyer, seller)
// order.id never changes
```

### Invariant 6 — Commitment Tree Consistency

For parent-child Commitment structures, the sum of child values must equal the
parent value at all times.

```typescript
// WRONG — children don't sum to parent (2500 ≠ 3000)
const parent   = { total: { amount: 3000, currency: "MAD" } }
const children = [
  { total: { amount: 1000, currency: "MAD" } },
  { total: { amount: 1500, currency: "MAD" } },
]

// RIGHT — children sum to parent (3000 = 3000)
const children = [
  { total: { amount: 1500, currency: "MAD" } },
  { total: { amount: 1500, currency: "MAD" } },
]
```

---

## Reading validation errors and self-correcting

Both packages return failures as data, not exceptions, so an agent can inspect and
retry without a try/catch. The result is a discriminated union:

```typescript
type Result<T> =
  | { ok: true;  value: T }
  | { ok: false; error: string }
```

The `error` string names the invariant it relates to, which is the signal an agent
should act on. For example, an invalid transition returns:

```
Commitment cannot transition from 'Draft' to 'Fulfilled' — not a valid
transition. A terminal state cannot move backward; to reverse a Fulfilled
commitment, create a new Commitment with the parties exchanged
(Invariant 2: State Monotonicity).
```

**Self-correction loop for a generating agent:**

1. Generate the object or transition.
2. Run the relevant check — `transition*` for a state move, or `auditCommerce` /
   `audit_commerce` for a whole object graph.
3. If `ok` is `false` (or the audit returns violations), read the invariant named
   in the message — e.g. *Invariant 1* means attach a currency or insert an
   explicit `convert`; *Invariant 2* means the transition is not in the table;
   *Invariant 6* means rebalance children to sum to the parent.
4. Regenerate the offending part and re-check. Do not present code that still has
   violations.

```typescript
// Whole-graph audit returns a list of violations, each with its invariant id
const violations = auditCommerce(commitments, fulfillments, parties)
if (violations.length > 0) {
  // each violation carries the invariant number, what is wrong, and where —
  // fix and re-run until the list is empty
}
```

---

## Type mappings — platform to Warp model

When working with existing platforms, map their types to Warp primitives.

### Shopify
```
Cart                    → Intent { state: Active }
Abandoned Checkout      → Intent { state: Abandoned }
Order (pending)         → Commitment { state: Proposed }
Order (paid)            → Commitment { state: Accepted }
Order (fulfilled)       → Commitment { state: Fulfilled }
Order (refunded)        → Commitment { state: Refunded }
Fulfillment             → Fulfillment entity
Customer                → Party { type: Individual }
Product variant         → Value { form: PhysicalGood }
```

### WooCommerce
```
Cart                    → Intent { state: Active }
Order (pending)         → Commitment { state: Proposed }
Order (processing)      → Commitment { state: Accepted }
Order (completed)       → Commitment { state: Fulfilled }
Order (refunded)        → Commitment { state: Refunded }
Shipment                → Fulfillment entity
Customer                → Party { type: Individual }
Product                 → Value { form: PhysicalGood }
```

### Stripe
```
PaymentIntent (created)    → Commitment { state: Proposed }
PaymentIntent (succeeded)  → Commitment { state: Accepted }
PaymentIntent (canceled)   → Commitment { state: Cancelled }
Customer                   → Party { type: Individual }
Price                      → Value { form: Money }
```

> The package ships these mappings: `import { fromShopifyOrder } from "@warp-lang/commerce-types/platforms/shopify"`
> (also `/platforms/woocommerce`, `/platforms/stripe`). Stripe amounts are
> minor-unit aware (cents ↔ decimal; zero-decimal currencies like JPY and
> three-decimal currencies like TND/BHD/KWD/OMR/JOD are handled). Adapters
> synthesize a valid transition history, so their output passes `auditCommerce`.

---

## Code generation rules

When generating commerce code, the agent must:

1. **Always use typed money.** Never generate `price: number`, `amount: number`,
   or `cost: number`. Always generate `price: Money` with a currency.
2. **Always use state machines for commitment state.** Never generate
   `status: string` with string comparisons. Always generate typed state with
   validated transitions (`transitionCommitment` / `transition_commitment`).
3. **Always verify capacity before acceptance.** Never transition to `Accepted`
   without a prior capacity check.
4. **Always enforce temporal ordering.** Never generate fulfillment code before
   commitment code.
5. **Always use unique, immutable IDs.** Never reassign or reuse entity IDs;
   generate them once at creation.
6. **Always validate tree consistency for split orders.** Never generate child
   commitments without summing to the parent.

---

## Commerce audit checklist

When reviewing existing commerce code, check each invariant:

- [ ] I-1: All money values carry currency denomination
- [ ] I-1: No currency mixing without explicit conversion
- [ ] I-2: All state transitions are in the valid list
- [ ] I-2: No backward transitions possible
- [ ] I-3: Capacity verified before any Accepted transition
- [ ] I-4: Fulfillment always follows Commitment temporally
- [ ] I-4: No backdated state transitions
- [ ] I-5: IDs are generated once and never reassigned
- [ ] I-6: Child commitment values sum to parent

Report each violation with: the invariant number and name, the file and line, what
the code does, what it should do instead, and the corrected code.
`auditCommerce(commitments, fulfillments, parties)` (TS) /
`audit_commerce(...)` (Python) returns exactly this list of violations
programmatically.

---

## Quick reference (TypeScript)

```typescript
import {
  Party, PartyID, PartyType, PartyCapacity,
  Value, Money, PhysicalGood, DigitalGood, ServiceValue,
  Intent, IntentID, IntentState,
  Commitment, CommitmentID, CommitmentState,
  Fulfillment, FulfillmentID, FulfillmentState,
  add, convert,
  transitionCommitment, transitionIntent, transitionFulfillment,
  checkI1ValueConservation, checkI2StateMonotonicity, checkI3CapacityVerification,
  checkI4TemporalIntegrity, checkI5IdentityPermanence, checkI6TreeConsistency,
  auditCommerce,
} from "@warp-lang/commerce-types"
```

The Python package (`warp_commerce_types`) exposes the same surface under
snake_case names.

---

## Beyond the packages

The packages and schema are the provider-neutral path and are enough on their own.
Warp also ships **one example integration surface** — a Model Context Protocol
(MCP) server in [`crates/warp-mcp/`](crates/warp-mcp/) — for agent runtimes that
speak MCP. It is one option among many, not a requirement; see its
[README](crates/warp-mcp/README.md).

To prove a binding in any language agrees with the model — generate types from the
schema, run the same fixtures, score the result — see
[`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) and the
[conformance suite](conformance/README.md).

---

*Based on the Warp Commerce Model — https://github.com/yasirlts/warp-lang*
