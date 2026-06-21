"""The planning oracle: when the guard says "no", it also says "here are your
valid moves." The Python twin of examples/planning-oracle.mjs — same verdicts.

    python planning_oracle.py
"""
from warp_commerce_types import (
    apply_commitment_path,
    guard_action,
    new_commitment,
    party_id,
    ProposedAction,
    valid_transitions,
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
world = World([order], [], [])
cid = str(order.id)

# The move set is a pure read of the model's transition table — no guessing.
print("Legal moves from Fulfilled:", valid_transitions({"type": "Fulfilled"}))

# 1) The agent proposes an INVALID move: revert a shipped order to Accepted.
verdict = guard_action(world, ProposedAction(commitment=cid, to={"type": "Accepted"}, actor="support_agent"))
if not verdict.ok:
    print("\nBLOCKED [%s] %s" % (verdict.violations[0].rule, verdict.violations[0].message))
    print("Alternatives the agent can choose from:")
    for alt in verdict.alternatives:
        print("  - %s (%s)%s" % (alt.to, alt.label, (" — bounded: %s" % alt.bounded) if alt.bounded else ""))

    # 2) The agent picks a legal, UNbounded alternative and retries. (Python
    #    validates state payloads strictly, so the agent supplies the chosen
    #    state's required fields — here Disputed needs by / reason / opened_at.)
    choice = next(a for a in verdict.alternatives if a.bounded is None)
    print("\nAgent picks: %s (%s)" % (choice.to, choice.label))
    target = {"type": "Disputed", "by": seller, "reason": "customer dispute", "opened_at": "2026-03-01T00:00:00.000Z"}
    retry = guard_action(world, ProposedAction(commitment=cid, to=target, actor="support_agent"))
    print("Retry accepted? %s" % retry.ok)

# 3) Over-refund: a LEGAL transition whose amount is the problem — Refunded is
#    returned "bounded": retry the SAME move with a corrected amount.
order2 = apply_commitment_path(
    new_commitment(buyer, seller, {"offered": [], "requested": [
        {"id": "v2", "form": {"kind": "Money", "money": {"amount": 200, "currency": "MAD"}}, "quantity": 1, "state": {"type": "Available"}}
    ]}),
    {"type": "Fulfilled"}, seller,
)
world2 = World([order2], [], [])
over = guard_action(world2, ProposedAction(commitment=str(order2.id), to={"type": "Refunded", "amount": {"amount": 500, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor="support_agent"))
if not over.ok:
    refund_alt = next(a for a in over.alternatives if a.to == "Refunded")
    print("\nBLOCKED [%s] over-refund. Refunded is legal but bounded: %s" % (over.violations[0].rule, refund_alt.bounded))
    corrected = guard_action(world2, ProposedAction(commitment=str(order2.id), to={"type": "Refunded", "amount": {"amount": 200, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor="support_agent"))
    print("Corrected refund (200 MAD) accepted? %s" % corrected.ok)
