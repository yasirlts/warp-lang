// Multi-object coherence (F6): refunds spread across a commitment TREE (a parent order
// and its line-item children) cannot cumulatively exceed the parent's committed amount,
// even when each individual refund is valid against its own child. Go twin of the TS /
// Python / Rust multi-object examples — same verdicts.
//
//	go run ./examples/multi_object
//
// The per-tree cap is ADDITIVE to the per-commitment cap and is keyed by the tree root.
package main

import (
	"encoding/json"
	"fmt"

	warp "github.com/yasirlts/warp-lang/bindings/go"
	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

func commitLinked(id string, amount float64, parent string, children []string) gen.Commitment {
	parentJSON := "null"
	if parent != "" {
		parentJSON = fmt.Sprintf("%q", parent)
	}
	childrenJSON, _ := json.Marshal(children)
	if children == nil {
		childrenJSON = []byte("[]")
	}
	var c gen.Commitment
	j := fmt.Sprintf(`{"id":"%s","parties":{"initiator":"buyer","counterparty":"seller","intermediaries":[]},"subject":{"offered":[],"requested":[{"id":"v","form":{"kind":"Money","money":{"amount":%v,"currency":"MAD"}},"quantity":1,"state":{"type":"Available"}}]},"state":{"type":"Fulfilled"},"history":[],"parent":%s,"children":%s,"created_at":"2026-01-02T08:00:00.000Z"}`, id, amount, parentJSON, string(childrenJSON))
	if err := json.Unmarshal([]byte(j), &c); err != nil {
		panic(err)
	}
	return c
}

func refund(id string, amount float64, key string) warp.ProposedAction {
	at := "2026-02-01T00:00:00.000Z"
	return warp.ProposedAction{Commitment: id, To: gen.CommitmentState{Type: "Refunded", Amount: &gen.Money{Amount: amount, Currency: "MAD"}, At: &at}, Actor: "agent", IdempotencyKey: key}
}

// treeTotal sums what has been refunded across the listed commitments in the tree.
func treeTotal(s *warp.Session, ids []string) float64 {
	total := 0.0
	for _, id := range ids {
		if amt, _, ok := s.RefundedSoFar(id); ok {
			total += amt
		}
	}
	return total
}

func okStr(b bool) string {
	if b {
		return "accepted"
	}
	return "rejected"
}

func main() {
	// A parent order (200 MAD) with two line-item children that reconcile via I-6.
	parent := commitLinked("order-1", 200, "", []string{"line-A", "line-B"})
	lineA := commitLinked("line-A", 100, "order-1", nil)
	lineB := commitLinked("line-B", 100, "order-1", nil)

	session := warp.CreateSession(warp.World{Commitments: []gen.Commitment{parent, lineA, lineB}})
	ids := []string{"order-1", "line-A", "line-B"}

	// Two line-item refunds, each <= its own child's committed (100). Individually valid.
	a := session.Propose(refund("line-A", 80, "a"))
	fmt.Printf("refund line-A 80 -> %s (tree refunded: %.0f MAD)\n", okStr(a.OK), treeTotal(session, ids))
	b := session.Propose(refund("line-B", 80, "b"))
	fmt.Printf("refund line-B 80 -> %s (tree refunded: %.0f MAD)\n", okStr(b.OK), treeTotal(session, ids))

	// A third refund — on the PARENT, 80 <= 200 on its own — but the TREE total would
	// reach 240 > 200. Caught at this step, with the remaining-refundable across the tree.
	over := session.Propose(refund("order-1", 80, "p"))
	if !over.OK {
		fmt.Printf("\nrefund order-1 80 -> BLOCKED [%s]\n", over.Violations[0].Rule)
		fmt.Printf("  %s\n", over.Violations[0].Message)
		if len(over.Alternatives) > 0 && over.Alternatives[0].Bounded != nil {
			fmt.Printf("  guidance: %s\n", *over.Alternatives[0].Bounded)
		}
	}

	// Corrected to the remaining 40 across the tree -> completes.
	fixed := session.Propose(refund("order-1", 40, "p2"))
	fmt.Printf("\ncorrected refund order-1 40 -> %s. tree refunded: %.0f MAD (== parent committed 200)\n",
		okStr(fixed.OK), treeTotal(session, ids))

	// A fully-valid tree: refund each child within the parent (100 + 100 = 200).
	p2 := commitLinked("order-2", 200, "", []string{"line-C", "line-D"})
	lc := commitLinked("line-C", 100, "order-2", nil)
	ld := commitLinked("line-D", 100, "order-2", nil)
	s2 := warp.CreateSession(warp.World{Commitments: []gen.Commitment{p2, lc, ld}})
	c := s2.Propose(refund("line-C", 100, "c"))
	d := s2.Propose(refund("line-D", 100, "d"))
	fmt.Printf("\nvalid tree: refund line-C 100 -> %v, line-D 100 -> %v (tree total 200 == parent 200, within the parent)\n", c.OK, d.OK)
}
