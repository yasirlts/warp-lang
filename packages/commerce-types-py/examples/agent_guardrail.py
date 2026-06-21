"""Putting an AI agent near money? Validate its actions BEFORE they execute.

    pip install warp-commerce-types
    python agent_guardrail.py

The Python twin of the TypeScript examples/agent-guardrail.mjs — same verdicts.
"""
from warp_commerce_types import (
    apply_commitment_path,
    guard_action,
    new_commitment,
    party_id,
    ProposedAction,
    World,
)

buyer = party_id("buyer_1")
seller = party_id("seller_1")

# A real, shipped (Fulfilled) order committed at 200 MAD.
order = apply_commitment_path(
    new_commitment(buyer, seller, {"offered": [], "requested": [
        {"id": "value:order-total", "form": {"kind": "Money", "money": {"amount": 200, "currency": "MAD"}}, "quantity": 1, "state": {"type": "Available"}}
    ]}),
    {"type": "Fulfilled"}, seller,
)
world = World([order], [], [])
cid = str(order.id)

# NIGHTMARE 1: the agent reverts a shipped order back to Accepted. Blocked first.
reverted = guard_action(world, ProposedAction(commitment=cid, to={"type": "Accepted"}, actor="support_agent"))
if not reverted.ok:
    v = reverted.violations[0]
    print("BLOCKED [%s] %s" % (v.rule, v.message))
    print("FIX: %s" % v.fix)

# NIGHTMARE 2: the agent refunds 500 MAD against a 200 MAD order. Blocked, I-1.
over = guard_action(world, ProposedAction(commitment=cid, to={"type": "Refunded", "amount": {"amount": 500, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor="support_agent"))
if not over.ok:
    v = next(x for x in over.violations if x.rule == "I-1")
    print("BLOCKED [%s] %s" % (v.rule, v.message))

# SAFE: a refund of at most the committed amount is approved.
refund = guard_action(world, ProposedAction(commitment=cid, to={"type": "Refunded", "amount": {"amount": 200, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor="support_agent"))
print("refund (200 MAD) approved? %s" % refund.ok)
