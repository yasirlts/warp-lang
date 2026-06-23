// Saga / compensation (F7): UNWIND a multi-step commerce flow as an explicit, validated
// sequence of compensating actions, and reject a compensation that would itself violate
// an invariant (e.g. an over-refund while reversing). Go twin of the TS / Python / Rust
// saga examples — same verdicts.
//
//	go run ./examples/saga
//
// Scope: Warp VALIDATES that a compensation sequence is coherent. It does NOT execute or
// orchestrate rollbacks on external systems — a plan is validated descriptors only.
package main

import (
	"encoding/json"
	"fmt"

	warp "github.com/yasirlts/warp-lang/bindings/go"
	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

const at = "2026-03-01T00:00:00.000Z"

func orderIn(id string, amount float64, stateJSON string) gen.Commitment {
	var c gen.Commitment
	j := fmt.Sprintf(`{"id":"%s","parties":{"initiator":"buyer","counterparty":"seller","intermediaries":[]},"subject":{"offered":[],"requested":[{"id":"v","form":{"kind":"Money","money":{"amount":%v,"currency":"MAD"}},"quantity":1,"state":{"type":"Available"}}]},"state":%s,"history":[],"children":[],"created_at":"2026-01-02T08:00:00.000Z"}`, id, amount, stateJSON)
	if err := json.Unmarshal([]byte(j), &c); err != nil {
		panic(err)
	}
	return c
}

func refundState(amount float64) gen.CommitmentState {
	a := at
	return gen.CommitmentState{Type: "Refunded", Amount: &gen.Money{Amount: amount, Currency: "MAD"}, At: &a}
}

func refundStatePtr(amount float64) *gen.CommitmentState {
	s := refundState(amount)
	return &s
}

func finalState(world *warp.World, id string) string {
	for i := range world.Commitments {
		if string(world.Commitments[i].Id) == id {
			return world.Commitments[i].State.Type
		}
	}
	return "?"
}

func main() {
	// Forward flow: accept → fulfill → partial refund 50 of 200.
	// We drive a 200 MAD order to Fulfilled, then a partial refund of 50 is applied in a
	// session (the schema has no partial-refund state, so the session tracks it and keeps
	// the order in Fulfilled). This is the world we now need to UNWIND.
	session := warp.CreateSession(warp.World{Commitments: []gen.Commitment{orderIn("order-1", 200, `{"type":"Fulfilled"}`)}})
	p := session.Propose(warp.ProposedAction{Commitment: "order-1", To: refundState(50), Actor: "seller", IdempotencyKey: "partial-50"})
	sofar, _, _ := session.RefundedSoFar("order-1")
	fmt.Printf("forward flow: accept → fulfill → partial refund 50 → applied: %v. refunded so far: %.0f MAD of 200\n", p.OK, sofar)

	// INVALID compensation: reverse the Fulfilled step by refunding the FULL 200 again.
	// Validated IN THE SAME SESSION, so the 50 already refunded is counted: 50 + 200 =
	// 250 > 200. The session rejects it with the remaining-refundable guidance.
	overStep := warp.ForwardStep{Commitment: "order-1", To: gen.CommitmentState{Type: "Fulfilled"}, Actor: "seller", CompensateWith: refundStatePtr(200)}
	_, bad := warp.CompensateSession(session, []warp.ForwardStep{overStep}, at)
	if !bad.OK {
		fmt.Printf("\nINVALID compensation (refund full 200 while 50 already refunded) → BLOCKED at step %d [%s]\n", bad.FailedAt, bad.Violations[0].Rule)
		fmt.Printf("  %s\n", bad.Violations[0].Message)
		for _, a := range bad.Alternatives {
			if a.To == "Refunded" && a.Bounded != nil {
				fmt.Printf("  guidance: %s\n", *a.Bounded)
			}
		}
	}

	// VALID compensation: reverse the Fulfilled step by refunding the REMAINING 150. The
	// cumulative cap accepts it (50 + 150 = 200 == committed); the session marks the order
	// fully Refunded, and the world is coherent.
	okStep := warp.ForwardStep{Commitment: "order-1", To: gen.CommitmentState{Type: "Fulfilled"}, Actor: "seller", CompensateWith: refundStatePtr(150)}
	_, good := warp.CompensateSession(session, []warp.ForwardStep{okStep}, at)
	if good.OK {
		fmt.Printf("\nVALID compensation (refund the remaining 150) → applied: true\n")
		fmt.Printf("  compensating actions applied: %d, skipped: %d\n", good.Applied, good.Skipped)
		total, _, _ := session.RefundedSoFar("order-1")
		fmt.Printf("  refunded total: %.0f MAD; order-1 final state: %s (50 + 150 = 200 == committed; value conserved)\n", total, finalState(good.Next, "order-1"))
	}

	// Default mapping over a fresh accept→active flow unwound by Cancellation.
	leaseWorld := warp.World{Commitments: []gen.Commitment{orderIn("lease-1", 100, `{"type":"Active"}`)}}
	leasePlan, leaseResult := warp.Compensate(leaseWorld, []warp.ForwardStep{{Commitment: "lease-1", To: gen.CommitmentState{Type: "Active"}, Actor: "seller"}}, at)
	reversing := 0
	for _, s := range leasePlan.Steps {
		if s.Action != nil {
			reversing++
		}
	}
	fmt.Printf("\ndefault mapping: Active commitment unwound by Cancellation → applied: %v (plan reverses %d step)\n", leaseResult.OK, reversing)
	if leaseResult.OK {
		fmt.Printf("  lease-1 final state: %s (committed-but-not-delivered → Cancelled)\n", finalState(leaseResult.Next, "lease-1"))
	}
}
