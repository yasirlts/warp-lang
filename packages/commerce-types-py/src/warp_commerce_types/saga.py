"""Saga / compensation — model the UNWINDING of a multi-step commerce flow as an
explicit, validated sequence of compensating actions, and check that the
compensation itself is coherent (a reversal that would violate an invariant — e.g.
an over-refund — is rejected).

A Python port of the TypeScript ``saga.ts``. A "saga" here is an ordered set of
forward actions (accept -> fulfill -> refund ...) together with the compensating
actions that reverse their economic effect. Each compensation is a LEGAL transition
(read from the same generated transition table as everything else: e.g.
Fulfilled -> Refunded, Accepted -> Cancelled), and the net economic effect of the
whole sequence is validated for conservation (I-1) and the rest of the six-invariant
audit.

This is a COMPOSITION over the already-proven primitives — it does NOT re-derive
invariant or transition logic:
  - :func:`valid_transitions` decides whether a compensation is a legal move from a
    commitment's current state (the model's transition table = I-2);
  - :func:`create_session` runs the compensation sequence against the accumulated
    world, so the cumulative over-refund check, the F3 optimistic-conflict check, the
    F4 idempotency/replay dedup, and the six-invariant audit all apply to the
    compensation exactly as they apply to any other action;
  - the planning-oracle alternatives / bounded guidance surface unchanged on a
    rejected compensation, so a caller can correct an over-refund the same way it
    would correct any rejected action.

SCOPE (honest): Warp VALIDATES that a compensation sequence is coherent — that each
compensating action is a legal transition reversing a prior step's effect and that
the net effect conserves value. Warp does NOT execute or orchestrate rollbacks on
external systems: a planned compensation is a sequence of validated descriptors, not
a runtime that calls Stripe/Shopify to undo anything. "Compensation" is a modelling
and validation affordance, not a distributed-transaction coordinator.

WHAT REVERSES WHAT (the default mapping): a step that drove a commitment to
``Fulfilled`` (value delivered) is reversed by ``Refunded`` for the amount that step
committed; a step that left a commitment ``Accepted`` / ``Active`` / ``Modified`` /
``PartiallyFulfilled`` (committed but not yet delivered) is reversed by ``Cancelled``.
A forward step that itself ended ``Cancelled`` or ``Refunded`` is already a terminal
compensation target and has nothing to reverse. Callers may override the mapping per
step; an overridden target is still checked against the transition table and the
invariants, so an illegal or invariant-violating override is rejected with guidance.

Scope: TypeScript and Python. Rust / Go ports are roadmap.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ._models import Commitment
from .guard import GuardResult, GuardViolation, ProposedAction, TransitionAlternative, World
from .money import Money, add
from .session import Session, create_session
from .transitions import _type_of, valid_transitions


@dataclass
class ForwardStep:
    """A forward step that was applied to reach the current world, paired with the
    commitment it acted on. This is the input to compensation planning: the saga reads
    each step's committed effect and proposes the reversing action.

    ``to`` is the state the forward step drove the commitment to (the same shape a
    :class:`ProposedAction` carries — a state object or a ``{"type": ...}`` dict).
    """

    commitment: str
    to: Any
    actor: str
    # Optional explicit compensation override for THIS step. When omitted, the default
    # mapping (see the module doc) is used. An override is still validated against the
    # transition table and the invariants — it is not a way to bypass either.
    compensate_with: Optional[Any] = None
    # Optional timestamp for the compensating transition (defaults to the call's ``at``).
    at: Optional[str] = None


@dataclass
class CompensationStep:
    """A single planned compensating action: the reversing transition for one forward
    step. ``action`` is None when the forward step has nothing to reverse — that case is
    reported in :attr:`CompensationPlan.skipped` with the reason, not silently dropped."""

    forward: ForwardStep
    action: Optional[ProposedAction] = None
    skip_reason: Optional[str] = None


@dataclass
class CompensationPlan:
    """The full plan: the compensating action for each forward step (in REVERSE order —
    a saga unwinds last-applied first), plus the steps that had nothing to reverse."""

    steps: List[CompensationStep] = field(default_factory=list)
    skipped: List[Dict[str, str]] = field(default_factory=list)  # [{commitment, reason}]


@dataclass
class CompensationResult:
    """The verdict of validating a whole compensation plan against a world. On success
    the world is fully unwound and ``next`` is the resulting coherent world. On
    rejection, ``failed_at`` is the index (into the plan's ``steps``) of the
    compensation that was rejected, and the usual ``violations`` / ``alternatives`` /
    conflict fields explain why. Additive over :class:`GuardResult`."""

    ok: bool
    next: Optional[World] = None
    applied: int = 0
    skipped: int = 0
    failed_at: Optional[int] = None
    violations: List[GuardViolation] = field(default_factory=list)
    alternatives: List[TransitionAlternative] = field(default_factory=list)
    conflict: bool = False
    expected: Optional[str] = None
    actual: Optional[str] = None


def _committed_total(c: Commitment) -> Optional[Money]:
    """Sum the Money in a commitment's ``requested`` subject (single currency), or None."""
    monies = [v.form.money for v in c.subject.requested if v.form.kind == "Money"]
    if not monies:
        return None
    currency = monies[0].currency
    if any(m.currency != currency for m in monies):
        return None
    total = monies[0]
    for m in monies[1:]:
        total = add(total, m)
    return total


def _default_compensation(forward: ForwardStep, current: Commitment, at: str):
    """The default compensating action for a forward step, given the commitment it acted
    on (read from the CURRENT world so the move is legal from where it now is). Returns a
    :class:`ProposedAction`, or a ``{"skip": reason}`` dict when there is nothing to
    reverse. The choice is constrained to the model's legal transitions via
    :func:`valid_transitions` — the saga never invents a move the table does not allow."""
    legal = valid_transitions(current.state)
    effect = _type_of(forward.to)

    # A forward step that delivered value (reached Fulfilled) is reversed by a Refund of
    # the committed amount — but only if Refunded is a legal move from where we are now.
    if effect == "Fulfilled":
        if "Refunded" not in legal:
            return {"skip": "commitment %s is in '%s', from which Refunded is not a legal transition — "
                    "nothing to reverse for the Fulfilled step" % (forward.commitment, _type_of(current.state))}
        committed = _committed_total(current)
        if committed is None:
            return {"skip": "commitment %s has no single-currency committed amount to refund" % forward.commitment}
        return ProposedAction(
            commitment=forward.commitment,
            to={"type": "Refunded", "amount": {"amount": committed.amount, "currency": committed.currency}, "at": at},
            actor=forward.actor,
            reason="compensation: reverse the Fulfilled step on %s" % forward.commitment,
            idempotency_key="comp:%s:Refunded" % forward.commitment,
        )

    # A committed-but-not-delivered step (Accepted / Active / Modified / PartiallyFulfilled)
    # is reversed by Cancelling the commitment, when legal.
    if effect in ("Accepted", "Active", "Modified", "PartiallyFulfilled"):
        if "Cancelled" not in legal:
            return {"skip": "commitment %s is in '%s', from which Cancelled is not a legal transition — "
                    "nothing to reverse for the %s step" % (forward.commitment, _type_of(current.state), effect)}
        return ProposedAction(
            commitment=forward.commitment,
            to={"type": "Cancelled", "by": forward.actor,
                "reason": "compensation: reverse the %s step on %s" % (effect, forward.commitment), "at": at},
            actor=forward.actor,
            reason="compensation: reverse the %s step on %s" % (effect, forward.commitment),
            idempotency_key="comp:%s:Cancelled" % forward.commitment,
        )

    # Already a terminal compensation target, or a step with no economic reversal.
    if effect in ("Cancelled", "Refunded"):
        return {"skip": "the forward step on %s already ended in '%s', a terminal compensation target — "
                "nothing to reverse" % (forward.commitment, effect)}
    return {"skip": "the forward step on %s (to '%s') has no defined economic reversal; supply "
            "compensate_with to model one explicitly" % (forward.commitment, effect)}


def plan_compensation(world: World, forward: List[ForwardStep], at: str) -> CompensationPlan:
    """Build the compensation plan for a sequence of forward steps against ``world``.

    Each forward step is mapped to its reversing action (default mapping, or the step's
    ``compensate_with`` override). The plan is returned in REVERSE order — a saga unwinds
    the most-recently-applied step first — and steps with nothing to reverse are listed
    in ``skipped``. This only PLANS; :func:`validate_compensation` runs the plan through a
    session to check it is coherent.

    ``at`` is the timestamp stamped on compensating transitions that need one (Refunded,
    Cancelled); pass a time no earlier than the world's last transition (I-4 temporal
    integrity is checked when the plan is validated). A per-step ``at`` overrides it."""
    by_id = {str(c.id): c for c in world.commitments}
    steps: List[CompensationStep] = []
    skipped: List[Dict[str, str]] = []

    # Unwind in reverse: the last forward step is compensated first.
    for step in reversed(forward):
        step_at = step.at if step.at is not None else at
        current = by_id.get(step.commitment)
        if current is None:
            reason = "commitment %s is not present in the world — cannot compensate a step on it" % step.commitment
            steps.append(CompensationStep(forward=step, action=None, skip_reason=reason))
            skipped.append({"commitment": step.commitment, "reason": reason})
            continue

        # An explicit override is still bounded by the transition table: only a legal
        # move is accepted; an illegal override is skipped with guidance.
        if step.compensate_with is not None:
            legal = valid_transitions(current.state)
            cw_type = _type_of(step.compensate_with)
            if cw_type not in legal:
                reason = ("compensate_with '%s' is not a legal transition from '%s' for %s (legal: %s)"
                          % (cw_type, _type_of(current.state), step.commitment,
                             ", ".join(legal) if legal else "none — terminal"))
                steps.append(CompensationStep(forward=step, action=None, skip_reason=reason))
                skipped.append({"commitment": step.commitment, "reason": reason})
                continue
            steps.append(CompensationStep(
                forward=step,
                action=ProposedAction(
                    commitment=step.commitment,
                    to=step.compensate_with,
                    actor=step.actor,
                    reason="compensation (explicit) on %s" % step.commitment,
                    idempotency_key="comp:%s:%s" % (step.commitment, cw_type),
                ),
            ))
            continue

        planned = _default_compensation(step, current, step_at)
        if isinstance(planned, dict) and "skip" in planned:
            steps.append(CompensationStep(forward=step, action=None, skip_reason=planned["skip"]))
            skipped.append({"commitment": step.commitment, "reason": planned["skip"]})
            continue
        steps.append(CompensationStep(forward=step, action=planned))

    return CompensationPlan(steps=steps, skipped=skipped)


def validate_compensation(session: Session, plan: CompensationPlan) -> CompensationResult:
    """Validate a compensation plan by running every compensating action through a
    :class:`Session`. The session applies the SAME checks as any other action sequence —
    the cumulative over-refund cap (I-1 across steps), the F3 optimistic-conflict check,
    the F4 replay/idempotency dedup, and the six-invariant audit — so a compensation that
    would itself violate an invariant (e.g. an over-refund while reversing) is rejected,
    with the bounded/alternatives guidance the caller already knows how to act on.

    IMPORTANT — pass the SAME session the forward flow ran in. The compensation continues
    that session's accumulating ledger, so a prior PARTIAL refund (which the schema cannot
    represent as a state, and which the session tracks in its own ledger) is correctly
    counted. If you instead validate against a fresh session built from a world, that
    ledger context is lost — use :func:`compensate` only when the world's commitment
    states already reflect every prior effect.

    On the first rejected compensation, validation STOPS and returns the rejection with
    the index of the offending step (``failed_at``). On success the world is fully unwound
    into a coherent state."""
    applied = 0
    skipped = 0

    for i, step in enumerate(plan.steps):
        if step.action is None:
            skipped += 1
            continue
        verdict: GuardResult = session.propose(step.action)
        if not verdict.ok:
            return CompensationResult(
                ok=False,
                failed_at=i,
                violations=verdict.violations,
                alternatives=verdict.alternatives,
                conflict=verdict.conflict,
                expected=verdict.expected,
                actual=verdict.actual,
            )
        applied += 1

    return CompensationResult(ok=True, next=session.world, applied=applied, skipped=skipped)


def compensate_session(session: Session, forward: List[ForwardStep], at: str):
    """Plan AND validate against an EXISTING session in one call: build the compensation
    plan for ``forward`` against the session's current world and immediately run it
    through that SAME session, so any prior partial-refund ledger is honored. Returns
    ``(plan, result)``. A convenience over :func:`plan_compensation` +
    :func:`validate_compensation`; no extra logic."""
    plan = plan_compensation(session.world, forward, at)
    result = validate_compensation(session, plan)
    return plan, result


def compensate(world: World, forward: List[ForwardStep], at: str):
    """Plan AND validate against a FRESH session built from ``world``. Use this when the
    world's commitment states already reflect every prior effect — there is no
    session-only partial-refund ledger to carry forward (e.g. unwinding a clean
    accept->active flow). When a prior partial refund is outstanding in a live session,
    use :func:`compensate_session` so that ledger is honored. Returns ``(plan, result)``."""
    session = create_session(world)
    plan = plan_compensation(world, forward, at)
    result = validate_compensation(session, plan)
    return plan, result
