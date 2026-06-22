"""Agent guardrail — validate a proposed commerce action *before* it executes.

A Python port of the TypeScript ``guard.ts``, behaviour-identical: an AI agent
proposes an action near money (refund this order, accept this commitment); the
guardrail answers **safe** or **not-safe-with-an-actionable-reason** before
anything happens, and on a transition-table rejection it returns the legal
alternatives (the planning oracle) so the agent can self-correct.

This is a thin COMPOSITION over the package's already-proven, cross-checked
logic — it does NOT re-derive invariants or the transition table:
  - :func:`transition_commitment` validates the proposed move (the model's
    transition table = Invariant 2) and replays append-only history;
  - :func:`audit_commerce` runs the six-invariant audit over the resulting world.

It returns a discriminated result; it never raises on a rejected action and never
coerces an unsafe action into a safe-looking one.

Scope: TypeScript and Python. Rust / Go ports are roadmap.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, List, Optional

from ._models import Commitment, Fulfillment, Party
from .invariants import InvariantViolation, audit_commerce
from .transitions import _type_of, transition_commitment, valid_transitions


@dataclass
class World:
    """The current commerce world the agent is acting on."""

    commitments: List[Commitment]
    fulfillments: List[Fulfillment]
    parties: List[Party]


@dataclass
class ProposedAction:
    """A proposed commerce action: move one commitment in the world to a new state.

    ``idempotency_key`` and ``expected_version`` are runtime inputs (NOT schema
    fields). ``idempotency_key`` gives a stable identity so a retried action is
    recognized as a replay (see :func:`create_session`); when omitted a session
    derives a fingerprint. ``expected_version`` is the version the caller planned
    against (from :func:`commitment_version`, derived from the commitment's
    append-only history + state); if it no longer matches, the action is rejected as
    an optimistic-concurrency CONFLICT. The model schema stays frozen.
    """

    commitment: str
    to: Any
    actor: str
    reason: Optional[str] = None
    idempotency_key: Optional[str] = None
    expected_version: Optional[str] = None


@dataclass
class GuardViolation:
    """One reason an action or world was rejected — written for an agent to act on."""

    rule: str
    message: str
    fix: str


@dataclass
class TransitionAlternative:
    """A legal target state from the current state — a move the agent may pick.

    These are LEGAL TRANSITIONS from the current state, read from the model's
    transition table — NOT guaranteed-safe actions. A listed move is a valid state
    transition; reaching it with particular data may still be rejected by another
    invariant. The absence of ``bounded`` does not promise safety.
    """

    to: str
    label: str
    bounded: Optional[str] = None


@dataclass
class GuardResult:
    """The guard's verdict. On success, ``next`` is the resulting valid world. On
    rejection, ``violations`` lists every reason and ``alternatives`` (when present)
    lists the legal transitions from the current state. ``alternatives`` is additive
    — consumers that read only ``violations`` are unaffected."""

    ok: bool
    next: Optional[World] = None
    violations: List[GuardViolation] = field(default_factory=list)
    alternatives: List[TransitionAlternative] = field(default_factory=list)
    # Idempotency: True when this accepted result is a replay of an already-applied
    # action (a no-op; nothing was applied again).
    replay: bool = False
    # Optimistic-conflict: set when the rejection is a stale-version CONFLICT
    # (distinct from an invariant violation). ``expected`` is the caller's planned
    # version, ``actual`` is the commitment's current version.
    conflict: bool = False
    expected: Optional[str] = None
    actual: Optional[str] = None


def _from_invariant(v: InvariantViolation) -> GuardViolation:
    return GuardViolation(rule=v.invariant, message=v.description, fix=v.fix)


def _state_fingerprint(s: Any) -> str:
    """A short fingerprint of a commitment state — the type, plus the amount for a Refunded."""
    t = s["type"] if isinstance(s, dict) else s.type
    if t == "Refunded":
        amt = s["amount"] if isinstance(s, dict) else s.amount
        a = amt["amount"] if isinstance(amt, dict) else amt.amount
        cur = amt["currency"] if isinstance(amt, dict) else amt.currency
        return "Refunded:%s:%s" % (a, cur)
    return t


def commitment_version(c: Commitment) -> str:
    """The optimistic-concurrency version of a commitment, derived from its existing
    append-only history + state (history length + a state fingerprint) — NOT a schema
    field. A caller passes it back as ``ProposedAction.expected_version``.

    Scope: OPTIMISTIC concurrency over the caller's view — it detects a stale plan. It
    is not a lock, distributed consensus, or a transaction manager; Warp does not
    serialize concurrent writers."""
    return "%s:%s" % (len(c.history), _state_fingerprint(c.state))


def check_version(target: Commitment, expected_version: Optional[str]) -> Optional[GuardResult]:
    """If ``expected_version`` is supplied and no longer matches the commitment's
    current version, return the CONFLICT result; otherwise None. Used by
    :func:`guard_action` and the session layer."""
    if expected_version is None:
        return None
    actual = commitment_version(target)
    if expected_version == actual:
        return None
    return GuardResult(
        ok=False,
        conflict=True,
        expected=expected_version,
        actual=actual,
        violations=[
            GuardViolation(
                rule="version-conflict",
                message="This action was planned against version '%s', but commitment '%s' is now at "
                "version '%s' — it changed since you planned (a concurrent actor advanced it). The "
                "change conflicts, so it was not applied." % (expected_version, target.id, actual),
                fix="Re-read the commitment, recompute its version with commitment_version(), and re-plan "
                "your action against the current version. This is optimistic concurrency — Warp detects "
                "the stale plan; it does not lock or serialize writers.",
            )
        ],
    )


def _rule_from_transition_error(error: str) -> str:
    m = re.search(r"Invariant (\d)", error)
    return "I-%s" % m.group(1) if m else "I-2"


_COMMITMENT_MOVE_LABELS = {
    "Draft": "return to draft",
    "Proposed": "propose to the counterparty",
    "Tendered": "tender as an open offer",
    "Accepted": "accept the commitment",
    "Modified": "modify the terms",
    "PartiallyFulfilled": "mark partially fulfilled",
    "Active": "activate the commitment",
    "Fulfilled": "mark fulfilled",
    "Cancelled": "cancel the commitment",
    "Disputed": "open a dispute",
    "Refunded": "refund the commitment",
}


def _commitment_alternatives(from_state: Any, bounded: Optional[dict] = None) -> List[TransitionAlternative]:
    """The legal moves from ``from_state`` (a pure read of the table via
    :func:`valid_transitions`). If ``bounded`` is given, the matching target is
    annotated as reachable-but-constrained."""
    out: List[TransitionAlternative] = []
    for to in valid_transitions(from_state):
        alt = TransitionAlternative(to=to, label=_COMMITMENT_MOVE_LABELS.get(to, to))
        if bounded is not None and bounded["to"] == to:
            alt.bounded = bounded["constraint"]
        out.append(alt)
    return out


def _summarize_alternatives(alts: List[TransitionAlternative]) -> str:
    if not alts:
        return "There are no legal transitions from this state — it is terminal."
    listing = ", ".join("%s (%s)" % (a.to, a.bounded) if a.bounded else a.to for a in alts)
    return "Legal transitions from here: %s." % listing


def guard_action(world: World, action: ProposedAction) -> GuardResult:
    """Guard a proposed transition-level action. Validates the move against the
    transition table, applies it (preserving append-only history), and audits the
    resulting world — all by composing the proven functions."""
    target = next((c for c in world.commitments if str(c.id) == action.commitment), None)
    if target is None:
        return GuardResult(
            ok=False,
            violations=[
                GuardViolation(
                    rule="unknown-commitment",
                    message="No commitment '%s' exists in the current world; an action must "
                    "target a commitment that is present." % action.commitment,
                    fix="Reference a commitment id that exists in the `world` you pass to "
                    "guard_action (the agent may be acting on a stale or hallucinated id).",
                )
            ],
        )

    # 0. Optimistic-concurrency check: a stale expected_version means the commitment
    #    advanced under the caller — reject as a CONFLICT (distinct from an invariant
    #    violation). Backward-compatible: no expected_version is a no-op.
    conflict = check_version(target, action.expected_version)
    if conflict is not None:
        return conflict

    # 1. Validate the proposed move + replay history (composes transition_commitment).
    moved = transition_commitment(target, action.to, action.actor, action.reason)
    if not moved.ok:
        rule = _rule_from_transition_error(moved.error or "")
        # A transition-table rejection (I-2) is the planning case: enumerate the legal
        # moves. A timestamp rejection (I-4) is not fixed by a different target state.
        if rule == "I-2":
            alternatives = _commitment_alternatives(target.state)
            return GuardResult(
                ok=False,
                violations=[
                    GuardViolation(
                        rule=rule,
                        message=moved.error or "",
                        fix="Only the model's valid transitions are allowed. %s Pick one of those, "
                        "or model a reversal as a NEW forward commitment with the parties exchanged "
                        "— never move a finalized state backward." % _summarize_alternatives(alternatives),
                    )
                ],
                alternatives=alternatives,
            )
        return GuardResult(
            ok=False,
            violations=[
                GuardViolation(
                    rule=rule,
                    message=moved.error or "",
                    fix="The target state is reachable, but the transition timestamp is not "
                    "monotonic — record the move at a time no earlier than the last transition "
                    "(Invariant 4: Temporal Integrity).",
                )
            ],
        )

    # 2. Build the resulting world: the target commitment, transitioned.
    moved_value = moved.value
    if moved_value is None:  # pragma: no cover - transition_commitment sets value on ok
        return GuardResult(ok=False, violations=[GuardViolation("I-2", "transition produced no value", "retry")])
    next_commitments = [moved_value if str(c.id) == str(target.id) else c for c in world.commitments]
    next_world = World(next_commitments, world.fulfillments, world.parties)

    # 3. Audit the RESULTING world (composes audit_commerce: the six invariants).
    violations = audit_commerce(next_world.commitments, next_world.fulfillments, next_world.parties)
    if violations:
        # The move was a LEGAL transition (it passed step 1), but the resulting world
        # is rejected. List the legal moves from the original state, and where a
        # violation cites the moved commitment, annotate the attempted target as
        # reachable-but-bounded — so the agent corrects the DATA, not the state.
        moved_id = str(target.id)
        cited = [v for v in violations if moved_id in v.description]
        bounded: Optional[dict] = None
        if cited:
            bounded = {"to": _type_of(action.to), "constraint": " ".join(v.description for v in cited)}
        return GuardResult(
            ok=False,
            violations=[_from_invariant(v) for v in violations],
            alternatives=_commitment_alternatives(target.state, bounded),
        )

    # 4. Valid edge + clean world → safe.
    return GuardResult(ok=True, next=next_world)


def guard_object(
    commitments: List[Commitment], fulfillments: List[Fulfillment], parties: List[Party]
) -> GuardResult:
    """Guard a fully-constructed world (the object-level case). A thin layer over
    :func:`audit_commerce`."""
    violations = audit_commerce(commitments, fulfillments, parties)
    if violations:
        return GuardResult(ok=False, violations=[_from_invariant(v) for v in violations])
    return GuardResult(ok=True, next=World(commitments, fulfillments, parties))
