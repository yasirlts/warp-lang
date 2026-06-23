"""Saga / compensation: model the UNWINDING of a multi-step flow as an explicit,
validated sequence of compensating actions, and check the compensation is coherent (a
reversal that would over-refund is rejected with guidance). Python twin of
examples/saga.mjs.

    python saga.py

Scope (honest): Warp VALIDATES the compensation sequence — each compensating action is a
legal reversing transition and the net effect conserves value. Warp does NOT execute or
orchestrate rollbacks on external systems; the plan is a sequence of validated
descriptors. Composes valid_transitions + create_session; it does not fork invariant or
transition logic.
"""
from warp_commerce_types import (
    ForwardStep,
    ProposedAction,
    World,
    apply_commitment_path,
    compensate,
    compensate_session,
    create_session,
    new_commitment,
    party_id,
)

buyer = party_id("buyer")
seller = party_id("seller")
AT = "2026-03-01T00:00:00.000Z"


def money(amount):
    return {"id": "value:%s" % amount, "form": {"kind": "Money", "money": {"amount": amount, "currency": "MAD"}}, "quantity": 1, "state": {"type": "Available"}}


def mk(cid, amount, to):
    base = new_commitment(buyer, seller, {"offered": [], "requested": [money(amount)]}).model_copy(update={"id": cid})
    return apply_commitment_path(base, to, seller)


# ── The multi-step forward flow: accept → fulfill → partial refund 50 of 200 ──────
order = mk("order-1", 200, {"type": "Fulfilled"})
session = create_session(World([order], [], []))
partial = session.propose(ProposedAction(commitment="order-1", to={"type": "Refunded", "amount": {"amount": 50, "currency": "MAD"}, "at": AT}, actor=seller, idempotency_key="partial-50"))
sofar = session.refunded_so_far("order-1")
print("forward flow: accept → fulfill → partial refund 50 → applied: %s. refunded so far: %s MAD of 200" % (
    partial.ok, int(sofar.amount) if sofar else 0))

# ── INVALID compensation: refund the FULL 200 again. The 50 already refunded is counted
# (50 + 200 = 250 > 200) — value would not be conserved. Rejected with guidance. ──────
over_refund = [ForwardStep(commitment="order-1", to={"type": "Fulfilled"}, actor=seller,
                           compensate_with={"type": "Refunded", "amount": {"amount": 200, "currency": "MAD"}, "at": AT})]
_, bad = compensate_session(session, over_refund, AT)
if not bad.ok:
    print("\nINVALID compensation (refund full 200 while 50 already refunded) → BLOCKED at step %s [%s]" % (
        bad.failed_at, bad.violations[0].rule))
    print("  %s" % bad.violations[0].message)
    alt = next((a for a in bad.alternatives if a.to == "Refunded"), None)
    if alt and alt.bounded:
        print("  guidance: %s" % alt.bounded)

# ── VALID compensation: refund the REMAINING 150 (50 + 150 = 200 == committed). ───────
remaining = [ForwardStep(commitment="order-1", to={"type": "Fulfilled"}, actor=seller,
                         compensate_with={"type": "Refunded", "amount": {"amount": 150, "currency": "MAD"}, "at": AT})]
_, valid = compensate_session(session, remaining, AT)
print("\nVALID compensation (refund the remaining 150) → applied: %s" % valid.ok)
if valid.ok:
    final_state = next(c for c in valid.next.commitments if str(c.id) == "order-1").state.type
    total = session.refunded_so_far("order-1")
    print("  compensating actions applied: %s, skipped: %s" % (valid.applied, valid.skipped))
    print("  refunded total: %s MAD; order-1 final state: %s (50 + 150 = 200 == committed; value conserved)" % (
        int(total.amount) if total else 0, final_state))

# ── Default mapping over the whole flow (no overrides): a fresh accept→active flow
# unwound by Cancellation, showing the non-refund compensation path. ─────────────────
lease = mk("lease-1", 100, {"type": "Active"})
lease_plan, lease_result = compensate(World([lease], [], []), [ForwardStep(commitment="lease-1", to={"type": "Active"}, actor=seller)], AT)
print("\ndefault mapping: Active commitment unwound by Cancellation → applied: %s (plan reverses %s step)" % (
    lease_result.ok, len([s for s in lease_plan.steps if s.action is not None])))
if lease_result.ok:
    state = next(c for c in lease_result.next.commitments if str(c.id) == "lease-1").state.type
    print("  lease-1 final state: %s (committed-but-not-delivered → Cancelled)" % state)
