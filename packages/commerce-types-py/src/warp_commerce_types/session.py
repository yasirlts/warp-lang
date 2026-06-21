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

Scope: TypeScript and Python. Rust / Go ports are roadmap.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from ._models import Commitment, CommitmentStateRefunded, Money
from .guard import GuardResult, GuardViolation, ProposedAction, TransitionAlternative, World, guard_action
from .invariants import check_i1_value_conservation
from .money import add, money_equals
from .transitions import _type_of, is_valid_commitment_transition


def _fmt(x: float) -> str:
    """Print whole amounts without a trailing .0 (200, not 200.0)."""
    return str(int(x)) if float(x).is_integer() else str(x)


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


class Session:
    """A stateful sequence validator over an accumulating world."""

    def __init__(self, initial_world: World) -> None:
        self._world = initial_world
        self._ledger: Dict[str, Dict[str, Any]] = {}  # commitment_id -> {total: Money, count: int}

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
        :func:`guard_action`. On rejection the world is not advanced."""
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

                # Accepted refund. Record it. Keep the order in Fulfilled for a PARTIAL
                # refund; transition to Refunded only once the refunds reach committed.
                proposed_money = Money(amount=proposed_amount, currency=proposed_currency)
                new_total = add(prior["total"], proposed_money) if prior else proposed_money
                fully_refunded = money_equals(cumulative, committed.amount, committed.currency)
                if fully_refunded:
                    verdict = guard_action(self._world, action)
                    if not verdict.ok or verdict.next is None:
                        return verdict
                    self._world = verdict.next
                    self._ledger[action.commitment] = {"total": new_total, "count": prior_count + 1}
                    return verdict
                self._ledger[action.commitment] = {"total": new_total, "count": prior_count + 1}
                return GuardResult(ok=True, next=self._world)

        # Non-refund action: pure compose over guard_action.
        verdict = guard_action(self._world, action)
        if verdict.ok and verdict.next is not None:
            self._world = verdict.next
        return verdict


def create_session(initial_world: World) -> Session:
    return Session(initial_world)
