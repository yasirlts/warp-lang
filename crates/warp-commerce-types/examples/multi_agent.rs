//! Multi-agent verification (F5): several named agents act on a SHARED world. Each
//! action is individually valid, but their COMBINED sequence violates an invariant —
//! Warp catches it at the offending step and attributes it to the actor whose action
//! tipped the shared world into violation. Rust twin of the TS / Python multi-agent
//! examples — same verdicts (the attribution wording is this binding's own).
//!
//!   cargo run -p warp-commerce-types --example multi_agent
//!
//! Scope: shared-world invariant enforcement WITH attribution. The attribution is the
//! action that tipped the world over — NOT collusion or intent detection.

use serde_json::json;
use warp_commerce_types::generated::types::{Commitment, CommitmentState, Money};
use warp_commerce_types::multi_agent::{create_multi_agent_session, MultiAgentResult};
use warp_commerce_types::toolkit::{ProposedAction, World};

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

fn draft_order(id: &str) -> Commitment {
    serde_json::from_value(json!({
        "id": id,
        "parties": {"initiator":"buyer","counterparty":"seller","intermediaries":[]},
        "subject": {"offered": [], "requested": []},
        "state": {"type":"Draft"},
        "history": [],
        "children": [],
        "created_at": "2026-01-02T08:00:00.000Z"
    }))
    .expect("valid commitment")
}

fn refund(amount: f64, actor: &str, key: &str) -> ProposedAction {
    let mut a = ProposedAction::new(
        "order_1",
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

fn refunded(s: &warp_commerce_types::multi_agent::MultiAgentSession) -> f64 {
    s.refunded_so_far("order_1")
        .map(|m| m.amount)
        .unwrap_or(0.0)
}

fn main() {
    // A shipped (Fulfilled) order committed at 200 MAD, shared by several agents.
    let mut session = create_multi_agent_session(World {
        commitments: vec![fulfilled_order("order_1", 200.0)],
        fulfillments: vec![],
        parties: vec![],
    });

    // 1) A finance-agent refunds 120 MAD for damaged items — valid on its own.
    let a = session.propose(&refund(120.0, "finance-agent", "fin-1"));
    println!(
        "finance-agent refunds 120 -> {} (refunded so far: {} MAD)",
        if a.is_ok() { "accepted" } else { "rejected" },
        refunded(&session) as i64
    );

    // 2) A support-agent, unaware, refunds 100 MAD goodwill — valid ON ITS OWN, but the
    //    SHARED world now over-refunds (220 > 200). Caught and attributed to support-agent.
    let b = session.propose(&refund(100.0, "support-agent", "sup-1"));
    if let MultiAgentResult::Rejected {
        violations,
        alternatives,
        attribution,
        ..
    } = &b
    {
        println!(
            "\nsupport-agent refunds 100 -> BLOCKED [{}]",
            violations[0].rule
        );
        println!("  attribution: {attribution}");
        let guidance = alternatives
            .iter()
            .find(|x| x.to == "Refunded")
            .and_then(|x| x.bounded.clone())
            .unwrap_or_else(|| violations[0].fix.clone());
        println!("  guidance: {guidance}");
    }

    // 3) support-agent reads the remaining-refundable guidance and corrects to 80 MAD.
    let c = session.propose(&refund(80.0, "support-agent", "sup-2"));
    let state = serde_json::to_value(&session.world().commitments[0].state).expect("serialize");
    println!(
        "\nsupport-agent corrects to 80 -> {}. total refunded: {} MAD (order is now {})",
        if c.is_ok() { "accepted" } else { "rejected" },
        refunded(&session) as i64,
        state["type"].as_str().unwrap_or("?")
    );
    println!("who did what: {:?}", session.actors_summary());

    // 4) A fully-valid multi-agent sequence on a fresh order: buyer-agent proposes,
    //    seller-agent accepts, ops-agent activates — different actors, all valid.
    let mut flow = create_multi_agent_session(World {
        commitments: vec![draft_order("order_2")],
        fulfillments: vec![],
        parties: vec![],
    });
    let p = flow.propose(&ProposedAction::new(
        "order_2",
        CommitmentState::Proposed,
        "buyer-agent",
    ));
    let acc = flow.propose(&ProposedAction::new(
        "order_2",
        CommitmentState::Accepted,
        "seller-agent",
    ));
    let act = flow.propose(&ProposedAction::new(
        "order_2",
        CommitmentState::Active,
        "ops-agent",
    ));
    let fstate = serde_json::to_value(&flow.world().commitments[0].state).expect("serialize");
    println!(
        "\nvalid multi-agent flow -> proposed:{} accepted:{} activated:{}. state: {}; agents: {:?}",
        p.is_ok(),
        acc.is_ok(),
        act.is_ok(),
        fstate["type"].as_str().unwrap_or("?"),
        flow.actors_summary()
    );
}
