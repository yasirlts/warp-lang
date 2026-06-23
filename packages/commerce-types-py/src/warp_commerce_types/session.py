"""Session-level coherence — validate a SEQUENCE of agent actions against the
accumulated history, catching violations that only emerge across steps.

A Python port of the TypeScript ``session.ts``, behaviour-identical. The headline
cross-step property is a CUMULATIVE over-refund: three partial refunds of 80
against a 200 order each individually pass (80 <= 200) but sum to 240 > 200. The
point-in-time I-1 check looks at a commitment's current Refunded state, so a naive
``guard_action``-in-a-loop catches none of these. A session accumulates and checks
the pattern.

This is a COMPOSITION over the proven primitives — it does not fork invariant logic:
  - :func:`guard_action` for per-action validation and planning-oracle alternatives;
  - :func:`check_i1_value_conservation` for the cumulative amount check — the session
    probes the SAME canonical I-1 function with the running refund total, so the
    cumulative rule is the point-in-time rule applied to a sum.

A NOTE ON PARTIAL REFUNDS: the schema models a refund as a single terminal
``Refunded`` state carrying one amount — there is no partial-refund state. So the
session tracks partial refunds in its own ledger (a binding-layer accumulation, not
a schema change) and keeps the order in ``Fulfilled`` until it is fully refunded,
at which point it transitions to ``Refunded``.

MULTI-OBJECT COHERENCE (F6): the per-commitment ledger above caps each commitment
against its OWN committed amount. A second, per-TREE ledger (keyed by the tree ROOT
id) caps the SUM of refunds across a parent and its children against the PARENT's
committed amount — so refunds spread over different children (each individually
valid, each child reconciling to the parent via I-6) cannot cumulatively exceed the
parent. This is ADDITIVE to the per-commitment cap and composes the existing
:func:`check_i6_tree_consistency` (structure) + the same I-1 cumulative probe lifted
to the parent. Standalone commitments are never tree members, so single-commitment
behaviour is unchanged.

Scope: TypeScript and Python. Rust / Go ports are roadmap.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from ._models import Commitment, CommitmentStateRefunded, Money
from .guard import (
    GuardResult,
    GuardViolation,
    ProposedAction,
    TransitionAlternative,
    World,
    check_version,
    guard_action,
)
from .invariants import check_i1_value_conservation, check_i6_tree_consistency
from .money import add, money_equals
from .transitions import _type_of, is_valid_commitment_transition


def _fmt(x: float) -> str:
    """Print whole amounts without a trailing .0 (200, not 200.0)."""
    return str(int(x)) if float(x).is_integer() else str(x)


def _action_key(action: ProposedAction) -> str:
    """The identity of an action for replay detection. An explicit
    ``idempotency_key`` is used when supplied; otherwise a fingerprint is derived
    from commitment + target type + amount (for a Refunded) + actor. Distinct
    operations therefore need distinct keys to be applied separately."""
    if action.idempotency_key is not None:
        return "key:%s" % action.idempotency_key
    parts = [action.commitment, _type_of(action.to), str(action.actor)]
    if _type_of(action.to) == "Refunded":
        amt = action.to["amount"] if isinstance(action.to, dict) else action.to.amount
        a = amt["amount"] if isinstance(amt, dict) else amt.amount
        cur = amt["currency"] if isinstance(amt, dict) else amt.currency
        parts.extend([str(a), cur])
    return "fp:%s" % "|".join(parts)


def _committed_total(c: Commitment) -> Optional[Money]:
    """Sum the Money in a commitment's ``requested`` subject (single currency)."""
    monies = [v.form.money for v in c.subject.requested if v.form.kind == "Money"]
    if not monies:
        return None
    currency = monies[0].currency
    if any(m.currency != currency for m in monies):
        return None  # mixed: a point-in-time I-1 concern, not ours
    total = monies[0]
    for m in monies[1:]:
        total = add(total, m)
    return total


def _is_cumulative_over_refund(order: Commitment, total: float, currency: str) -> bool:
    """Derived from canonical I-1: probe :func:`check_i1_value_conservation` with a
    commitment in ``Refunded(total)`` state — the point-in-time rule applied to the
    sum, not a second copy of it."""
    probe = order.model_copy(
        update={
            "state": CommitmentStateRefunded(amount=Money(amount=total, currency=currency), at=order.created_at),
            "history": [],
        }
    )
    return any(
        v.invariant == "I-1" and "cannot exceed what was captured" in v.description
        for v in check_i1_value_conservation([probe])
    )


def _tree_root_of(world: World, commitment: Commitment) -> Commitment:
    """The root of ``commitment``'s tree in ``world`` — walk ``parent`` pointers up
    while the parent is present in the world. A commitment with no parent (or whose
    parent is not in the world) is its own root. The append-only ``parent`` /
    ``children`` fields already exist on the model, so this is a pure structural
    read — no schema change."""
    by_id = {str(c.id): c for c in world.commitments}
    current = commitment
    seen: set = set()
    while current.parent is not None:
        parent = by_id.get(str(current.parent))
        if parent is None or str(current.id) in seen:
            break
        seen.add(str(current.id))
        current = parent
    return current


def _is_in_tree(commitment: Commitment, root: Commitment) -> bool:
    """A commitment is "in a tree" if it has a parent (is a child) or has children."""
    return str(root.id) != str(commitment.id) or len(commitment.children) > 0


class Session:
    """A stateful sequence validator over an accumulating world."""

    def __init__(self, initial_world: World) -> None:
        self._world = initial_world
        self._ledger: Dict[str, Dict[str, Any]] = {}  # commitment_id -> {total: Money, count: int}
        # Per-TREE cumulative refund ledger, keyed by the tree ROOT id (F6). The
        # per-commitment ``_ledger`` above caps each commitment against its own
        # committed amount; this caps the SUM of refunds across a parent + its children
        # against the parent's committed amount. Standalone commitments are never tree
        # members, so single-commitment behaviour is byte-for-byte unchanged.
        self._tree_ledger: Dict[str, Dict[str, Any]] = {}  # root_id -> {total: Money, count: int}
        # Idempotency: keys of actions ALREADY APPLIED in this session. Per-session,
        # in-memory — durable cross-session idempotency is not provided (see docs).
        self._applied: set = set()

    @property
    def world(self) -> World:
        """The current accumulated world (updated only on accepted actions)."""
        return self._world

    def refunded_so_far(self, commitment_id: str) -> Optional[Money]:
        """The amount refunded so far for a commitment across this session, or None."""
        tally = self._ledger.get(commitment_id)
        return tally["total"] if tally else None

    def propose(self, action: ProposedAction) -> GuardResult:
        """Validate ``action`` against the accumulated world (and the cross-step
        refund ledger), apply it on success, and return the same verdict as
        :func:`guard_action`. On rejection the world is not advanced.

        Ordering: replay check → conflict check → process. A same-key retry is a
        replay (no-op); a different action planned against a stale version is a
        conflict; an unsafe action is an invariant violation."""
        key = _action_key(action)
        # Replay: an already-applied action is a no-op (world not advanced).
        if key in self._applied:
            return GuardResult(ok=True, next=self._world, replay=True)

        # Optimistic-concurrency conflict (distinct from a replay): if the action was
        # planned against a version the commitment has since moved past, reject as a
        # CONFLICT. Checked here too because the partial-refund path does not route
        # through guard_action.
        conflict_target = next((c for c in self._world.commitments if str(c.id) == action.commitment), None)
        if conflict_target is not None:
            conflict = check_version(conflict_target, action.expected_version)
            if conflict is not None:
                return conflict

        if _type_of(action.to) == "Refunded":
            order = next((c for c in self._world.commitments if str(c.id) == action.commitment), None)
            # If the order can't legally reach Refunded from its current state (e.g. a
            # refund before fulfilment, or after a full refund), let guard_action
            # produce the I-2 rejection WITH alternatives.
            if order is None or not is_valid_commitment_transition(order.state, action.to):
                return guard_action(self._world, action)

            committed = _committed_total(order)
            proposed = action.to["amount"] if isinstance(action.to, dict) else action.to.amount
            proposed_amount = proposed["amount"] if isinstance(proposed, dict) else proposed.amount
            proposed_currency = proposed["currency"] if isinstance(proposed, dict) else proposed.currency

            if committed is not None and proposed_currency == committed.currency:
                prior = self._ledger.get(action.commitment)
                prior_amt = prior["total"].amount if prior else 0.0
                prior_count = prior["count"] if prior else 0
                cumulative = prior_amt + proposed_amount

                if _is_cumulative_over_refund(order, cumulative, committed.currency):
                    remaining = max(0.0, committed.amount - prior_amt)
                    return GuardResult(
                        ok=False,
                        violations=[
                            GuardViolation(
                                rule="I-1",
                                message="Cumulative refunds on %s would reach %s %s across %d refund(s), but "
                                "only %s %s was committed — value is not conserved across the session (the "
                                "point-in-time check sees each refund alone)."
                                % (order.id, _fmt(cumulative), committed.currency, prior_count + 1,
                                   _fmt(committed.amount), committed.currency),
                                fix="Refund at most the remaining %s %s (committed %s − already refunded %s)."
                                % (_fmt(remaining), committed.currency, _fmt(committed.amount), _fmt(prior_amt)),
                            )
                        ],
                        alternatives=[
                            TransitionAlternative(
                                to="Refunded",
                                label="refund the commitment",
                                bounded="cumulative refunds must stay within the committed %s %s; %s %s remains refundable"
                                % (_fmt(committed.amount), committed.currency, _fmt(remaining), committed.currency),
                            )
                        ],
                    )

                # Multi-object coherence (F6): if this commitment is part of a tree (a
                # parent with children, or a child), cap the SUM of refunds across the
                # whole tree against the PARENT's committed amount — so refunds spread
                # over different children (each individually valid, each child
                # reconciling via I-6) cannot cumulatively exceed the parent. Composes
                # the existing check_i6_tree_consistency (structure) + the same I-1
                # cumulative probe (lifted to the parent).
                root = _tree_root_of(self._world, order)
                tree_member = _is_in_tree(order, root)
                if tree_member:
                    children = [c for c in self._world.commitments if c.parent is not None and str(c.parent) == str(root.id)]
                    i6 = check_i6_tree_consistency(root, children)
                    if i6:
                        return GuardResult(
                            ok=False,
                            violations=[GuardViolation(rule=v.invariant, message=v.description, fix=v.fix) for v in i6],
                        )
                    tree_committed = _committed_total(root)
                    if tree_committed is not None and proposed_currency == tree_committed.currency:
                        tree_prior = self._tree_ledger.get(str(root.id))
                        tree_prior_amt = tree_prior["total"].amount if tree_prior else 0.0
                        tree_count = tree_prior["count"] if tree_prior else 0
                        tree_cumulative = tree_prior_amt + proposed_amount
                        if _is_cumulative_over_refund(root, tree_cumulative, tree_committed.currency):
                            remaining = max(0.0, tree_committed.amount - tree_prior_amt)
                            return GuardResult(
                                ok=False,
                                violations=[
                                    GuardViolation(
                                        rule="I-1",
                                        message="Cumulative refunds across the commitment tree rooted at %s would "
                                        "reach %s %s across %d refund(s) on the parent and its children, but the "
                                        "parent committed only %s %s — value is not conserved across the tree."
                                        % (root.id, _fmt(tree_cumulative), tree_committed.currency, tree_count + 1,
                                           _fmt(tree_committed.amount), tree_committed.currency),
                                        fix="Refund at most the remaining %s %s across the tree (parent committed %s "
                                        "− already refunded across the tree %s)."
                                        % (_fmt(remaining), tree_committed.currency, _fmt(tree_committed.amount), _fmt(tree_prior_amt)),
                                    )
                                ],
                                alternatives=[
                                    TransitionAlternative(
                                        to="Refunded",
                                        label="refund the commitment",
                                        bounded="cumulative refunds across the tree must stay within the parent's "
                                        "committed %s %s; %s %s remains refundable"
                                        % (_fmt(tree_committed.amount), tree_committed.currency, _fmt(remaining), tree_committed.currency),
                                    )
                                ],
                            )

                # Accepted refund. Record it. Keep the order in Fulfilled for a PARTIAL
                # refund; transition to Refunded only once the refunds reach committed.
                proposed_money = Money(amount=proposed_amount, currency=proposed_currency)
                new_total = add(prior["total"], proposed_money) if prior else proposed_money

                def _record_tree() -> None:
                    if not tree_member:
                        return
                    tp = self._tree_ledger.get(str(root.id))
                    self._tree_ledger[str(root.id)] = {
                        "total": add(tp["total"], proposed_money) if tp else proposed_money,
                        "count": (tp["count"] if tp else 0) + 1,
                    }

                fully_refunded = money_equals(cumulative, committed.amount, committed.currency)
                if fully_refunded:
                    verdict = guard_action(self._world, action)
                    if not verdict.ok or verdict.next is None:
                        return verdict
                    self._world = verdict.next
                    self._ledger[action.commitment] = {"total": new_total, "count": prior_count + 1}
                    _record_tree()
                    self._applied.add(key)
                    return verdict
                self._ledger[action.commitment] = {"total": new_total, "count": prior_count + 1}
                _record_tree()
                self._applied.add(key)
                return GuardResult(ok=True, next=self._world)

        # Non-refund action: pure compose over guard_action.
        verdict = guard_action(self._world, action)
        if verdict.ok and verdict.next is not None:
            self._world = verdict.next
            self._applied.add(key)
        return verdict


def create_session(initial_world: World) -> Session:
    return Session(initial_world)
