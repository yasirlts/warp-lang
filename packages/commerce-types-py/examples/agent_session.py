"""Session-level coherence: validate a SEQUENCE of actions, catching a cumulative
over-refund single-action checks cannot see. Python twin of examples/agent-session.mjs.

    python agent_session.py
"""
from warp_commerce_types import (
    apply_commitment_path,
    create_session,
    new_commitment,
    party_id,
    ProposedAction,
    World,
)

buyer = party_id("buyer_1")
seller = party_id("seller_1")

order = apply_commitment_path(
    new_commitment(buyer, seller, {"offered": [], "requested": [
        {"id": "value:order-total", "form": {"kind": "Money", "money": {"amount": 200, "currency": "MAD"}}, "quantity": 1, "state": {"type": "Available"}}
    ]}),
    {"type": "Fulfilled"}, seller,
)
cid = str(order.id)
session = create_session(World([order], [], []))


def refund(amount):
    return ProposedAction(commitment=cid, to={"type": "Refunded", "amount": {"amount": amount, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor="support_agent")


# Three partial refunds of 80 MAD. Each ALONE passes (80 <= 200) — but they accumulate.
for amount in (80, 80, 80):
    verdict = session.propose(refund(amount))
    sofar = session.refunded_so_far(cid)
    if verdict.ok:
        print("refund %s MAD → accepted. refunded so far: %s %s" % (amount, int(sofar.amount), sofar.currency))
    else:
        print("\nrefund %s MAD → BLOCKED [%s]" % (amount, verdict.violations[0].rule))
        print(verdict.violations[0].message)
        print("FIX: %s" % verdict.violations[0].fix)
        print("bounded alternative: Refunded — %s" % verdict.alternatives[0].bounded)
        print("refunded so far (unchanged): %s %s" % (int(sofar.amount), sofar.currency))

# The agent reads the bounded guidance (40 MAD remaining) and refunds within it.
corrected = session.propose(refund(40))
total = session.refunded_so_far(cid)
print("\ncorrected refund 40 MAD → %s. total refunded: %s %s (== committed 200; order is now %s)" % (
    "accepted" if corrected.ok else "blocked", int(total.amount), total.currency, session.world.commitments[0].state.type))
