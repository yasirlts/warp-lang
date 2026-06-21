# warp-commerce-types

**Formal commerce types for Python — the twin of [`@warp-lang/commerce-types`](../commerce-types).**

Typed money, validated state transitions, and the six commerce invariants of the
Warp Commerce Model — as Pydantic v2 models. Both this package and the TypeScript
package are generated from / read the **same canonical schema**
([`../../schema`](../../schema)), so the two languages agree *by construction*:

- the data shapes come from `schema/structure/*.schema.json`;
- the legal state-machine edges come from `schema/behavior/transitions.json`;
- the invariant definitions come from `schema/behavior/invariants.json`.

```bash
pip install warp-commerce-types
```

> **Available on PyPI as of v1.0.0.** If you're building from a pre-release
> checkout (before v1.0.0 is live on PyPI), the line above won't resolve yet —
> install from source instead:
>
> ```bash
> # from a checkout of the warp-lang repo:
> pip install ./packages/commerce-types-py
> # …or editable, with dev deps, for working on the package:
> pip install -e "./packages/commerce-types-py[dev]"
> ```

## What you get

```python
from warp_commerce_types import (
    Money, new_commitment, transition_commitment, audit_commerce, allocate,
)

# Currency-safe money. You cannot add MAD to EUR — and minor units are correct
# per currency (TND is 3-decimal: 1.5 TND == 1500 millimes, not 150).
from warp_commerce_types import add, convert
add(Money(amount=100, currency="MAD"), Money(amount=50, currency="MAD"))
# add(Money(amount=1, currency="MAD"), Money(amount=1, currency="EUR"))  -> CurrencyMismatchError

# Exact splits that always reconcile (largest-remainder, minor-unit aware):
allocate(Money(amount=100, currency="MAD"), [1, 1, 1])
# -> 33.34 + 33.33 + 33.33 == 100.00 exactly

# State machines validate every move against the canonical transition table.
c = new_commitment("buyer", "seller")
r = transition_commitment(c, {"type": "Proposed"}, actor="buyer")
assert r.ok and r.value.state.type == "Proposed"
bad = transition_commitment(c, {"type": "Fulfilled"}, actor="buyer")
assert not bad.ok and "Invariant 2" in bad.error   # Draft -> Fulfilled is illegal

# The six invariants, as runtime checkers that return actionable violations.
violations = audit_commerce(commitments=[c], fulfillments=[], parties=[])
```

## The agent toolkit

The same agent toolkit that ships in the TypeScript package is now available in
Python, **behaviour-equivalent** (the conformance cross-check proves the bindings
agree on the model these compose). It is a thin composition over the primitives
above — it does not re-derive invariant or transition logic.

```python
from warp_commerce_types import (
    guard_action, guard_object, valid_transitions, create_session,
    unify, to_stripe_action, World, ProposedAction, UnifySource,
)

# Guardrail — validate a proposed action BEFORE it executes.
verdict = guard_action(world, ProposedAction(commitment=cid, to={"type": "Accepted"}, actor="agent"))
# verdict.ok -> True/False; on rejection, verdict.violations = [{rule, message, fix}]

# Planning oracle — on rejection, the legal moves from the current state.
valid_transitions({"type": "Fulfilled"})   # ['Disputed', 'Refunded']  (a pure read of the table)
verdict.alternatives                         # [{to, label, bounded?}] — LEGAL transitions, not guaranteed-safe

# Session coherence — catch cross-step violations a single check misses.
session = create_session(world)
session.propose(refund_80); session.propose(refund_80)
session.propose(refund_80)  # BLOCKED [I-1]: cumulative 240 > committed 200, with the remaining-refundable bound

# Interop CIR — unify caller-corresponded platform objects; emit validated descriptors.
unify([UnifySource("shopify", order), UnifySource("stripe", charge)])  # mismatch -> I-1 (not auto-reconciled)
to_stripe_action(refund_action).descriptor   # {"kind": "stripe.refund", ...} — a descriptor, NOT an executed call
```

- **`guard_action` / `guard_object`** — compose `transition_commitment` (I-2) +
  `audit_commerce` (the six invariants); never raise on rejection, never coerce.
- **`valid_transitions`** — the legal target states from a state, a pure read of
  the transition table. These are **legal transitions, not guaranteed-safe
  actions**; the absence of a `bounded` note promises nothing.
- **`create_session`** — accumulates a world + a refund ledger; catches a
  **cumulative over-refund** (three 80s against a 200 order) the point-in-time
  check cannot see. The cumulative check probes the **same** `check_i1_value_conservation`.
- **`unify`** — merges objects the **caller asserts correspond** (a mechanism, not
  auto-reconciliation); a value mismatch is surfaced as I-1. The outbound emitters
  return platform-shaped **descriptors** only — **no network, no credentials, no
  execution**. (Python ships inbound mappers for Shopify and Stripe; `unify` itself
  is platform-agnostic.)

Runnable twins of the TypeScript examples live in
[`examples/`](examples/): `agent_guardrail.py`, `planning_oracle.py`,
`agent_session.py`, `cross_platform.py`.

> **Binding coverage:** the agent toolkit is available in **TypeScript and Python**.
> Rust and Go carry the model (primitives, invariants, transitions, cross-checked)
> but not yet the toolkit — those ports are on the roadmap.

## The model

Five primitives — **Party, Value, Intent, Commitment, Fulfillment** — plus the
v0.3 commerce vocabulary (terms, auctions, resolution, metering, evidence, …),
all generated as Pydantic models with discriminated unions keyed on `"type"` /
`"kind"`.

| Concern | Module |
|---------|--------|
| Currency-safe `Money`, minor-unit math, `allocate`, `MoneyBreakdown` | `warp_commerce_types.money` |
| Primitive constructors (`new_commitment`, `party_id`, …) | `warp_commerce_types.primitives` |
| `transition_*` / `is_valid_*_transition`, history synthesis | `warp_commerce_types.transitions` |
| `check_i1..i6`, `audit_commerce`, `check_loyalty_liability` | `warp_commerce_types.invariants` |
| Generated data models | `warp_commerce_types` (re-exported) |
| Platform adapters | `warp_commerce_types.platforms.shopify`, `…stripe` |

### The six invariants

1. **Value Conservation** — value is transferred, not created; no mixed currencies
   without explicit conversion. (Fourth clause: loyalty-point liability —
   `check_loyalty_liability`.)
2. **State Monotonicity** — only legal transitions; terminal states never reverse.
3. **Capacity Verification** — a buyer must be verified (`can_buy`) before Accepted.
4. **Temporal Integrity** — commitments form before fulfillments execute;
   append-only history; timestamps never move backward.
5. **Identity Permanence** — identifiers are globally unique, never reused.
6. **Commitment Tree Consistency** — a parent's value equals the sum of its
   children, within minor-unit tolerance (build exact children with `allocate`).

### `MoneyBreakdown`

A total decomposed into labelled components. Construction enforces the
`money_breakdown_sum` rule from `schema/behavior/invariants.json`: components sum
to the total (minor-unit tolerance), all share one currency, and discount
components are negative.

```python
from warp_commerce_types import MoneyBreakdown
MoneyBreakdown.model_validate({
    "components": [
        {"kind": "subtotal", "amount": {"amount": 90, "currency": "MAD"}},
        {"kind": "discount", "amount": {"amount": -10, "currency": "MAD"}},
        {"kind": "tax",      "amount": {"amount": 20, "currency": "MAD"}},
    ],
    "total": {"amount": 100, "currency": "MAD"},
})  # ok — components sum to 100
```

## Regenerating from the schema

The models and the bundled behavior data are generated. Edit the schema, never
the generated `_models.py`:

```bash
python scripts/generate_from_schema.py   # reads ../../schema, writes src/.../_models.py
```

## Development

```bash
pip install -e ".[dev]"
pytest        # mirrors the TS bug-fix, transition, and invariant suites
mypy          # configured in pyproject.toml
python -m build
```

MIT licensed. Part of the [Warp](https://github.com/yasirlts/warp-lang) project.
