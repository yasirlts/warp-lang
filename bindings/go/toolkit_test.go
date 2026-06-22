package warp

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

func fulfilledOrder(id string, amount float64) gen.Commitment {
	var c gen.Commitment
	j := fmt.Sprintf(`{"id":"%s","parties":{"initiator":"buyer","counterparty":"seller","intermediaries":[]},"subject":{"offered":[],"requested":[{"id":"v","form":{"kind":"Money","money":{"amount":%v,"currency":"MAD"}},"quantity":1,"state":{"type":"Available"}}]},"state":{"type":"Fulfilled"},"history":[],"children":[],"created_at":"2026-01-02T08:00:00.000Z"}`, id, amount)
	if err := json.Unmarshal([]byte(j), &c); err != nil {
		panic(err)
	}
	return c
}

func refundState(amount float64) gen.CommitmentState {
	at := "2026-02-01T00:00:00.000Z"
	return gen.CommitmentState{Type: "Refunded", Amount: &gen.Money{Amount: amount, Currency: "MAD"}, At: &at}
}

func refundAction(id string, amount float64) ProposedAction {
	return ProposedAction{Commitment: id, To: refundState(amount), Actor: "agent"}
}

func TestValidTransitionsEqualsTable(t *testing.T) {
	for from, tos := range gen.CommitmentTransitions {
		got := ValidTransitions(gen.CommitmentState{Type: from})
		want := append([]string{}, tos...)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("valid_transitions(%s) = %v, want %v", from, got, want)
		}
	}
}

func TestTerminalStatesEmpty(t *testing.T) {
	if len(ValidTransitions(gen.CommitmentState{Type: "Refunded"})) != 0 {
		t.Fatal("Refunded should have no transitions")
	}
	if len(ValidTransitions(gen.CommitmentState{Type: "Cancelled"})) != 0 {
		t.Fatal("Cancelled should have no transitions")
	}
}

func TestInvalidTransitionReturnsAlternatives(t *testing.T) {
	order := fulfilledOrder("order_1", 200)
	world := World{Commitments: []gen.Commitment{order}}
	r := GuardAction(world, ProposedAction{Commitment: "order_1", To: gen.CommitmentState{Type: "Accepted"}, Actor: "agent"})
	if r.OK {
		t.Fatal("expected rejection")
	}
	if r.Violations[0].Rule != "I-2" {
		t.Fatalf("rule = %s, want I-2", r.Violations[0].Rule)
	}
	tos := []string{}
	for _, a := range r.Alternatives {
		tos = append(tos, a.To)
	}
	if !reflect.DeepEqual(tos, []string{"Disputed", "Refunded"}) {
		t.Fatalf("alternatives = %v", tos)
	}
	for _, a := range r.Alternatives {
		if a.Bounded != nil {
			t.Fatal("no alternative should be bounded for a plain invalid transition")
		}
	}
}

func TestOverRefundMarksRefundedBounded(t *testing.T) {
	order := fulfilledOrder("order_1", 200)
	world := World{Commitments: []gen.Commitment{order}}
	r := GuardAction(world, refundAction("order_1", 500))
	if r.OK {
		t.Fatal("expected rejection")
	}
	hasI1 := false
	for _, v := range r.Violations {
		if v.Rule == "I-1" {
			hasI1 = true
		}
	}
	if !hasI1 {
		t.Fatal("expected I-1")
	}
	var refunded, disputed *TransitionAlternative
	for i := range r.Alternatives {
		switch r.Alternatives[i].To {
		case "Refunded":
			refunded = &r.Alternatives[i]
		case "Disputed":
			disputed = &r.Alternatives[i]
		}
	}
	if refunded == nil || refunded.Bounded == nil {
		t.Fatal("Refunded should be bounded")
	}
	if disputed == nil || disputed.Bounded != nil {
		t.Fatal("Disputed should not be bounded")
	}
}

func TestUnknownCommitment(t *testing.T) {
	r := GuardAction(World{}, ProposedAction{Commitment: "nope", To: gen.CommitmentState{Type: "Proposed"}, Actor: "a"})
	if r.OK || r.Violations[0].Rule != "unknown-commitment" {
		t.Fatal("expected unknown-commitment rejection")
	}
}

func TestSessionCatchesCumulativeOverRefund(t *testing.T) {
	order := fulfilledOrder("order_1", 200)
	s := CreateSession(World{Commitments: []gen.Commitment{order}})
	if !s.Propose(refundAction("order_1", 80)).OK {
		t.Fatal("first 80 should pass")
	}
	if !s.Propose(refundAction("order_1", 80)).OK {
		t.Fatal("second 80 should pass")
	}
	third := s.Propose(refundAction("order_1", 80))
	if third.OK {
		t.Fatal("third 80 should be rejected")
	}
	if third.Violations[0].Rule != "I-1" {
		t.Fatalf("rule = %s", third.Violations[0].Rule)
	}
	amt, _, _ := s.RefundedSoFar("order_1")
	if amt != 160 {
		t.Fatalf("ledger should be 160 after rejection, got %v", amt)
	}
}

func TestSessionFullRefundMovesToRefunded(t *testing.T) {
	order := fulfilledOrder("order_1", 200)
	s := CreateSession(World{Commitments: []gen.Commitment{order}})
	v := s.Propose(refundAction("order_1", 200))
	if !v.OK {
		t.Fatal("full refund should pass")
	}
	if s.World().Commitments[0].State.Type != "Refunded" {
		t.Fatalf("state = %s, want Refunded", s.World().Commitments[0].State.Type)
	}
}

func TestUnifyConserveAndMismatch(t *testing.T) {
	shop := fulfilledOrder("order_123", 200)
	stripe := fulfilledOrder("pi_abc", 200)
	id := "order_123"
	u := Unify([]UnifySource{{Platform: "shopify", Commitment: shop}, {Platform: "stripe", Commitment: stripe}}, &id)
	if !u.OK || string(u.Commitment.Id) != "order_123" {
		t.Fatal("expected unified order_123")
	}
	stripeBad := fulfilledOrder("pi_bad", 150)
	u2 := Unify([]UnifySource{{Platform: "shopify", Commitment: shop}, {Platform: "stripe", Commitment: stripeBad}}, nil)
	if u2.OK {
		t.Fatal("mismatch must be rejected, never auto-reconciled")
	}
	if u2.Violations[0].Rule != "I-1" {
		t.Fatalf("rule = %s, want I-1", u2.Violations[0].Rule)
	}
}

func TestEmittersAndNotRepresentable(t *testing.T) {
	refund := refundAction("order_123", 40)
	se := ToStripeAction(refund)
	if !se.OK || se.Descriptor["kind"] != "stripe.refund" || se.Descriptor["amount"] != int64(4000) || se.Descriptor["currency"] != "mad" {
		t.Fatalf("stripe descriptor = %v", se.Descriptor)
	}
	sh := ToShopifyAction(refund)
	if !sh.OK || sh.Descriptor["amount"] != "40" {
		t.Fatalf("shopify descriptor = %v", sh.Descriptor)
	}
	accept := ProposedAction{Commitment: "order_123", To: gen.CommitmentState{Type: "Accepted"}, Actor: "a"}
	nr := ToStripeAction(accept)
	if nr.OK || !reflect.ValueOf(nr.Reason).IsValid() {
		t.Fatal("expected not-representable")
	}
}
