"""Multi-object coherence (per-tree cumulative). Python mirror of
tests/multi-object.test.ts."""
from warp_commerce_types import (
    ProposedAction,
    World,
    apply_commitment_path,
    check_i6_tree_consistency,
    commitment_version,
    create_session,
    new_commitment,
    party_id,
)

buyer = party_id("buyer")
seller = party_id("seller")


def money_value(amount):
    return {"id": "value:%s" % amount, "form": {"kind": "Money", "money": {"amount": amount, "currency": "MAD"}}, "quantity": 1, "state": {"type": "Available"}}


def commit(cid, amount, **links):
    """A Fulfilled commitment with id/amount and optional parent/children links."""
    base = new_commitment(buyer, seller, {"offered": [], "requested": [money_value(amount)]}).model_copy(
        update={"id": cid, **links}
    )
    return apply_commitment_path(base, {"type": "Fulfilled"}, seller)


def tree(parent_id="order-1"):
    """A parent (200) with two 100-children that reconcile via I-6."""
    a = "%s-A" % parent_id
    b = "%s-B" % parent_id
    return [
        commit(parent_id, 200, children=[a, b]),
        commit(a, 100, parent=parent_id),
        commit(b, 100, parent=parent_id),
    ]


def refund(commitment, amount, key):
    return ProposedAction(commitment=commitment, to={"type": "Refunded", "amount": {"amount": amount, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor=seller, idempotency_key=key)


def test_catches_cumulative_over_refund_spread_across_tree():
    parent, a, b = tree()
    assert len(check_i6_tree_consistency(parent, [a, b])) == 0  # I-6 reconciles
    session = create_session(World([parent, a, b], [], []))

    assert session.propose(refund("order-1-A", 80, "a")).ok is True  # child <= 100
    assert session.propose(refund("order-1-B", 80, "b")).ok is True  # child <= 100
    over = session.propose(refund("order-1", 80, "p"))  # parent <= 200, but tree → 240
    assert over.ok is False
    assert over.violations[0].rule == "I-1"
    assert "tree" in over.violations[0].message
    assert "240" in over.violations[0].message
    assert "200" in over.violations[0].message
    alt = next((x for x in over.alternatives if x.to == "Refunded"), None)
    assert "40" in alt.bounded  # remaining across the tree


def test_each_child_individually_valid_yet_tree_caps_the_sum():
    parent, a, b = tree()
    session = create_session(World([parent, a, b], [], []))
    assert session.propose(refund("order-1-A", 100, "a")).ok is True
    assert session.propose(refund("order-1-B", 100, "b")).ok is True
    # …tree now fully refunded; any further refund anywhere in it is capped.
    more = session.propose(refund("order-1", 1, "p"))
    assert more.ok is False


def test_child_over_refund_still_caught_per_commitment():
    parent, a, b = tree()
    session = create_session(World([parent, a, b], [], []))
    # child-A committed 100; refunding 150 against it exceeds the CHILD itself.
    over = session.propose(refund("order-1-A", 150, "a"))
    assert over.ok is False
    assert over.violations[0].rule == "I-1"


def test_single_commitment_no_tree_unchanged():
    standalone = commit("solo", 200)  # no parent, no children
    session = create_session(World([standalone], [], []))
    assert session.propose(refund("solo", 120, "a")).ok is True
    over = session.propose(refund("solo", 100, "b"))  # 220 > 200 — per-commitment
    assert over.ok is False
    assert over.violations[0].rule == "I-1"
    # standalone message is the per-commitment form (not the tree form).
    assert "tree" not in over.violations[0].message


def test_valid_tree_of_refunds_within_parent_completes():
    parent, a, b = tree()
    session = create_session(World([parent, a, b], [], []))
    assert session.propose(refund("order-1-A", 100, "a")).ok is True
    assert session.propose(refund("order-1-B", 100, "b")).ok is True


def test_f4_replay_across_tree_dedups():
    parent, a, b = tree()
    session = create_session(World([parent, a, b], [], []))
    assert session.propose(refund("order-1-A", 80, "k")).ok is True
    replay = session.propose(refund("order-1-A", 80, "k"))  # same key
    assert replay.ok is True
    assert replay.replay is True
    # tree not double-counted: a further 120 against child-B exceeds the CHILD (100)…
    assert session.propose(refund("order-1-B", 120, "b")).ok is False
    # …but 100 fits (80 + 100 = 180 <= 200 tree).
    assert session.propose(refund("order-1-B", 100, "b2")).ok is True


def test_f3_conflict_on_child_still_works():
    accepted_child = apply_commitment_path(
        new_commitment(buyer, seller, {"offered": [], "requested": [money_value(100)]}).model_copy(update={"id": "c-1", "parent": "p-1"}),
        {"type": "Accepted"}, seller,
    )
    parent = commit("p-1", 200, children=["c-1", "c-2"])
    sibling = commit("c-2", 100, parent="p-1")
    session = create_session(World([parent, accepted_child, sibling], [], []))
    planned = commitment_version(next(c for c in session.world.commitments if str(c.id) == "c-1"))
    # advance the child…
    assert session.propose(ProposedAction(commitment="c-1", to={"type": "Active"}, actor=seller, expected_version=planned, idempotency_key="x")).ok is True
    # …a stale-version action on the same child conflicts.
    stale = session.propose(ProposedAction(commitment="c-1", to={"type": "Disputed", "by": buyer, "reason": "x", "opened_at": "2026-03-01T00:00:00.000Z"}, actor=buyer, expected_version=planned, idempotency_key="y"))
    assert stale.ok is False
    assert stale.conflict is True
