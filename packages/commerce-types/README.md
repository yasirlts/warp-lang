# @warp-lang/commerce-types

**Formal commerce types derived from the [Warp Commerce Model](https://github.com/yasirlts/warp-lang), canonical schema v1.0.0.**

Typed money you can't mix by accident. State transitions validated against the
model's 26-transition table. Runtime checkers for the six commerce invariants.
Platform mappings for Shopify, WooCommerce, and Stripe.

When AI coding agents see these types in your project, they generate commerce
code that satisfies them — and your TypeScript compiler enforces the rest.

## Install

```bash
npm install @warp-lang/commerce-types
```

## Quickstart — `order()`

The fastest path from install to a real validation result. `order()` is a fluent
builder that composes a **history-complete, auditable** order in a few lines, then
hands it to the headline `auditCommerce` check.

```typescript
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
  // The headline check: audit the history-complete order. An empty list is clean.
  const violations = built.value.audit();   // []
}

// A buggy order — two currencies in one order — is surfaced as a Result,
// not coerced into a broken object.
const mixed = order()
  .from("buyer_1").to("seller_1")
  .value({ amount: 200, currency: "MAD" })
  .value({ amount: 30, currency: "EUR" })
  .build();

if (mixed.ok === false) {
  mixed.error; // "Order mixes currencies (MAD, EUR)… (Invariant 1: Value Conservation)"
}
```

Runnable version: [`examples/order-quickstart.mjs`](examples/order-quickstart.mjs).

`order()` makes a *correct* order easy to construct; it does not make an incorrect
one impossible. Invalid compositions — a missing party, the same party on both
sides, mixed currencies, a non-finite amount — return `{ ok: false, error }` with
an actionable message, never a thrown exception and never a silently coerced
object. Internally it uses the same public constructors and the
`applyCommitmentPath` / `applyFulfillmentPath` replay helpers, so every state it
reaches has a real, valid, append-only history — exactly what a hand-built object
would have.

> `order()` is a **TypeScript convenience**. The Python package
> (`warp-commerce-types`) exposes the same primitives, transitions, and invariant
> checkers, but does not (yet) ship this builder.

### From scratch (the primitives)

The builder is sugar — the primitives stay public and unchanged. When you need
full control, construct and transition objects directly:

```typescript
import {
  type Money,
  newCommitment,
  partyId,
  transitionCommitment,
  auditCommerce,
} from "@warp-lang/commerce-types";

// Money always carries currency — there is no amount without a denomination.
const price: Money = { amount: 150, currency: "MAD" };

// State transitions are validated; invalid ones return an error, not a throw.
// transitionCommitment returns Result<Commitment> = { ok: true, value } | { ok: false, error }.
// Checking `r.ok` narrows the type, so `r.value` needs no non-null assertion.
const commitment = newCommitment(partyId("cust_1"), partyId("store"));

const proposed = transitionCommitment(commitment, { type: "Proposed" }, partyId("cust_1"));
if (proposed.ok === false) throw new Error(proposed.error);

const accepted = transitionCommitment(proposed.value, { type: "Accepted" }, partyId("store"));
if (accepted.ok === false) throw new Error(accepted.error);

// Accepted → Draft is rejected: an invalid transition returns an error, not a throw.
const bad = transitionCommitment(accepted.value, { type: "Draft" }, partyId("store"));
if (bad.ok === false) bad.error; // human-readable explanation (Invariant 2: State Monotonicity)

// Audit a set of commerce objects against all six invariants.
const violations = auditCommerce([accepted.value], [], []);
```

### Currency-safe money

```typescript
import { add, convert, CurrencyMismatchError } from "@warp-lang/commerce-types";

add({ amount: 100, currency: "MAD" }, { amount: 50, currency: "MAD" }); // 150 MAD
add({ amount: 100, currency: "MAD" }, { amount: 50, currency: "EUR" }); // throws CurrencyMismatchError
const eur = convert({ amount: 1000, currency: "MAD" }, "EUR", 0.092);   // explicit rate required
```

### Platform mappings

```typescript
import { fromShopifyOrder } from "@warp-lang/commerce-types/platforms/shopify";
import { fromStripePaymentIntent } from "@warp-lang/commerce-types/platforms/stripe";

const commitment = fromShopifyOrder(shopifyOrder); // Order → Commitment, status mapped
```

## What's inside

| Module | Exports |
|--------|---------|
| builder | `order()` — fluent, history-complete order construction returning `Result<AuditedOrder>` (TS-only) |
| primitives | `Party`, `Value`, `Intent`, `Commitment`, `Fulfillment` + branded IDs + constructors |
| states | `IntentState`, `CommitmentState` (11 variants), `FulfillmentState` |
| transitions | `transitionCommitment`/`Intent`/`Fulfillment`, `isValid*Transition` |
| invariants | `checkI1…I6`, `auditCommerce` (aliased as `verifyInvariant1…6`, `auditCommerceCode`) |
| money | `Money`, `add`, `subtract`, `convert`, `compare`, `format`, `zero` |
| platforms/* | `fromShopify*`, `fromWoo*`, `fromStripe*` mappings |

## The six invariants

1. **Value Conservation** — money always carries currency; no silent mixing.
2. **State Monotonicity** — orders follow directed state paths; no backward transitions.
3. **Capacity Verification** — party capacity verified before a commitment is Accepted.
4. **Temporal Integrity** — fulfillment follows commitment; history is append-only.
5. **Identity Permanence** — IDs are unique and never reused.
6. **Commitment Tree Consistency** — child order values sum to their parent.

## Generated from the canonical schema

The structural types and the state-transition tables are **generated from the
[canonical schema spine](https://github.com/yasirlts/warp-lang/tree/main/schema)**
(`schema/structure/*.schema.json` + `schema/behavior/transitions.json`), not
hand-authored. The generator lives at
[`scripts/generate-from-schema.mjs`](scripts/generate-from-schema.mjs) and emits
[`src/generated/`](src/generated/); the brand types (`PartyID`, …) and the open
`CurrencyCode` union — which JSON Schema cannot express — are re-applied by the
generator. The runtime (money math, transition functions, invariant checkers,
platform adapters) is hand-written and consumes the generated types.

```
npm run generate   # regenerate src/generated/ from ../../schema
npm run codegen    # CI: fail if the generated output drifts from the schema
```

## Scope (v1.0.0)

This release covers the five primitives, the three state machines with their
transition validators, the six invariant checkers, currency-safe money, and the
Shopify / WooCommerce / Stripe mappings. The fuller value trees (digital
licensing / streaming / service-scheduling detail) and the market-making
records (`AuctionProcess`, `ResolutionProcess`) are modeled in the
[specification](https://github.com/yasirlts/warp-lang/blob/main/spec/COMMERCE_MODEL.md)
and land in a later release.

## License

MIT
