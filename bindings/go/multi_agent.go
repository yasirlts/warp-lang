// Multi-agent verification (F5) — make it first-class that several NAMED agents act on
// a SHARED world, so the invariants hold over their COMBINED actions, with per-actor
// attribution.
//
// A Go port of the TypeScript multi-agent.ts (and the Python / Rust multi_agent
// modules). This is NOT new invariant logic. The model is already actor-agnostic: a
// World holds many commitments, every ProposedAction carries an Actor, and a Session
// accumulates a world across actions regardless of who made each — so the cumulative
// refund check and the six invariants already catch a violation that EMERGES from the
// combined valid actions of different agents (three agents each refunding 80 against a
// 200 commitment is caught at the third, exactly as one agent doing it three times
// would be). This wrapper composes that existing session; it does not fork or re-derive
// any check.
//
// What it adds is ergonomics + ATTRIBUTION: run a sequence of actions from different
// actors against one shared world, record which actor performed each accepted action,
// and — on a rejection — name the actor whose action, applied to the accumulated shared
// world, tipped it into violation.
//
// SCOPE (honest): this is shared-world invariant enforcement WITH attribution. The
// attribution is "which action tipped the world into violation" — the proposing actor
// of the step that failed the check. It is NOT collusion, conspiracy, or multi-party
// intent detection: Warp does not infer that several actors coordinated, only that a
// violation emerged over the world they share and which single action triggered it.
//
// ATTRIBUTION WORDING (per-binding note): this Go port composes the SAME underlying
// session as the TS / Python / Rust twins and produces the same verdict plus the Actor
// and (on a rejection) Attribution. The attribution STRING wording is this binding's
// own phrasing; it conveys the same facts as the other bindings (the tipping actor, the
// prior actors as accumulated context, and whether the cause was a conflict or an
// invariant violation) but is not a byte-for-byte copy. Tests assert the facts (which
// actor, which prior actors, conflict-vs-violation), not the exact sentence.

package warp

import (
	"fmt"
	"strings"
)

// AgentActionRecord is one accepted action, with the actor who performed it (the
// who-did-what log entry).
type AgentActionRecord struct {
	Actor      string
	Commitment string
	// To is the target state's discriminant (e.g. "Refunded", "Active").
	To string
}

// MultiAgentResult is a multi-agent verdict: the session's verdict plus the Actor of
// this action. Additive over GuardResult — every field the single-actor session returns
// is still present. On a rejection, Actor is the actor whose action — applied to the
// accumulated shared world — tipped it into violation, and Attribution spells that out
// against the prior accepted actors.
type MultiAgentResult struct {
	GuardResult
	// Actor of this action (present on both accepted and rejected results).
	Actor string
	// Attribution is set only on a rejection — which actor's action tipped the shared
	// world over, against the prior actors.
	Attribution string
}

// MultiAgentSession is a stateful sequence validator over a shared world spanning
// several named agents. It composes the existing Session — same accumulated world, same
// actor-agnostic cumulative / conflict / replay checks. This wrapper only adds
// attribution and the who-did-what log.
type MultiAgentSession struct {
	session *Session
	log     []AgentActionRecord
}

// CreateMultiAgentSession returns a MultiAgentSession over the given shared world.
func CreateMultiAgentSession(initialWorld World) *MultiAgentSession {
	return &MultiAgentSession{session: CreateSession(initialWorld), log: nil}
}

// World returns the current accumulated shared world (updated only on accepted actions).
func (m *MultiAgentSession) World() World { return m.session.World() }

// Log returns the accepted actions in order, each tagged with the actor who performed it.
func (m *MultiAgentSession) Log() []AgentActionRecord { return m.log }

// RefundedSoFar returns the amount refunded so far for a commitment across all agents,
// or (0,"",false).
func (m *MultiAgentSession) RefundedSoFar(commitmentID string) (float64, string, bool) {
	return m.session.RefundedSoFar(commitmentID)
}

// ActorsSummary returns a per-actor count of accepted actions (who did how much).
func (m *MultiAgentSession) ActorsSummary() map[string]int {
	out := map[string]int{}
	for _, r := range m.log {
		out[r.Actor]++
	}
	return out
}

// priorActors returns the distinct actors who have an accepted action so far (the
// accumulated context), in first-seen order.
func (m *MultiAgentSession) priorActors() []string {
	seen := map[string]bool{}
	out := []string{}
	for _, r := range m.log {
		if !seen[r.Actor] {
			seen[r.Actor] = true
			out = append(out, r.Actor)
		}
	}
	return out
}

// Propose validates action (from action.Actor) against the ACCUMULATED shared world,
// applies it on success, and returns the verdict with per-actor attribution. The
// cumulative / conflict / replay checks all apply across actors, because the underlying
// session is actor-agnostic.
func (m *MultiAgentSession) Propose(action ProposedAction) MultiAgentResult {
	actor := action.Actor
	verdict := m.session.Propose(action)
	if verdict.OK {
		// A replay applied nothing new; only log genuinely-applied actions.
		if !verdict.Replay {
			m.log = append(m.log, AgentActionRecord{Actor: actor, Commitment: action.Commitment, To: action.To.Type})
		}
		return MultiAgentResult{GuardResult: verdict, Actor: actor}
	}

	others := []string{}
	for _, a := range m.priorActors() {
		if a != actor {
			others = append(others, a)
		}
	}
	context := "no prior actions"
	if len(others) > 0 {
		context = "the accumulated actions of " + strings.Join(others, ", ")
	}
	rule := "an invariant"
	if len(verdict.Violations) > 0 {
		rule = verdict.Violations[0].Rule
	}
	what := fmt.Sprintf("tipped the shared world into violation of %s", rule)
	if verdict.Conflict {
		what = "conflicts with the commitment's current version (a concurrent actor advanced it)"
	}
	attribution := fmt.Sprintf("%s's action, applied after %s, %s.", actor, context, what)
	return MultiAgentResult{GuardResult: verdict, Actor: actor, Attribution: attribution}
}
