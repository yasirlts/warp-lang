"""Transition validators — the heart of the package. The legal-transition tables
are read from ``schema/behavior/transitions.json`` (the same data the TypeScript
binding reads), so the two languages agree by construction. Every transition not
in a table is rejected — this enforces Invariant 2 (State Monotonicity). The
``transition_*`` functions additionally enforce Invariant 4 (Temporal Integrity):
history is append-only and timestamps never move backward.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Generic, List, Optional, TypeVar

from pydantic import TypeAdapter

from ._data import transitions as _transitions
from ._models import (
    Commitment,
    CommitmentState,
    CommitmentTransition,
    Fulfillment,
    FulfillmentState,
    FulfillmentTransition,
    Intent,
    IntentState,
    IntentTransition,
)
from .primitives import now

T = TypeVar("T")

# Adapters that coerce a plain dict (e.g. {"type": "Accepted"}) into the proper
# discriminated-union member. model_copy(update=...) does NOT re-validate, so we
# coerce explicitly before storing a transition target.
_COMMITMENT_STATE: TypeAdapter[Any] = TypeAdapter(CommitmentState)
_INTENT_STATE: TypeAdapter[Any] = TypeAdapter(IntentState)
_FULFILLMENT_STATE: TypeAdapter[Any] = TypeAdapter(FulfillmentState)

# The canonical schema (schema/behavior/transitions.json) carries each machine's
# table DIRECTLY (no wrapper): the value of "commitment" / "intent" / "fulfillment"
# is a map {from_state: [allowed_to_states]}. Every pair not listed is rejected.
_TABLES = _transitions()
_COMMITMENT_EDGES: Dict[str, List[str]] = _TABLES["commitment"]
_INTENT_EDGES: Dict[str, List[str]] = _TABLES["intent"]
_FULFILLMENT_EDGES: Dict[str, List[str]] = _TABLES["fulfillment"]


@dataclass
class Result(Generic[T]):
    """A fallible result. ``error`` is set (and ``ok`` is False) on failure."""

    ok: bool
    value: Optional[T] = None
    error: Optional[str] = None


class InvalidTransitionError(Exception):
    """Raised by callers who choose to raise on a failed transition."""


class CapacityError(Exception):
    """Raised when a party lacks the capacity required for an operation."""


# --- state helpers (accept model instances or plain dicts) ------------------

def _type_of(state: Any) -> str:
    return state["type"] if isinstance(state, dict) else state.type


def _field_of(state: Any, name: str) -> Any:
    if isinstance(state, dict):
        return state.get(name)
    return getattr(state, name, None)


# --- validity (Invariant 2) -------------------------------------------------

def is_valid_commitment_transition(from_state: Any, to_state: Any) -> bool:
    return _type_of(to_state) in _COMMITMENT_EDGES.get(_type_of(from_state), [])


def is_valid_intent_transition(from_state: Any, to_state: Any) -> bool:
    return _type_of(to_state) in _INTENT_EDGES.get(_type_of(from_state), [])


def is_valid_fulfillment_transition(from_state: Any, to_state: Any) -> bool:
    from_type = _type_of(from_state)
    to_type = _type_of(to_state)
    # Documented special case (schema/behavior/transitions.json
    # notes.fulfillment_failed_recovery): Failed is listed with an EMPTY transition
    # set in the table, but Failed -> Planned is valid as a SPECIAL CASE iff the
    # Failed state's `recoverable` flag is true. A non-recoverable Failed is terminal.
    if from_type == "Failed":
        return to_type == "Planned" and bool(_field_of(from_state, "recoverable"))
    return to_type in _FULFILLMENT_EDGES.get(from_type, [])


# --- move enumeration (the planning-oracle primitive) -----------------------
# The legal target states from a given state — a PURE READ of the same generated
# tables the ``is_valid_*`` checks consult, so the set is correct by construction:
# ``valid_transitions(s)`` lists exactly the targets for which
# ``is_valid_commitment_transition(s, {type})`` is true. A terminal state returns
# []. These are LEGAL TRANSITIONS, not guaranteed-safe actions: a move may be a
# valid transition yet still be rejected by another invariant (e.g. an over-refund
# is a valid Fulfilled -> Refunded transition that still fails I-1 on amount).

def valid_transitions(from_state: Any) -> List[str]:
    return list(_COMMITMENT_EDGES.get(_type_of(from_state), []))


def valid_intent_transitions(from_state: Any) -> List[str]:
    return list(_INTENT_EDGES.get(_type_of(from_state), []))


def valid_fulfillment_transitions(from_state: Any) -> List[str]:
    # Mirror is_valid_fulfillment_transition: the Failed -> Planned retry is gated
    # on `recoverable` and is intentionally NOT in the table, so apply the same rule.
    if _type_of(from_state) == "Failed":
        return ["Planned"] if bool(_field_of(from_state, "recoverable")) else []
    return list(_FULFILLMENT_EDGES.get(_type_of(from_state), []))


# --- temporal integrity (Invariant 4) ---------------------------------------

def _parse(ts: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _timestamp_not_before(nxt: str, prev: str) -> bool:
    """True if ``nxt`` is not earlier than ``prev`` (equal is allowed)."""
    n, p = _parse(nxt), _parse(prev)
    if n is None or p is None:
        return nxt >= prev
    return n >= p


# --- state-advancing functions — immutable, append-only ---------------------

def transition_commitment(
    commitment: Commitment, to: Any, actor: str, reason: Optional[str] = None
) -> "Result[Commitment]":
    if not is_valid_commitment_transition(commitment.state, to):
        return Result(
            ok=False,
            error=(
                "Commitment cannot transition from '%s' to '%s' — not a valid "
                "transition. A terminal state cannot move backward; to reverse a "
                "Fulfilled commitment, create a new Commitment with the parties "
                "exchanged (Invariant 2: State Monotonicity)."
                % (_type_of(commitment.state), _type_of(to))
            ),
        )
    at = now()
    if commitment.history and not _timestamp_not_before(at, commitment.history[-1].at):
        return Result(
            ok=False,
            error="Transition timestamp '%s' is earlier than the previous transition "
            "'%s' (Invariant 4: Temporal Integrity)." % (at, commitment.history[-1].at),
        )
    to = _COMMITMENT_STATE.validate_python(to)
    entry = CommitmentTransition.model_validate(
        {"from": commitment.state, "to": to, "at": at, "actor": actor, "reason": reason}
    )
    return Result(
        ok=True,
        value=commitment.model_copy(update={"state": to, "history": [*commitment.history, entry]}),
    )


def transition_intent(
    intent: Intent, to: Any, actor: str, reason: Optional[str] = None
) -> "Result[Intent]":
    if not is_valid_intent_transition(intent.state, to):
        return Result(
            ok=False,
            error="Intent cannot transition from '%s' to '%s' — not a valid transition "
            "(Invariant 2)." % (_type_of(intent.state), _type_of(to)),
        )
    at = now()
    if intent.history and not _timestamp_not_before(at, intent.history[-1].at):
        return Result(
            ok=False,
            error="Intent transition timestamp '%s' is earlier than the previous "
            "transition '%s' (Invariant 4)." % (at, intent.history[-1].at),
        )
    to = _INTENT_STATE.validate_python(to)
    entry = IntentTransition.model_validate(
        {"from": intent.state, "to": to, "at": at, "actor": actor, "reason": reason}
    )
    return Result(
        ok=True,
        value=intent.model_copy(update={"state": to, "history": [*intent.history, entry]}),
    )


def transition_fulfillment(fulfillment: Fulfillment, to: Any, actor: str) -> "Result[Fulfillment]":
    if not is_valid_fulfillment_transition(fulfillment.state, to):
        return Result(
            ok=False,
            error="Fulfillment cannot transition from '%s' to '%s' — not a valid "
            "transition (Invariant 2)." % (_type_of(fulfillment.state), _type_of(to)),
        )
    at = now()
    if fulfillment.history and not _timestamp_not_before(at, fulfillment.history[-1].at):
        return Result(
            ok=False,
            error="Fulfillment transition timestamp '%s' is earlier than the previous "
            "transition '%s' (Invariant 4)." % (at, fulfillment.history[-1].at),
        )
    to = _FULFILLMENT_STATE.validate_python(to)
    entry = FulfillmentTransition.model_validate(
        {"from": fulfillment.state, "to": to, "at": at, "actor": actor}
    )
    update: Dict[str, Any] = {"state": to, "history": [*fulfillment.history, entry]}
    to_type = _type_of(to)
    if to_type == "InProgress" and fulfillment.started_at is None:
        update["started_at"] = at
    if to_type == "Completed":
        update["completed_at"] = at
    return Result(ok=True, value=fulfillment.model_copy(update=update))


# --- history synthesis ------------------------------------------------------
# Reconstruct a *valid* history for an object known only in its final state. A
# platform adapter that maps a paid+fulfilled order knows the final state but not
# the path that produced it; an empty-history Fulfilled order would falsely fail
# checkI4TemporalIntegrity. These helpers replay the canonical path through the
# transition functions above, so the synthesized history is valid by construction.

def _commitment_path(target: Any) -> List[dict]:
    proposed = {"type": "Proposed"}
    accepted = {"type": "Accepted"}
    partially = {"type": "PartiallyFulfilled", "fulfilled_item_ids": [], "remaining_item_ids": []}
    fulfilled = {"type": "Fulfilled"}
    t = _type_of(target)
    if t == "Draft":
        return []
    if t in ("Proposed", "Tendered", "Cancelled"):
        return [target]
    if t == "Accepted":
        return [proposed, target]
    if t in ("Modified", "Active", "Disputed", "PartiallyFulfilled"):
        return [proposed, accepted, target]
    if t == "Fulfilled":
        return [proposed, accepted, partially, target]
    if t == "Refunded":
        return [proposed, accepted, partially, fulfilled, target]
    return [target]


def apply_commitment_path(
    commitment: Commitment, target: Any, actor: str, reason: Optional[str] = None
) -> Commitment:
    """Return a copy of ``commitment`` driven to ``target`` with a synthesized,
    valid history. Pass a freshly created Draft commitment. On the impossible event
    that a step is rejected, falls back to setting the final state directly."""
    current = commitment
    for step in _commitment_path(target):
        result = transition_commitment(current, step, actor, reason)
        if not result.ok or result.value is None:
            return commitment.model_copy(update={"state": target})
        current = result.value
    return current


def _fulfillment_path(target: Any) -> List[dict]:
    in_progress = {"type": "InProgress"}
    t = _type_of(target)
    if t == "Planned":
        return []
    if t in ("InProgress", "Failed"):
        return [target]
    if t in ("Completed", "Reversed"):
        return [in_progress, target]
    return [target]


def apply_fulfillment_path(fulfillment: Fulfillment, target: Any, actor: str) -> Fulfillment:
    """Return a copy of ``fulfillment`` driven to ``target`` with a synthesized,
    valid history (and ``started_at`` / ``completed_at`` stamped). Pass a freshly
    created Planned fulfillment."""
    current = fulfillment
    for step in _fulfillment_path(target):
        result = transition_fulfillment(current, step, actor)
        if not result.ok or result.value is None:
            return fulfillment.model_copy(update={"state": target})
        current = result.value
    return current
