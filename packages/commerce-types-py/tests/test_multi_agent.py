"""Multi-agent: shared-world enforcement with attribution. Python mirror of
tests/multi-agent.test.ts. Asserts the FACTS (which actor tipped it, which prior
actors form the context, conflict-vs-violation) rather than the exact attribution
sentence — the Python attribution wording differs from TS by design (see the module
docstring)."""
from warp_commerce_types import (
    ProposedAction,
    World,
    apply_commitment_path,
    commitment_version,
    create_multi_agent_session,
    new_commitment,
    party_id,
)

buyer = party_id("buyer")
seller = party_id("seller")


def money_value(amount):
    return {"id": "value:%s" % amount, "form": {"kind": "Money", "money": {"amount": amount, "currency": "MAD"}}, "quantity": 1, "state": {"type": "Available"}}


def fulfilled_order(amount):
    return apply_commitment_path(
        new_commitment(buyer, seller, {"offered": [], "requested": [money_value(amount)]}),
        {"type": "Fulfilled"}, seller,
    )


def refund(commitment, amount, actor, key):
    return ProposedAction(commitment=commitment, to={"type": "Refunded", "amount": {"amount": amount, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor=actor, idempotency_key=key)


def test_catches_cumulative_violation_across_actors_attributed_to_tipper():
    order = fulfilled_order(200)
    cid = str(order.id)
    session = create_multi_agent_session(World([order], [], []))

    assert session.propose(refund(cid, 80, "agent-A", "a")).ok is True
    assert session.propose(refund(cid, 80, "agent-B", "b")).ok is True
    third = session.propose(refund(cid, 80, "agent-C", "c"))
    assert third.ok is False
    assert third.violations[0].rule == "I-1"
    # attribution names the tipping actor (agent-C), applied after the others.
    assert third.actor == "agent-C"
    assert "agent-C" in third.attribution
    assert "agent-A" in third.attribution
    assert "agent-B" in third.attribution
    assert "conspir" not in third.attribution  # NOT collusion
    # the world did not advance past the two accepted refunds.
    assert session.refunded_so_far(cid).amount == 160


def test_attributes_to_the_right_actor_regardless_of_which_tips():
    order = fulfilled_order(200)
    cid = str(order.id)
    session = create_multi_agent_session(World([order], [], []))
    session.propose(refund(cid, 120, "finance-agent", "f"))
    tip = session.propose(refund(cid, 100, "support-agent", "s"))  # 220 > 200
    assert tip.ok is False
    assert tip.actor == "support-agent"
    assert "finance-agent" in tip.attribution  # the accumulated context


def test_single_actor_session_behaves_identically():
    order = fulfilled_order(200)
    cid = str(order.id)
    session = create_multi_agent_session(World([order], [], []))
    assert session.propose(refund(cid, 80, "solo", "a")).ok is True
    assert session.propose(refund(cid, 80, "solo", "b")).ok is True
    third = session.propose(refund(cid, 80, "solo", "c"))
    assert third.ok is False
    assert third.actor == "solo"
    assert "no prior actions" in third.attribution  # no OTHER actors


def test_valid_multi_agent_sequence_completes_with_per_actor_summary():
    draft = new_commitment(buyer, seller)
    cid = str(draft.id)
    session = create_multi_agent_session(World([draft], [], []))
    assert session.propose(ProposedAction(commitment=cid, to={"type": "Proposed"}, actor="buyer-agent")).ok is True
    assert session.propose(ProposedAction(commitment=cid, to={"type": "Accepted"}, actor="seller-agent")).ok is True
    assert session.propose(ProposedAction(commitment=cid, to={"type": "Active"}, actor="ops-agent")).ok is True
    assert session.world.commitments[0].state.type == "Active"
    assert session.actors_summary() == {"buyer-agent": 1, "seller-agent": 1, "ops-agent": 1}
    assert [r.actor for r in session.log] == ["buyer-agent", "seller-agent", "ops-agent"]


def test_f3_stale_version_conflict_attributed_to_late_actor():
    order = apply_commitment_path(new_commitment(buyer, seller), {"type": "Accepted"}, seller)
    cid = str(order.id)
    session = create_multi_agent_session(World([order], [], []))
    planned = commitment_version(session.world.commitments[0])

    # agent-A advances the commitment.
    assert session.propose(ProposedAction(commitment=cid, to={"type": "Active"}, actor="agent-A", expected_version=planned, idempotency_key="A")).ok is True
    # agent-B planned against the stale version → conflict, attributed to agent-B.
    b = session.propose(ProposedAction(commitment=cid, to={"type": "Disputed", "by": buyer, "reason": "x", "opened_at": "2026-03-01T00:00:00.000Z"}, actor="agent-B", expected_version=planned, idempotency_key="B"))
    assert b.ok is False
    assert b.conflict is True
    assert b.actor == "agent-B"
    assert "conflict" in b.attribution


def test_f4_replay_by_same_actor_not_double_logged():
    order = fulfilled_order(200)
    cid = str(order.id)
    session = create_multi_agent_session(World([order], [], []))
    first = session.propose(refund(cid, 50, "agent-A", "k"))
    assert first.ok is True
    retry = session.propose(refund(cid, 50, "agent-A", "k"))
    assert retry.ok is True
    assert retry.replay is True
    # logged once (the replay applied nothing new); refunded once.
    assert session.actors_summary() == {"agent-A": 1}
    assert session.refunded_so_far(cid).amount == 50
