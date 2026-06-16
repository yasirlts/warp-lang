package warp

import (
	"testing"

	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

func boolp(b bool) *bool { return &b }

func TestCurrencyDecimalsMatchesRunnerSets(t *testing.T) {
	cases := map[string]int{
		"MAD": 2, // default
		"usd": 2, // case-insensitive
		"JPY": 0, // zero-decimal
		"TND": 3, // three-decimal
		"PTS": 2, // open / custom defaults to 2
	}
	for c, want := range cases {
		if got := CurrencyDecimals(c); got != want {
			t.Errorf("CurrencyDecimals(%q) = %d, want %d", c, got, want)
		}
	}
}

func TestMoneyEqualsWithinHalfMinorUnit(t *testing.T) {
	// 0.1 + 0.2 != 0.3 in IEEE754, but equal within MAD tolerance.
	if !MoneyEquals(0.1+0.2, 0.3, "MAD") {
		t.Error("0.1+0.2 should equal 0.3 within MAD tolerance")
	}
	if MoneyEquals(1.0, 2.0, "MAD") {
		t.Error("1.0 should not equal 2.0")
	}
}

func TestFulfillmentFailedToPlannedIsRecoverableOnly(t *testing.T) {
	recoverable := State{Type: "Failed", Recoverable: boolp(true)}
	nonrecoverable := State{Type: "Failed", Recoverable: boolp(false)}
	planned := State{Type: "Planned"}
	inProgress := State{Type: "InProgress"}

	if !IsValidTransition("fulfillment", recoverable, planned) {
		t.Error("recoverable Failed -> Planned should be valid")
	}
	if IsValidTransition("fulfillment", nonrecoverable, planned) {
		t.Error("non-recoverable Failed -> Planned should be invalid")
	}
	// Failed -> anything-but-Planned is always rejected.
	if IsValidTransition("fulfillment", recoverable, inProgress) {
		t.Error("Failed -> InProgress should be invalid even if recoverable")
	}
}

func TestCommitmentTableRejectsBackward(t *testing.T) {
	accepted := State{Type: "Accepted"}
	proposed := State{Type: "Proposed"}
	cancelled := State{Type: "Cancelled"}
	if !IsValidTransition("commitment", accepted, cancelled) {
		t.Error("Accepted -> Cancelled should be valid")
	}
	if IsValidTransition("commitment", accepted, proposed) {
		t.Error("Accepted -> Proposed should be invalid (no backward edge)")
	}
}

func TestBreakdownSumRule(t *testing.T) {
	comp := func(amt float64, cur string) gen.MoneyComponent {
		return gen.MoneyComponent{
			Kind:   gen.MoneyComponentKindBase,
			Amount: gen.Money{Amount: amt, Currency: cur},
		}
	}
	// 80 + 16 + 10 - 6 == 100, single currency → valid.
	if !BreakdownIsValid("MAD", 100.0, []gen.MoneyComponent{
		comp(80.0, "MAD"), comp(16.0, "MAD"), comp(10.0, "MAD"), comp(-6.0, "MAD"),
	}) {
		t.Error("balanced single-currency breakdown should be valid")
	}
	// mixed currency → invalid.
	if BreakdownIsValid("MAD", 100.0, []gen.MoneyComponent{comp(100.0, "EUR")}) {
		t.Error("mixed-currency breakdown should be invalid")
	}
	// sum mismatch → invalid.
	if BreakdownIsValid("MAD", 100.0, []gen.MoneyComponent{comp(50.0, "MAD")}) {
		t.Error("sum-mismatch breakdown should be invalid")
	}
}
