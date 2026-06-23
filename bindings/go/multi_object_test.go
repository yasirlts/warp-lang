package warp

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

// commitLinked builds a Fulfilled commitment with optional parent / children links.
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

// tree builds a parent (200) with two 100-children that reconcile via I-6.
func tree(parentID string) []gen.Commitment {
	a := parentID + "-A"
	b := parentID + "-B"
	return []gen.Commitment{
		commitLinked(parentID, 200, "", []string{a, b}),
		commitLinked(a, 100, parentID, nil),
		commitLinked(b, 100, parentID, nil),
	}
}

func TestTreeCatchesCumulativeOverRefundSpreadAcrossChildren(t *testing.T) {
	s := CreateSession(World{Commitments: tree("order-1")})
	// Each child refund is <= its own committed (100) — individually valid.
	if !s.Propose(refundActionKeyed("order-1-A", 80, "a")).OK {
		t.Fatal("child-A refund 80 should be accepted")
	}
	if !s.Propose(refundActionKeyed("order-1-B", 80, "b")).OK {
		t.Fatal("child-B refund 80 should be accepted")
	}
	// Parent refund of 80 <= 200 on its own, but the TREE would reach 240 > 200.
	over := s.Propose(refundActionKeyed("order-1", 80, "p"))
	if over.OK {
		t.Fatal("expected the tree cap to reject the third refund")
	}
	if over.Violations[0].Rule != "I-1" {
		t.Fatalf("expected I-1, got %s", over.Violations[0].Rule)
	}
	if !strings.Contains(over.Violations[0].Message, "tree") {
		t.Fatalf("message %q should mention the tree", over.Violations[0].Message)
	}
	if !strings.Contains(over.Violations[0].Message, "240") || !strings.Contains(over.Violations[0].Message, "200") {
		t.Fatalf("message %q should mention 240 and 200", over.Violations[0].Message)
	}
	if over.Alternatives[0].Bounded == nil || !strings.Contains(*over.Alternatives[0].Bounded, "40") {
		t.Fatal("bounded alternative should report 40 remaining across the tree")
	}
}

func TestTreeCapsSumEvenWhenEachChildIsIndividuallyValid(t *testing.T) {
	s := CreateSession(World{Commitments: tree("order-1")})
	if !s.Propose(refundActionKeyed("order-1-A", 100, "a")).OK {
		t.Fatal("child-A refund 100 should be accepted")
	}
	if !s.Propose(refundActionKeyed("order-1-B", 100, "b")).OK {
		t.Fatal("child-B refund 100 should be accepted")
	}
	// The tree is now fully refunded; any further refund in it is capped.
	more := s.Propose(refundActionKeyed("order-1", 1, "p"))
	if more.OK {
		t.Fatal("a further refund on a fully-refunded tree should be rejected")
	}
}

func TestChildOverRefundStillCaughtPerCommitment(t *testing.T) {
	s := CreateSession(World{Commitments: tree("order-1")})
	// child-A committed 100; refunding 150 against it exceeds the CHILD itself.
	over := s.Propose(refundActionKeyed("order-1-A", 150, "a"))
	if over.OK {
		t.Fatal("per-child over-refund should be rejected")
	}
	if over.Violations[0].Rule != "I-1" {
		t.Fatalf("expected I-1, got %s", over.Violations[0].Rule)
	}
}

func TestStandaloneCommitmentUnchangedMessageIsPerCommitmentForm(t *testing.T) {
	s := CreateSession(World{Commitments: []gen.Commitment{fulfilledOrder("solo", 200)}})
	if !s.Propose(refundActionKeyed("solo", 120, "a")).OK {
		t.Fatal("standalone refund 120 should be accepted")
	}
	over := s.Propose(refundActionKeyed("solo", 100, "b")) // 220 > 200
	if over.OK {
		t.Fatal("standalone cumulative over-refund should be rejected")
	}
	if over.Violations[0].Rule != "I-1" {
		t.Fatalf("expected I-1, got %s", over.Violations[0].Rule)
	}
	// The standalone message is the per-commitment form, not the tree form.
	if strings.Contains(over.Violations[0].Message, "tree") {
		t.Fatalf("standalone message %q should not mention a tree", over.Violations[0].Message)
	}
}

func TestValidTreeOfRefundsWithinTheParentCompletes(t *testing.T) {
	s := CreateSession(World{Commitments: tree("order-1")})
	if !s.Propose(refundActionKeyed("order-1-A", 100, "a")).OK {
		t.Fatal("child-A refund 100 should be accepted")
	}
	if !s.Propose(refundActionKeyed("order-1-B", 100, "b")).OK {
		t.Fatal("child-B refund 100 should be accepted")
	}
}

func TestTreeReplayDoesNotDoubleCountTheTreeLedger(t *testing.T) {
	s := CreateSession(World{Commitments: tree("order-1")})
	if !s.Propose(refundActionKeyed("order-1-A", 80, "k")).OK {
		t.Fatal("child-A refund 80 should be accepted")
	}
	replay := s.Propose(refundActionKeyed("order-1-A", 80, "k")) // same key
	if !replay.Replay {
		t.Fatal("same-key retry should be a replay")
	}
	// Tree not double-counted: child-B committed only 100, so 120 fails per-child…
	if s.Propose(refundActionKeyed("order-1-B", 120, "b")).OK {
		t.Fatal("child-B 120 should fail per-child cap")
	}
	// …but 100 fits (tree 80 + 100 = 180 <= 200).
	if !s.Propose(refundActionKeyed("order-1-B", 100, "b2")).OK {
		t.Fatal("child-B 100 should fit within the tree (80 + 100 = 180 <= 200)")
	}
}
