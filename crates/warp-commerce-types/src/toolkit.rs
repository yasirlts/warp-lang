//! Agent toolkit — guardrail, planning oracle, session coherence, and interop.
//!
//! A COMPOSITION over [`crate::runtime`] (transition validity + the six-invariant
//! scene audit) and the generated transition table, mirroring the TypeScript and
//! Python toolkits behaviourally. It does NOT re-derive invariant or transition
//! logic.
//!
//! Two binding notes, documented honestly rather than papered over (the Rust
//! runtime is conformance-focused — it deserializes scenes and audits them):
//!
//!   * `audit_scene` returns invariant *id strings* (e.g. `"I-1"`), not per-
//!     violation descriptions, so the [`GuardViolation`] messages here are
//!     standard per-invariant text. The VERDICT (which invariant fires) matches
//!     TS/Python exactly; the message wording is binding-specific (as it already
//!     is across bindings).
//!   * the runtime exposes no `transition_commitment` history-replay and no
//!     platform inbound mappers. So [`guard_action`] advances a commitment's
//!     *state* to build the next world (the audit reads state vs subject for the
//!     over-refund check and validates history independently, so the verdict is
//!     unaffected), and [`unify`] is platform-agnostic — callers map platform
//!     objects themselves (e.g. via `serde_json`).

use std::collections::HashMap;

use serde_json::json;

use crate::generated::transitions::COMMITMENT_TRANSITIONS;
use crate::generated::types::{Commitment, CommitmentState, Fulfillment, Money, Party};
use crate::runtime::{
    audit_scene, commitment_state_type, committed_money, currency_decimals, is_valid_transition,
    money_equals,
};

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/// The current commerce world the agent is acting on.
#[derive(Debug, Clone)]
pub struct World {
    pub commitments: Vec<Commitment>,
    pub fulfillments: Vec<Fulfillment>,
    pub parties: Vec<Party>,
}

/// A proposed commerce action: move one commitment in the world to a new state.
#[derive(Debug, Clone)]
pub struct ProposedAction {
    pub commitment: String,
    pub to: CommitmentState,
    pub actor: String,
}

/// One reason an action or world was rejected — written for an agent to act on.
#[derive(Debug, Clone)]
pub struct GuardViolation {
    pub rule: String,
    pub message: String,
    pub fix: String,
}

/// A legal target state from the current state — a move the agent may pick.
///
/// These are LEGAL TRANSITIONS from the current state, read from the transition
/// table — NOT guaranteed-safe actions. A listed move is a valid state
/// transition; reaching it with particular data may still be rejected by another
/// invariant. The absence of `bounded` does not promise safety.
#[derive(Debug, Clone)]
pub struct TransitionAlternative {
    pub to: String,
    pub label: String,
    pub bounded: Option<String>,
}

/// The guard's verdict — `Accepted` carries the resulting world; `Rejected`
/// carries the violations and (when applicable) the legal alternatives.
#[derive(Debug, Clone)]
pub enum GuardResult {
    Accepted {
        next: World,
    },
    Rejected {
        violations: Vec<GuardViolation>,
        alternatives: Vec<TransitionAlternative>,
    },
}

impl GuardResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, GuardResult::Accepted { .. })
    }
}

// ---------------------------------------------------------------------------
// Planning oracle — the move-enumeration primitive
// ---------------------------------------------------------------------------

/// The legal target states from a commitment state — a pure read of the same
/// `COMMITMENT_TRANSITIONS` table `is_valid_transition` consults. Terminal states
/// return an empty vector.
pub fn valid_transitions(from: &CommitmentState) -> Vec<String> {
    let ft = commitment_state_type(from);
    COMMITMENT_TRANSITIONS
        .iter()
        .find(|(k, _)| *k == ft)
        .map(|(_, tos)| tos.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

fn move_label(to: &str) -> String {
    match to {
        "Draft" => "return to draft",
        "Proposed" => "propose to the counterparty",
        "Tendered" => "tender as an open offer",
        "Accepted" => "accept the commitment",
        "Modified" => "modify the terms",
        "PartiallyFulfilled" => "mark partially fulfilled",
        "Active" => "activate the commitment",
        "Fulfilled" => "mark fulfilled",
        "Cancelled" => "cancel the commitment",
        "Disputed" => "open a dispute",
        "Refunded" => "refund the commitment",
        other => other,
    }
    .to_string()
}

fn fmt_amount(x: f64) -> String {
    if x.fract() == 0.0 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

/// The legal moves from `from`; if `bounded` matches a target, annotate it.
fn commitment_alternatives(
    from: &CommitmentState,
    bounded: Option<(String, String)>,
) -> Vec<TransitionAlternative> {
    valid_transitions(from)
        .into_iter()
        .map(|to| {
            let b = bounded
                .as_ref()
                .filter(|(bt, _)| *bt == to)
                .map(|(_, c)| c.clone());
            TransitionAlternative {
                label: move_label(&to),
                to,
                bounded: b,
            }
        })
        .collect()
}

fn summarize_alternatives(alts: &[TransitionAlternative]) -> String {
    if alts.is_empty() {
        return "There are no legal transitions from this state — it is terminal.".to_string();
    }
    let listing = alts
        .iter()
        .map(|a| match &a.bounded {
            Some(b) => format!("{} ({})", a.to, b),
            None => a.to.clone(),
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("Legal transitions from here: {listing}.")
}

/// Standard per-invariant message/fix. `audit_scene` returns only the id, so the
/// toolkit attaches this text; the VERDICT (the id) is what matches TS/Python.
fn violation_for(rule: &str) -> GuardViolation {
    let (message, fix): (&str, &str) = match rule {
        "I-1" => (
            "Value Conservation (I-1) violated — currency mixing in a subject, or a refund that exceeds what was committed.",
            "Keep one currency per subject (convert explicitly), and refund at most the committed amount.",
        ),
        "I-2" => (
            "State Monotonicity (I-2) violated — a transition not in the model's table, or backdated history.",
            "Only the model's valid transitions are allowed; model a reversal as a new forward commitment.",
        ),
        "I-3" => (
            "Capacity Verification (I-3) violated — reached Accepted without a verified capacity.",
            "Verify party capacity (can_buy) before accepting.",
        ),
        "I-4" => (
            "Temporal Integrity (I-4) violated — a fulfillment executing before its commitment was accepted.",
            "Accept the commitment before any fulfillment starts.",
        ),
        "I-5" => (
            "Identity Permanence (I-5) violated — an id appears more than once.",
            "Ids are globally unique and never reused; generate a fresh id.",
        ),
        "I-6" => (
            "Commitment Tree Consistency (I-6) violated — child values do not sum to the parent.",
            "Recalculate children so they sum to the parent within the minor-unit tolerance.",
        ),
        _ => ("Invariant violated.", "See the Warp Commerce Model invariants."),
    };
    GuardViolation {
        rule: rule.to_string(),
        message: message.to_string(),
        fix: fix.to_string(),
    }
}

fn violations_from_ids(ids: &[String]) -> Vec<GuardViolation> {
    ids.iter().map(|id| violation_for(id)).collect()
}

// ---------------------------------------------------------------------------
// Guardrail
// ---------------------------------------------------------------------------

/// If `to` is a `Refunded` state that over-refunds `target` (same currency,
/// amount > committed beyond tolerance), the bound to annotate; else None.
fn over_refund_bound(target: &Commitment, to: &CommitmentState) -> Option<(String, String)> {
    if let CommitmentState::Refunded { amount, .. } = to {
        if let Some((orig, cur)) = committed_money(target) {
            if amount.currency == cur
                && amount.amount > orig
                && !money_equals(amount.amount, orig, &cur)
            {
                return Some((
                    "Refunded".to_string(),
                    format!(
                        "refund at most the committed {} {} (a refund cannot exceed what was captured)",
                        fmt_amount(orig),
                        cur
                    ),
                ));
            }
        }
    }
    None
}

/// Guard a proposed transition-level action: validate the move against the table,
/// advance the target's state, and audit the resulting world — composing
/// `is_valid_transition` + `audit_scene`. Never panics on rejection.
pub fn guard_action(world: &World, action: &ProposedAction) -> GuardResult {
    let Some(target) = world.commitments.iter().find(|c| c.id == action.commitment) else {
        return GuardResult::Rejected {
            violations: vec![GuardViolation {
                rule: "unknown-commitment".to_string(),
                message: format!(
                    "No commitment '{}' exists in the current world; an action must target a commitment that is present.",
                    action.commitment
                ),
                fix: "Reference a commitment id that exists in the world you pass to guard_action.".to_string(),
            }],
            alternatives: vec![],
        };
    };

    // 1. Validate the proposed move (composes is_valid_transition; the table = I-2).
    let from_json = json!({ "type": commitment_state_type(&target.state) });
    let to_json = json!({ "type": commitment_state_type(&action.to) });
    if !is_valid_transition("commitment", &from_json, &to_json) {
        let alternatives = commitment_alternatives(&target.state, None);
        let mut v = violation_for("I-2");
        v.message = format!(
            "Commitment cannot transition from '{}' to '{}' — not a valid transition (Invariant 2: State Monotonicity).",
            commitment_state_type(&target.state),
            commitment_state_type(&action.to)
        );
        v.fix = format!(
            "Only the model's valid transitions are allowed. {} Pick one of those, or model a reversal as a new forward commitment.",
            summarize_alternatives(&alternatives)
        );
        return GuardResult::Rejected {
            violations: vec![v],
            alternatives,
        };
    }

    // 2. Build the resulting world: the target commitment, with its state advanced.
    let target_id = target.id.clone();
    let next_commitments: Vec<Commitment> = world
        .commitments
        .iter()
        .map(|c| {
            if c.id == target_id {
                let mut nc = c.clone();
                nc.state = action.to.clone();
                nc
            } else {
                c.clone()
            }
        })
        .collect();
    let next = World {
        commitments: next_commitments,
        fulfillments: world.fulfillments.clone(),
        parties: world.parties.clone(),
    };

    // 3. Audit the RESULTING world (composes audit_scene: the six invariants).
    let ids = audit_scene(&next.commitments, &next.fulfillments, &next.parties);
    if !ids.is_empty() {
        let bound = over_refund_bound(target, &action.to);
        return GuardResult::Rejected {
            violations: violations_from_ids(&ids),
            alternatives: commitment_alternatives(&target.state, bound),
        };
    }

    GuardResult::Accepted { next }
}

/// Guard a fully-constructed world (the object-level case). A thin layer over
/// `audit_scene`.
pub fn guard_object(
    commitments: &[Commitment],
    fulfillments: &[Fulfillment],
    parties: &[Party],
) -> GuardResult {
    let ids = audit_scene(commitments, fulfillments, parties);
    if !ids.is_empty() {
        return GuardResult::Rejected {
            violations: violations_from_ids(&ids),
            alternatives: vec![],
        };
    }
    GuardResult::Accepted {
        next: World {
            commitments: commitments.to_vec(),
            fulfillments: fulfillments.to_vec(),
            parties: parties.to_vec(),
        },
    }
}

// ---------------------------------------------------------------------------
// Session coherence
// ---------------------------------------------------------------------------

struct Tally {
    amount: f64,
    currency: String,
    count: u32,
}

/// A stateful sequence validator over an accumulating world.
pub struct Session {
    world: World,
    ledger: HashMap<String, Tally>,
}

/// Is a cumulative refund of `total` over the committed amount? Derived from the
/// canonical audit: a probe commitment in `Refunded(total)` state is run through
/// `audit_scene`, and we look for the I-1 it raises — the point-in-time rule
/// applied to the sum, not a second copy of it.
fn is_cumulative_over_refund(order: &Commitment, total: f64, currency: &str) -> bool {
    let mut probe = order.clone();
    probe.state = CommitmentState::Refunded {
        amount: Money {
            amount: total,
            currency: currency.to_string(),
        },
        at: order.created_at.clone(),
    };
    probe.history = Vec::new();
    audit_scene(std::slice::from_ref(&probe), &[], &[])
        .iter()
        .any(|id| id == "I-1")
}

impl Session {
    pub fn world(&self) -> &World {
        &self.world
    }

    /// The amount refunded so far for a commitment across this session.
    pub fn refunded_so_far(&self, commitment_id: &str) -> Option<Money> {
        self.ledger.get(commitment_id).map(|t| Money {
            amount: t.amount,
            currency: t.currency.clone(),
        })
    }

    /// Validate `action` against the accumulated world (and the cross-step refund
    /// ledger), apply it on success, and return the same verdict as
    /// `guard_action`. On rejection the world is not advanced.
    pub fn propose(&mut self, action: &ProposedAction) -> GuardResult {
        if let CommitmentState::Refunded { amount: refund, .. } = &action.to {
            let order = self
                .world
                .commitments
                .iter()
                .find(|c| c.id == action.commitment)
                .cloned();
            // If the order can't legally reach Refunded from its current state,
            // let guard_action produce the I-2 rejection WITH alternatives.
            let needs_passthrough = match &order {
                None => true,
                Some(o) => {
                    let from = json!({ "type": commitment_state_type(&o.state) });
                    let to = json!({ "type": "Refunded" });
                    !is_valid_transition("commitment", &from, &to)
                }
            };
            if needs_passthrough {
                return guard_action(&self.world, action);
            }
            let order = order.expect("checked Some above");

            if let Some((committed, cur)) = committed_money(&order) {
                if refund.currency == cur {
                    let (prior_amt, prior_count) = self
                        .ledger
                        .get(&action.commitment)
                        .map(|t| (t.amount, t.count))
                        .unwrap_or((0.0, 0));
                    let cumulative = prior_amt + refund.amount;

                    if is_cumulative_over_refund(&order, cumulative, &cur) {
                        let remaining = (committed - prior_amt).max(0.0);
                        return GuardResult::Rejected {
                            violations: vec![GuardViolation {
                                rule: "I-1".to_string(),
                                message: format!(
                                    "Cumulative refunds on {} would reach {} {} across {} refund(s), but only {} {} was committed — value is not conserved across the session (the point-in-time check sees each refund alone).",
                                    order.id, fmt_amount(cumulative), cur, prior_count + 1, fmt_amount(committed), cur
                                ),
                                fix: format!(
                                    "Refund at most the remaining {} {} (committed {} − already refunded {}).",
                                    fmt_amount(remaining), cur, fmt_amount(committed), fmt_amount(prior_amt)
                                ),
                            }],
                            alternatives: vec![TransitionAlternative {
                                to: "Refunded".to_string(),
                                label: move_label("Refunded"),
                                bounded: Some(format!(
                                    "cumulative refunds must stay within the committed {} {}; {} {} remains refundable",
                                    fmt_amount(committed), cur, fmt_amount(remaining), cur
                                )),
                            }],
                        };
                    }

                    // Accepted refund. Keep the order Fulfilled for a PARTIAL refund;
                    // transition to Refunded only once refunds reach committed.
                    let fully = money_equals(cumulative, committed, &cur);
                    if fully {
                        let verdict = guard_action(&self.world, action);
                        if let GuardResult::Accepted { next } = &verdict {
                            self.world = next.clone();
                            self.ledger.insert(
                                action.commitment.clone(),
                                Tally {
                                    amount: cumulative,
                                    currency: cur,
                                    count: prior_count + 1,
                                },
                            );
                        }
                        return verdict;
                    }
                    self.ledger.insert(
                        action.commitment.clone(),
                        Tally {
                            amount: cumulative,
                            currency: cur,
                            count: prior_count + 1,
                        },
                    );
                    return GuardResult::Accepted {
                        next: self.world.clone(),
                    };
                }
            }
        }

        // Non-refund action: pure compose over guard_action.
        let verdict = guard_action(&self.world, action);
        if let GuardResult::Accepted { next } = &verdict {
            self.world = next.clone();
        }
        verdict
    }
}

pub fn create_session(world: World) -> Session {
    Session {
        world,
        ledger: HashMap::new(),
    }
}

// ---------------------------------------------------------------------------
// Interop CIR — unification (inbound) + emission (outbound)
// ---------------------------------------------------------------------------

/// A platform object ALREADY mapped to a Warp commitment. Passing several of
/// these to [`unify`] is how the caller ASSERTS they correspond.
#[derive(Debug, Clone)]
pub struct UnifySource {
    pub platform: String,
    pub commitment: Commitment,
}

/// The result of unifying corresponded sources.
#[derive(Debug, Clone)]
pub enum UnifyResult {
    /// `commitment` is boxed because a `Commitment` is large relative to the
    /// `Rejected` variant (clippy::large_enum_variant); deref to use it.
    Unified {
        commitment: Box<Commitment>,
        world: World,
    },
    Rejected {
        violations: Vec<GuardViolation>,
    },
}

/// Merge corresponded platform objects into one validated Warp commitment. The
/// first source is the primary (its lifecycle is the merged view); every other
/// source must conserve value against it (same currency, equal within the I-1
/// tolerance). A disagreement is reported as an I-1 violation. The merged
/// commitment is validated by `guard_object`. The correspondence is the caller's
/// assertion — `unify` does NOT infer it.
pub fn unify(sources: &[UnifySource], id: Option<&str>) -> UnifyResult {
    let Some(primary) = sources.first() else {
        return UnifyResult::Rejected {
            violations: vec![GuardViolation {
                rule: "unify-empty".to_string(),
                message: "unify requires at least one mapped platform source.".to_string(),
                fix: "Map each platform object with its inbound adapter and pass the corresponding ones together.".to_string(),
            }],
        };
    };
    let primary_money = committed_money(&primary.commitment);

    let mut violations = Vec::new();
    for other in &sources[1..] {
        let other_money = committed_money(&other.commitment);
        if let (Some((pa, pc)), Some((oa, oc))) = (&primary_money, &other_money) {
            if oc != pc || !money_equals(*oa, *pa, pc) {
                violations.push(GuardViolation {
                    rule: "I-1".to_string(),
                    message: format!(
                        "Corresponded sources do not conserve value: {} commits {} {} but {} commits {} {}. Value is not conserved across the unified transaction.",
                        primary.platform, fmt_amount(*pa), pc, other.platform, fmt_amount(*oa), oc
                    ),
                    fix: "Confirm the objects truly correspond and that the amounts (and currency) match; a partial capture or fee belongs in its own Value.".to_string(),
                });
            }
        }
    }
    if !violations.is_empty() {
        return UnifyResult::Rejected { violations };
    }

    let mut commitment = primary.commitment.clone();
    if let Some(new_id) = id {
        commitment.id = new_id.to_string();
    }

    match guard_object(std::slice::from_ref(&commitment), &[], &[]) {
        GuardResult::Rejected { violations, .. } => UnifyResult::Rejected { violations },
        GuardResult::Accepted { next } => UnifyResult::Unified {
            commitment: Box::new(commitment),
            world: next,
        },
    }
}

/// The outcome of emitting a platform payload — a structured DESCRIPTOR (the call
/// the app should make; it is NOT sent here), or an honest not-representable
/// result. The emitters make no network calls, hold no credentials, and execute
/// nothing.
#[derive(Debug, Clone)]
pub enum EmitResult {
    Descriptor {
        platform: String,
        descriptor: serde_json::Value,
    },
    NotRepresentable {
        platform: String,
        reason: String,
    },
}

fn not_representable(platform: &str, to: &CommitmentState) -> EmitResult {
    EmitResult::NotRepresentable {
        platform: platform.to_string(),
        reason: format!(
            "A '{}' action has no faithful {} equivalent in this layer (covered: Refunded → refund, Cancelled → cancel). Handle it in the application, or extend the emitter.",
            commitment_state_type(to),
            platform
        ),
    }
}

/// Stripe minor-unit amount for a Money, composing `currency_decimals` (the same
/// per-currency precision the auditor uses) — no separate Stripe table.
fn stripe_minor(amount: &Money) -> i64 {
    let factor = 10f64.powi(currency_decimals(&amount.currency));
    (amount.amount * factor).round() as i64
}

/// Emit a Stripe-shaped descriptor for a VALIDATED action.
pub fn to_stripe_action(action: &ProposedAction) -> EmitResult {
    match &action.to {
        CommitmentState::Refunded { amount, .. } => EmitResult::Descriptor {
            platform: "stripe".to_string(),
            descriptor: json!({
                "kind": "stripe.refund",
                "payment_intent": action.commitment,
                "amount": stripe_minor(amount),
                "currency": amount.currency.to_lowercase(),
            }),
        },
        CommitmentState::Cancelled { .. } => EmitResult::Descriptor {
            platform: "stripe".to_string(),
            descriptor: json!({ "kind": "stripe.cancel", "payment_intent": action.commitment }),
        },
        other => not_representable("stripe", other),
    }
}

/// Emit a Shopify-shaped descriptor for a VALIDATED action.
pub fn to_shopify_action(action: &ProposedAction) -> EmitResult {
    match &action.to {
        CommitmentState::Refunded { amount, .. } => EmitResult::Descriptor {
            platform: "shopify".to_string(),
            descriptor: json!({
                "kind": "shopify.refund",
                "order_id": action.commitment,
                "amount": fmt_amount(amount.amount),
                "currency": amount.currency,
            }),
        },
        CommitmentState::Cancelled { .. } => EmitResult::Descriptor {
            platform: "shopify".to_string(),
            descriptor: json!({ "kind": "shopify.cancel", "order_id": action.commitment }),
        },
        other => not_representable("shopify", other),
    }
}

/// Emit a WooCommerce-shaped descriptor for a VALIDATED action.
pub fn to_woocommerce_action(action: &ProposedAction) -> EmitResult {
    match &action.to {
        CommitmentState::Refunded { amount, .. } => EmitResult::Descriptor {
            platform: "woocommerce".to_string(),
            descriptor: json!({
                "kind": "woocommerce.refund",
                "order_id": action.commitment,
                "amount": fmt_amount(amount.amount),
                "currency": amount.currency,
            }),
        },
        CommitmentState::Cancelled { .. } => EmitResult::Descriptor {
            platform: "woocommerce".to_string(),
            descriptor: json!({ "kind": "woocommerce.cancel", "order_id": action.commitment }),
        },
        other => not_representable("woocommerce", other),
    }
}

// ---------------------------------------------------------------------------
// Behavioural-equivalence tests — mirror the TS/Python toolkit suites. The
// VERDICTS must match (the message wording is binding-specific, see the module
// docs). Commitments are built via serde_json — the same path the conformance
// runner uses to load fixtures (the runtime ships no builders).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated::transitions::COMMITMENT_TRANSITIONS;

    fn fulfilled_order(id: &str, amount: f64) -> Commitment {
        // An empty-history Fulfilled order with a Money subject: audits clean
        // (I-2 has no history to check; I-3/I-4 need parties/fulfillments).
        serde_json::from_value(json!({
            "id": id,
            "parties": { "initiator": "buyer", "counterparty": "seller", "intermediaries": [] },
            "subject": { "offered": [], "requested": [
                { "id": "v", "form": { "kind": "Money", "money": { "amount": amount, "currency": "MAD" } }, "quantity": 1, "state": { "type": "Available" } }
            ] },
            "state": { "type": "Fulfilled" },
            "history": [],
            "children": [],
            "created_at": "2026-01-02T08:00:00.000Z"
        }))
        .expect("valid commitment")
    }

    fn refund_state(amount: f64) -> CommitmentState {
        CommitmentState::Refunded {
            amount: Money {
                amount,
                currency: "MAD".to_string(),
            },
            at: "2026-02-01T00:00:00.000Z".to_string(),
        }
    }

    fn rejected(r: &GuardResult) -> (&Vec<GuardViolation>, &Vec<TransitionAlternative>) {
        match r {
            GuardResult::Rejected {
                violations,
                alternatives,
            } => (violations, alternatives),
            GuardResult::Accepted { .. } => panic!("expected Rejected"),
        }
    }

    #[test]
    fn valid_transitions_equals_table_for_every_state() {
        for (from, tos) in COMMITMENT_TRANSITIONS {
            let state: CommitmentState =
                serde_json::from_value(json!({ "type": from })).unwrap_or(CommitmentState::Draft);
            // For payload-bearing states, build a minimal valid instance.
            let state = match *from {
                "Tendered" => serde_json::from_value(json!({"type":"Tendered","offer_amount":1,"offer_currency":"MAD","closes_at":"2099-01-01T00:00:00.000Z"})).unwrap(),
                "Modified" => serde_json::from_value(json!({"type":"Modified","modified_by":"p","reason":"x"})).unwrap(),
                "Cancelled" => serde_json::from_value(json!({"type":"Cancelled","by":"p","reason":"x","at":"2099-01-01T00:00:00.000Z"})).unwrap(),
                "Disputed" => serde_json::from_value(json!({"type":"Disputed","by":"p","reason":"x","opened_at":"2099-01-01T00:00:00.000Z"})).unwrap(),
                "Refunded" => refund_state(1.0),
                _ => state,
            };
            let expected: Vec<String> = tos.iter().map(|s| s.to_string()).collect();
            assert_eq!(valid_transitions(&state), expected);
        }
    }

    #[test]
    fn terminal_states_have_no_transitions() {
        assert!(valid_transitions(&refund_state(1.0)).is_empty());
    }

    #[test]
    fn invalid_transition_returns_legal_alternatives() {
        let order = fulfilled_order("order_1", 200.0);
        let world = World {
            commitments: vec![order],
            fulfillments: vec![],
            parties: vec![],
        };
        let action = ProposedAction {
            commitment: "order_1".to_string(),
            to: CommitmentState::Accepted,
            actor: "agent".to_string(),
        };
        let r = guard_action(&world, &action);
        let (violations, alternatives) = rejected(&r);
        assert_eq!(violations[0].rule, "I-2");
        let tos: Vec<String> = alternatives.iter().map(|a| a.to.clone()).collect();
        assert_eq!(tos, vec!["Disputed".to_string(), "Refunded".to_string()]);
        assert!(alternatives.iter().all(|a| a.bounded.is_none()));
    }

    #[test]
    fn over_refund_marks_refunded_bounded() {
        let order = fulfilled_order("order_1", 200.0);
        let world = World {
            commitments: vec![order],
            fulfillments: vec![],
            parties: vec![],
        };
        let action = ProposedAction {
            commitment: "order_1".to_string(),
            to: refund_state(500.0),
            actor: "agent".to_string(),
        };
        let r = guard_action(&world, &action);
        let (violations, alternatives) = rejected(&r);
        assert!(violations.iter().any(|v| v.rule == "I-1"));
        let refunded = alternatives.iter().find(|a| a.to == "Refunded").unwrap();
        let disputed = alternatives.iter().find(|a| a.to == "Disputed").unwrap();
        assert!(refunded.bounded.is_some());
        assert!(disputed.bounded.is_none());
    }

    #[test]
    fn unknown_commitment_is_rejected() {
        let world = World {
            commitments: vec![],
            fulfillments: vec![],
            parties: vec![],
        };
        let action = ProposedAction {
            commitment: "nope".to_string(),
            to: CommitmentState::Proposed,
            actor: "a".to_string(),
        };
        let verdict = guard_action(&world, &action);
        let (violations, _) = rejected(&verdict);
        assert_eq!(violations[0].rule, "unknown-commitment");
    }

    #[test]
    fn session_catches_cumulative_over_refund() {
        let order = fulfilled_order("order_1", 200.0);
        let mut s = create_session(World {
            commitments: vec![order],
            fulfillments: vec![],
            parties: vec![],
        });
        let r = |amt: f64| ProposedAction {
            commitment: "order_1".to_string(),
            to: refund_state(amt),
            actor: "a".to_string(),
        };
        assert!(s.propose(&r(80.0)).is_ok());
        assert!(s.propose(&r(80.0)).is_ok());
        let third = s.propose(&r(80.0));
        let (violations, alternatives) = rejected(&third);
        assert_eq!(violations[0].rule, "I-1");
        assert!(violations[0].message.contains("240"));
        assert!(violations[0].message.contains("200"));
        assert!(alternatives[0].bounded.as_ref().unwrap().contains("40"));
        // ledger unchanged on rejection
        assert_eq!(s.refunded_so_far("order_1").unwrap().amount, 160.0);
    }

    #[test]
    fn session_full_refund_moves_to_refunded() {
        let order = fulfilled_order("order_1", 200.0);
        let mut s = create_session(World {
            commitments: vec![order],
            fulfillments: vec![],
            parties: vec![],
        });
        let v = s.propose(&ProposedAction {
            commitment: "order_1".to_string(),
            to: refund_state(200.0),
            actor: "a".to_string(),
        });
        assert!(v.is_ok());
        assert_eq!(
            commitment_state_type(&s.world().commitments[0].state),
            "Refunded"
        );
    }

    #[test]
    fn unify_conserve_and_mismatch() {
        let shop = fulfilled_order("order_123", 200.0);
        let stripe = fulfilled_order("pi_abc", 200.0);
        let u = unify(
            &[
                UnifySource {
                    platform: "shopify".to_string(),
                    commitment: shop.clone(),
                },
                UnifySource {
                    platform: "stripe".to_string(),
                    commitment: stripe,
                },
            ],
            Some("order_123"),
        );
        match u {
            UnifyResult::Unified { commitment, .. } => assert_eq!(commitment.id, "order_123"),
            UnifyResult::Rejected { .. } => panic!("expected Unified"),
        }
        let stripe_bad = fulfilled_order("pi_bad", 150.0);
        let u2 = unify(
            &[
                UnifySource {
                    platform: "shopify".to_string(),
                    commitment: shop,
                },
                UnifySource {
                    platform: "stripe".to_string(),
                    commitment: stripe_bad,
                },
            ],
            None,
        );
        match u2 {
            UnifyResult::Rejected { violations } => {
                assert_eq!(violations[0].rule, "I-1");
                assert!(
                    violations[0].message.contains("200") && violations[0].message.contains("150")
                );
            }
            UnifyResult::Unified { .. } => panic!("expected Rejected (no auto-reconcile)"),
        }
    }

    #[test]
    fn emitters_and_not_representable() {
        let refund = ProposedAction {
            commitment: "order_123".to_string(),
            to: refund_state(40.0),
            actor: "a".to_string(),
        };
        match to_stripe_action(&refund) {
            EmitResult::Descriptor { descriptor, .. } => {
                assert_eq!(descriptor["kind"], "stripe.refund");
                assert_eq!(descriptor["amount"], 4000);
                assert_eq!(descriptor["currency"], "mad");
            }
            EmitResult::NotRepresentable { .. } => panic!("expected descriptor"),
        }
        match to_shopify_action(&refund) {
            EmitResult::Descriptor { descriptor, .. } => assert_eq!(descriptor["amount"], "40"),
            EmitResult::NotRepresentable { .. } => panic!("expected descriptor"),
        }
        let accept = ProposedAction {
            commitment: "order_123".to_string(),
            to: CommitmentState::Accepted,
            actor: "a".to_string(),
        };
        match to_stripe_action(&accept) {
            EmitResult::NotRepresentable { reason, .. } => assert!(reason.contains("Accepted")),
            EmitResult::Descriptor { .. } => panic!("expected not-representable"),
        }
    }
}
