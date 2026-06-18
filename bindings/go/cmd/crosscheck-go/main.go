// Command crosscheck-go emits the Go binding's verdict for every conformance
// fixture, as JSON.
//
// Runs each fixture through the CANONICAL Go binding (schema-generated types in
// bindings/go/generated + the hand-written runtime ported from
// conformance/runner/run.mjs). Used by conformance/tooling/crosscheck.mjs to
// prove TS, Python, Rust, and Go agree.
//
// Verdict shape per fixture (identical to crosscheck-{ts,python,rust}):
//
//	{ id, kind, runnable, verdict: "accept"|"reject"|null, rules:[], steps:[bool], note }
//
// runnable=false means this binding exposes no behavioral API for the fixture
// (state-catalog fixtures are structural — covered by the runner + JSON Schema).
//
// The conformance dir is read from env WARP_CONFORMANCE_DIR, defaulting to a
// path relative to the module (../../conformance). The verdict JSON array
// (manifest order, one per fixture) is written to STDOUT only.
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"

	warp "github.com/yasirlts/warp-lang/bindings/go"
	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

// record is the per-fixture verdict. rules/steps are initialised to empty
// (non-nil) slices so they serialise as [] and never null; verdict is a
// *string so it serialises as null when absent.
type record struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Runnable bool     `json:"runnable"`
	Verdict  *string  `json:"verdict"`
	Rules    []string `json:"rules"`
	Steps    []bool   `json:"steps"`
	Note     string   `json:"note"`
}

func conformanceDir() string {
	if dir := os.Getenv("WARP_CONFORMANCE_DIR"); dir != "" {
		return dir
	}
	// Default relative to the module root (bindings/go) → repo conformance/.
	return filepath.Join("..", "..", "conformance")
}

func loadJSON(root, rel string, out any) error {
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

// jsRound replicates JS Math.round (half away from +inf via floor(x+0.5)),
// matching crosscheck-rust's js_round and run.mjs's Math.round.
func jsRound(x float64) float64 {
	return math.Floor(x + 0.5)
}

func strptr(s string) *string { return &s }

// stateOf extracts the {type, recoverable} view a transition needs from a raw
// JSON state object.
func stateOf(raw json.RawMessage) warp.State {
	var probe struct {
		Type        string `json:"type"`
		Recoverable *bool  `json:"recoverable"`
	}
	_ = json.Unmarshal(raw, &probe)
	return warp.State{Type: probe.Type, Recoverable: probe.Recoverable}
}

type processed struct {
	verdict      *string
	rules        []string
	steps        []bool
	stateCatalog bool
	err          string
}

func processFixture(kind string, payload json.RawMessage) processed {
	switch kind {
	case "scene":
		var p struct {
			Parties      json.RawMessage `json:"parties"`
			Commitments  json.RawMessage `json:"commitments"`
			Fulfillments json.RawMessage `json:"fulfillments"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return processed{err: err.Error()}
		}
		var parties []gen.Party
		var commitments []gen.Commitment
		var fulfillments []gen.Fulfillment
		if err := json.Unmarshal(p.Parties, &parties); err != nil {
			return processed{err: err.Error()}
		}
		if err := json.Unmarshal(p.Commitments, &commitments); err != nil {
			return processed{err: err.Error()}
		}
		if err := json.Unmarshal(p.Fulfillments, &fulfillments); err != nil {
			return processed{err: err.Error()}
		}
		rules := warp.AuditScene(commitments, fulfillments, parties)
		v := "accept"
		if len(rules) > 0 {
			v = "reject"
		}
		if rules == nil {
			rules = []string{}
		}
		return processed{verdict: strptr(v), rules: rules}

	case "transition-sequence":
		var p struct {
			Primitive string          `json:"primitive"`
			Initial   json.RawMessage `json:"initial"`
			Steps     []struct {
				To json.RawMessage `json:"to"`
			} `json:"steps"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return processed{err: err.Error()}
		}
		cur := stateOf(p.Initial)
		steps := []bool{}
		for _, step := range p.Steps {
			to := stateOf(step.To)
			valid := warp.IsValidTransition(p.Primitive, cur, to)
			steps = append(steps, valid)
			if valid {
				cur = to
			}
		}
		return processed{verdict: strptr("accept"), steps: steps}

	case "money-roundtrip":
		var p struct {
			Cases []struct {
				Currency      string  `json:"currency"`
				MinorAmount   float64 `json:"minor_amount"`
				DecimalAmount float64 `json:"decimal_amount"`
			} `json:"cases"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return processed{err: err.Error()}
		}
		okAll := true
		for _, c := range p.Cases {
			f := math.Pow(10, float64(warp.CurrencyDecimals(c.Currency)))
			decimal := c.MinorAmount / f
			if decimal != c.DecimalAmount || jsRound(decimal*f) != c.MinorAmount {
				okAll = false
			}
		}
		v := "reject"
		if okAll {
			v = "accept"
		}
		return processed{verdict: strptr(v)}

	case "money-breakdown":
		var p struct {
			Total struct {
				Amount   float64 `json:"amount"`
				Currency string  `json:"currency"`
			} `json:"total"`
			Components json.RawMessage `json:"components"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return processed{err: err.Error()}
		}
		var components []gen.MoneyComponent
		if err := json.Unmarshal(p.Components, &components); err != nil {
			return processed{err: err.Error()}
		}
		if warp.BreakdownIsValid(p.Total.Currency, p.Total.Amount, components) {
			return processed{verdict: strptr("accept"), rules: []string{}}
		}
		return processed{verdict: strptr("reject"), rules: []string{"money_breakdown_sum"}}

	case "state-catalog":
		return processed{stateCatalog: true}

	default:
		return processed{err: fmt.Sprintf("unknown kind %s", kind)}
	}
}

func main() {
	root := conformanceDir()
	var manifest struct {
		Fixtures []struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
			Path string `json:"path"`
		} `json:"fixtures"`
	}
	if err := loadJSON(root, "manifest.json", &manifest); err != nil {
		fmt.Fprintf(os.Stderr, "cannot load manifest: %v\n", err)
		os.Exit(1)
	}

	out := make([]record, 0, len(manifest.Fixtures))
	for _, entry := range manifest.Fixtures {
		rec := record{
			ID:       entry.ID,
			Kind:     entry.Kind,
			Runnable: true,
			Verdict:  nil,
			Rules:    []string{},
			Steps:    []bool{},
			Note:     "",
		}

		var fx struct {
			Kind    string          `json:"kind"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := loadJSON(root, entry.Path, &fx); err != nil {
			rec.Runnable = false
			rec.Note = fmt.Sprintf("Go raised: %v", err)
			out = append(out, rec)
			continue
		}

		res := processFixture(entry.Kind, fx.Payload)
		switch {
		case res.stateCatalog:
			rec.Runnable = false
			rec.Note = "structural only — covered by runner + JSON Schema"
		case res.err != "":
			rec.Runnable = false
			rec.Note = fmt.Sprintf("Go raised: %s", res.err)
		default:
			rec.Verdict = res.verdict
			if res.rules != nil {
				rules := append([]string{}, res.rules...)
				sort.Strings(rules)
				rec.Rules = rules
			}
			if res.steps != nil {
				rec.Steps = res.steps
			}
		}
		out = append(out, rec)
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fmt.Fprintf(os.Stderr, "encode: %v\n", err)
		os.Exit(1)
	}
}
