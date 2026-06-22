//! The planning oracle: on rejection, the guard returns the legal moves. Rust
//! twin of the TS/Python planning-oracle examples — same verdicts.
//!
//!   cargo run -p warp-commerce-types --example planning_oracle

use serde_json::json;
use warp_commerce_types::generated::types::{Commitment, CommitmentState, Money};
use warp_commerce_types::toolkit::{
    guard_action, valid_transitions, GuardResult, ProposedAction, World,
};

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

    println!(
        "Legal moves from Fulfilled: {:?}",
        valid_transitions(&CommitmentState::Fulfilled)
    );

    // 1) An invalid revert — rejected WITH the legal alternatives.
    let verdict = guard_action(
        &world,
        &ProposedAction {
            commitment: "order_1".into(),
            to: CommitmentState::Accepted,
            actor: "support_agent".into(),
        },
    );
    if let GuardResult::Rejected {
        violations,
        alternatives,
    } = &verdict
    {
        println!(
            "\nBLOCKED [{}] {}",
            violations[0].rule, violations[0].message
        );
        println!("Alternatives the agent can choose from:");
        for a in alternatives {
            let b = a
                .bounded
                .as_ref()
                .map(|s| format!(" — bounded: {s}"))
                .unwrap_or_default();
            println!("  - {} ({}){}", a.to, a.label, b);
        }
        // 2) The agent picks a legal, unbounded alternative and retries. (Disputed
        //    requires payload fields; the agent supplies them.)
        let choice = alternatives
            .iter()
            .find(|a| a.bounded.is_none())
            .expect("an unbounded move");
        println!("\nAgent picks: {} ({})", choice.to, choice.label);
        let disputed: CommitmentState = serde_json::from_value(json!({"type":"Disputed","by":"seller","reason":"customer dispute","opened_at":"2026-03-01T00:00:00.000Z"})).unwrap();
        let retry = guard_action(
            &world,
            &ProposedAction {
                commitment: "order_1".into(),
                to: disputed,
                actor: "support_agent".into(),
            },
        );
        println!("Retry accepted? {}", retry.is_ok());
    }

    // 3) Over-refund: Refunded is legal but bounded by the amount.
    let order2 = fulfilled_order("order_2", 200.0);
    let world2 = World {
        commitments: vec![order2],
        fulfillments: vec![],
        parties: vec![],
    };
    let over = guard_action(
        &world2,
        &ProposedAction {
            commitment: "order_2".into(),
            to: refund(500.0),
            actor: "support_agent".into(),
        },
    );
    if let GuardResult::Rejected {
        violations,
        alternatives,
    } = &over
    {
        let refunded = alternatives
            .iter()
            .find(|a| a.to == "Refunded")
            .and_then(|a| a.bounded.clone())
            .unwrap_or_default();
        println!(
            "\nBLOCKED [{}] over-refund. Refunded is legal but bounded: {}",
            violations[0].rule, refunded
        );
        let corrected = guard_action(
            &world2,
            &ProposedAction {
                commitment: "order_2".into(),
                to: refund(200.0),
                actor: "support_agent".into(),
            },
        );
        println!("Corrected refund (200 MAD) accepted? {}", corrected.is_ok());
    }
}
