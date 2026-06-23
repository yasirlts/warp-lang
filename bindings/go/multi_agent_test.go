package warp

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

func acceptedOrderMA(id string) gen.Commitment {
	var c gen.Commitment
	j := fmt.Sprintf(`{"id":"%s","parties":{"initiator":"buyer","counterparty":"seller","intermediaries":[]},"subject":{"offered":[],"requested":[{"id":"v","form":{"kind":"Money","money":{"amount":200,"currency":"MAD"}},"quantity":1,"state":{"type":"Available"}}]},"state":{"type":"Accepted"},"history":[],"children":[],"created_at":"2026-01-02T08:00:00.000Z"}`, id)
	if err := json.Unmarshal([]byte(j), &c); err != nil {
		panic(err)
	}
	return c
}

func draftOrderMA(id string) gen.Commitment {
	var c gen.Commitment
	j := fmt.Sprintf(`{"id":"%s","parties":{"initiator":"buyer","counterparty":"seller","intermediaries":[]},"subject":{"offered":[],"requested":[]},"state":{"type":"Draft"},"history":[],"children":[],"created_at":"2026-01-02T08:00:00.000Z"}`, id)
	if err := json.Unmarshal([]byte(j), &c); err != nil {
		panic(err)
	}
	return c
}

func disputedStateMA() gen.CommitmentState {
	var s gen.CommitmentState
	_ = json.Unmarshal([]byte(`{"type":"Disputed","by":"buyer","reason":"x","opened_at":"2026-03-01T00:00:00.000Z"}`), &s)
	return s
}

func refundByActor(id string, amount float64, actor, key string) ProposedAction {
	return ProposedAction{Commitment: id, To: refundState(amount), Actor: actor, IdempotencyKey: key}
}

func TestMACatchesCumulativeViolationAcrossActorsAttributed(t *testing.T) {
	s := CreateMultiAgentSession(World{Commitments: []gen.Commitment{fulfilledOrder("order_1", 200)}})
	if !s.Propose(refundByActor("order_1", 80, "agent-A", "a")).OK {
		t.Fatal("first refund should be accepted")
	}
	if !s.Propose(refundByActor("order_1", 80, "agent-B", "b")).OK {
		t.Fatal("second refund should be accepted")
	}
	third := s.Propose(refundByActor("order_1", 80, "agent-C", "c"))
	if third.OK {
		t.Fatal("expected rejection on the third refund")
	}
	if third.Violations[0].Rule != "I-1" {
		t.Fatalf("expected I-1, got %s", third.Violations[0].Rule)
	}
	if third.Actor != "agent-C" {
		t.Fatalf("expected tipping actor agent-C, got %s", third.Actor)
	}
	for _, want := range []string{"agent-C", "agent-A", "agent-B"} {
		if !strings.Contains(third.Attribution, want) {
			t.Fatalf("attribution %q missing %q", third.Attribution, want)
		}
	}
	if strings.Contains(third.Attribution, "conspir") {
		t.Fatal("attribution must not claim conspiracy/collusion")
	}
	// World did not advance past the two accepted refunds.
	sofar, _, _ := s.RefundedSoFar("order_1")
	if sofar != 160 {
		t.Fatalf("refunded so far = %v, want 160", sofar)
	}
}

func TestMASingleActorBehavesIdenticallyAttributionAdditive(t *testing.T) {
	s := CreateMultiAgentSession(World{Commitments: []gen.Commitment{fulfilledOrder("order_1", 200)}})
	s.Propose(refundByActor("order_1", 80, "solo", "a"))
	s.Propose(refundByActor("order_1", 80, "solo", "b"))
	third := s.Propose(refundByActor("order_1", 80, "solo", "c"))
	if third.OK {
		t.Fatal("expected rejection")
	}
	if third.Actor != "solo" {
		t.Fatalf("expected actor solo, got %s", third.Actor)
	}
	if !strings.Contains(third.Attribution, "no prior actions") {
		t.Fatalf("attribution %q should note no OTHER prior actors", third.Attribution)
	}
}

func TestMAValidSequenceCompletesWithSummaryAndLog(t *testing.T) {
	s := CreateMultiAgentSession(World{Commitments: []gen.Commitment{draftOrderMA("order_1")}})
	if !s.Propose(ProposedAction{Commitment: "order_1", To: gen.CommitmentState{Type: "Proposed"}, Actor: "buyer-agent"}).OK {
		t.Fatal("propose Proposed should be accepted")
	}
	if !s.Propose(ProposedAction{Commitment: "order_1", To: gen.CommitmentState{Type: "Accepted"}, Actor: "seller-agent"}).OK {
		t.Fatal("propose Accepted should be accepted")
	}
	if !s.Propose(ProposedAction{Commitment: "order_1", To: gen.CommitmentState{Type: "Active"}, Actor: "ops-agent"}).OK {
		t.Fatal("propose Active should be accepted")
	}
	if got := s.World().Commitments[0].State.Type; got != "Active" {
		t.Fatalf("final state = %s, want Active", got)
	}
	summary := s.ActorsSummary()
	for _, actor := range []string{"buyer-agent", "seller-agent", "ops-agent"} {
		if summary[actor] != 1 {
			t.Fatalf("actor %s count = %d, want 1", actor, summary[actor])
		}
	}
	wantOrder := []string{"buyer-agent", "seller-agent", "ops-agent"}
	for i, r := range s.Log() {
		if r.Actor != wantOrder[i] {
			t.Fatalf("log[%d] actor = %s, want %s", i, r.Actor, wantOrder[i])
		}
	}
}

func TestMAStaleVersionConflictAttributedToLateActor(t *testing.T) {
	s := CreateMultiAgentSession(World{Commitments: []gen.Commitment{acceptedOrderMA("order_1")}})
	planned := CommitmentVersion(&s.World().Commitments[0])

	a := ProposedAction{Commitment: "order_1", To: gen.CommitmentState{Type: "Active"}, Actor: "agent-A", ExpectedVersion: planned, IdempotencyKey: "A"}
	if !s.Propose(a).OK {
		t.Fatal("agent-A activate should be accepted")
	}
	b := ProposedAction{Commitment: "order_1", To: disputedStateMA(), Actor: "agent-B", ExpectedVersion: planned, IdempotencyKey: "B"}
	verdict := s.Propose(b)
	if !verdict.Conflict {
		t.Fatal("expected a conflict on the stale plan")
	}
	if verdict.Actor != "agent-B" {
		t.Fatalf("expected actor agent-B, got %s", verdict.Actor)
	}
	if !strings.Contains(verdict.Attribution, "conflict") {
		t.Fatalf("attribution %q should mention conflict", verdict.Attribution)
	}
}

func TestMAReplayBySameActorIsReplayAndNotDoubleLogged(t *testing.T) {
	s := CreateMultiAgentSession(World{Commitments: []gen.Commitment{fulfilledOrder("order_1", 200)}})
	first := s.Propose(refundByActor("order_1", 50, "agent-A", "k"))
	if !first.OK || first.Replay {
		t.Fatal("first refund should be accepted and not a replay")
	}
	retry := s.Propose(refundByActor("order_1", 50, "agent-A", "k"))
	if !retry.OK || !retry.Replay {
		t.Fatal("retry with same key should be an accepted replay")
	}
	if s.ActorsSummary()["agent-A"] != 1 {
		t.Fatalf("agent-A logged %d times, want 1 (replay applied nothing new)", s.ActorsSummary()["agent-A"])
	}
	sofar, _, _ := s.RefundedSoFar("order_1")
	if sofar != 50 {
		t.Fatalf("refunded so far = %v, want 50 (no double refund)", sofar)
	}
}
