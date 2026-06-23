"""Multi-agent verification — make it first-class that several NAMED agents act on
a SHARED world, so the invariants hold over their COMBINED actions, with per-actor
attribution.

A Python port of the TypeScript ``multi-agent.ts``. This is NOT new invariant logic.
The model is already actor-agnostic: a :class:`World` holds many commitments, every
:class:`ProposedAction` carries an ``actor``, and :class:`Session` accumulates a world
across actions regardless of who made each — so the cumulative refund check and the
six invariants already catch a violation that EMERGES from the combined valid actions
of different agents (three agents each refunding 80 against a 200 commitment is caught
at the third, exactly as one agent doing it three times would be). This module composes
that existing session; it does not fork or re-derive any check.

What it adds is ergonomics + ATTRIBUTION: run a sequence of actions from different
actors against one shared world, record which actor performed each accepted action,
and — on a rejection — name the actor whose action, applied to the accumulated shared
world, tipped it into violation.

SCOPE (honest): this is shared-world invariant enforcement WITH attribution. The
attribution is "which action tipped the world into violation" — the proposing actor
of the step that failed the check. It is NOT collusion, conspiracy, or multi-party
intent detection: Warp does not infer that several actors coordinated, only that a
violation emerged over the world they share and which single action triggered it.

ATTRIBUTION WORDING (per-binding note): this Python port composes the SAME underlying
session as the TS twin and produces the same verdict fields plus ``actor`` and (on a
rejection) ``attribution``. The attribution STRING wording is the Python binding's own
phrasing; it conveys the same facts as the TS string (the tipping actor, the prior
actors as accumulated context, and whether the cause was a conflict or an invariant
violation) but is not a byte-for-byte copy of the TS sentence. Tests assert the facts
(which actor, which prior actors, conflict-vs-violation), not the exact sentence.

Scope: TypeScript and Python. Rust / Go ports are roadmap.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .guard import GuardViolation, ProposedAction, TransitionAlternative, World
from .money import Money
from .session import create_session
from .transitions import _type_of


@dataclass
class AgentActionRecord:
    """One accepted action, with the actor who performed it (the who-did-what log)."""

    actor: str
    commitment: str
    to: str


@dataclass
class MultiAgentResult:
    """A multi-agent verdict: the session's verdict plus the ``actor`` of this action.

    Additive over :class:`GuardResult` — every field the single-actor session returns is
    still present (``ok``, ``next``, ``violations``, ``alternatives``, ``replay``,
    ``conflict``, ``expected``, ``actual``). On a rejection, ``actor`` is the actor whose
    action — applied to the accumulated shared world — tipped it into violation, and
    ``attribution`` spells that out against the prior accepted actors.
    """

    ok: bool
    actor: str
    next: Optional[World] = None
    violations: List[GuardViolation] = field(default_factory=list)
    alternatives: List[TransitionAlternative] = field(default_factory=list)
    replay: bool = False
    conflict: bool = False
    expected: Optional[str] = None
    actual: Optional[str] = None
    # Present only on a rejection: which actor's action tipped the shared world over.
    attribution: Optional[str] = None


class MultiAgentSession:
    """A stateful sequence validator over a shared world spanning several named agents.

    Composes the existing :class:`Session` — same accumulated world, same actor-agnostic
    cumulative / conflict / replay checks. This wrapper only adds attribution.
    """

    def __init__(self, initial_world: World) -> None:
        self._session = create_session(initial_world)
        self._log: List[AgentActionRecord] = []

    @property
    def world(self) -> World:
        """The current accumulated shared world (updated only on accepted actions)."""
        return self._session.world

    @property
    def log(self) -> List[AgentActionRecord]:
        """The accepted actions in order, each tagged with the actor who performed it."""
        return self._log

    def refunded_so_far(self, commitment_id: str) -> Optional[Money]:
        """The amount refunded so far for a commitment across all agents, or None."""
        return self._session.refunded_so_far(commitment_id)

    def actors_summary(self) -> Dict[str, int]:
        """A per-actor count of accepted actions (who did how much)."""
        out: Dict[str, int] = {}
        for r in self._log:
            out[r.actor] = out.get(r.actor, 0) + 1
        return out

    def _prior_actors(self) -> List[str]:
        """Distinct actors who have an accepted action so far (accumulated context)."""
        seen: set = set()
        out: List[str] = []
        for r in self._log:
            if r.actor not in seen:
                seen.add(r.actor)
                out.append(r.actor)
        return out

    def propose(self, action: ProposedAction) -> MultiAgentResult:
        """Validate ``action`` (from ``action.actor``) against the ACCUMULATED shared
        world, apply it on success, and return the verdict with per-actor attribution.
        The cumulative / conflict / replay checks all apply across actors, because the
        underlying session is actor-agnostic."""
        actor = str(action.actor)
        verdict = self._session.propose(action)
        if verdict.ok:
            # A replay applied nothing new; only log genuinely-applied actions.
            if not verdict.replay:
                self._log.append(
                    AgentActionRecord(actor=actor, commitment=action.commitment, to=_type_of(action.to))
                )
            return MultiAgentResult(
                ok=True,
                actor=actor,
                next=verdict.next,
                replay=verdict.replay,
            )

        others = [a for a in self._prior_actors() if a != actor]
        context = "the accumulated actions of %s" % ", ".join(others) if others else "no prior actions"
        rule = verdict.violations[0].rule if verdict.violations else "an invariant"
        what = (
            "conflicts with the commitment's current version (a concurrent actor advanced it)"
            if verdict.conflict
            else "tipped the shared world into violation of %s" % rule
        )
        attribution = "%s's action, applied after %s, %s." % (actor, context, what)
        return MultiAgentResult(
            ok=False,
            actor=actor,
            violations=verdict.violations,
            alternatives=verdict.alternatives,
            conflict=verdict.conflict,
            expected=verdict.expected,
            actual=verdict.actual,
            attribution=attribution,
        )


def create_multi_agent_session(initial_world: World) -> MultiAgentSession:
    return MultiAgentSession(initial_world)
