// Package warp is the hand-written behavioral runtime for the Warp Commerce
// Model Go binding — a faithful port of the normative conformance runner
// `conformance/runner/run.mjs` (and its Rust sibling
// `crates/warp-commerce-types/src/runtime.rs`).
//
// Everything here mirrors run.mjs line-by-line: currencyDecimals, moneyEquals,
// isValidTransition (incl. the documented fulfillment Failed -> Planned
// recoverable-only special case), the six-invariant auditScene, and the
// breakdownRule / money_breakdown_sum rule. It consumes the schema-generated
// types in the `generated` package.
package warp

import (
	"math"
	"sort"
	"strconv"

	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

// ===========================================================================
// Money precision — ZERO_DECIMAL / THREE_DECIMAL sets exactly as run.mjs.
// ===========================================================================

var zeroDecimal = map[string]bool{
	"JPY": true, "KRW": true, "VND": true, "CLP": true, "ISK": true, "XAF": true,
	"XOF": true, "XPF": true, "BIF": true, "DJF": true, "GNF": true, "KMF": true,
	"MGA": true, "PYG": true, "RWF": true, "UGX": true, "VUV": true,
}

var threeDecimal = map[string]bool{
	"TND": true, "BHD": true, "KWD": true, "OMR": true, "JOD": true,
}

func upper(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'a' && b[i] <= 'z' {
			b[i] -= 32
		}
	}
	return string(b)
}

// CurrencyDecimals returns the minor-unit decimal places for a currency code.
func CurrencyDecimals(c string) int {
	u := upper(c)
	if zeroDecimal[u] {
		return 0
	}
	if threeDecimal[u] {
		return 3
	}
	return 2
}

// MoneyEquals reports equality within half a minor unit of currency c.
func MoneyEquals(a, b float64, c string) bool {
	return math.Abs(a-b) < 0.5*math.Pow(10, float64(-CurrencyDecimals(c)))
}

// ===========================================================================
// Transition validity — operates on the raw {type, ...} state, exactly like
// run.mjs isValidTransition(primitive, from, to).
// ===========================================================================

// State is a minimal view over a transition state: its discriminant `type`
// plus the optional `recoverable` flag used by the fulfillment special case.
type State struct {
	Type        string
	Recoverable *bool
}

func tableFor(primitive string) map[string][]string {
	switch primitive {
	case "commitment":
		return gen.CommitmentTransitions
	case "intent":
		return gen.IntentTransitions
	case "fulfillment":
		return gen.FulfillmentTransitions
	default:
		return nil
	}
}

// IsValidTransition is the table lookup plus the documented fulfillment
// Failed -> Planned special case (valid iff recoverable == true).
func IsValidTransition(primitive string, from, to State) bool {
	if primitive == "fulfillment" && from.Type == "Failed" {
		// Failed -> Planned is valid iff recoverable == true; every other
		// Failed -> X is rejected.
		if to.Type == "Planned" {
			return from.Recoverable != nil && *from.Recoverable
		}
		return false
	}
	table := tableFor(primitive)
	if table == nil {
		return false
	}
	for _, t := range table[from.Type] {
		if t == to.Type {
			return true
		}
	}
	return false
}

// ===========================================================================
// Money helpers for the scene audit — moneyOf / sumMoney.
// ===========================================================================

type sumResult struct {
	total *moneyTotal
	mixed bool
}

type moneyTotal struct {
	amount   float64
	currency string
}

// moneyOf returns the Money in a Value whose form is Money, else nil.
func moneyOf(v *gen.Value) (float64, string, bool) {
	if v == nil || v.Form == nil {
		return 0, "", false
	}
	if v.Form.Kind == "Money" && v.Form.Money != nil {
		return v.Form.Money.Amount, v.Form.Money.Currency, true
	}
	return 0, "", false
}

// sumMoney computes the first-currency total plus a mixed flag.
func sumMoney(values []*gen.Value) sumResult {
	var currencies []string
	var amount float64
	for _, v := range values {
		if amt, cur, ok := moneyOf(v); ok {
			seen := false
			for _, c := range currencies {
				if c == cur {
					seen = true
					break
				}
			}
			if !seen {
				currencies = append(currencies, cur)
			}
			amount += amt
		}
	}
	if len(currencies) == 0 {
		return sumResult{total: nil, mixed: false}
	}
	return sumResult{
		total: &moneyTotal{amount: amount, currency: currencies[0]},
		mixed: len(currencies) > 1,
	}
}

// ===========================================================================
// Commitment-state helpers — discriminant string + history reads.
// ===========================================================================

var acceptedOrLater = map[string]bool{
	"Accepted": true, "Active": true, "Modified": true, "PartiallyFulfilled": true,
	"Fulfilled": true, "Disputed": true, "Refunded": true,
}

// reachedAccepted: current state is Accepted-or-later, OR any history
// transition landed on Accepted.
func reachedAccepted(c *gen.Commitment) bool {
	if acceptedOrLater[c.State.Type] {
		return true
	}
	for _, h := range c.History {
		if h.To.Type == "Accepted" {
			return true
		}
	}
	return false
}

// acceptedAt: the `at` timestamp of the first transition to Accepted, or nil.
func acceptedAt(c *gen.Commitment) *string {
	for i := range c.History {
		if c.History[i].To.Type == "Accepted" {
			at := c.History[i].At
			return &at
		}
	}
	return nil
}

// ===========================================================================
// Timestamp ordering — run.mjs uses Date.parse (epoch ms). The fixtures only
// COMPARE two timestamps, so we parse the ISO date-time fields to a comparable
// integer and fall back to lexicographic compare (order-equivalent for the
// well-formed ISO strings the fixtures use).
// ===========================================================================

func parseEpochMs(s string) (int64, bool) {
	if len(s) < 19 || s[4] != '-' || s[7] != '-' || (s[10] != 'T' && s[10] != ' ') {
		return 0, false
	}
	atoi := func(sub string) (int64, bool) {
		n, err := strconv.ParseInt(sub, 10, 64)
		return n, err == nil
	}
	year, ok1 := atoi(s[0:4])
	month, ok2 := atoi(s[5:7])
	day, ok3 := atoi(s[8:10])
	hour, ok4 := atoi(s[11:13])
	minute, ok5 := atoi(s[14:16])
	sec, ok6 := atoi(s[17:19])
	if !(ok1 && ok2 && ok3 && ok4 && ok5 && ok6) {
		return 0, false
	}
	a := (14 - month) / 12
	y := year + 4800 - a
	m := month + 12*a - 3
	jdn := day + (153*m+2)/5 + 365*y + y/4 - y/100 + y/400 - 32045
	return ((jdn*24+hour)*60+minute)*60_000 + sec*1000, true
}

// timestampLt compares two timestamps the way Date.parse(a) < Date.parse(b) does.
func timestampLt(a, b string) bool {
	if x, ok1 := parseEpochMs(a); ok1 {
		if yv, ok2 := parseEpochMs(b); ok2 {
			return x < yv
		}
	}
	return a < b // fallback: lexicographic, order-equivalent for ISO strings
}

// ===========================================================================
// The six-invariant scene audit — port of run.mjs auditScene.
// ===========================================================================

// AuditScene returns the sorted, unique invariant ids violated ("I-1".."I-6").
// An empty result means the scene is accepted.
func AuditScene(commitments []gen.Commitment, fulfillments []gen.Fulfillment, parties []gen.Party) []string {
	out := map[string]bool{}

	capByParty := map[string]*gen.PartyCapacity{}
	for i := range parties {
		capByParty[parties[i].Id] = &parties[i].Capacity
	}
	byID := map[string]*gen.Commitment{}
	for i := range commitments {
		byID[commitments[i].Id] = &commitments[i]
	}

	// I-1 no_currency_mixing
	for i := range commitments {
		c := &commitments[i]
		var all []*gen.Value
		for j := range c.Subject.Offered {
			all = append(all, &c.Subject.Offered[j])
		}
		for j := range c.Subject.Requested {
			all = append(all, &c.Subject.Requested[j])
		}
		if sumMoney(all).mixed {
			out["I-1"] = true
		}
	}
	// I-1 amount conservation (over-refund): a Refunded commitment's refund
	// amount must not exceed the original committed amount, in the same currency
	// (same-currency only; a cross-currency refund is a separate concern).
	for i := range commitments {
		c := &commitments[i]
		if c.State.Type == "Refunded" && c.State.Amount != nil {
			var requested []*gen.Value
			for j := range c.Subject.Requested {
				requested = append(requested, &c.Subject.Requested[j])
			}
			orig := sumMoney(requested).total
			r := c.State.Amount
			if orig != nil && string(r.Currency) == orig.currency && r.Amount > orig.amount && !MoneyEquals(r.Amount, orig.amount, orig.currency) {
				out["I-1"] = true
			}
		}
	}

	for i := range commitments {
		c := &commitments[i]

		// I-2 commitment transition table + timestamp monotonicity
		for _, h := range c.History {
			from := State{Type: h.From.Type}
			to := State{Type: h.To.Type}
			if !IsValidTransition("commitment", from, to) {
				out["I-2"] = true
			}
		}
		for j := 1; j < len(c.History); j++ {
			if timestampLt(c.History[j].At, c.History[j-1].At) {
				out["I-2"] = true
			}
		}

		// I-3 capacity before Accepted
		if cap, ok := capByParty[c.Parties.Initiator]; ok {
			if reachedAccepted(c) && !cap.CanBuy {
				out["I-3"] = true
			}
		}

		// I-4 fulfillment after accepted
		acc := acceptedAt(c)
		for j := range fulfillments {
			f := &fulfillments[j]
			if f.Commitment != c.Id {
				continue
			}
			executed := f.State.Type == "InProgress" || f.State.Type == "Completed"
			if executed && acc == nil {
				out["I-4"] = true
			} else if f.StartedAt != nil && acc != nil {
				if timestampLt(*f.StartedAt, *acc) {
					out["I-4"] = true
				}
			}
		}

		// I-6 tree sum
		if len(c.Children) > 0 {
			var kids []*gen.Commitment
			for _, id := range c.Children {
				if k, ok := byID[id]; ok {
					kids = append(kids, k)
				}
			}
			if len(kids) > 0 {
				var requested []*gen.Value
				for j := range c.Subject.Requested {
					requested = append(requested, &c.Subject.Requested[j])
				}
				parentSum := sumMoney(requested)
				if parentSum.total != nil {
					childAmt := 0.0
					currencies := map[string]bool{parentSum.total.currency: true}
					for _, k := range kids {
						var kreq []*gen.Value
						for j := range k.Subject.Requested {
							kreq = append(kreq, &k.Subject.Requested[j])
						}
						if s := sumMoney(kreq); s.total != nil {
							currencies[s.total.currency] = true
							childAmt += s.total.amount
						}
					}
					if len(currencies) > 1 || !MoneyEquals(childAmt, parentSum.total.amount, parentSum.total.currency) {
						out["I-6"] = true
					}
				}
			}
		}
	}

	// I-5 identity permanence (no duplicate ids across commitments/fulfillments/parties)
	seen := map[string]bool{}
	dup := false
	for i := range commitments {
		if seen[commitments[i].Id] {
			dup = true
		}
		seen[commitments[i].Id] = true
	}
	for i := range fulfillments {
		if seen[fulfillments[i].Id] {
			dup = true
		}
		seen[fulfillments[i].Id] = true
	}
	for i := range parties {
		if seen[parties[i].Id] {
			dup = true
		}
		seen[parties[i].Id] = true
	}
	if dup {
		out["I-5"] = true
	}

	ids := make([]string, 0, len(out))
	for id := range out {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// ===========================================================================
// money_breakdown_sum — port of run.mjs breakdownRule.
// ===========================================================================

// BreakdownIsValid reports whether the breakdown is VALID (single currency
// across all components and the total, and components sum to the total within
// MoneyEquals tolerance). A false return is the money_breakdown_sum violation
// (the structural expression of Invariant 1).
func BreakdownIsValid(totalCurrency string, totalAmount float64, components []gen.MoneyComponent) bool {
	for _, c := range components {
		if c.Amount.Currency != totalCurrency {
			return false
		}
	}
	sum := 0.0
	for _, c := range components {
		sum += c.Amount.Amount
	}
	return MoneyEquals(sum, totalAmount, totalCurrency)
}
