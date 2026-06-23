// Saga / compensation (F7) — model the UNWINDING of a multi-step commerce flow as an
// explicit, validated sequence of compensating actions, and check that the compensation
// itself is coherent (a reversal that would violate an invariant — e.g. an over-refund —
// is rejected).
//
// A Go port of the TypeScript saga.ts (and the Python / Rust saga modules). A "saga"
// here is an ordered set of forward actions (accept -> fulfill -> refund ...) together
// with the compensating actions that reverse their economic effect. Each compensation
// is a LEGAL transition (read from the same generated transition table as everything
// else: e.g. Fulfilled -> Refunded, Accepted -> Cancelled), and the net economic effect
// of the whole sequence is validated for conservation (I-1) and the rest of the
// six-invariant audit.
//
// This is a COMPOSITION over the already-proven primitives — it does NOT re-derive
// invariant or transition logic:
//   - ValidTransitions decides whether a compensation is a legal move from a
//     commitment's current state (the model's transition table = I-2);
//   - CreateSession runs the compensation sequence against the accumulated world, so the
//     cumulative over-refund check, the F3 optimistic-conflict check, the F4
//     idempotency/replay dedup, the F6 per-tree cap, and the six-invariant audit all
//     apply to the compensation exactly as they apply to any other action;
//   - the planning-oracle alternatives / bounded guidance surface unchanged on a
//     rejected compensation, so a caller can correct an over-refund the same way it
//     would correct any rejected action.
//
// SCOPE (honest): Warp VALIDATES that a compensation sequence is coherent — that each
// compensating action is a legal transition reversing a prior step's effect and that
// the net effect conserves value. Warp does NOT execute or orchestrate rollbacks on
// external systems: a planned compensation is a sequence of validated descriptors, not a
// runtime that calls Stripe/Shopify to undo anything. The interop emitters elsewhere in
// this package are descriptors in the same sense. "Compensation" is a modelling and
// validation affordance, not a distributed-transaction coordinator.
//
// WHAT REVERSES WHAT (the default mapping): a step that drove a commitment to Fulfilled
// (value delivered) is reversed by Refunded for the amount that step committed; a step
// that left a commitment Accepted / Active / Modified / PartiallyFulfilled (committed
// but not yet delivered) is reversed by Cancelled. A forward step that itself ended
// Cancelled or Refunded is already a terminal compensation target and has nothing to
// reverse. Callers may override the mapping per step via CompensateWith; an overridden
// target is still checked against the transition table and the invariants, so an illegal
// or invariant-violating override is rejected with guidance.

package warp

import (
	"fmt"

	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

// ForwardStep is a forward step that was applied to reach the current world, paired with
// the commitment it acted on. This is the input to compensation planning: the saga reads
// each step's committed effect and proposes the reversing action. To is the state the
// forward step drove the commitment to (the same shape a ProposedAction carries).
type ForwardStep struct {
	// Commitment is the id of the commitment the forward step acted on.
	Commitment string
	// To is the state the forward step drove the commitment to.
	To gen.CommitmentState
	// Actor who performed the forward step (carried onto the compensation by default).
	Actor string
	// CompensateWith is an optional explicit compensation override for THIS step. When
	// nil, the default mapping (see the package doc) is used. An override is still
	// validated against the transition table and the invariants — it is not a way to
	// bypass either.
	CompensateWith *gen.CommitmentState
	// At is an optional timestamp for the compensating transition (defaults to the
	// call's at).
	At string
}

// CompensationStep is a single planned compensating action: the reversing transition for
// one forward step. Action is nil when the forward step has nothing to reverse — that
// case is reported in CompensationPlan.Skipped with the reason, not silently dropped.
type CompensationStep struct {
	// Forward is the forward step this compensates.
	Forward ForwardStep
	// Action is the compensating action to run through the session, or nil when the
	// forward step has nothing to reverse.
	Action *ProposedAction
	// SkipReason is why a nil Action was produced (present only when Action is nil).
	SkipReason string
}

// SkippedStep records a forward step that produced no compensating action, with the
// reason it was skipped.
type SkippedStep struct {
	Commitment string
	Reason     string
}

// CompensationPlan is the full plan: the compensating action for each forward step (in
// REVERSE order — a saga unwinds last-applied first), plus the steps that had nothing to
// reverse.
type CompensationPlan struct {
	// Steps are the compensating actions, ordered last-forward-step-first (unwind order).
	Steps []CompensationStep
	// Skipped lists forward steps that produced no compensating action, with the reason.
	Skipped []SkippedStep
}

// CompensationResult is the verdict of validating a whole compensation plan against a
// world. On success OK is true, the world is fully unwound, and Next is the resulting
// coherent world. On rejection OK is false, FailedAt is the index (into the plan's Steps)
// of the compensation that was rejected, and the usual GuardResult fields explain why —
// so a caller corrects the offending compensation (e.g. an over-refund) exactly as it
// would correct any rejected action.
type CompensationResult struct {
	OK   bool
	Next *World
	// Applied / Skipped count the compensations that ran / were skipped (success only).
	Applied int
	Skipped int
	// FailedAt is the index of the rejected compensation (rejection only).
	FailedAt int
	// The verdict fields carried through from the rejected GuardResult.
	Violations   []GuardViolation
	Alternatives []TransitionAlternative
	Conflict     bool
	Expected     string
	Actual       string
}

func strPtr(s string) *string { return &s }

// defaultCompensation returns the default compensating action for a forward step, given
// the commitment it acted on (read from the CURRENT world so the move is legal from
// where it now is). Returns (action, "") on success, or (nil, reason) when there is
// nothing to reverse. The choice is constrained to the model's legal transitions via
// ValidTransitions — the saga never invents a move the table does not allow.
func defaultCompensation(forward ForwardStep, current *gen.Commitment, at string) (*ProposedAction, string) {
	legal := map[string]bool{}
	for _, t := range ValidTransitions(current.State) {
		legal[t] = true
	}
	effect := forward.To.Type

	// A forward step that delivered value (reached Fulfilled) is reversed by a Refund of
	// the committed amount — but only if Refunded is a legal move from where we are now.
	if effect == "Fulfilled" {
		if !legal["Refunded"] {
			return nil, fmt.Sprintf("commitment %s is in '%s', from which Refunded is not a legal transition — nothing to reverse for the Fulfilled step", forward.Commitment, current.State.Type)
		}
		amount, currency, ok := committedMoney(current)
		if !ok {
			return nil, fmt.Sprintf("commitment %s has no single-currency committed amount to refund", forward.Commitment)
		}
		return &ProposedAction{
			Commitment:     forward.Commitment,
			To:             gen.CommitmentState{Type: "Refunded", Amount: &gen.Money{Amount: amount, Currency: gen.CurrencyCode(currency)}, At: strPtr(at)},
			Actor:          forward.Actor,
			IdempotencyKey: fmt.Sprintf("comp:%s:Refunded", forward.Commitment),
		}, ""
	}

	// A committed-but-not-delivered step (Accepted / Active / Modified /
	// PartiallyFulfilled) is reversed by Cancelling the commitment, when legal.
	if effect == "Accepted" || effect == "Active" || effect == "Modified" || effect == "PartiallyFulfilled" {
		if !legal["Cancelled"] {
			return nil, fmt.Sprintf("commitment %s is in '%s', from which Cancelled is not a legal transition — nothing to reverse for the %s step", forward.Commitment, current.State.Type, effect)
		}
		by := gen.PartyID(forward.Actor)
		reason := fmt.Sprintf("compensation: reverse the %s step on %s", effect, forward.Commitment)
		return &ProposedAction{
			Commitment:     forward.Commitment,
			To:             gen.CommitmentState{Type: "Cancelled", By: &by, Reason: strPtr(reason), At: strPtr(at)},
			Actor:          forward.Actor,
			IdempotencyKey: fmt.Sprintf("comp:%s:Cancelled", forward.Commitment),
		}, ""
	}

	// Already a terminal compensation target, or a step with no economic reversal.
	if effect == "Cancelled" || effect == "Refunded" {
		return nil, fmt.Sprintf("the forward step on %s already ended in '%s', a terminal compensation target — nothing to reverse", forward.Commitment, effect)
	}
	return nil, fmt.Sprintf("the forward step on %s (to '%s') has no defined economic reversal; supply CompensateWith to model one explicitly", forward.Commitment, effect)
}

// PlanCompensation builds the compensation plan for a sequence of forward steps against
// world.
//
// Each forward step is mapped to its reversing action (default mapping, or the step's
// CompensateWith override). The plan is returned in REVERSE order — a saga unwinds the
// most-recently-applied step first — and steps with nothing to reverse are listed in
// Skipped. This only PLANS; ValidateCompensation runs the plan through a session to check
// it is coherent.
//
// at is the timestamp stamped on compensating transitions that need one (Refunded,
// Cancelled); pass a time no earlier than the world's last transition (I-4 temporal
// integrity is checked when the plan is validated). A per-step At overrides it.
func PlanCompensation(world World, forward []ForwardStep, at string) CompensationPlan {
	byID := map[string]*gen.Commitment{}
	for i := range world.Commitments {
		byID[string(world.Commitments[i].Id)] = &world.Commitments[i]
	}
	plan := CompensationPlan{}

	// Unwind in reverse: the last forward step is compensated first.
	for i := len(forward) - 1; i >= 0; i-- {
		step := forward[i]
		stepAt := at
		if step.At != "" {
			stepAt = step.At
		}
		current, ok := byID[step.Commitment]
		if !ok {
			reason := fmt.Sprintf("commitment %s is not present in the world — cannot compensate a step on it", step.Commitment)
			plan.Steps = append(plan.Steps, CompensationStep{Forward: step, Action: nil, SkipReason: reason})
			plan.Skipped = append(plan.Skipped, SkippedStep{Commitment: step.Commitment, Reason: reason})
			continue
		}

		// An explicit override is still bounded by the transition table: only a legal
		// move is accepted; an illegal override is skipped with guidance.
		if step.CompensateWith != nil {
			legal := map[string]bool{}
			legalList := ValidTransitions(current.State)
			for _, t := range legalList {
				legal[t] = true
			}
			cwType := step.CompensateWith.Type
			if !legal[cwType] {
				listing := "none — terminal"
				if len(legalList) > 0 {
					listing = joinStrings(legalList, ", ")
				}
				reason := fmt.Sprintf("CompensateWith '%s' is not a legal transition from '%s' for %s (legal: %s)", cwType, current.State.Type, step.Commitment, listing)
				plan.Steps = append(plan.Steps, CompensationStep{Forward: step, Action: nil, SkipReason: reason})
				plan.Skipped = append(plan.Skipped, SkippedStep{Commitment: step.Commitment, Reason: reason})
				continue
			}
			plan.Steps = append(plan.Steps, CompensationStep{Forward: step, Action: &ProposedAction{
				Commitment:     step.Commitment,
				To:             *step.CompensateWith,
				Actor:          step.Actor,
				IdempotencyKey: fmt.Sprintf("comp:%s:%s", step.Commitment, cwType),
			}})
			continue
		}

		action, reason := defaultCompensation(step, current, stepAt)
		if action == nil {
			plan.Steps = append(plan.Steps, CompensationStep{Forward: step, Action: nil, SkipReason: reason})
			plan.Skipped = append(plan.Skipped, SkippedStep{Commitment: step.Commitment, Reason: reason})
			continue
		}
		plan.Steps = append(plan.Steps, CompensationStep{Forward: step, Action: action})
	}

	return plan
}

func joinStrings(ss []string, sep string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += sep
		}
		out += s
	}
	return out
}

// ValidateCompensation validates a compensation plan by running every compensating
// action through a Session. The session applies the SAME checks as any other action
// sequence — the cumulative over-refund cap (I-1 across steps), the F3 optimistic-
// conflict check, the F4 replay/idempotency dedup, the F6 per-tree cap, and the
// six-invariant audit — so a compensation that would itself violate an invariant (e.g.
// an over-refund while reversing) is rejected, with the bounded/alternatives guidance
// the caller already knows how to act on.
//
// IMPORTANT — pass the SAME session the forward flow ran in. The compensation continues
// that session's accumulating ledger, so a prior PARTIAL refund (which the schema cannot
// represent as a state, and which the session tracks in its own ledger) is correctly
// counted. If you instead validate against a fresh session built from a world, that
// ledger context is lost — use Compensate only when the world's commitment states
// already reflect every prior effect.
//
// On the first rejected compensation, validation STOPS and returns the rejection with
// the index of the offending step (FailedAt). On success the world is fully unwound into
// a coherent state.
func ValidateCompensation(session *Session, plan CompensationPlan) CompensationResult {
	applied, skipped := 0, 0
	for i, step := range plan.Steps {
		if step.Action == nil {
			skipped++
			continue
		}
		verdict := session.Propose(*step.Action)
		if !verdict.OK {
			return CompensationResult{
				OK:           false,
				FailedAt:     i,
				Violations:   verdict.Violations,
				Alternatives: verdict.Alternatives,
				Conflict:     verdict.Conflict,
				Expected:     verdict.Expected,
				Actual:       verdict.Actual,
			}
		}
		applied++
	}
	w := session.World()
	return CompensationResult{OK: true, Next: &w, Applied: applied, Skipped: skipped}
}

// CompensateSession plans AND validates against an EXISTING session in one call: it
// builds the compensation plan for forward against the session's current world and
// immediately runs it through that SAME session, so any prior partial-refund ledger is
// honored. Returns both the plan (so a caller can inspect what was/wasn't reversed) and
// the verdict. A convenience over PlanCompensation + ValidateCompensation; no extra
// logic.
func CompensateSession(session *Session, forward []ForwardStep, at string) (CompensationPlan, CompensationResult) {
	plan := PlanCompensation(session.World(), forward, at)
	result := ValidateCompensation(session, plan)
	return plan, result
}

// Compensate plans AND validates against a FRESH session built from world. Use this when
// the world's commitment states already reflect every prior effect — there is no
// session-only partial-refund ledger to carry forward (e.g. unwinding a clean
// accept->active flow). When a prior partial refund is outstanding in a live session,
// use CompensateSession so that ledger is honored. Returns the plan + verdict.
func Compensate(world World, forward []ForwardStep, at string) (CompensationPlan, CompensationResult) {
	session := CreateSession(world)
	plan := PlanCompensation(world, forward, at)
	result := ValidateCompensation(session, plan)
	return plan, result
}
