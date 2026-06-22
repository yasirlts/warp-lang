//! Session coherence: catch a cumulative over-refund single-action checks miss.
//! Rust twin of the TS/Python agent-session examples — same verdicts.
//!
//!   cargo run -p warp-commerce-types --example agent_session

use serde_json::json;
use warp_commerce_types::generated::types::{Commitment, CommitmentState, Money};
use warp_commerce_types::toolkit::{create_session, GuardResult, ProposedAction, World};

fn fulfilled_order(id: &str, amount: f64) -> Commitment {
    serde_json::from_value(json!({
        "id": id,
        "parties": {"initiator":"buyer","counterparty":"seller","intermediaries":[]},
        "subject": {"offered": [], "requested": [
            {"id":"v","form":{"kind":"Money","money":{"amount":amount,"currency":"MAD"}},"quantity":1,"state":{"type":"Available"}}
        ]},
        "state": {"type":"Fulfilled"},
        "history": [],
        "children": [],
        "created_at": "2026-01-02T08:00:00.000Z"
    }))
    .expect("valid commitment")
}

fn refund(amount: f64) -> ProposedAction {
    ProposedAction {
        commitment: "order_1".into(),
        to: CommitmentState::Refunded {
            amount: Money {
                amount,
                currency: "MAD".to_string(),
            },
            at: "2026-02-01T00:00:00.000Z".to_string(),
        },
        actor: "support_agent".into(),
    }
}

fn main() {
    let order = fulfilled_order("order_1", 200.0);
    let mut session = create_session(World {
        commitments: vec![order],
        fulfillments: vec![],
        parties: vec![],
    });

    // Three partial refunds of 80 MAD. Each alone passes (80 <= 200) — but they accumulate.
    for amount in [80.0, 80.0, 80.0] {
        let verdict = session.propose(&refund(amount));
        let sofar = session
            .refunded_so_far("order_1")
            .map(|m| m.amount)
            .unwrap_or(0.0);
        match &verdict {
            GuardResult::Accepted { .. } => {
                println!(
                    "refund {} MAD -> accepted. refunded so far: {} MAD",
                    amount as i64, sofar as i64
                );
            }
            GuardResult::Rejected {
                violations,
                alternatives,
            } => {
                println!(
                    "\nrefund {} MAD -> BLOCKED [{}]",
                    amount as i64, violations[0].rule
                );
                println!("{}", violations[0].message);
                println!("FIX: {}", violations[0].fix);
                println!(
                    "bounded alternative: Refunded — {}",
                    alternatives[0].bounded.as_deref().unwrap_or("")
                );
                println!("refunded so far (unchanged): {} MAD", sofar as i64);
            }
        }
    }

    // The agent reads the bounded guidance (40 MAD remaining) and refunds within it.
    let corrected = session.propose(&refund(40.0));
    let total = session
        .refunded_so_far("order_1")
        .map(|m| m.amount)
        .unwrap_or(0.0);
    // The state's discriminant via the public Serialize (CommitmentState is tagged on "type").
    let state_json =
        serde_json::to_value(&session.world().commitments[0].state).expect("serialize");
    let state = state_json["type"].as_str().unwrap_or("?");
    println!(
        "\ncorrected refund 40 MAD -> {}. total refunded: {} MAD (== committed 200; order is now {})",
        if corrected.is_ok() { "accepted" } else { "blocked" },
        total as i64,
        state
    );
}
