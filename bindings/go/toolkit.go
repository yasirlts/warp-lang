// Agent toolkit — guardrail, planning oracle, session coherence, and interop.
//
// A COMPOSITION over the runtime (transition validity + the six-invariant scene
// audit) and the generated transition table, mirroring the TypeScript / Python /
// Rust toolkits behaviourally. It does NOT re-derive invariant or transition logic.
//
// Two binding notes, documented honestly (the Go runtime is conformance-focused —
// it deserializes scenes and audits them):
//   - AuditScene returns invariant id strings (e.g. "I-1"), not per-violation
//     descriptions, so the GuardViolation messages here are standard per-invariant
//     text. The VERDICT (which invariant fires) matches TS/Python/Rust exactly; the
//     message wording is binding-specific (as it already is across bindings).
//   - the runtime exposes no transition history-replay and no platform inbound
//     mappers. So GuardAction advances a commitment's state to build the next world
//     (the audit reads state vs subject for the over-refund check and validates
//     history independently, so the verdict is unaffected), and Unify is
//     platform-agnostic — callers map platform objects themselves.

package warp

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	gen "github.com/yasirlts/warp-lang/bindings/go/generated"
)

// World is the current commerce world the agent is acting on.
type World struct {
	Commitments  []gen.Commitment
	Fulfillments []gen.Fulfillment
	Parties      []gen.Party
}

// ProposedAction is a proposed commerce action: move one commitment to a new state.
type ProposedAction struct {
	Commitment string
	To         gen.CommitmentState
	Actor      string
	// IdempotencyKey gives a stable identity so a retried action is recognized as a
	// replay (see CreateSession); empty means none (a session derives a fingerprint).
	IdempotencyKey string
	// ExpectedVersion is the version the caller planned against (from
	// CommitmentVersion); if it no longer matches, the action is rejected as an
	// optimistic-concurrency conflict. Empty means unconditional. Both are runtime
	// inputs, NOT schema fields — the model schema stays frozen.
	ExpectedVersion string
}

// GuardViolation is one reason an action or world was rejected.
type GuardViolation struct {
	Rule    string
	Message string
	Fix     string
}

// TransitionAlternative is a legal target state from the current state — a move the
// agent may pick. These are LEGAL TRANSITIONS, not guaranteed-safe actions: a listed
// move is a valid transition; reaching it with particular data may still be rejected
// by another invariant. A nil Bounded does not promise safety.
type TransitionAlternative struct {
	To      string
	Label   string
	Bounded *string
}

// GuardResult is the guard's verdict. On success OK is true and Next carries the
// resulting world. On rejection OK is false and Violations / Alternatives explain it.
type GuardResult struct {
	OK           bool
	Next         *World
	Violations   []GuardViolation
	Alternatives []TransitionAlternative
	// Replay is true when this accepted result is a replay of an already-applied
	// action (a no-op — nothing was applied again).
	Replay bool
	// Conflict is set when the rejection is a stale-version CONFLICT (distinct from
	// an invariant violation); Expected/Actual are the planned vs current version.
	Conflict bool
	Expected string
	Actual   string
}

// ---------------------------------------------------------------------------
// Planning oracle
// ---------------------------------------------------------------------------

// ValidTransitions returns the legal target states from a commitment state — a pure
// read of the same gen.CommitmentTransitions table IsValidTransition consults.
// Terminal states return an empty slice.
func ValidTransitions(from gen.CommitmentState) []string {
	out := []string{}
	out = append(out, gen.CommitmentTransitions[from.Type]...)
	return out
}

func moveLabel(to string) string {
	switch to {
	case "Draft":
		return "return to draft"
	case "Proposed":
		return "propose to the counterparty"
	case "Tendered":
		return "tender as an open offer"
	case "Accepted":
		return "accept the commitment"
	case "Modified":
		return "modify the terms"
	case "PartiallyFulfilled":
		return "mark partially fulfilled"
	case "Active":
		return "activate the commitment"
	case "Fulfilled":
		return "mark fulfilled"
	case "Cancelled":
		return "cancel the commitment"
	case "Disputed":
		return "open a dispute"
	case "Refunded":
		return "refund the commitment"
	default:
		return to
	}
}

func fmtAmount(x float64) string {
	if x == math.Trunc(x) {
		return strconv.FormatInt(int64(x), 10)
	}
	return strconv.FormatFloat(x, 'f', -1, 64)
}

func strptr(s string) *string { return &s }

type boundHint struct {
	to         string
	constraint string
}

func commitmentAlternatives(from gen.CommitmentState, bound *boundHint) []TransitionAlternative {
	out := []TransitionAlternative{}
	for _, to := range ValidTransitions(from) {
		alt := TransitionAlternative{To: to, Label: moveLabel(to)}
		if bound != nil && bound.to == to {
			alt.Bounded = strptr(bound.constraint)
		}
		out = append(out, alt)
	}
	return out
}

func summarizeAlternatives(alts []TransitionAlternative) string {
	if len(alts) == 0 {
		return "There are no legal transitions from this state — it is terminal."
	}
	parts := make([]string, 0, len(alts))
	for _, a := range alts {
		if a.Bounded != nil {
			parts = append(parts, fmt.Sprintf("%s (%s)", a.To, *a.Bounded))
		} else {
			parts = append(parts, a.To)
		}
	}
	return "Legal transitions from here: " + strings.Join(parts, ", ") + "."
}

// violationFor attaches standard per-invariant text. AuditScene returns only the id;
// the VERDICT (the id) is what matches the other bindings.
func violationFor(rule string) GuardViolation {
	var message, fix string
	switch rule {
	case "I-1":
		message = "Value Conservation (I-1) violated — currency mixing in a subject, or a refund that exceeds what was committed."
		fix = "Keep one currency per subject (convert explicitly), and refund at most the committed amount."
	case "I-2":
		message = "State Monotonicity (I-2) violated — a transition not in the model's table, or backdated history."
		fix = "Only the model's valid transitions are allowed; model a reversal as a new forward commitment."
	case "I-3":
		message = "Capacity Verification (I-3) violated — reached Accepted without a verified capacity."
		fix = "Verify party capacity (can_buy) before accepting."
	case "I-4":
		message = "Temporal Integrity (I-4) violated — a fulfillment executing before its commitment was accepted."
		fix = "Accept the commitment before any fulfillment starts."
	case "I-5":
		message = "Identity Permanence (I-5) violated — an id appears more than once."
		fix = "Ids are globally unique and never reused; generate a fresh id."
	case "I-6":
		message = "Commitment Tree Consistency (I-6) violated — child values do not sum to the parent."
		fix = "Recalculate children so they sum to the parent within the minor-unit tolerance."
	default:
		message = "Invariant violated."
		fix = "See the Warp Commerce Model invariants."
	}
	return GuardViolation{Rule: rule, Message: message, Fix: fix}
}

func violationsFromIDs(ids []string) []GuardViolation {
	out := make([]GuardViolation, 0, len(ids))
	for _, id := range ids {
		out = append(out, violationFor(id))
	}
	return out
}

// committedMoney returns the single committed Money of a commitment (sum of
// subject.requested), composing the auditor's sumMoney.
func committedMoney(c *gen.Commitment) (float64, string, bool) {
	vals := make([]*gen.Value, 0, len(c.Subject.Requested))
	for j := range c.Subject.Requested {
		vals = append(vals, &c.Subject.Requested[j])
	}
	r := sumMoney(vals)
	if r.total == nil {
		return 0, "", false
	}
	return r.total.amount, r.total.currency, true
}

// ---------------------------------------------------------------------------
// Guardrail
// ---------------------------------------------------------------------------

func findCommitment(world *World, id string) *gen.Commitment {
	for i := range world.Commitments {
		if string(world.Commitments[i].Id) == id {
			return &world.Commitments[i]
		}
	}
	return nil
}

func overRefundBound(target *gen.Commitment, to gen.CommitmentState) *boundHint {
	if to.Type != "Refunded" || to.Amount == nil {
		return nil
	}
	committed, cur, ok := committedMoney(target)
	if !ok {
		return nil
	}
	if string(to.Amount.Currency) == cur && to.Amount.Amount > committed && !MoneyEquals(to.Amount.Amount, committed, cur) {
		return &boundHint{
			to: "Refunded",
			constraint: fmt.Sprintf(
				"refund at most the committed %s %s (a refund cannot exceed what was captured)",
				fmtAmount(committed), cur),
		}
	}
	return nil
}

// GuardAction guards a proposed transition-level action: validate the move against
// stateFingerprint is a short fingerprint of a commitment state — the type, plus
// the amount for a Refunded.
func stateFingerprint(s gen.CommitmentState) string {
	if s.Type == "Refunded" && s.Amount != nil {
		return fmt.Sprintf("Refunded:%v:%s", s.Amount.Amount, string(s.Amount.Currency))
	}
	return s.Type
}

// CommitmentVersion is the optimistic-concurrency version of a commitment, derived
// from its existing append-only history + state (history length + a state
// fingerprint) — NOT a schema field. A caller passes it back as
// ProposedAction.ExpectedVersion.
//
// Scope: OPTIMISTIC concurrency over the caller's view — it detects a stale plan. It
// is not a lock, distributed consensus, or a transaction manager; Warp does not
// serialize concurrent writers.
func CommitmentVersion(c *gen.Commitment) string {
	return fmt.Sprintf("%d:%s", len(c.History), stateFingerprint(c.State))
}

// checkVersion returns a CONFLICT result if expectedVersion is supplied and no
// longer matches the commitment's current version; else nil.
func checkVersion(target *gen.Commitment, expectedVersion string) *GuardResult {
	if expectedVersion == "" {
		return nil
	}
	actual := CommitmentVersion(target)
	if expectedVersion == actual {
		return nil
	}
	return &GuardResult{
		OK:       false,
		Conflict: true,
		Expected: expectedVersion,
		Actual:   actual,
		Violations: []GuardViolation{{
			Rule: "version-conflict",
			Message: fmt.Sprintf("This action was planned against version '%s', but commitment '%s' is now at version '%s' — it changed since you planned (a concurrent actor advanced it). The change conflicts, so it was not applied.",
				expectedVersion, target.Id, actual),
			Fix: "Re-read the commitment, recompute its version with CommitmentVersion(), and re-plan your action against the current version. This is optimistic concurrency — Warp detects the stale plan; it does not lock or serialize writers.",
		}},
	}
}

// actionKey is the identity of an action for replay detection: an explicit
// IdempotencyKey, else a fingerprint of commitment + target type + amount (for a
// Refunded) + actor.
func actionKey(action ProposedAction) string {
	if action.IdempotencyKey != "" {
		return "key:" + action.IdempotencyKey
	}
	parts := []string{action.Commitment, action.To.Type, action.Actor}
	if action.To.Type == "Refunded" && action.To.Amount != nil {
		parts = append(parts, fmt.Sprintf("%v", action.To.Amount.Amount), string(action.To.Amount.Currency))
	}
	return "fp:" + strings.Join(parts, "|")
}

// the table, advance the target's state, and audit the resulting world — composing
// IsValidTransition + AuditScene. Never panics on rejection.
func GuardAction(world World, action ProposedAction) GuardResult {
	target := findCommitment(&world, action.Commitment)
	if target == nil {
		return GuardResult{
			OK: false,
			Violations: []GuardViolation{{
				Rule:    "unknown-commitment",
				Message: fmt.Sprintf("No commitment '%s' exists in the current world; an action must target a commitment that is present.", action.Commitment),
				Fix:     "Reference a commitment id that exists in the world you pass to GuardAction.",
			}},
		}
	}

	// Optimistic-concurrency check: a stale ExpectedVersion means the commitment
	// advanced under the caller — reject as a CONFLICT (distinct from an invariant
	// violation). Backward-compatible: empty ExpectedVersion is a no-op.
	if conflict := checkVersion(target, action.ExpectedVersion); conflict != nil {
		return *conflict
	}

	if !IsValidTransition("commitment", State{Type: target.State.Type}, State{Type: action.To.Type}) {
		alternatives := commitmentAlternatives(target.State, nil)
		v := violationFor("I-2")
		v.Message = fmt.Sprintf("Commitment cannot transition from '%s' to '%s' — not a valid transition (Invariant 2: State Monotonicity).", target.State.Type, action.To.Type)
		v.Fix = "Only the model's valid transitions are allowed. " + summarizeAlternatives(alternatives) + " Pick one of those, or model a reversal as a new forward commitment."
		return GuardResult{OK: false, Violations: []GuardViolation{v}, Alternatives: alternatives}
	}

	// Build the next world: the target commitment, with its state advanced.
	next := World{
		Commitments:  make([]gen.Commitment, len(world.Commitments)),
		Fulfillments: world.Fulfillments,
		Parties:      world.Parties,
	}
	copy(next.Commitments, world.Commitments)
	for i := range next.Commitments {
		if string(next.Commitments[i].Id) == action.Commitment {
			next.Commitments[i].State = action.To
		}
	}

	ids := AuditScene(next.Commitments, next.Fulfillments, next.Parties)
	if len(ids) > 0 {
		bound := overRefundBound(target, action.To)
		return GuardResult{
			OK:           false,
			Violations:   violationsFromIDs(ids),
			Alternatives: commitmentAlternatives(target.State, bound),
		}
	}

	return GuardResult{OK: true, Next: &next}
}

// GuardObject guards a fully-constructed world (the object-level case). A thin layer
// over AuditScene.
func GuardObject(commitments []gen.Commitment, fulfillments []gen.Fulfillment, parties []gen.Party) GuardResult {
	ids := AuditScene(commitments, fulfillments, parties)
	if len(ids) > 0 {
		return GuardResult{OK: false, Violations: violationsFromIDs(ids)}
	}
	return GuardResult{OK: true, Next: &World{Commitments: commitments, Fulfillments: fulfillments, Parties: parties}}
}

// ---------------------------------------------------------------------------
// Session coherence
// ---------------------------------------------------------------------------

type tally struct {
	amount   float64
	currency string
	count    int
}

// Session is a stateful sequence validator over an accumulating world.
type Session struct {
	world  World
	ledger map[string]*tally
	// applied holds keys of actions ALREADY APPLIED. Per-session, in-memory —
	// durable cross-session idempotency is not provided (see the docs).
	applied map[string]bool
}

// CreateSession returns a Session holding the given world.
func CreateSession(world World) *Session {
	return &Session{world: world, ledger: map[string]*tally{}, applied: map[string]bool{}}
}

// World returns the current accumulated world.
func (s *Session) World() World { return s.world }

// RefundedSoFar returns the amount refunded so far for a commitment, or (0,"",false).
func (s *Session) RefundedSoFar(commitmentID string) (float64, string, bool) {
	t, ok := s.ledger[commitmentID]
	if !ok {
		return 0, "", false
	}
	return t.amount, t.currency, true
}

func isCumulativeOverRefund(order *gen.Commitment, total float64, currency string) bool {
	probe := *order
	at := order.CreatedAt
	probe.State = gen.CommitmentState{Type: "Refunded", Amount: &gen.Money{Amount: total, Currency: currency}, At: &at}
	probe.History = nil
	for _, id := range AuditScene([]gen.Commitment{probe}, nil, nil) {
		if id == "I-1" {
			return true
		}
	}
	return false
}

// Propose validates action against the accumulated world (and the cross-step refund
// ledger), applies it on success, and returns the same verdict as GuardAction. On
// rejection the world is not advanced.
func (s *Session) Propose(action ProposedAction) GuardResult {
	// Ordering: replay → conflict → process. A same-key retry is a replay (no-op);
	// a different action planned against a stale version is a conflict.
	key := actionKey(action)
	if s.applied[key] {
		w := s.world
		return GuardResult{OK: true, Next: &w, Replay: true}
	}
	if c := findCommitment(&s.world, action.Commitment); c != nil {
		if conflict := checkVersion(c, action.ExpectedVersion); conflict != nil {
			return *conflict
		}
	}

	if action.To.Type == "Refunded" && action.To.Amount != nil {
		order := findCommitment(&s.world, action.Commitment)
		if order == nil || !IsValidTransition("commitment", State{Type: order.State.Type}, State{Type: "Refunded"}) {
			return GuardAction(s.world, action)
		}
		committed, cur, ok := committedMoney(order)
		if ok && string(action.To.Amount.Currency) == cur {
			priorAmt, priorCount := 0.0, 0
			if t, has := s.ledger[action.Commitment]; has {
				priorAmt, priorCount = t.amount, t.count
			}
			cumulative := priorAmt + action.To.Amount.Amount

			if isCumulativeOverRefund(order, cumulative, cur) {
				remaining := math.Max(0, committed-priorAmt)
				bounded := fmt.Sprintf("cumulative refunds must stay within the committed %s %s; %s %s remains refundable",
					fmtAmount(committed), cur, fmtAmount(remaining), cur)
				return GuardResult{
					OK: false,
					Violations: []GuardViolation{{
						Rule: "I-1",
						Message: fmt.Sprintf("Cumulative refunds on %s would reach %s %s across %d refund(s), but only %s %s was committed — value is not conserved across the session (the point-in-time check sees each refund alone).",
							order.Id, fmtAmount(cumulative), cur, priorCount+1, fmtAmount(committed), cur),
						Fix: fmt.Sprintf("Refund at most the remaining %s %s (committed %s − already refunded %s).",
							fmtAmount(remaining), cur, fmtAmount(committed), fmtAmount(priorAmt)),
					}},
					Alternatives: []TransitionAlternative{{To: "Refunded", Label: moveLabel("Refunded"), Bounded: strptr(bounded)}},
				}
			}

			// Accepted refund. Keep the order Fulfilled for a PARTIAL refund;
			// transition to Refunded only once refunds reach committed.
			if MoneyEquals(cumulative, committed, cur) {
				verdict := GuardAction(s.world, action)
				if verdict.OK {
					s.world = *verdict.Next
					s.ledger[action.Commitment] = &tally{amount: cumulative, currency: cur, count: priorCount + 1}
					s.applied[key] = true
				}
				return verdict
			}
			s.ledger[action.Commitment] = &tally{amount: cumulative, currency: cur, count: priorCount + 1}
			s.applied[key] = true
			w := s.world
			return GuardResult{OK: true, Next: &w}
		}
	}

	verdict := GuardAction(s.world, action)
	if verdict.OK {
		s.world = *verdict.Next
		s.applied[key] = true
	}
	return verdict
}

// ---------------------------------------------------------------------------
// Interop CIR — unification (inbound) + emission (outbound)
// ---------------------------------------------------------------------------

// UnifySource is a platform object ALREADY mapped to a Warp commitment. Passing
// several to Unify is how the caller ASSERTS they correspond.
type UnifySource struct {
	Platform   string
	Commitment gen.Commitment
}

// UnifyResult is the outcome of unifying corresponded sources.
type UnifyResult struct {
	OK         bool
	Commitment *gen.Commitment
	World      *World
	Violations []GuardViolation
}

// Unify merges corresponded platform objects into one validated Warp commitment.
// The first source is the primary; every other source must conserve value against
// it (same currency, equal within the I-1 tolerance). A disagreement is an I-1
// violation. The merged commitment is validated by GuardObject. The correspondence
// is the caller's assertion — Unify does NOT infer it.
func Unify(sources []UnifySource, id *string) UnifyResult {
	if len(sources) == 0 {
		return UnifyResult{
			OK: false,
			Violations: []GuardViolation{{
				Rule:    "unify-empty",
				Message: "unify requires at least one mapped platform source.",
				Fix:     "Map each platform object with its inbound adapter and pass the corresponding ones together.",
			}},
		}
	}
	primary := sources[0]
	pa, pc, pok := committedMoney(&primary.Commitment)

	var violations []GuardViolation
	for _, other := range sources[1:] {
		oa, oc, ook := committedMoney(&other.Commitment)
		if !pok || !ook {
			continue
		}
		if oc != pc || !MoneyEquals(oa, pa, pc) {
			violations = append(violations, GuardViolation{
				Rule: "I-1",
				Message: fmt.Sprintf("Corresponded sources do not conserve value: %s commits %s %s but %s commits %s %s. Value is not conserved across the unified transaction.",
					primary.Platform, fmtAmount(pa), pc, other.Platform, fmtAmount(oa), oc),
				Fix: "Confirm the objects truly correspond and that the amounts (and currency) match; a partial capture or fee belongs in its own Value.",
			})
		}
	}
	if len(violations) > 0 {
		return UnifyResult{OK: false, Violations: violations}
	}

	commitment := primary.Commitment
	if id != nil {
		commitment.Id = gen.CommitmentID(*id)
	}

	verdict := GuardObject([]gen.Commitment{commitment}, nil, nil)
	if !verdict.OK {
		return UnifyResult{OK: false, Violations: verdict.Violations}
	}
	return UnifyResult{OK: true, Commitment: &commitment, World: verdict.Next}
}

// EmitResult is the outcome of emitting a platform payload — a structured DESCRIPTOR
// (the call the app should make; it is NOT sent here), or an honest not-representable
// result. The emitters make no network calls, hold no credentials, and execute nothing.
type EmitResult struct {
	OK         bool
	Platform   string
	Descriptor map[string]any
	Reason     string
}

func notRepresentable(platform string, to gen.CommitmentState) EmitResult {
	return EmitResult{
		OK:       false,
		Platform: platform,
		Reason: fmt.Sprintf("A '%s' action has no faithful %s equivalent in this layer (covered: Refunded → refund, Cancelled → cancel). Handle it in the application, or extend the emitter.",
			to.Type, platform),
	}
}

// stripeMinor returns the Stripe minor-unit amount, composing CurrencyDecimals (the
// same per-currency precision the auditor uses) — no separate Stripe table.
func stripeMinor(m *gen.Money) int64 {
	factor := math.Pow(10, float64(CurrencyDecimals(string(m.Currency))))
	return int64(math.Round(m.Amount * factor))
}

// ToStripeAction emits a Stripe-shaped descriptor for a VALIDATED action.
func ToStripeAction(action ProposedAction) EmitResult {
	switch action.To.Type {
	case "Refunded":
		return EmitResult{OK: true, Platform: "stripe", Descriptor: map[string]any{
			"kind": "stripe.refund", "payment_intent": action.Commitment,
			"amount": stripeMinor(action.To.Amount), "currency": strings.ToLower(string(action.To.Amount.Currency)),
		}}
	case "Cancelled":
		return EmitResult{OK: true, Platform: "stripe", Descriptor: map[string]any{"kind": "stripe.cancel", "payment_intent": action.Commitment}}
	default:
		return notRepresentable("stripe", action.To)
	}
}

// ToShopifyAction emits a Shopify-shaped descriptor for a VALIDATED action.
func ToShopifyAction(action ProposedAction) EmitResult {
	switch action.To.Type {
	case "Refunded":
		return EmitResult{OK: true, Platform: "shopify", Descriptor: map[string]any{
			"kind": "shopify.refund", "order_id": action.Commitment,
			"amount": fmtAmount(action.To.Amount.Amount), "currency": string(action.To.Amount.Currency),
		}}
	case "Cancelled":
		return EmitResult{OK: true, Platform: "shopify", Descriptor: map[string]any{"kind": "shopify.cancel", "order_id": action.Commitment}}
	default:
		return notRepresentable("shopify", action.To)
	}
}

// ToWooCommerceAction emits a WooCommerce-shaped descriptor for a VALIDATED action.
func ToWooCommerceAction(action ProposedAction) EmitResult {
	switch action.To.Type {
	case "Refunded":
		return EmitResult{OK: true, Platform: "woocommerce", Descriptor: map[string]any{
			"kind": "woocommerce.refund", "order_id": action.Commitment,
			"amount": fmtAmount(action.To.Amount.Amount), "currency": string(action.To.Amount.Currency),
		}}
	case "Cancelled":
		return EmitResult{OK: true, Platform: "woocommerce", Descriptor: map[string]any{"kind": "woocommerce.cancel", "order_id": action.Commitment}}
	default:
		return notRepresentable("woocommerce", action.To)
	}
}
