"""Mirrors the TS transitions.test.ts: the exhaustive commitment table (26
edges), backward-transition rejection, immutable append-only history, Invariant 4
timestamp monotonicity, and the intent / fulfillment machines."""
from warp_commerce_types import (
    CommitmentTransition,
    is_valid_commitment_transition,
    is_valid_fulfillment_transition,
    is_valid_intent_transition,
    new_commitment,
    new_fulfillment,
    new_intent,
    transition_commitment,
    transition_fulfillment,
    transition_intent,
)

p1, buyer, seller = "p1", "buyer", "seller"

tendered = {"type": "Tendered", "offer_amount": 100, "offer_currency": "MAD", "closes_at": "2099-01-01T00:00:00.000Z"}
modified = {"type": "Modified", "modified_by": p1, "reason": "x"}
partially = {"type": "PartiallyFulfilled", "fulfilled_item_ids": ["i1"], "remaining_item_ids": ["i2"]}
cancelled = {"type": "Cancelled", "by": p1, "reason": "x", "at": "2099-01-01T00:00:00.000Z"}
disputed = {"type": "Disputed", "by": p1, "reason": "x", "opened_at": "2099-01-01T00:00:00.000Z"}
refunded = {"type": "Refunded", "amount": {"amount": 100, "currency": "MAD"}, "at": "2099-01-01T00:00:00.000Z"}

VALID = [
    ({"type": "Draft"}, {"type": "Proposed"}),
    ({"type": "Draft"}, tendered),
    ({"type": "Draft"}, cancelled),
    ({"type": "Proposed"}, {"type": "Accepted"}),
    ({"type": "Proposed"}, cancelled),
    ({"type": "Proposed"}, modified),
    (tendered, {"type": "Accepted"}),
    (tendered, cancelled),
    ({"type": "Accepted"}, modified),
    ({"type": "Accepted"}, partially),
    ({"type": "Accepted"}, {"type": "Active"}),
    ({"type": "Accepted"}, cancelled),
    ({"type": "Accepted"}, disputed),
    (modified, {"type": "Accepted"}),
    (modified, cancelled),
    (partially, {"type": "Fulfilled"}),
    (partially, modified),
    (partially, cancelled),
    ({"type": "Active"}, modified),
    ({"type": "Active"}, cancelled),
    ({"type": "Active"}, disputed),
    ({"type": "Fulfilled"}, disputed),
    ({"type": "Fulfilled"}, refunded),
    (disputed, {"type": "Fulfilled"}),
    (disputed, refunded),
    (disputed, cancelled),
]


def test_exactly_26_valid_transitions_all_accepted():
    assert len(VALID) == 26
    for frm, to in VALID:
        assert is_valid_commitment_transition(frm, to) is True


def test_draft_to_fulfilled_invalid():
    assert is_valid_commitment_transition({"type": "Draft"}, {"type": "Fulfilled"}) is False


def test_fulfilled_to_accepted_invalid():
    assert is_valid_commitment_transition({"type": "Fulfilled"}, {"type": "Accepted"}) is False


def test_cancelled_terminal():
    assert is_valid_commitment_transition(cancelled, {"type": "Accepted"}) is False
    assert is_valid_commitment_transition(cancelled, {"type": "Fulfilled"}) is False


def test_modified_to_accepted_valid():
    assert is_valid_commitment_transition(modified, {"type": "Accepted"}) is True


def test_tendered_to_accepted_valid():
    assert is_valid_commitment_transition(tendered, {"type": "Accepted"}) is True


def test_rejects_all_backward_transitions():
    backward = [
        ({"type": "Fulfilled"}, {"type": "Accepted"}),
        ({"type": "Accepted"}, {"type": "Draft"}),
        ({"type": "Accepted"}, {"type": "Proposed"}),
        ({"type": "Active"}, {"type": "Fulfilled"}),
        (refunded, {"type": "Accepted"}),
    ]
    for frm, to in backward:
        assert is_valid_commitment_transition(frm, to) is False


def test_transition_commitment_advances_and_records_history():
    c0 = new_commitment(buyer, seller)
    r1 = transition_commitment(c0, {"type": "Proposed"}, buyer)
    assert r1.ok
    r2 = transition_commitment(r1.value, {"type": "Accepted"}, seller)
    assert r2.ok
    assert r2.value.state.type == "Accepted"
    assert len(r2.value.history) == 2


def test_rejects_invalid_transition_with_clear_error():
    c0 = new_commitment(buyer, seller)
    r = transition_commitment(c0, {"type": "Fulfilled"}, buyer)
    assert r.ok is False
    assert "Invariant 2" in r.error


def test_immutable_append_only_input_never_mutated():
    c0 = new_commitment(buyer, seller)
    r = transition_commitment(c0, {"type": "Proposed"}, buyer)
    assert r.ok
    assert len(c0.history) == 0
    assert len(r.value.history) == 1


def test_rejects_backdated_transition_invariant_4():
    c0 = new_commitment(buyer, seller)
    c0.history.append(
        CommitmentTransition.model_validate(
            {"from": {"type": "Draft"}, "to": {"type": "Draft"}, "at": "2999-01-01T00:00:00.000Z", "actor": buyer}
        )
    )
    r = transition_commitment(c0, {"type": "Proposed"}, buyer)
    assert r.ok is False
    assert "Invariant 4" in r.error


def test_intent_transitions():
    assert is_valid_intent_transition({"type": "Active"}, {"type": "Abandoned"}) is True
    assert is_valid_intent_transition({"type": "Abandoned"}, {"type": "Active"}) is False
    i = new_intent(buyer)
    r = transition_intent(i, {"type": "Abandoned"}, buyer, "timeout")
    assert r.ok
    assert r.value.state.type == "Abandoned"
    assert r.value.history[0].reason == "timeout"


def test_fulfillment_transitions():
    assert is_valid_fulfillment_transition({"type": "Planned"}, {"type": "InProgress"}) is True
    assert is_valid_fulfillment_transition({"type": "Planned"}, {"type": "Completed"}) is False
    assert is_valid_fulfillment_transition({"type": "Failed", "reason": "x", "recoverable": True}, {"type": "Planned"}) is True
    assert is_valid_fulfillment_transition({"type": "Failed", "reason": "x", "recoverable": False}, {"type": "Planned"}) is False
    f = new_fulfillment(new_commitment(buyer, seller).id)
    r1 = transition_fulfillment(f, {"type": "InProgress"}, buyer)
    assert r1.ok and r1.value.started_at is not None
    r2 = transition_fulfillment(r1.value, {"type": "Completed"}, buyer)
    assert r2.value.completed_at is not None
