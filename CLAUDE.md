# Warp Commerce Model — AI Coding Rules

This project uses the **Warp Commerce Model** as the formal
specification for all commerce logic.

Specification: https://github.com/yasirlts/warp-lang/blob/main/spec/COMMERCE_MODEL.md
Type package: npm install @warp-lang/commerce-types

---

## Core Rule

**Every commerce operation must be expressible as a sequence of
valid state transitions on one of the five Warp primitives.**

The five primitives:
- **Party** — any entity participating in commerce
- **Value** — what moves or is accessed between parties
- **Intent** — expressed desire before commitment
- **Commitment** — formal agreement between parties
- **Fulfillment** — execution of a commitment

If you cannot map a commerce operation to these primitives,
flag it before generating code.

---

## The Six Invariants — Never Violate These

### Invariant 1 — Value Conservation

For physical goods and money:
Value transfers. The originating party loses it.

For digital goods:
Access rights are granted or revoked.
The provider retains their copy.

**In code:**
```typescript
// WRONG — amount without currency is meaningless
const price = 150

// RIGHT — money always carries denomination
const price: Money = { amount: 150, currency: "MAD" }

// WRONG — currency mixing without conversion
const total = amountMAD + amountEUR

// RIGHT — explicit conversion required
const total = add(convert(amountEUR, "MAD", rate), amountMAD)
```

### Invariant 2 — State Monotonicity

States follow directed paths. No backward transitions.
A Fulfilled commitment cannot return to Accepted.
A Cancelled commitment cannot become Fulfilled.

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

**In code:**
```typescript
// WRONG — allows any transition
order.status = "fulfilled"

// RIGHT — validates against transition table
const result = transitionCommitment(order, { type: "Fulfilled" }, actorId)
if (!result.ok) throw new InvalidTransitionError(result.error!)
```

### Invariant 3 — Capacity Verification

A Commitment cannot reach Accepted state unless the capacity
of all parties has been verified.

**In code:**
```typescript
// WRONG — accepts without verifying party capacity
order.status = "accepted"

// RIGHT — verify capacity first
if (!party.capacity.can_buy) throw new CapacityError("Party cannot buy")
const result = transitionCommitment(order, { type: "Accepted" }, actorId)
```

### Invariant 4 — Temporal Integrity

State transitions happen in time order.
No backdating. History is append-only.
Fulfillment cannot precede Commitment.

**In code:**
```typescript
// WRONG — fulfillment before commitment
await shipOrder(orderId)
await acceptOrder(orderId)

// RIGHT — commitment before fulfillment
await acceptOrder(orderId)    // Commitment(Accepted)
await shipOrder(orderId)      // Fulfillment(InProgress)
```

### Invariant 5 — Identity Permanence

IDs are globally unique and never reused.
A CommitmentID maps to exactly one Commitment forever.

**In code:**
```typescript
// WRONG — reusing or reassigning IDs
order.id = newId

// RIGHT — IDs are immutable after creation
const order = newCommitment(buyer, seller)
// order.id never changes
```

### Invariant 6 — Commitment Tree Consistency

For parent-child Commitment structures:
Sum of child values must equal parent value at all times.

**In code:**
```typescript
// WRONG — children don't sum to parent (2500 ≠ 3000)
const parent  = { total: { amount: 3000, currency: "MAD" } }
const children = [
  { total: { amount: 1000, currency: "MAD" } },
  { total: { amount: 1500, currency: "MAD" } },
]

// RIGHT — children must sum to parent (3000 = 3000)
const children = [
  { total: { amount: 1500, currency: "MAD" } },
  { total: { amount: 1500, currency: "MAD" } },
]
```

---

## Type Mappings — Platform to Warp Model

When working with existing platforms, map their types to Warp:

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
> minor-unit aware (cents ↔ decimal, zero-decimal currencies handled).

---

## Code Generation Rules

When generating commerce code, Claude must:

**1. Always use typed money.**
Never generate `price: number`, `amount: number`, or `cost: number`.
Always generate `price: Money` with a currency.

**2. Always use state machines for commitment state.**
Never generate `status: string` with string comparisons.
Always generate typed state with validated transitions (`transitionCommitment`).

**3. Always verify capacity before acceptance.**
Never transition to Accepted without a prior capacity check.

**4. Always enforce temporal ordering.**
Never generate fulfillment code before commitment code.

**5. Always use unique immutable IDs.**
Never reassign or reuse entity IDs; generate them once at creation.

**6. Always validate tree consistency for split orders.**
Never generate child commitments without summing to the parent.

---

## Commerce Audit Checklist

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

Report each violation with: the invariant number and name, the file
and line, what the code does, what it should do instead, and the
corrected code. The package's `auditCommerce(commitments, fulfillments, parties)`
returns exactly this list of violations programmatically.

---

## Quick Reference

```typescript
import {
  Party, PartyID, PartyType, PartyCapacity,
  Value, Money, PhysicalGood, DigitalGood, ServiceValue,
  Intent, IntentID, IntentState,
  Commitment, CommitmentID, CommitmentState,
  Fulfillment, FulfillmentID, FulfillmentState,
  transitionCommitment,
  transitionIntent,
  transitionFulfillment,
  verifyInvariant1, verifyInvariant2, verifyInvariant3,
  verifyInvariant4, verifyInvariant5, verifyInvariant6,
  auditCommerceCode,
} from "@warp-lang/commerce-types"
```

---

*Based on Warp Commerce Model v0.2*
*https://github.com/yasirlts/warp-lang*
