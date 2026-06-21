"""Guardrail + planning-oracle tests — mirror of the TypeScript guard/transitions
suites, asserting behavioural equivalence (same verdicts)."""
from warp_commerce_types import (
    apply_commitment_path,
    guard_action,
    guard_object,
    is_valid_commitment_transition,
    new_commitment,
    party_id,
    valid_fulfillment_transitions,
    valid_intent_transitions,
    valid_transitions,
    ProposedAction,
    World,
)
from warp_commerce_types.transitions import (
    _COMMITMENT_EDGES,
    _FULFILLMENT_EDGES,
    _INTENT_EDGES,
)

buyer = party_id("buyer_1")
seller = party_id("seller_1")


def money_value(amount, currency="MAD"):
    return {"id": "v", "form": {"kind": "Money", "money": {"amount": amount, "currency": currency}}, "quantity": 1, "state": {"type": "Available"}}


def fulfilled_order(amount=200):
    c = new_commitment(buyer, seller, {"offered": [], "requested": [money_value(amount)]})
    return apply_commitment_path(c, {"type": "Fulfilled"}, seller)


# --- valid_transitions: a pure read of the generated table --------------------

def test_valid_transitions_matches_table_for_every_state():
    for state in _COMMITMENT_EDGES:
        assert valid_transitions({"type": state}) == list(_COMMITMENT_EDGES[state])


def test_valid_transitions_agrees_with_is_valid_for_every_pair():
    states = list(_COMMITMENT_EDGES)
    for frm in states:
        legal = set(valid_transitions({"type": frm}))
        for to in states:
            assert is_valid_commitment_transition({"type": frm}, {"type": to}) == (to in legal)


def test_valid_transitions_terminal_is_empty():
    assert valid_transitions({"type": "Refunded"}) == []
    assert valid_transitions({"type": "Cancelled"}) == []


def test_valid_intent_and_fulfillment_transitions():
    assert valid_intent_transitions({"type": "Active"}) == list(_INTENT_EDGES["Active"])
    assert valid_intent_transitions({"type": "Converted"}) == []
    assert valid_fulfillment_transitions({"type": "Planned"}) == list(_FULFILLMENT_EDGES["Planned"])
    assert valid_fulfillment_transitions({"type": "Failed", "reason": "x", "recoverable": True}) == ["Planned"]
    assert valid_fulfillment_transitions({"type": "Failed", "reason": "x", "recoverable": False}) == []


# --- guard_action: invalid transition → alternatives --------------------------

def test_invalid_transition_returns_legal_alternatives():
    order = fulfilled_order()
    world = World([order], [], [])
    verdict = guard_action(world, ProposedAction(commitment=str(order.id), to={"type": "Accepted"}, actor=seller))
    assert verdict.ok is False
    assert verdict.violations[0].rule == "I-2"
    assert [a.to for a in verdict.alternatives] == valid_transitions({"type": "Fulfilled"}) == ["Disputed", "Refunded"]
    assert all(a.label for a in verdict.alternatives)
    assert all(a.bounded is None for a in verdict.alternatives)
    assert "Disputed" in verdict.violations[0].fix


def test_agent_can_pick_an_alternative_and_retry_succeeds():
    order = fulfilled_order()
    world = World([order], [], [])
    rejected = guard_action(world, ProposedAction(commitment=str(order.id), to={"type": "Accepted"}, actor=seller))
    assert rejected.ok is False
    target = {"type": "Disputed", "by": seller, "reason": "x", "opened_at": "2026-03-01T00:00:00.000Z"}
    retry = guard_action(world, ProposedAction(commitment=str(order.id), to=target, actor=seller))
    assert retry.ok is True


# --- guard_action: over-refund → Refunded bounded, Disputed clean -------------

def test_over_refund_frames_refunded_as_bounded():
    order = fulfilled_order(200)
    world = World([order], [], [])
    verdict = guard_action(world, ProposedAction(commitment=str(order.id), to={"type": "Refunded", "amount": {"amount": 500, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor=seller))
    assert verdict.ok is False
    assert any(v.rule == "I-1" for v in verdict.violations)
    refund_alt = next(a for a in verdict.alternatives if a.to == "Refunded")
    dispute_alt = next(a for a in verdict.alternatives if a.to == "Disputed")
    assert refund_alt.bounded is not None
    assert dispute_alt.bounded is None


def test_terminal_state_action_returns_no_alternatives():
    refunded = apply_commitment_path(new_commitment(buyer, seller), {"type": "Refunded", "amount": {"amount": 0, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, seller)
    world = World([refunded], [], [])
    verdict = guard_action(world, ProposedAction(commitment=str(refunded.id), to={"type": "Disputed", "by": seller, "reason": "x", "opened_at": "2026-03-01T00:00:00.000Z"}, actor=seller))
    assert verdict.ok is False
    assert verdict.violations[0].rule == "I-2"
    assert verdict.alternatives == []


# --- guard_object: thin audit wrapper, no coercion ----------------------------

def test_guard_object_rejects_mixed_currency_world():
    dirty = new_commitment(buyer, seller, {"offered": [], "requested": [money_value(200, "MAD"), money_value(30, "EUR")]})
    verdict = guard_object([dirty], [], [])
    assert verdict.ok is False
    assert any(v.rule == "I-1" for v in verdict.violations)


def test_unknown_commitment_is_rejected_not_raised():
    world = World([new_commitment(buyer, seller)], [], [])
    verdict = guard_action(world, ProposedAction(commitment="does_not_exist", to={"type": "Proposed"}, actor=buyer))
    assert verdict.ok is False
    assert verdict.violations[0].rule == "unknown-commitment"
