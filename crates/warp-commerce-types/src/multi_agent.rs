//! Multi-agent verification (F5) — make it first-class that several NAMED agents act
//! on a SHARED world, so the invariants hold over their COMBINED actions, with
//! per-actor attribution.
//!
//! A Rust port of the TypeScript `multi-agent.ts` (and the Python `multi_agent.py`).
//! This is NOT new invariant logic. The model is already actor-agnostic: a
//! [`World`](crate::toolkit::World) holds many commitments, every
//! [`ProposedAction`](crate::toolkit::ProposedAction) carries an `actor`, and a
//! [`Session`](crate::toolkit::Session) accumulates a world across actions regardless
//! of who made each — so the cumulative refund check and the six invariants already
//! catch a violation that EMERGES from the combined valid actions of different agents
//! (three agents each refunding 80 against a 200 commitment is caught at the third,
//! exactly as one agent doing it three times would be). This module composes that
//! existing session; it does not fork or re-derive any check.
//!
//! What it adds is ergonomics + ATTRIBUTION: run a sequence of actions from different
//! actors against one shared world, record which actor performed each accepted action,
//! and — on a rejection — name the actor whose action, applied to the accumulated
//! shared world, tipped it into violation.
//!
//! SCOPE (honest): this is shared-world invariant enforcement WITH attribution. The
//! attribution is "which action tipped the world into violation" — the proposing actor
//! of the step that failed the check. It is NOT collusion, conspiracy, or multi-party
//! intent detection: Warp does not infer that several actors coordinated, only that a
//! violation emerged over the world they share and which single action triggered it.
//!
//! ATTRIBUTION WORDING (per-binding note): this Rust port composes the SAME underlying
//! session as the TS / Python twins and produces the same verdict plus the `actor` and
//! (on a rejection) `attribution`. The attribution STRING wording is this binding's own
//! phrasing; it conveys the same facts as the TS / Python string (the tipping actor,
//! the prior actors as accumulated context, and whether the cause was a conflict or an
//! invariant violation) but is not a byte-for-byte copy of either sentence. Tests
//! assert the facts (which actor, which prior actors, conflict-vs-violation), not the
//! exact sentence.

use std::collections::{HashMap, HashSet};

use crate::generated::types::Money;
use crate::runtime::commitment_state_type;
use crate::toolkit::{
    create_session, GuardResult, GuardViolation, ProposedAction, Session, TransitionAlternative,
    World,
};

/// One accepted action, with the actor who performed it (the who-did-what log).
#[derive(Debug, Clone)]
pub struct AgentActionRecord {
    pub actor: String,
    pub commitment: String,
    /// The target state's discriminant (e.g. `"Refunded"`, `"Active"`).
    pub to: String,
}

/// A multi-agent verdict: the session's verdict plus the `actor` of this action.
///
/// Additive over [`GuardResult`] — `Accepted` carries the same `next` world and
/// `replay` flag the session returns, plus the `actor`. `Rejected` carries the same
/// `violations` / `alternatives` / conflict fields, plus the `actor` whose action
/// tipped the shared world over and an `attribution` sentence spelling that out
/// against the prior accepted actors.
#[derive(Debug, Clone)]
pub enum MultiAgentResult {
    Accepted {
        next: World,
        replay: bool,
        actor: String,
    },
    Rejected {
        violations: Vec<GuardViolation>,
        alternatives: Vec<TransitionAlternative>,
        conflict: bool,
        expected: Option<String>,
        actual: Option<String>,
        actor: String,
        /// Which actor's action tipped the shared world over, against the prior actors.
        attribution: String,
    },
}

impl MultiAgentResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, MultiAgentResult::Accepted { .. })
    }
    pub fn is_replay(&self) -> bool {
        matches!(self, MultiAgentResult::Accepted { replay: true, .. })
    }
    pub fn is_conflict(&self) -> bool {
        matches!(self, MultiAgentResult::Rejected { conflict: true, .. })
    }
    /// The actor of this action (present on both variants).
    pub fn actor(&self) -> &str {
        match self {
            MultiAgentResult::Accepted { actor, .. } | MultiAgentResult::Rejected { actor, .. } => {
                actor
            }
        }
    }
}

/// A stateful sequence validator over a shared world spanning several named agents.
///
/// Composes the existing [`Session`] — same accumulated world, same actor-agnostic
/// cumulative / conflict / replay checks. This wrapper only adds attribution.
pub struct MultiAgentSession {
    session: Session,
    log: Vec<AgentActionRecord>,
}

impl MultiAgentSession {
    /// The current accumulated shared world (updated only on accepted actions).
    pub fn world(&self) -> &World {
        self.session.world()
    }

    /// The accepted actions in order, each tagged with the actor who performed it.
    pub fn log(&self) -> &[AgentActionRecord] {
        &self.log
    }

    /// The amount refunded so far for a commitment across all agents, or None.
    pub fn refunded_so_far(&self, commitment_id: &str) -> Option<Money> {
        self.session.refunded_so_far(commitment_id)
    }

    /// A per-actor count of accepted actions (who did how much).
    pub fn actors_summary(&self) -> HashMap<String, u32> {
        let mut out: HashMap<String, u32> = HashMap::new();
        for r in &self.log {
            *out.entry(r.actor.clone()).or_insert(0) += 1;
        }
        out
    }

    /// Distinct actors who have an accepted action so far (the accumulated context),
    /// in first-seen order.
    fn prior_actors(&self) -> Vec<String> {
        let mut seen: HashSet<&str> = HashSet::new();
        let mut out: Vec<String> = Vec::new();
        for r in &self.log {
            if seen.insert(r.actor.as_str()) {
                out.push(r.actor.clone());
            }
        }
        out
    }

    /// Validate `action` (from `action.actor`) against the ACCUMULATED shared world,
    /// apply it on success, and return the verdict with per-actor attribution. The
    /// cumulative / conflict / replay checks all apply across actors, because the
    /// underlying session is actor-agnostic.
    pub fn propose(&mut self, action: &ProposedAction) -> MultiAgentResult {
        let actor = action.actor.clone();
        let verdict = self.session.propose(action);
        match verdict {
            GuardResult::Accepted { next, replay } => {
                // A replay applied nothing new; only log genuinely-applied actions.
                if !replay {
                    self.log.push(AgentActionRecord {
                        actor: actor.clone(),
                        commitment: action.commitment.clone(),
                        to: commitment_state_type(&action.to).to_string(),
                    });
                }
                MultiAgentResult::Accepted {
                    next,
                    replay,
                    actor,
                }
            }
            GuardResult::Rejected {
                violations,
                alternatives,
                conflict,
                expected,
                actual,
            } => {
                let others: Vec<String> = self
                    .prior_actors()
                    .into_iter()
                    .filter(|a| *a != actor)
                    .collect();
                let context = if others.is_empty() {
                    "no prior actions".to_string()
                } else {
                    format!("the accumulated actions of {}", others.join(", "))
                };
                let rule = violations
                    .first()
                    .map(|v| v.rule.clone())
                    .unwrap_or_else(|| "an invariant".to_string());
                let what = if conflict {
                    "conflicts with the commitment's current version (a concurrent actor advanced it)".to_string()
                } else {
                    format!("tipped the shared world into violation of {rule}")
                };
                let attribution = format!("{actor}'s action, applied after {context}, {what}.");
                MultiAgentResult::Rejected {
                    violations,
                    alternatives,
                    conflict,
                    expected,
                    actual,
                    actor,
                    attribution,
                }
            }
        }
    }
}

pub fn create_multi_agent_session(initial_world: World) -> MultiAgentSession {
    MultiAgentSession {
        session: create_session(initial_world),
        log: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated::types::{Commitment, CommitmentState};
    use serde_json::json;

    fn fulfilled_order(id: &str, amount: f64) -> Commitment {
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

    fn accepted_order(id: &str) -> Commitment {
        serde_json::from_value(json!({
            "id": id,
            "parties": { "initiator": "buyer", "counterparty": "seller", "intermediaries": [] },
            "subject": { "offered": [], "requested": [
                { "id": "v", "form": { "kind": "Money", "money": { "amount": 200, "currency": "MAD" } }, "quantity": 1, "state": { "type": "Available" } }
            ] },
            "state": { "type": "Accepted" },
            "history": [],
            "children": [],
            "created_at": "2026-01-02T08:00:00.000Z"
        }))
        .expect("valid commitment")
    }

    fn draft_order(id: &str) -> Commitment {
        serde_json::from_value(json!({
            "id": id,
            "parties": { "initiator": "buyer", "counterparty": "seller", "intermediaries": [] },
            "subject": { "offered": [], "requested": [] },
            "state": { "type": "Draft" },
            "history": [],
            "children": [],
            "created_at": "2026-01-02T08:00:00.000Z"
        }))
        .expect("valid commitment")
    }

    fn refund(id: &str, amount: f64, actor: &str, key: &str) -> ProposedAction {
        let mut a = ProposedAction::new(
            id,
            CommitmentState::Refunded {
                amount: Money {
                    amount,
                    currency: "MAD".to_string(),
                },
                at: "2026-02-01T00:00:00.000Z".to_string(),
            },
            actor,
        );
        a.idempotency_key = Some(key.to_string());
        a
    }

    #[test]
    fn catches_cumulative_violation_across_actors_attributed_to_tipping_actor() {
        let mut s = create_multi_agent_session(World {
            commitments: vec![fulfilled_order("order_1", 200.0)],
            fulfillments: vec![],
            parties: vec![],
        });
        assert!(s.propose(&refund("order_1", 80.0, "agent-A", "a")).is_ok());
        assert!(s.propose(&refund("order_1", 80.0, "agent-B", "b")).is_ok());
        let third = s.propose(&refund("order_1", 80.0, "agent-C", "c"));
        match third {
            MultiAgentResult::Rejected {
                violations,
                actor,
                attribution,
                ..
            } => {
                assert_eq!(violations[0].rule, "I-1");
                assert_eq!(actor, "agent-C");
                assert!(attribution.contains("agent-C"));
                assert!(attribution.contains("agent-A"));
                assert!(attribution.contains("agent-B"));
                assert!(!attribution.contains("conspir")); // NOT collusion
            }
            MultiAgentResult::Accepted { .. } => panic!("expected rejection"),
        }
        // The world did not advance past the two accepted refunds.
        assert_eq!(s.refunded_so_far("order_1").unwrap().amount, 160.0);
    }

    #[test]
    fn single_actor_session_behaves_identically_attribution_additive() {
        let mut s = create_multi_agent_session(World {
            commitments: vec![fulfilled_order("order_1", 200.0)],
            fulfillments: vec![],
            parties: vec![],
        });
        assert!(s.propose(&refund("order_1", 80.0, "solo", "a")).is_ok());
        assert!(s.propose(&refund("order_1", 80.0, "solo", "b")).is_ok());
        let third = s.propose(&refund("order_1", 80.0, "solo", "c"));
        match third {
            MultiAgentResult::Rejected {
                actor, attribution, ..
            } => {
                assert_eq!(actor, "solo");
                assert!(attribution.contains("no prior actions")); // no OTHER actors
            }
            MultiAgentResult::Accepted { .. } => panic!("expected rejection"),
        }
    }

    #[test]
    fn valid_multi_agent_sequence_completes_with_summary_and_log() {
        let mut s = create_multi_agent_session(World {
            commitments: vec![draft_order("order_1")],
            fulfillments: vec![],
            parties: vec![],
        });
        assert!(s
            .propose(&ProposedAction::new(
                "order_1",
                CommitmentState::Proposed,
                "buyer-agent"
            ))
            .is_ok());
        assert!(s
            .propose(&ProposedAction::new(
                "order_1",
                CommitmentState::Accepted,
                "seller-agent"
            ))
            .is_ok());
        assert!(s
            .propose(&ProposedAction::new(
                "order_1",
                CommitmentState::Active,
                "ops-agent"
            ))
            .is_ok());
        assert_eq!(
            commitment_state_type(&s.world().commitments[0].state),
            "Active"
        );
        let summary = s.actors_summary();
        assert_eq!(summary.get("buyer-agent"), Some(&1));
        assert_eq!(summary.get("seller-agent"), Some(&1));
        assert_eq!(summary.get("ops-agent"), Some(&1));
        let actors: Vec<&str> = s.log().iter().map(|r| r.actor.as_str()).collect();
        assert_eq!(actors, vec!["buyer-agent", "seller-agent", "ops-agent"]);
    }

    #[test]
    fn f3_stale_version_conflict_attributed_to_late_actor() {
        let mut s = create_multi_agent_session(World {
            commitments: vec![accepted_order("order_1")],
            fulfillments: vec![],
            parties: vec![],
        });
        let planned = crate::toolkit::commitment_version(&s.world().commitments[0]);

        let mut a = ProposedAction::new("order_1", CommitmentState::Active, "agent-A");
        a.expected_version = Some(planned.clone());
        a.idempotency_key = Some("A".to_string());
        assert!(s.propose(&a).is_ok());

        let mut b = ProposedAction::new(
            "order_1",
            CommitmentState::Disputed {
                by: "buyer".to_string(),
                reason: "x".to_string(),
                opened_at: "2026-03-01T00:00:00.000Z".to_string(),
            },
            "agent-B",
        );
        b.expected_version = Some(planned);
        b.idempotency_key = Some("B".to_string());
        let verdict = s.propose(&b);
        assert!(verdict.is_conflict());
        match verdict {
            MultiAgentResult::Rejected {
                actor, attribution, ..
            } => {
                assert_eq!(actor, "agent-B");
                assert!(attribution.contains("conflict"));
            }
            MultiAgentResult::Accepted { .. } => panic!("expected conflict"),
        }
    }

    #[test]
    fn f4_replay_by_same_actor_is_replay_and_not_double_logged() {
        let mut s = create_multi_agent_session(World {
            commitments: vec![fulfilled_order("order_1", 200.0)],
            fulfillments: vec![],
            parties: vec![],
        });
        let first = s.propose(&refund("order_1", 50.0, "agent-A", "k"));
        assert!(first.is_ok() && !first.is_replay());
        let retry = s.propose(&refund("order_1", 50.0, "agent-A", "k"));
        assert!(retry.is_ok() && retry.is_replay());
        // Logged once (the replay applied nothing new); refunded once.
        assert_eq!(s.actors_summary().get("agent-A"), Some(&1));
        assert_eq!(s.refunded_so_far("order_1").unwrap().amount, 50.0);
    }
}
