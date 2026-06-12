# @warp-lang/commerce-types

**Formal commerce types derived from the [Warp Commerce Model](https://github.com/yasirlts/warp-lang) v0.2.**

Typed money you can't mix by accident. State transitions validated against the
model's 26-transition table. Runtime checkers for the six commerce invariants.
Platform mappings for Shopify, WooCommerce, and Stripe.

When AI coding agents see these types in your project, they generate commerce
code that satisfies them — and your TypeScript compiler enforces the rest.

## Install

```bash
npm install @warp-lang/commerce-types
```

## Use

```typescript
import {
  type Money,
  newCommitment,
  partyId,
  transitionCommitment,
  auditCommerce,
} from "@warp-lang/commerce-types";

// Money always carries currency — enforced by the type.
const price: Money = { amount: 150, currency: "MAD" };

// State transitions are validated; invalid ones return an error, not a throw.
let order = newCommitment(partyId("cust_1"), partyId("store"));
const proposed = transitionCommitment(order, { type: "Proposed" }, partyId("cust_1"));
const accepted = transitionCommitment(proposed.value!, { type: "Accepted" }, partyId("store"));

const bad = transitionCommitment(accepted.value!, { type: "Draft" }, partyId("store"));
bad.ok;    // false — Accepted → Draft is not a valid transition (Invariant 2)
bad.error; // human-readable explanation

// Audit a set of commerce objects against all six invariants.
const violations = auditCommerce([accepted.value!], [], []);
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

## Scope (v0.1)

This release covers the five primitives, the three state machines with their
transition validators, the six invariant checkers, currency-safe money, and the
Shopify / WooCommerce / Stripe mappings. The fuller value trees (digital
licensing / streaming / service-scheduling detail) and the market-making
records (`AuctionProcess`, `ResolutionProcess`) are modeled in the
[specification](https://github.com/yasirlts/warp-lang/blob/main/spec/COMMERCE_MODEL.md)
and land in a later release.

## License

MIT
