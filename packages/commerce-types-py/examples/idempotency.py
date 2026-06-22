"""Idempotency & replay-safety: the SAME action applied twice does not double-apply.
Python twin of examples/idempotency.mjs — same outcomes.

    python idempotency.py

Scope: per-session, in-memory. Durable cross-session idempotency is not provided.
"""
from warp_commerce_types import apply_commitment_path, create_session, new_commitment, party_id, ProposedAction, World

buyer = party_id("buyer_1")
seller = party_id("seller_1")

order = apply_commitment_path(
    new_commitment(buyer, seller, {"offered": [], "requested": [
        {"id": "v", "form": {"kind": "Money", "money": {"amount": 200, "currency": "MAD"}}, "quantity": 1, "state": {"type": "Available"}}
    ]}),
    {"type": "Fulfilled"}, seller,
)
cid = str(order.id)
session = create_session(World([order], [], []))


def refund(amount, key=None):
    return ProposedAction(commitment=cid, to={"type": "Refunded", "amount": {"amount": amount, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor="support_agent", idempotency_key=key)


def sofar():
    m = session.refunded_so_far(cid)
    return int(m.amount) if m else 0


first = session.propose(refund(50, "refund-key-1"))
print("refund 50 (key refund-key-1) -> ok: %s, replay: %s. refunded so far: %s MAD" % (first.ok, first.replay, sofar()))

retry = session.propose(refund(50, "refund-key-1"))
print("retry 50 (key refund-key-1) -> ok: %s, replay: %s. refunded so far (unchanged): %s MAD" % (retry.ok, retry.replay, sofar()))

second = session.propose(refund(30, "refund-key-2"))
print("refund 30 (key refund-key-2) -> ok: %s, replay: %s. refunded so far: %s MAD" % (second.ok, second.replay, sofar()))

keyless = session.propose(refund(20))
keyless_retry = session.propose(refund(20))
print("keyless refund 20 -> ok: %s, replay: %s" % (keyless.ok, keyless.replay))
print("identical keyless retry -> ok: %s, replay: %s. total refunded: %s MAD" % (keyless_retry.ok, keyless_retry.replay, sofar()))
