"""Mirrors the TS invariants.test.ts: I-1..I-6 checkers and audit_commerce."""
from warp_commerce_types import (
    Commitment,
    CommitmentTransition,
    audit_commerce,
    check_i1_value_conservation,
    check_i2_state_monotonicity,
    check_i3_capacity_verification,
    check_i4_temporal_integrity,
    check_i5_identity_permanence,
    check_i6_tree_consistency,
    new_commitment,
    new_fulfillment,
    unverified_capacity,
    value_id,
)

buyer, seller = "buyer", "seller"


def revalidate(model, **updates):
    """Apply field updates THROUGH validation (model_copy does not re-validate, so
    a dict assigned to a discriminated-union field would stay a dict)."""
    data = model.model_dump(by_alias=True)
    data.update(updates)
    return type(model).model_validate(data)


def money_value(amount, currency):
    return {
        "id": value_id(),
        "form": {"kind": "Money", "money": {"amount": amount, "currency": currency}},
        "quantity": 1,
        "state": {"type": "Available"},
    }


def commitment_v(requested):
    return revalidate(new_commitment(buyer, seller), subject={"offered": [], "requested": requested})


def test_i1_flags_mixed_currencies():
    c = commitment_v([money_value(100, "MAD"), money_value(50, "EUR")])
    assert len(check_i1_value_conservation([c])) == 1


def test_i1_passes_single_currency():
    c = commitment_v([money_value(100, "MAD"), money_value(50, "MAD")])
    assert check_i1_value_conservation([c]) == []


def test_i2_flags_invalid_transition_in_history():
    c = commitment_v([money_value(100, "MAD")])
    c.history.append(
        CommitmentTransition.model_validate(
            {"from": {"type": "Fulfilled"}, "to": {"type": "Accepted"}, "at": "2026-01-01T00:00:00.000Z", "actor": buyer}
        )
    )
    assert len(check_i2_state_monotonicity(c)) == 1


def test_i2_passes_valid_history():
    c = commitment_v([money_value(100, "MAD")])
    c.history.append(
        CommitmentTransition.model_validate(
            {"from": {"type": "Draft"}, "to": {"type": "Proposed"}, "at": "2026-01-01T00:00:00.000Z", "actor": buyer}
        )
    )
    assert check_i2_state_monotonicity(c) == []


def _accepted() -> Commitment:
    return revalidate(commitment_v([money_value(100, "MAD")]), state={"type": "Accepted"})


def test_i3_flags_accepted_without_buy_capacity():
    cap = revalidate(unverified_capacity(), can_buy=False)
    assert len(check_i3_capacity_verification(_accepted(), cap)) == 1


def test_i3_passes_when_capacity_verified():
    cap = revalidate(unverified_capacity(), can_buy=True)
    assert check_i3_capacity_verification(_accepted(), cap) == []


def test_i4_flags_fulfillment_before_accepted():
    c = commitment_v([money_value(100, "MAD")])
    c.history.append(
        CommitmentTransition.model_validate(
            {"from": {"type": "Proposed"}, "to": {"type": "Accepted"}, "at": "2026-06-10T12:00:00.000Z", "actor": seller}
        )
    )
    f = revalidate(new_fulfillment(c.id), state={"type": "InProgress"}, started_at="2026-06-10T09:00:00.000Z")
    assert len(check_i4_temporal_integrity(c, [f])) == 1


def test_i4_passes_when_fulfillment_follows_acceptance():
    c = commitment_v([money_value(100, "MAD")])
    c.history.append(
        CommitmentTransition.model_validate(
            {"from": {"type": "Proposed"}, "to": {"type": "Accepted"}, "at": "2026-06-10T09:00:00.000Z", "actor": seller}
        )
    )
    f = revalidate(new_fulfillment(c.id), state={"type": "InProgress"}, started_at="2026-06-10T12:00:00.000Z")
    assert check_i4_temporal_integrity(c, [f]) == []


def test_i5_flags_duplicate_id():
    assert len(check_i5_identity_permanence(["a", "a", "b"])) == 1


def test_i5_passes_unique_ids():
    assert check_i5_identity_permanence(["a", "b", "c"]) == []


def test_i6_flags_children_exceeding_parent():
    parent = commitment_v([money_value(500, "MAD")])
    kids = [commitment_v([money_value(300, "MAD")]), commitment_v([money_value(300, "MAD")])]
    assert len(check_i6_tree_consistency(parent, kids)) == 1


def test_i6_passes_when_children_sum_to_parent():
    parent = commitment_v([money_value(500, "MAD")])
    kids = [commitment_v([money_value(250, "MAD")]), commitment_v([money_value(250, "MAD")])]
    assert check_i6_tree_consistency(parent, kids) == []


def test_audit_aggregates_violations():
    c = commitment_v([money_value(100, "MAD"), money_value(5, "EUR")])  # I-1 mix
    violations = audit_commerce([c], [], [])
    assert any(v.invariant == "I-1" for v in violations)


def test_audit_returns_empty_for_clean_set():
    c = commitment_v([money_value(100, "MAD")])
    assert audit_commerce([c], [], []) == []
