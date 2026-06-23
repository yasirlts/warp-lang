//! Saga / compensation (F7) — model the UNWINDING of a multi-step commerce flow as an
//! explicit, validated sequence of compensating actions, and check that the
//! compensation itself is coherent (a reversal that would violate an invariant — e.g.
//! an over-refund — is rejected).
//!
//! A Rust port of the TypeScript `saga.ts` (and the Python `saga.py`). A "saga" here is
//! an ordered set of forward actions (accept -> fulfill -> refund ...) together with
//! the compensating actions that reverse their economic effect. Each compensation is a
//! LEGAL transition (read from the same generated transition table as everything else:
//! e.g. Fulfilled -> Refunded, Accepted -> Cancelled), and the net economic effect of
//! the whole sequence is validated for conservation (I-1) and the rest of the
//! six-invariant audit.
//!
//! This is a COMPOSITION over the already-proven primitives — it does NOT re-derive
//! invariant or transition logic:
//!   - [`valid_transitions`](crate::toolkit::valid_transitions) decides whether a
//!     compensation is a legal move from a commitment's current state (the model's
//!     transition table = I-2);
//!   - [`create_session`](crate::toolkit::create_session) runs the compensation
//!     sequence against the accumulated world, so the cumulative over-refund check, the
//!     F3 optimistic-conflict check, the F4 idempotency/replay dedup, the F6 per-tree
//!     cap, and the six-invariant audit all apply to the compensation exactly as they
//!     apply to any other action;
//!   - the planning-oracle alternatives / bounded guidance surface unchanged on a
//!     rejected compensation, so a caller can correct an over-refund the same way it
//!     would correct any rejected action.
//!
//! SCOPE (honest): Warp VALIDATES that a compensation sequence is coherent — that each
//! compensating action is a legal transition reversing a prior step's effect and that
//! the net effect conserves value. Warp does NOT execute or orchestrate rollbacks on
//! external systems: a planned compensation is a sequence of validated descriptors, not
//! a runtime that calls Stripe/Shopify to undo anything. The interop emitters elsewhere
//! in this crate are descriptors in the same sense. "Compensation" is a modelling and
//! validation affordance, not a distributed-transaction coordinator.
//!
//! WHAT REVERSES WHAT (the default mapping): a step that drove a commitment to
//! `Fulfilled` (value delivered) is reversed by `Refunded` for the amount that step
//! committed; a step that left a commitment `Accepted` / `Active` / `Modified` /
//! `PartiallyFulfilled` (committed but not yet delivered) is reversed by `Cancelled`. A
//! forward step that itself ended `Cancelled` or `Refunded` is already a terminal
//! compensation target and has nothing to reverse. Callers may override the mapping per
//! step; an overridden target is still checked against the transition table and the
//! invariants, so an illegal or invariant-violating override is rejected with guidance.

use crate::generated::types::{Commitment, CommitmentState, Money};
use crate::runtime::{commitment_state_type, committed_money};
use crate::toolkit::{
    valid_transitions, GuardResult, GuardViolation, ProposedAction, Session, TransitionAlternative,
    World,
};

/// A forward step that was applied to reach the current world, paired with the
/// commitment it acted on. This is the input to compensation planning: the saga reads
/// each step's committed effect and proposes the reversing action. The `to` is the
/// state the forward step drove the commitment to (the same shape a [`ProposedAction`]
/// carries).
#[derive(Debug, Clone)]
pub struct ForwardStep {
    /// Id of the commitment the forward step acted on.
    pub commitment: String,
    /// The state the forward step drove the commitment to.
    pub to: CommitmentState,
    /// The actor who performed the forward step (carried onto the compensation by default).
    pub actor: String,
    /// Optional explicit compensation override for THIS step. When omitted, the default
    /// mapping (see the module doc) is used. An override is still validated against the
    /// transition table and the invariants — it is not a way to bypass either.
    pub compensate_with: Option<CommitmentState>,
    /// Optional timestamp for the compensating transition (defaults to the call's `at`).
    pub at: Option<String>,
}

impl ForwardStep {
    /// A forward step with no override and no per-step timestamp (the common case).
    pub fn new(
        commitment: impl Into<String>,
        to: CommitmentState,
        actor: impl Into<String>,
    ) -> Self {
        ForwardStep {
            commitment: commitment.into(),
            to,
            actor: actor.into(),
            compensate_with: None,
            at: None,
        }
    }
}

/// A single planned compensating action: the reversing transition for one forward
/// step. `action` is None when the forward step has nothing to reverse — that case is
/// reported in [`CompensationPlan::skipped`] with the reason, not silently dropped.
#[derive(Debug, Clone)]
pub struct CompensationStep {
    /// The forward step this compensates.
    pub forward: ForwardStep,
    /// The compensating action to run through the session, or None when the forward
    /// step has nothing to reverse.
    pub action: Option<ProposedAction>,
    /// Why a None `action` was produced (present only when `action` is None).
    pub skip_reason: Option<String>,
}

/// The full plan: the compensating action for each forward step (in REVERSE order — a
/// saga unwinds last-applied first), plus the steps that had nothing to reverse.
#[derive(Debug, Clone, Default)]
pub struct CompensationPlan {
    /// The compensating actions, ordered last-forward-step-first (the unwind order).
    pub steps: Vec<CompensationStep>,
    /// Forward steps that produced no compensating action, with `(commitment, reason)`.
    pub skipped: Vec<(String, String)>,
}

/// The verdict of validating a whole compensation plan against a world. On success the
/// world is fully unwound and `next` is the resulting coherent world. On rejection,
/// `failed_at` is the index (into the plan's `steps`) of the compensation that was
/// rejected, and the usual `violations` / `alternatives` / conflict fields explain why.
/// Additive over [`GuardResult`].
#[derive(Debug, Clone)]
pub enum CompensationResult {
    Ok {
        next: World,
        applied: u32,
        skipped: u32,
    },
    Rejected {
        failed_at: usize,
        violations: Vec<GuardViolation>,
        alternatives: Vec<TransitionAlternative>,
        conflict: bool,
        expected: Option<String>,
        actual: Option<String>,
    },
}

impl CompensationResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, CompensationResult::Ok { .. })
    }
    pub fn is_conflict(&self) -> bool {
        matches!(self, CompensationResult::Rejected { conflict: true, .. })
    }
}

/// The default compensating action for a forward step, given the commitment it acted
/// on (read from the CURRENT world so the move is legal from where it now is). Returns
/// `Ok(action)`, or `Err(reason)` when there is nothing to reverse. The choice is
/// constrained to the model's legal transitions via [`valid_transitions`] — the saga
/// never invents a move the table does not allow.
fn default_compensation(
    forward: &ForwardStep,
    current: &Commitment,
    at: &str,
) -> Result<ProposedAction, String> {
    let legal = valid_transitions(&current.state);
    let effect = commitment_state_type(&forward.to);

    // A forward step that delivered value (reached Fulfilled) is reversed by a Refund of
    // the committed amount — but only if Refunded is a legal move from where we are now.
    if effect == "Fulfilled" {
        if !legal.iter().any(|s| s == "Refunded") {
            return Err(format!(
                "commitment {} is in '{}', from which Refunded is not a legal transition — nothing to reverse for the Fulfilled step",
                forward.commitment,
                commitment_state_type(&current.state)
            ));
        }
        let Some((amount, currency)) = committed_money(current) else {
            return Err(format!(
                "commitment {} has no single-currency committed amount to refund",
                forward.commitment
            ));
        };
        let mut a = ProposedAction::new(
            forward.commitment.clone(),
            CommitmentState::Refunded {
                amount: Money { amount, currency },
                at: at.to_string(),
            },
            forward.actor.clone(),
        );
        a.idempotency_key = Some(format!("comp:{}:Refunded", forward.commitment));
        return Ok(a);
    }

    // A committed-but-not-delivered step (Accepted / Active / Modified /
    // PartiallyFulfilled) is reversed by Cancelling the commitment, when legal.
    if matches!(
        effect,
        "Accepted" | "Active" | "Modified" | "PartiallyFulfilled"
    ) {
        if !legal.iter().any(|s| s == "Cancelled") {
            return Err(format!(
                "commitment {} is in '{}', from which Cancelled is not a legal transition — nothing to reverse for the {} step",
                forward.commitment,
                commitment_state_type(&current.state),
                effect
            ));
        }
        let mut a = ProposedAction::new(
            forward.commitment.clone(),
            CommitmentState::Cancelled {
                by: forward.actor.clone(),
                reason: format!(
                    "compensation: reverse the {} step on {}",
                    effect, forward.commitment
                ),
                at: at.to_string(),
            },
            forward.actor.clone(),
        );
        a.idempotency_key = Some(format!("comp:{}:Cancelled", forward.commitment));
        return Ok(a);
    }

    // Already a terminal compensation target, or a step with no economic reversal.
    if matches!(effect, "Cancelled" | "Refunded") {
        return Err(format!(
            "the forward step on {} already ended in '{}', a terminal compensation target — nothing to reverse",
            forward.commitment, effect
        ));
    }
    Err(format!(
        "the forward step on {} (to '{}') has no defined economic reversal; supply compensate_with to model one explicitly",
        forward.commitment, effect
    ))
}

/// Build the compensation plan for a sequence of forward steps against `world`.
///
/// Each forward step is mapped to its reversing action (default mapping, or the step's
/// `compensate_with` override). The plan is returned in REVERSE order — a saga unwinds
/// the most-recently-applied step first — and steps with nothing to reverse are listed
/// in `skipped`. This only PLANS; [`validate_compensation`] runs the plan through a
/// session to check it is coherent.
///
/// `at` is the timestamp stamped on compensating transitions that need one (Refunded,
/// Cancelled); pass a time no earlier than the world's last transition (I-4 temporal
/// integrity is checked when the plan is validated). A per-step `at` overrides it.
pub fn plan_compensation(world: &World, forward: &[ForwardStep], at: &str) -> CompensationPlan {
    let mut steps: Vec<CompensationStep> = Vec::new();
    let mut skipped: Vec<(String, String)> = Vec::new();

    // Unwind in reverse: the last forward step is compensated first.
    for step in forward.iter().rev() {
        let step_at = step.at.clone().unwrap_or_else(|| at.to_string());
        let Some(current) = world.commitments.iter().find(|c| c.id == step.commitment) else {
            let reason = format!(
                "commitment {} is not present in the world — cannot compensate a step on it",
                step.commitment
            );
            steps.push(CompensationStep {
                forward: step.clone(),
                action: None,
                skip_reason: Some(reason.clone()),
            });
            skipped.push((step.commitment.clone(), reason));
            continue;
        };

        // An explicit override is still bounded by the transition table: only a legal
        // move is accepted; an illegal override is skipped with guidance.
        if let Some(cw) = &step.compensate_with {
            let legal = valid_transitions(&current.state);
            let cw_type = commitment_state_type(cw);
            if !legal.iter().any(|s| s == cw_type) {
                let legal_list = if legal.is_empty() {
                    "none — terminal".to_string()
                } else {
                    legal.join(", ")
                };
                let reason = format!(
                    "compensate_with '{}' is not a legal transition from '{}' for {} (legal: {})",
                    cw_type,
                    commitment_state_type(&current.state),
                    step.commitment,
                    legal_list
                );
                steps.push(CompensationStep {
                    forward: step.clone(),
                    action: None,
                    skip_reason: Some(reason.clone()),
                });
                skipped.push((step.commitment.clone(), reason));
                continue;
            }
            let mut a =
                ProposedAction::new(step.commitment.clone(), cw.clone(), step.actor.clone());
            a.idempotency_key = Some(format!("comp:{}:{}", step.commitment, cw_type));
            steps.push(CompensationStep {
                forward: step.clone(),
                action: Some(a),
                skip_reason: None,
            });
            continue;
        }

        match default_compensation(step, current, &step_at) {
            Ok(action) => steps.push(CompensationStep {
                forward: step.clone(),
                action: Some(action),
                skip_reason: None,
            }),
            Err(reason) => {
                steps.push(CompensationStep {
                    forward: step.clone(),
                    action: None,
                    skip_reason: Some(reason.clone()),
                });
                skipped.push((step.commitment.clone(), reason));
            }
        }
    }

    CompensationPlan { steps, skipped }
}

/// Validate a compensation plan by running every compensating action through a
/// [`Session`]. The session applies the SAME checks as any other action sequence — the
/// cumulative over-refund cap (I-1 across steps), the F3 optimistic-conflict check, the
/// F4 replay/idempotency dedup, the F6 per-tree cap, and the six-invariant audit — so a
/// compensation that would itself violate an invariant (e.g. an over-refund while
/// reversing) is rejected, with the bounded/alternatives guidance the caller already
/// knows how to act on.
///
/// IMPORTANT — pass the SAME session the forward flow ran in. The compensation
/// continues that session's accumulating ledger, so a prior PARTIAL refund (which the
/// schema cannot represent as a state, and which the session tracks in its own ledger)
/// is correctly counted. If you instead validate against a fresh session built from a
/// world, that ledger context is lost — use [`compensate`] only when the world's
/// commitment states already reflect every prior effect.
///
/// On the first rejected compensation, validation STOPS and returns the rejection with
/// the index of the offending step (`failed_at`). On success the world is fully unwound
/// into a coherent state.
pub fn validate_compensation(session: &mut Session, plan: &CompensationPlan) -> CompensationResult {
    let mut applied = 0u32;
    let mut skipped = 0u32;

    for (i, step) in plan.steps.iter().enumerate() {
        let Some(action) = &step.action else {
            skipped += 1;
            continue;
        };
        match session.propose(action) {
            GuardResult::Accepted { .. } => applied += 1,
            GuardResult::Rejected {
                violations,
                alternatives,
                conflict,
                expected,
                actual,
            } => {
                return CompensationResult::Rejected {
                    failed_at: i,
                    violations,
                    alternatives,
                    conflict,
                    expected,
                    actual,
                };
            }
        }
    }

    CompensationResult::Ok {
        next: session.world().clone(),
        applied,
        skipped,
    }
}

/// Plan AND validate against an EXISTING session in one call: build the compensation
/// plan for `forward` against the session's current world and immediately run it
/// through that SAME session, so any prior partial-refund ledger is honored. Returns
/// `(plan, result)`. A convenience over [`plan_compensation`] + [`validate_compensation`];
/// no extra logic.
pub fn compensate_session(
    session: &mut Session,
    forward: &[ForwardStep],
    at: &str,
) -> (CompensationPlan, CompensationResult) {
    let plan = plan_compensation(session.world(), forward, at);
    let result = validate_compensation(session, &plan);
    (plan, result)
}

/// Plan AND validate against a FRESH session built from `world`. Use this when the
/// world's commitment states already reflect every prior effect — there is no
/// session-only partial-refund ledger to carry forward (e.g. unwinding a clean
/// accept->active flow). When a prior partial refund is outstanding in a live session,
/// use [`compensate_session`] so that ledger is honored. Returns `(plan, result)`.
pub fn compensate(
    world: &World,
    forward: &[ForwardStep],
    at: &str,
) -> (CompensationPlan, CompensationResult) {
    let mut session = crate::toolkit::create_session(world.clone());
    let plan = plan_compensation(world, forward, at);
    let result = validate_compensation(&mut session, &plan);
    (plan, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::toolkit::{commitment_version, create_session};
    use serde_json::json;

    const AT: &str = "2026-03-01T00:00:00.000Z";

    fn order_in(id: &str, amount: f64, state: serde_json::Value) -> Commitment {
        serde_json::from_value(json!({
            "id": id,
            "parties": { "initiator": "buyer", "counterparty": "seller", "intermediaries": [] },
            "subject": { "offered": [], "requested": [
                { "id": "v", "form": { "kind": "Money", "money": { "amount": amount, "currency": "MAD" } }, "quantity": 1, "state": { "type": "Available" } }
            ] },
            "state": state,
            "history": [],
            "children": [],
            "created_at": "2026-01-02T08:00:00.000Z"
        }))
        .expect("valid commitment")
    }

    fn fulfilled(id: &str, amount: f64) -> Commitment {
        order_in(id, amount, json!({ "type": "Fulfilled" }))
    }

    fn fulfill_step(id: &str) -> ForwardStep {
        ForwardStep::new(id, CommitmentState::Fulfilled, "seller")
    }

    fn world_of(c: Commitment) -> World {
        World {
            commitments: vec![c],
            fulfillments: vec![],
            parties: vec![],
        }
    }

    fn refund_state(amount: f64) -> CommitmentState {
        CommitmentState::Refunded {
            amount: Money {
                amount,
                currency: "MAD".to_string(),
            },
            at: AT.to_string(),
        }
    }

    #[test]
    fn plans_a_refund_to_reverse_a_fulfilled_step_default_mapping() {
        let world = world_of(fulfilled("order_1", 200.0));
        let plan = plan_compensation(&world, &[fulfill_step("order_1")], AT);
        assert_eq!(plan.steps.len(), 1);
        let action = plan.steps[0].action.as_ref().expect("an action");
        match &action.to {
            CommitmentState::Refunded { amount, .. } => assert_eq!(amount.amount, 200.0),
            other => panic!("expected Refunded, got {}", commitment_state_type(other)),
        }
    }

    #[test]
    fn valid_compensation_sequence_completes_fully_refunded() {
        let world = world_of(fulfilled("order_1", 200.0));
        let (_, result) = compensate(&world, &[fulfill_step("order_1")], AT);
        match result {
            CompensationResult::Ok { next, applied, .. } => {
                assert_eq!(applied, 1);
                assert_eq!(
                    commitment_state_type(&next.commitments[0].state),
                    "Refunded"
                );
            }
            CompensationResult::Rejected { .. } => panic!("expected Ok"),
        }
    }

    #[test]
    fn rejects_over_refund_while_reversing_a_partially_refunded_flow() {
        let mut session = create_session(world_of(fulfilled("order_1", 200.0)));
        // Forward flow: a partial refund of 50 tracked in the session ledger.
        let mut partial = ProposedAction::new("order_1", refund_state(50.0), "seller");
        partial.idempotency_key = Some("partial-50".to_string());
        assert!(session.propose(&partial).is_ok());

        // Compensation refunds the FULL 200 again → 50 + 200 = 250 > 200 (over-refund).
        let mut step = ForwardStep::new("order_1", CommitmentState::Fulfilled, "seller");
        step.compensate_with = Some(refund_state(200.0));
        let (_, result) = compensate_session(&mut session, &[step], AT);
        match result {
            CompensationResult::Rejected {
                failed_at,
                violations,
                alternatives,
                ..
            } => {
                assert_eq!(failed_at, 0);
                assert_eq!(violations[0].rule, "I-1");
                assert!(violations[0].message.contains("250"));
                let alt = alternatives.iter().find(|a| a.to == "Refunded").unwrap();
                assert!(alt.bounded.as_ref().unwrap().contains("150"));
            }
            CompensationResult::Ok { .. } => panic!("expected rejection"),
        }
    }

    #[test]
    fn accepts_the_bounded_remaining_compensation() {
        let mut session = create_session(world_of(fulfilled("order_1", 200.0)));
        let mut partial = ProposedAction::new("order_1", refund_state(50.0), "seller");
        partial.idempotency_key = Some("partial-50".to_string());
        session.propose(&partial);

        let mut step = ForwardStep::new("order_1", CommitmentState::Fulfilled, "seller");
        step.compensate_with = Some(refund_state(150.0));
        let (_, result) = compensate_session(&mut session, &[step], AT);
        assert!(result.is_ok());
        assert_eq!(session.refunded_so_far("order_1").unwrap().amount, 200.0);
        assert_eq!(
            commitment_state_type(&session.world().commitments[0].state),
            "Refunded"
        );
    }

    #[test]
    fn reverses_committed_but_not_delivered_by_cancellation() {
        let world = world_of(order_in("lease_1", 100.0, json!({ "type": "Active" })));
        let (plan, result) = compensate(
            &world,
            &[ForwardStep::new(
                "lease_1",
                CommitmentState::Active,
                "seller",
            )],
            AT,
        );
        assert_eq!(
            commitment_state_type(&plan.steps[0].action.as_ref().unwrap().to),
            "Cancelled"
        );
        match result {
            CompensationResult::Ok { next, .. } => assert_eq!(
                commitment_state_type(&next.commitments[0].state),
                "Cancelled"
            ),
            CompensationResult::Rejected { .. } => panic!("expected Ok"),
        }
    }

    #[test]
    fn skips_a_step_with_nothing_to_reverse_terminal_refunded() {
        let world = world_of(order_in(
            "order_2",
            200.0,
            json!({ "type": "Refunded", "amount": { "amount": 200, "currency": "MAD" }, "at": AT }),
        ));
        let step = ForwardStep::new("order_2", refund_state(200.0), "seller");
        let plan = plan_compensation(&world, &[step], AT);
        assert!(plan.steps[0].action.is_none());
        assert_eq!(plan.skipped.len(), 1);
        assert!(plan.skipped[0].1.contains("terminal"));
    }

    #[test]
    fn rejects_an_illegal_compensate_with_override() {
        let world = world_of(fulfilled("order_1", 200.0));
        // Fulfilled → Accepted is NOT a legal transition.
        let mut step = ForwardStep::new("order_1", CommitmentState::Fulfilled, "seller");
        step.compensate_with = Some(CommitmentState::Accepted);
        let plan = plan_compensation(&world, &[step], AT);
        assert!(plan.steps[0].action.is_none());
        assert!(plan.skipped[0].1.contains("not a legal transition"));
    }

    #[test]
    fn composes_with_f4_replay_no_double_apply() {
        let mut session = create_session(world_of(fulfilled("order_1", 200.0)));
        let plan = plan_compensation(session.world(), &[fulfill_step("order_1")], AT);
        let first = validate_compensation(&mut session, &plan);
        assert!(first.is_ok());
        // Re-running the SAME plan is a replay — the comp idempotency key dedups.
        let again = validate_compensation(&mut session, &plan);
        assert!(again.is_ok());
        assert_eq!(session.refunded_so_far("order_1").unwrap().amount, 200.0); // not 400
    }

    #[test]
    fn composes_with_f3_conflict_on_stale_version() {
        let mut session = create_session(world_of(fulfilled("order_1", 200.0)));
        let stale = commitment_version(&session.world().commitments[0]);
        // A concurrent actor disputes the order — Fulfilled → Disputed is legal and
        // advances the version, so the planned Fulfilled version is now stale.
        let disputed = ProposedAction::new(
            "order_1",
            CommitmentState::Disputed {
                by: "buyer".to_string(),
                reason: "item missing".to_string(),
                opened_at: AT.to_string(),
            },
            "buyer",
        );
        assert!(session.propose(&disputed).is_ok());

        let mut step = ForwardStep::new("order_1", CommitmentState::Fulfilled, "seller");
        step.compensate_with = Some(refund_state(100.0));
        let mut plan = plan_compensation(session.world(), &[step], AT);
        // Stamp the stale version onto the planned compensation.
        if let Some(action) = plan.steps[0].action.as_mut() {
            action.expected_version = Some(stale);
        }
        let result = validate_compensation(&mut session, &plan);
        assert!(result.is_conflict());
    }

    #[test]
    fn unwinds_in_reverse_order() {
        let world = World {
            commitments: vec![
                fulfilled("order_A", 100.0),
                order_in("order_B", 100.0, json!({ "type": "Active" })),
            ],
            fulfillments: vec![],
            parties: vec![],
        };
        let plan = plan_compensation(
            &world,
            &[
                fulfill_step("order_A"),
                ForwardStep::new("order_B", CommitmentState::Active, "seller"),
            ],
            AT,
        );
        // forward = [A, B] → unwind = [B first, A second].
        assert_eq!(plan.steps[0].forward.commitment, "order_B");
        assert_eq!(plan.steps[1].forward.commitment, "order_A");
    }
}
