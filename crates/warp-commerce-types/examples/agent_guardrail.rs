//! Validate an agent's actions BEFORE they execute. Rust twin of the TS/Python
//! agent-guardrail examples — same verdicts.
//!
//!   cargo run -p warp-commerce-types --example agent_guardrail

use serde_json::json;
use warp_commerce_types::generated::types::{Commitment, CommitmentState, Money};
use warp_commerce_types::toolkit::{guard_action, GuardResult, ProposedAction, World};

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

fn refund(amount: f64) -> CommitmentState {
    CommitmentState::Refunded {
        amount: Money {
            amount,
            currency: "MAD".to_string(),
        },
        at: "2026-02-01T00:00:00.000Z".to_string(),
    }
}

fn main() {
    let order = fulfilled_order("order_1", 200.0);
    let world = World {
        commitments: vec![order],
        fulfillments: vec![],
        parties: vec![],
    };

    // NIGHTMARE 1: revert a shipped order to Accepted — blocked first.
    let reverted = guard_action(
        &world,
        &ProposedAction {
            commitment: "order_1".into(),
            to: CommitmentState::Accepted,
            actor: "support_agent".into(),
        },
    );
    if let GuardResult::Rejected { violations, .. } = &reverted {
        println!("BLOCKED [{}] {}", violations[0].rule, violations[0].message);
        println!("FIX: {}", violations[0].fix);
    }

    // NIGHTMARE 2: refund 500 against a 200 order — blocked, I-1.
    let over = guard_action(
        &world,
        &ProposedAction {
            commitment: "order_1".into(),
            to: refund(500.0),
            actor: "support_agent".into(),
        },
    );
    if let GuardResult::Rejected { violations, .. } = &over {
        let v = violations.iter().find(|v| v.rule == "I-1").expect("I-1");
        println!("BLOCKED [{}] {}", v.rule, v.message);
    }

    // SAFE: a refund of at most the committed amount is approved.
    let ok = guard_action(
        &world,
        &ProposedAction {
            commitment: "order_1".into(),
            to: refund(200.0),
            actor: "support_agent".into(),
        },
    );
    println!("refund (200 MAD) approved? {}", ok.is_ok());
}
