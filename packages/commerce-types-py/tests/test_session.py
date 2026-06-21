"""Session-level coherence tests — mirror of the TypeScript session suite."""
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


def money_value(amount):
    return {"id": "v", "form": {"kind": "Money", "money": {"amount": amount, "currency": "MAD"}}, "quantity": 1, "state": {"type": "Available"}}


def fulfilled_order(amount):
    return apply_commitment_path(new_commitment(buyer, seller, {"offered": [], "requested": [money_value(amount)]}), {"type": "Fulfilled"}, seller)


def refund(cid, amount):
    return ProposedAction(commitment=cid, to={"type": "Refunded", "amount": {"amount": amount, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor=seller)


def test_cumulative_over_refund_caught_at_third():
    order = fulfilled_order(200)
    cid = str(order.id)
    s = create_session(World([order], [], []))
    assert s.propose(refund(cid, 80)).ok is True
    assert s.propose(refund(cid, 80)).ok is True
    third = s.propose(refund(cid, 80))
    assert third.ok is False
    assert third.violations[0].rule == "I-1"
    assert "240" in third.violations[0].message
    assert "200" in third.violations[0].message
    refund_alt = next(a for a in third.alternatives if a.to == "Refunded")
    assert "40" in (refund_alt.bounded or "")


def test_rejected_refund_does_not_advance_ledger_or_world():
    order = fulfilled_order(200)
    cid = str(order.id)
    s = create_session(World([order], [], []))
    s.propose(refund(cid, 80))
    s.propose(refund(cid, 80))
    assert s.refunded_so_far(cid).amount == 160
    rejected = s.propose(refund(cid, 80))
    assert rejected.ok is False
    assert s.refunded_so_far(cid).amount == 160
    assert s.world.commitments[0].state.type == "Fulfilled"


def test_each_individually_valid_but_cumulatively_invalid():
    order = fulfilled_order(200)
    cid = str(order.id)
    s = create_session(World([order], [], []))
    assert [s.propose(refund(cid, a)).ok for a in (80, 80, 80)] == [True, True, False]


def test_full_refund_moves_order_to_refunded():
    order = fulfilled_order(200)
    s = create_session(World([order], [], []))
    v = s.propose(refund(str(order.id), 200))
    assert v.ok is True
    assert s.world.commitments[0].state.type == "Refunded"
    assert s.refunded_so_far(str(order.id)).amount == 200


def test_partials_summing_to_committed_complete_the_order():
    order = fulfilled_order(200)
    cid = str(order.id)
    s = create_session(World([order], [], []))
    assert s.propose(refund(cid, 120)).ok is True
    assert s.world.commitments[0].state.type == "Fulfilled"  # partial — stays Fulfilled
    assert s.propose(refund(cid, 80)).ok is True
    assert s.world.commitments[0].state.type == "Refunded"  # full — now Refunded


def test_refund_before_capture_rejected_with_alternatives():
    draft = new_commitment(buyer, seller, {"offered": [], "requested": [money_value(200)]})
    s = create_session(World([draft], [], []))
    v = s.propose(refund(str(draft.id), 50))
    assert v.ok is False
    assert v.violations[0].rule == "I-2"
    assert [a.to for a in v.alternatives] == ["Proposed", "Tendered", "Cancelled"]
    assert s.world.commitments[0].state.type == "Draft"


def test_non_refund_action_advances_only_on_acceptance():
    draft = new_commitment(buyer, seller)
    s = create_session(World([draft], [], []))
    assert s.propose(ProposedAction(commitment=str(draft.id), to={"type": "Proposed"}, actor=buyer)).ok is True
    assert s.world.commitments[0].state.type == "Proposed"
    bad = s.propose(ProposedAction(commitment=str(draft.id), to={"type": "Fulfilled"}, actor=buyer))
    assert bad.ok is False
    assert s.world.commitments[0].state.type == "Proposed"
