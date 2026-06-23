package warp

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

const sagaAt = "2026-03-01T00:00:00.000Z"

func orderInState(id string, amount float64, stateJSON string) gen.Commitment {
	var c gen.Commitment
	j := fmt.Sprintf(`{"id":"%s","parties":{"initiator":"buyer","counterparty":"seller","intermediaries":[]},"subject":{"offered":[],"requested":[{"id":"v","form":{"kind":"Money","money":{"amount":%v,"currency":"MAD"}},"quantity":1,"state":{"type":"Available"}}]},"state":%s,"history":[],"children":[],"created_at":"2026-01-02T08:00:00.000Z"}`, id, amount, stateJSON)
	if err := json.Unmarshal([]byte(j), &c); err != nil {
		panic(err)
	}
	return c
}

func sagaFulfilled(id string, amount float64) gen.Commitment {
	return orderInState(id, amount, `{"type":"Fulfilled"}`)
}

func fulfillStep(id string) ForwardStep {
	return ForwardStep{Commitment: id, To: gen.CommitmentState{Type: "Fulfilled"}, Actor: "seller"}
}

func worldOf(c gen.Commitment) World {
	return World{Commitments: []gen.Commitment{c}}
}

func TestSagaPlansARefundToReverseAFulfilledStep(t *testing.T) {
	world := worldOf(sagaFulfilled("order_1", 200))
	plan := PlanCompensation(world, []ForwardStep{fulfillStep("order_1")}, sagaAt)
	if len(plan.Steps) != 1 {
		t.Fatalf("plan has %d steps, want 1", len(plan.Steps))
	}
	action := plan.Steps[0].Action
	if action == nil {
		t.Fatal("expected a compensating action")
	}
	if action.To.Type != "Refunded" {
		t.Fatalf("expected Refunded, got %s", action.To.Type)
	}
	if action.To.Amount == nil || action.To.Amount.Amount != 200 {
		t.Fatal("refund should be for the committed 200")
	}
}

func TestSagaValidCompensationSequenceCompletesFullyRefunded(t *testing.T) {
	world := worldOf(sagaFulfilled("order_1", 200))
	_, result := Compensate(world, []ForwardStep{fulfillStep("order_1")}, sagaAt)
	if !result.OK {
		t.Fatal("expected the compensation to succeed")
	}
	if result.Applied != 1 {
		t.Fatalf("applied = %d, want 1", result.Applied)
	}
	if result.Next.Commitments[0].State.Type != "Refunded" {
		t.Fatalf("final state = %s, want Refunded", result.Next.Commitments[0].State.Type)
	}
}

func TestSagaRejectsOverRefundWhileReversingPartiallyRefundedFlow(t *testing.T) {
	session := CreateSession(worldOf(sagaFulfilled("order_1", 200)))
	// Forward flow: a partial refund of 50 tracked in the session ledger.
	if !session.Propose(ProposedAction{Commitment: "order_1", To: refundState(50), Actor: "seller", IdempotencyKey: "partial-50"}).OK {
		t.Fatal("partial refund of 50 should be accepted")
	}
	// Compensation refunds the FULL 200 again → 50 + 200 = 250 > 200 (over-refund).
	step := ForwardStep{Commitment: "order_1", To: gen.CommitmentState{Type: "Fulfilled"}, Actor: "seller", CompensateWith: refundStatePtr(200)}
	_, result := CompensateSession(session, []ForwardStep{step}, sagaAt)
	if result.OK {
		t.Fatal("expected the over-refund compensation to be rejected")
	}
	if result.FailedAt != 0 {
		t.Fatalf("failedAt = %d, want 0", result.FailedAt)
	}
	if result.Violations[0].Rule != "I-1" {
		t.Fatalf("expected I-1, got %s", result.Violations[0].Rule)
	}
	if !strings.Contains(result.Violations[0].Message, "250") {
		t.Fatalf("message %q should mention 250", result.Violations[0].Message)
	}
	var alt *TransitionAlternative
	for i := range result.Alternatives {
		if result.Alternatives[i].To == "Refunded" {
			alt = &result.Alternatives[i]
		}
	}
	if alt == nil || alt.Bounded == nil || !strings.Contains(*alt.Bounded, "150") {
		t.Fatal("bounded alternative should report 150 remaining")
	}
}

func TestSagaAcceptsTheBoundedRemainingCompensation(t *testing.T) {
	session := CreateSession(worldOf(sagaFulfilled("order_1", 200)))
	session.Propose(ProposedAction{Commitment: "order_1", To: refundState(50), Actor: "seller", IdempotencyKey: "partial-50"})

	step := ForwardStep{Commitment: "order_1", To: gen.CommitmentState{Type: "Fulfilled"}, Actor: "seller", CompensateWith: refundStatePtr(150)}
	_, result := CompensateSession(session, []ForwardStep{step}, sagaAt)
	if !result.OK {
		t.Fatal("the bounded remaining compensation should be accepted")
	}
	sofar, _, _ := session.RefundedSoFar("order_1")
	if sofar != 200 {
		t.Fatalf("refunded so far = %v, want 200", sofar)
	}
	if session.World().Commitments[0].State.Type != "Refunded" {
		t.Fatalf("final state = %s, want Refunded", session.World().Commitments[0].State.Type)
	}
}

func TestSagaReversesCommittedButNotDeliveredByCancellation(t *testing.T) {
	world := worldOf(orderInState("lease_1", 100, `{"type":"Active"}`))
	plan, result := Compensate(world, []ForwardStep{{Commitment: "lease_1", To: gen.CommitmentState{Type: "Active"}, Actor: "seller"}}, sagaAt)
	if plan.Steps[0].Action == nil || plan.Steps[0].Action.To.Type != "Cancelled" {
		t.Fatal("an Active step should be reversed by Cancelled")
	}
	if !result.OK {
		t.Fatal("the cancellation compensation should succeed")
	}
	if result.Next.Commitments[0].State.Type != "Cancelled" {
		t.Fatalf("final state = %s, want Cancelled", result.Next.Commitments[0].State.Type)
	}
}

func TestSagaSkipsAStepWithNothingToReverseTerminalRefunded(t *testing.T) {
	world := worldOf(orderInState("order_2", 200, fmt.Sprintf(`{"type":"Refunded","amount":{"amount":200,"currency":"MAD"},"at":%q}`, sagaAt)))
	step := ForwardStep{Commitment: "order_2", To: refundState(200), Actor: "seller"}
	plan := PlanCompensation(world, []ForwardStep{step}, sagaAt)
	if plan.Steps[0].Action != nil {
		t.Fatal("a terminal Refunded step has nothing to reverse")
	}
	if len(plan.Skipped) != 1 {
		t.Fatalf("skipped %d steps, want 1", len(plan.Skipped))
	}
	if !strings.Contains(plan.Skipped[0].Reason, "terminal") {
		t.Fatalf("skip reason %q should mention terminal", plan.Skipped[0].Reason)
	}
}

func TestSagaRejectsAnIllegalCompensateWithOverride(t *testing.T) {
	world := worldOf(sagaFulfilled("order_1", 200))
	// Fulfilled → Accepted is NOT a legal transition.
	step := ForwardStep{Commitment: "order_1", To: gen.CommitmentState{Type: "Fulfilled"}, Actor: "seller", CompensateWith: &gen.CommitmentState{Type: "Accepted"}}
	plan := PlanCompensation(world, []ForwardStep{step}, sagaAt)
	if plan.Steps[0].Action != nil {
		t.Fatal("an illegal override should produce no action")
	}
	if !strings.Contains(plan.Skipped[0].Reason, "not a legal transition") {
		t.Fatalf("skip reason %q should mention an illegal transition", plan.Skipped[0].Reason)
	}
}

func TestSagaComposesWithF4ReplayNoDoubleApply(t *testing.T) {
	session := CreateSession(worldOf(sagaFulfilled("order_1", 200)))
	plan := PlanCompensation(session.World(), []ForwardStep{fulfillStep("order_1")}, sagaAt)
	first := ValidateCompensation(session, plan)
	if !first.OK {
		t.Fatal("first compensation should succeed")
	}
	// Re-running the SAME plan is a replay — the comp idempotency key dedups.
	again := ValidateCompensation(session, plan)
	if !again.OK {
		t.Fatal("replaying the same plan should still be OK")
	}
	sofar, _, _ := session.RefundedSoFar("order_1")
	if sofar != 200 {
		t.Fatalf("refunded so far = %v, want 200 (not 400)", sofar)
	}
}

func TestSagaComposesWithF3ConflictOnStaleVersion(t *testing.T) {
	session := CreateSession(worldOf(sagaFulfilled("order_1", 200)))
	stale := CommitmentVersion(&session.World().Commitments[0])
	// A concurrent actor disputes the order — Fulfilled → Disputed is legal and advances
	// the version, so the planned Fulfilled version is now stale.
	disputed := ProposedAction{Commitment: "order_1", To: disputedStateMA(), Actor: "buyer"}
	if !session.Propose(disputed).OK {
		t.Fatal("the dispute should be accepted")
	}
	step := ForwardStep{Commitment: "order_1", To: gen.CommitmentState{Type: "Fulfilled"}, Actor: "seller", CompensateWith: refundStatePtr(100)}
	plan := PlanCompensation(session.World(), []ForwardStep{step}, sagaAt)
	// Stamp the stale version onto the planned compensation.
	if plan.Steps[0].Action != nil {
		plan.Steps[0].Action.ExpectedVersion = stale
	}
	result := ValidateCompensation(session, plan)
	if !result.Conflict {
		t.Fatal("expected a conflict on the stale-version compensation")
	}
}

func TestSagaUnwindsInReverseOrder(t *testing.T) {
	world := World{Commitments: []gen.Commitment{
		sagaFulfilled("order_A", 100),
		orderInState("order_B", 100, `{"type":"Active"}`),
	}}
	plan := PlanCompensation(world, []ForwardStep{
		fulfillStep("order_A"),
		{Commitment: "order_B", To: gen.CommitmentState{Type: "Active"}, Actor: "seller"},
	}, sagaAt)
	// forward = [A, B] → unwind = [B first, A second].
	if plan.Steps[0].Forward.Commitment != "order_B" {
		t.Fatalf("steps[0] = %s, want order_B", plan.Steps[0].Forward.Commitment)
	}
	if plan.Steps[1].Forward.Commitment != "order_A" {
		t.Fatalf("steps[1] = %s, want order_A", plan.Steps[1].Forward.Commitment)
	}
}

func refundStatePtr(amount float64) *gen.CommitmentState {
	s := refundState(amount)
	return &s
}
