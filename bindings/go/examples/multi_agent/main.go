// Multi-agent verification (F5): several named agents act on a SHARED world. Each
// action is individually valid, but their COMBINED sequence violates an invariant —
// Warp catches it at the offending step and attributes it to the actor whose action
// tipped the shared world into violation. Go twin of the TS / Python / Rust multi-agent
// examples — same verdicts (the attribution wording is this binding's own).
//
//	go run ./examples/multi_agent
//
// Scope: shared-world invariant enforcement WITH attribution. The attribution is the
// action that tipped the world over — NOT collusion or intent detection.
package main

import (
	"encoding/json"
	"fmt"

	warp "github.com/yasirlts/warp-lang/bindings/go"
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

func draftOrder(id string) gen.Commitment {
	var c gen.Commitment
	j := fmt.Sprintf(`{"id":"%s","parties":{"initiator":"buyer","counterparty":"seller","intermediaries":[]},"subject":{"offered":[],"requested":[]},"state":{"type":"Draft"},"history":[],"children":[],"created_at":"2026-01-02T08:00:00.000Z"}`, id)
	if err := json.Unmarshal([]byte(j), &c); err != nil {
		panic(err)
	}
	return c
}

func refund(amount float64, actor, key string) warp.ProposedAction {
	at := "2026-02-01T00:00:00.000Z"
	return warp.ProposedAction{Commitment: "order_1", To: gen.CommitmentState{Type: "Refunded", Amount: &gen.Money{Amount: amount, Currency: "MAD"}, At: &at}, Actor: actor, IdempotencyKey: key}
}

func okStr(b bool) string {
	if b {
		return "accepted"
	}
	return "rejected"
}

func main() {
	// A shipped (Fulfilled) order committed at 200 MAD, shared by several agents.
	session := warp.CreateMultiAgentSession(warp.World{Commitments: []gen.Commitment{fulfilledOrder("order_1", 200)}})

	// 1) A finance-agent refunds 120 MAD for damaged items — valid on its own.
	a := session.Propose(refund(120, "finance-agent", "fin-1"))
	sofar, _, _ := session.RefundedSoFar("order_1")
	fmt.Printf("finance-agent refunds 120 -> %s (refunded so far: %.0f MAD)\n", okStr(a.OK), sofar)

	// 2) A support-agent, unaware, refunds 100 MAD goodwill — valid ON ITS OWN, but the
	//    SHARED world now over-refunds (220 > 200). Caught and attributed to support-agent.
	b := session.Propose(refund(100, "support-agent", "sup-1"))
	if !b.OK {
		fmt.Printf("\nsupport-agent refunds 100 -> BLOCKED [%s]\n", b.Violations[0].Rule)
		fmt.Printf("  attribution: %s\n", b.Attribution)
		guidance := b.Violations[0].Fix
		for _, alt := range b.Alternatives {
			if alt.To == "Refunded" && alt.Bounded != nil {
				guidance = *alt.Bounded
			}
		}
		fmt.Printf("  guidance: %s\n", guidance)
	}

	// 3) support-agent reads the remaining-refundable guidance and corrects to 80 MAD.
	c := session.Propose(refund(80, "support-agent", "sup-2"))
	total, _, _ := session.RefundedSoFar("order_1")
	fmt.Printf("\nsupport-agent corrects to 80 -> %s. total refunded: %.0f MAD (order is now %s)\n",
		okStr(c.OK), total, session.World().Commitments[0].State.Type)
	fmt.Printf("who did what: %v\n", session.ActorsSummary())

	// 4) A fully-valid multi-agent sequence on a fresh order: buyer-agent proposes,
	//    seller-agent accepts, ops-agent activates — different actors, all valid.
	flow := warp.CreateMultiAgentSession(warp.World{Commitments: []gen.Commitment{draftOrder("order_2")}})
	p := flow.Propose(warp.ProposedAction{Commitment: "order_2", To: gen.CommitmentState{Type: "Proposed"}, Actor: "buyer-agent"})
	acc := flow.Propose(warp.ProposedAction{Commitment: "order_2", To: gen.CommitmentState{Type: "Accepted"}, Actor: "seller-agent"})
	act := flow.Propose(warp.ProposedAction{Commitment: "order_2", To: gen.CommitmentState{Type: "Active"}, Actor: "ops-agent"})
	fmt.Printf("\nvalid multi-agent flow -> proposed:%v accepted:%v activated:%v. state: %s; agents: %v\n",
		p.OK, acc.OK, act.OK, flow.World().Commitments[0].State.Type, flow.ActorsSummary())
}
