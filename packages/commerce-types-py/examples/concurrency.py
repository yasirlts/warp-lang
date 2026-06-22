"""Optimistic-concurrency: two actors on the same commitment; one planned against a
stale version is rejected as a CONFLICT so it re-reads and re-plans. Python twin of
examples/concurrency.mjs — same outcomes.

    python concurrency.py

Scope: OPTIMISTIC concurrency over the caller's world view. NOT a lock, distributed
consensus, or a transaction manager.
"""
from warp_commerce_types import apply_commitment_path, commitment_version, create_session, new_commitment, party_id, ProposedAction, World

buyer = party_id("buyer_1")
seller = party_id("seller_1")

order = apply_commitment_path(new_commitment(buyer, seller), {"type": "Accepted"}, seller)
cid = str(order.id)
session = create_session(World([order], [], []))

planned = commitment_version(session.world.commitments[0])
print("both actors planned against version: %s" % planned)

a = session.propose(ProposedAction(commitment=cid, to={"type": "Active"}, actor=seller, expected_version=planned, idempotency_key="A-activate"))
print("\nActor A: activate (planned %s) -> ok: %s. commitment is now version %s" % (planned, a.ok, commitment_version(session.world.commitments[0])))


def dispute(key):
    return ProposedAction(commitment=cid, to={"type": "Disputed", "by": buyer, "reason": "item issue", "opened_at": "2026-03-01T00:00:00.000Z"}, actor=buyer, idempotency_key=key)


b = session.propose(ProposedAction(commitment=cid, to={"type": "Disputed", "by": buyer, "reason": "item issue", "opened_at": "2026-03-01T00:00:00.000Z"}, actor=buyer, expected_version=planned, idempotency_key="B-dispute"))
if not b.ok and b.conflict:
    print("\nActor B: dispute (planned %s) -> CONFLICT" % planned)
    print("  expected %s, but actual is %s" % (b.expected, b.actual))
    print("  %s" % b.violations[0].fix)

current = commitment_version(session.world.commitments[0])
b2 = session.propose(ProposedAction(commitment=cid, to={"type": "Disputed", "by": buyer, "reason": "item issue", "opened_at": "2026-03-01T00:00:00.000Z"}, actor=buyer, expected_version=current, idempotency_key="B-dispute-2"))
print("\nActor B re-reads (version %s) and re-plans -> ok: %s. commitment is now %s" % (current, b2.ok, session.world.commitments[0].state.type))

order2 = apply_commitment_path(new_commitment(buyer, seller), {"type": "Accepted"}, seller)
session2 = create_session(World([order2], [], []))
no_version = session2.propose(ProposedAction(commitment=str(order2.id), to={"type": "Active"}, actor=seller))
print("\nno expectedVersion supplied -> applied unconditionally (backward-compatible): %s" % no_version.ok)

replay = session.propose(ProposedAction(commitment=cid, to={"type": "Active"}, actor=seller, expected_version=planned, idempotency_key="A-activate"))
print("replay of Actor A (same key, stale version) -> replay: %s, conflict: %s (a retry is a replay, not a conflict)" % (replay.replay, replay.conflict))
