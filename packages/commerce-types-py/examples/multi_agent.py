"""Multi-agent verification: several named agents act on a SHARED world. Each action
is individually valid, but their COMBINED sequence violates an invariant — Warp catches
it at the offending step and attributes it to the actor whose action tipped the shared
world into violation. Python twin of examples/multi-agent.mjs.

    python multi_agent.py

Scope: shared-world invariant enforcement WITH attribution. The attribution is the
action that tipped the world into violation — NOT collusion or intent detection.
"""
from warp_commerce_types import (
    ProposedAction,
    World,
    apply_commitment_path,
    create_multi_agent_session,
    new_commitment,
    party_id,
)

buyer = party_id("buyer")
seller = party_id("seller")

# A shipped (Fulfilled) order committed at 200 MAD, shared by several agents.
order = apply_commitment_path(
    new_commitment(buyer, seller, {"offered": [], "requested": [
        {"id": "value:order-total", "form": {"kind": "Money", "money": {"amount": 200, "currency": "MAD"}}, "quantity": 1, "state": {"type": "Available"}}
    ]}),
    {"type": "Fulfilled"}, seller,
)
cid = str(order.id)
session = create_multi_agent_session(World([order], [], []))


def refund(amount, actor, key):
    return ProposedAction(commitment=cid, to={"type": "Refunded", "amount": {"amount": amount, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor=actor, idempotency_key=key)


# 1) A finance-agent refunds 120 MAD for damaged items — valid on its own.
a = session.propose(refund(120, "finance-agent", "fin-1"))
print("finance-agent refunds 120 → %s (refunded so far: %s MAD)" % (
    "accepted" if a.ok else "rejected", int(session.refunded_so_far(cid).amount)))

# 2) A support-agent, unaware, refunds 100 MAD goodwill — valid ON ITS OWN, but the
#    SHARED world now over-refunds (220 > 200). Caught and attributed to support-agent.
b = session.propose(refund(100, "support-agent", "sup-1"))
if not b.ok:
    print("\nsupport-agent refunds 100 → BLOCKED [%s]" % b.violations[0].rule)
    print("  attribution: %s" % b.attribution)
    alt = next((x for x in b.alternatives if x.to == "Refunded"), None)
    print("  guidance: %s" % (alt.bounded if alt and alt.bounded else b.violations[0].fix))

# 3) support-agent reads the remaining-refundable guidance and corrects to 80 MAD.
c = session.propose(refund(80, "support-agent", "sup-2"))
print("\nsupport-agent corrects to 80 → %s. total refunded: %s MAD (order is now %s)" % (
    "accepted" if c.ok else "rejected", int(session.refunded_so_far(cid).amount),
    session.world.commitments[0].state.type))
print("who did what:", session.actors_summary())

# 4) A fully-valid multi-agent sequence on a fresh order: buyer-agent proposes,
#    seller-agent accepts, ops-agent activates — different actors, all valid.
draft = new_commitment(buyer, seller)
flow = create_multi_agent_session(World([draft], [], []))
did = str(draft.id)
p = flow.propose(ProposedAction(commitment=did, to={"type": "Proposed"}, actor="buyer-agent"))
acc = flow.propose(ProposedAction(commitment=did, to={"type": "Accepted"}, actor="seller-agent"))
act = flow.propose(ProposedAction(commitment=did, to={"type": "Active"}, actor="ops-agent"))
print("\nvalid multi-agent flow → proposed:%s accepted:%s activated:%s. state: %s; agents: %s" % (
    p.ok, acc.ok, act.ok, flow.world.commitments[0].state.type, flow.actors_summary()))
