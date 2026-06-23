"""Multi-object coherence: the session's cumulative checking spans a TREE of related
commitments — a parent order and its child line-item commitments. Refunds spread across
DIFFERENT children (each individually valid, each child reconciling to the parent via
I-6) cannot cumulatively exceed the PARENT's committed amount. Python twin of
examples/multi-object.mjs.

    python multi_object.py

The unit is a parent + its children tree. This composes the existing
check_i6_tree_consistency (structure) + the I-1 cumulative rule (lifted to the parent).
"""
from warp_commerce_types import (
    ProposedAction,
    World,
    apply_commitment_path,
    check_i6_tree_consistency,
    new_commitment,
    party_id,
)

buyer = party_id("buyer")
seller = party_id("seller")


def money(amount):
    return {"id": "value:%s" % amount, "form": {"kind": "Money", "money": {"amount": amount, "currency": "MAD"}}, "quantity": 1, "state": {"type": "Available"}}


def mk(cid, amount, **links):
    """A Fulfilled commitment with id/amount and optional parent/children links."""
    base = new_commitment(buyer, seller, {"offered": [], "requested": [money(amount)]}).model_copy(
        update={"id": cid, **links}
    )
    return apply_commitment_path(base, {"type": "Fulfilled"}, seller)


# A 200 MAD parent order with two line-item children (100 + 100 = 200), all shipped.
parent = mk("order-1", 200, children=["line-A", "line-B"])
line_a = mk("line-A", 100, parent="order-1")
line_b = mk("line-B", 100, parent="order-1")

print("I-6 static reconciliation (children 100+100 == parent 200):",
      len(check_i6_tree_consistency(parent, [line_a, line_b])) == 0)

from warp_commerce_types import create_session

session = create_session(World([parent, line_a, line_b], [], []))


def refund(commitment, amount, key):
    return ProposedAction(commitment=commitment, to={"type": "Refunded", "amount": {"amount": amount, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor="agent", idempotency_key=key)


def tree_total():
    return sum((session.refunded_so_far(i).amount if session.refunded_so_far(i) else 0) for i in ("order-1", "line-A", "line-B"))


# Two line-item refunds, each <= its own child's committed (100). Individually valid.
print("\nrefund line-A 80 → %s (tree refunded: %s MAD)" % (
    "accepted" if session.propose(refund("line-A", 80, "a")).ok else "rejected", int(tree_total())))
print("refund line-B 80 → %s (tree refunded: %s MAD)" % (
    "accepted" if session.propose(refund("line-B", 80, "b")).ok else "rejected", int(tree_total())))

# A third refund — on the PARENT, 80 <= 200 on its own — but the TREE total would reach
# 240 > 200. Caught at this step, with the remaining-refundable across the tree.
over = session.propose(refund("order-1", 80, "p"))
if not over.ok:
    print("\nrefund order-1 80 → BLOCKED [%s]" % over.violations[0].rule)
    print("  %s" % over.violations[0].message)
    print("  guidance: %s" % over.alternatives[0].bounded)

# Corrected to the remaining 40 across the tree → completes.
fixed = session.propose(refund("order-1", 40, "p2"))
print("\ncorrected refund order-1 40 → %s. tree refunded: %s MAD (== parent committed 200)" % (
    "accepted" if fixed.ok else "rejected", int(tree_total())))

# A fully-valid tree: refund each child within the parent (100 + 100 = 200).
p2 = mk("order-2", 200, children=["line-C", "line-D"])
lc = mk("line-C", 100, parent="order-2")
ld = mk("line-D", 100, parent="order-2")
s2 = create_session(World([p2, lc, ld], [], []))
c = s2.propose(refund("line-C", 100, "c"))
d = s2.propose(refund("line-D", 100, "d"))
print("\nvalid tree: refund line-C 100 → %s, line-D 100 → %s (tree total 200 == parent 200, within the parent)" % (c.ok, d.ok))
