"""Saga / compensation — validate compensating sequences for coherence. Python mirror
of tests/saga.test.ts."""
from warp_commerce_types import (
    SCHEMA_VERSION,
    ForwardStep,
    ProposedAction,
    World,
    apply_commitment_path,
    commitment_version,
    compensate,
    compensate_session,
    create_session,
    new_commitment,
    party_id,
    plan_compensation,
    validate_compensation,
)

buyer = party_id("buyer")
seller = party_id("seller")
AT = "2026-03-01T00:00:00.000Z"


def money_value(amount):
    return {"id": "value:%s" % amount, "form": {"kind": "Money", "money": {"amount": amount, "currency": "MAD"}}, "quantity": 1, "state": {"type": "Available"}}


def commit(cid, amount, to):
    base = new_commitment(buyer, seller, {"offered": [], "requested": [money_value(amount)]}).model_copy(update={"id": cid})
    return apply_commitment_path(base, to, seller)


def fulfilled(cid, amount):
    return commit(cid, amount, {"type": "Fulfilled"})


def fulfill_step(cid):
    return ForwardStep(commitment=cid, to={"type": "Fulfilled"}, actor=seller)


def _state_type(action_to):
    return action_to["type"] if isinstance(action_to, dict) else action_to.type


def test_plans_refund_to_reverse_fulfilled_step():
    order = fulfilled("order-1", 200)
    world = World([order], [], [])
    plan = plan_compensation(world, [fulfill_step("order-1")], AT)
    assert len(plan.steps) == 1
    action = plan.steps[0].action
    assert action is not None
    assert _state_type(action.to) == "Refunded"
    assert action.to["amount"]["amount"] == 200


def test_valid_compensation_completes_leaving_coherent_refunded_world():
    order = fulfilled("order-1", 200)
    _, result = compensate(World([order], [], []), [fulfill_step("order-1")], AT)
    assert result.ok is True
    assert result.applied == 1
    final_state = next(c for c in result.next.commitments if str(c.id) == "order-1").state.type
    assert final_state == "Refunded"


def test_rejects_over_refund_while_reversing_partially_refunded_flow():
    order = fulfilled("order-1", 200)
    session = create_session(World([order], [], []))
    assert session.propose(ProposedAction(commitment="order-1", to={"type": "Refunded", "amount": {"amount": 50, "currency": "MAD"}, "at": AT}, actor=seller, idempotency_key="partial-50")).ok is True

    over_refund = [ForwardStep(commitment="order-1", to={"type": "Fulfilled"}, actor=seller,
                               compensate_with={"type": "Refunded", "amount": {"amount": 200, "currency": "MAD"}, "at": AT})]
    _, result = compensate_session(session, over_refund, AT)
    assert result.ok is False
    assert result.failed_at == 0
    assert result.violations[0].rule == "I-1"
    assert "250" in result.violations[0].message
    alt = next((a for a in result.alternatives if a.to == "Refunded"), None)
    assert "150" in alt.bounded


def test_same_flow_accepts_bounded_remaining_compensation():
    order = fulfilled("order-1", 200)
    session = create_session(World([order], [], []))
    session.propose(ProposedAction(commitment="order-1", to={"type": "Refunded", "amount": {"amount": 50, "currency": "MAD"}, "at": AT}, actor=seller, idempotency_key="partial-50"))
    remaining = [ForwardStep(commitment="order-1", to={"type": "Fulfilled"}, actor=seller,
                             compensate_with={"type": "Refunded", "amount": {"amount": 150, "currency": "MAD"}, "at": AT})]
    _, result = compensate_session(session, remaining, AT)
    assert result.ok is True
    assert session.refunded_so_far("order-1").amount == 200
    assert next(c for c in session.world.commitments if str(c.id) == "order-1").state.type == "Refunded"


def test_reverses_committed_but_not_delivered_step_by_cancellation():
    lease = commit("lease-1", 100, {"type": "Active"})
    plan, result = compensate(World([lease], [], []), [ForwardStep(commitment="lease-1", to={"type": "Active"}, actor=seller)], AT)
    assert _state_type(plan.steps[0].action.to) == "Cancelled"
    assert result.ok is True
    assert next(c for c in result.next.commitments if str(c.id) == "lease-1").state.type == "Cancelled"


def test_skips_step_with_nothing_to_reverse_terminal_refunded():
    refunded = apply_commitment_path(
        new_commitment(buyer, seller, {"offered": [], "requested": [money_value(200)]}).model_copy(update={"id": "order-2"}),
        {"type": "Refunded", "amount": {"amount": 200, "currency": "MAD"}, "at": AT}, seller,
    )
    world = World([refunded], [], [])
    plan = plan_compensation(world, [ForwardStep(commitment="order-2", to={"type": "Refunded", "amount": {"amount": 200, "currency": "MAD"}, "at": AT}, actor=seller)], AT)
    assert plan.steps[0].action is None
    assert len(plan.skipped) == 1
    assert "terminal" in plan.skipped[0]["reason"]


def test_rejects_illegal_compensate_with_override():
    order = fulfilled("order-1", 200)
    world = World([order], [], [])
    # Fulfilled → Accepted is NOT a legal transition; an override demanding it is skipped.
    plan = plan_compensation(world, [ForwardStep(commitment="order-1", to={"type": "Fulfilled"}, actor=seller, compensate_with={"type": "Accepted"})], AT)
    assert plan.steps[0].action is None
    assert "not a legal transition" in plan.skipped[0]["reason"]


def test_composes_with_f4_replay_no_double_apply():
    order = fulfilled("order-1", 200)
    session = create_session(World([order], [], []))
    plan = plan_compensation(session.world, [fulfill_step("order-1")], AT)
    first = validate_compensation(session, plan)
    assert first.ok is True
    again = validate_compensation(session, plan)
    assert again.ok is True
    assert session.refunded_so_far("order-1").amount == 200  # still 200, not 400


def test_composes_with_f3_conflict_stale_version():
    order = fulfilled("order-1", 200)
    session = create_session(World([order], [], []))
    stale_version = commitment_version(session.world.commitments[0])
    # A concurrent actor disputes the order — a real transition that appends history.
    assert session.propose(ProposedAction(commitment="order-1", to={"type": "Disputed", "by": buyer, "reason": "item missing", "opened_at": AT}, actor=buyer)).ok is True
    stale_plan = plan_compensation(session.world, [ForwardStep(commitment="order-1", to={"type": "Fulfilled"}, actor=seller, compensate_with={"type": "Refunded", "amount": {"amount": 100, "currency": "MAD"}, "at": AT})], AT)
    action = stale_plan.steps[0].action
    assert action is not None
    action.expected_version = stale_version
    result = validate_compensation(session, stale_plan)
    assert result.ok is False
    assert result.conflict is True


def test_unwinds_in_reverse_order():
    a = fulfilled("order-A", 100)
    b = commit("order-B", 100, {"type": "Active"})
    world = World([a, b], [], [])
    plan = plan_compensation(world, [fulfill_step("order-A"), ForwardStep(commitment="order-B", to={"type": "Active"}, actor=seller)], AT)
    # forward = [A, B] → unwind = [B first, A second].
    assert plan.steps[0].forward.commitment == "order-B"
    assert plan.steps[1].forward.commitment == "order-A"


def test_schema_is_frozen():
    assert SCHEMA_VERSION == "1.0.0"
