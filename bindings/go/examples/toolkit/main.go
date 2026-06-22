// Runnable Go twin of the TS/Python/Rust toolkit examples — same verdicts. It
// walks the four flows in one program: guardrail, planning oracle, session
// coherence, and cross-platform interop.
//
// NOTE: the Go binding ships no platform inbound mappers, so the "platform
// objects" are built directly here (the shape the mappers would produce); Unify
// is platform-agnostic. No network, no execution — descriptors only.
//
//	go run ./examples/toolkit
package main

import (
	"encoding/json"
	"fmt"

	warp "github.com/yasirlts/warp-lang/bindings/go"
	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

func order(id string, amount float64) gen.Commitment {
	var c gen.Commitment
	j := fmt.Sprintf(`{"id":"%s","parties":{"initiator":"buyer","counterparty":"seller","intermediaries":[]},"subject":{"offered":[],"requested":[{"id":"v","form":{"kind":"Money","money":{"amount":%v,"currency":"MAD"}},"quantity":1,"state":{"type":"Available"}}]},"state":{"type":"Fulfilled"},"history":[],"children":[],"created_at":"2026-01-02T08:00:00.000Z"}`, id, amount)
	if err := json.Unmarshal([]byte(j), &c); err != nil {
		panic(err)
	}
	return c
}

func refund(amount float64) gen.CommitmentState {
	at := "2026-02-01T00:00:00.000Z"
	return gen.CommitmentState{Type: "Refunded", Amount: &gen.Money{Amount: amount, Currency: "MAD"}, At: &at}
}

func bounded(a warp.TransitionAlternative) string {
	if a.Bounded != nil {
		return *a.Bounded
	}
	return ""
}

func main() {
	world := warp.World{Commitments: []gen.Commitment{order("order_1", 200)}}

	fmt.Println("== guardrail ==")
	rev := warp.GuardAction(world, warp.ProposedAction{Commitment: "order_1", To: gen.CommitmentState{Type: "Accepted"}, Actor: "agent"})
	fmt.Printf("BLOCKED [%s] %s\n", rev.Violations[0].Rule, rev.Violations[0].Message)
	over := warp.GuardAction(world, warp.ProposedAction{Commitment: "order_1", To: refund(500), Actor: "agent"})
	fmt.Printf("BLOCKED [%s] %s\n", over.Violations[0].Rule, over.Violations[0].Message)
	ok := warp.GuardAction(world, warp.ProposedAction{Commitment: "order_1", To: refund(200), Actor: "agent"})
	fmt.Printf("refund (200 MAD) approved? %v\n", ok.OK)

	fmt.Println("\n== planning oracle ==")
	fmt.Printf("Legal moves from Fulfilled: %v\n", warp.ValidTransitions(gen.CommitmentState{Type: "Fulfilled"}))
	for _, a := range rev.Alternatives {
		fmt.Printf("  - %s (%s)\n", a.To, a.Label)
	}
	for _, a := range over.Alternatives {
		if a.To == "Refunded" {
			fmt.Printf("over-refund: Refunded is legal but bounded: %s\n", bounded(a))
		}
	}

	fmt.Println("\n== session coherence ==")
	s := warp.CreateSession(warp.World{Commitments: []gen.Commitment{order("order_1", 200)}})
	for _, amt := range []float64{80, 80, 80} {
		v := s.Propose(warp.ProposedAction{Commitment: "order_1", To: refund(amt), Actor: "agent"})
		sofar, _, _ := s.RefundedSoFar("order_1")
		if v.OK {
			fmt.Printf("refund %.0f MAD -> accepted. refunded so far: %.0f MAD\n", amt, sofar)
		} else {
			fmt.Printf("refund %.0f MAD -> BLOCKED [%s] %s\n", amt, v.Violations[0].Rule, v.Violations[0].Message)
			fmt.Printf("bounded: %s | refunded so far (unchanged): %.0f MAD\n", bounded(v.Alternatives[0]), sofar)
		}
	}
	corrected := s.Propose(warp.ProposedAction{Commitment: "order_1", To: refund(40), Actor: "agent"})
	total, _, _ := s.RefundedSoFar("order_1")
	fmt.Printf("corrected refund 40 MAD -> accepted: %v. total: %.0f MAD (order is now %s)\n", corrected.OK, total, s.World().Commitments[0].State.Type)

	fmt.Println("\n== cross-platform interop ==")
	id := "order_123"
	u := warp.Unify([]warp.UnifySource{{Platform: "shopify", Commitment: order("order_123", 200)}, {Platform: "stripe", Commitment: order("pi_abc", 200)}}, &id)
	fmt.Printf("unify (200 == 200) -> ok: %v, commitment '%s' state %s\n", u.OK, u.Commitment.Id, u.Commitment.State.Type)
	action := warp.ProposedAction{Commitment: "order_123", To: refund(40), Actor: "agent"}
	if warp.GuardAction(*u.World, action).OK {
		desc := warp.ToStripeAction(action).Descriptor
		fmt.Printf("emit (no API call — a descriptor only): %v\n", desc)
	}
	mism := warp.Unify([]warp.UnifySource{{Platform: "shopify", Commitment: order("order_123", 200)}, {Platform: "stripe", Commitment: order("pi_short", 150)}}, nil)
	fmt.Printf("unify (200 vs 150) -> BLOCKED [%s]: %s\n", mism.Violations[0].Rule, mism.Violations[0].Message)
}
