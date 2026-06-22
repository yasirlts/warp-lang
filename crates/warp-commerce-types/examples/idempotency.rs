//! Idempotency & replay-safety: the SAME action applied twice does not
//! double-apply. Rust twin of examples/idempotency.mjs — same outcomes.
//!
//! Scope: per-session, in-memory. Durable cross-session idempotency is not provided.
//!
//!   cargo run -p warp-commerce-types --example idempotency

use serde_json::json;
use warp_commerce_types::generated::types::{Commitment, CommitmentState, Money};
use warp_commerce_types::toolkit::{create_session, ProposedAction, World};

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

fn refund(amount: f64, key: Option<&str>) -> ProposedAction {
    let mut a = ProposedAction::new(
        "order_1",
        CommitmentState::Refunded {
            amount: Money {
                amount,
                currency: "MAD".to_string(),
            },
            at: "2026-02-01T00:00:00.000Z".to_string(),
        },
        "support_agent",
    );
    a.idempotency_key = key.map(|k| k.to_string());
    a
}

fn main() {
    let mut session = create_session(World {
        commitments: vec![fulfilled_order("order_1", 200.0)],
        fulfillments: vec![],
        parties: vec![],
    });
    let sofar = |s: &warp_commerce_types::toolkit::Session| {
        s.refunded_so_far("order_1")
            .map(|m| m.amount as i64)
            .unwrap_or(0)
    };

    let first = session.propose(&refund(50.0, Some("refund-key-1")));
    println!(
        "refund 50 (key refund-key-1) -> ok: {}, replay: {}. refunded so far: {} MAD",
        first.is_ok(),
        first.is_replay(),
        sofar(&session)
    );

    let retry = session.propose(&refund(50.0, Some("refund-key-1")));
    println!(
        "retry 50 (key refund-key-1) -> ok: {}, replay: {}. refunded so far (unchanged): {} MAD",
        retry.is_ok(),
        retry.is_replay(),
        sofar(&session)
    );

    let second = session.propose(&refund(30.0, Some("refund-key-2")));
    println!(
        "refund 30 (key refund-key-2) -> ok: {}, replay: {}. refunded so far: {} MAD",
        second.is_ok(),
        second.is_replay(),
        sofar(&session)
    );

    let keyless = session.propose(&refund(20.0, None));
    let keyless_retry = session.propose(&refund(20.0, None));
    println!(
        "keyless refund 20 -> ok: {}, replay: {}",
        keyless.is_ok(),
        keyless.is_replay()
    );
    println!(
        "identical keyless retry -> ok: {}, replay: {}. total refunded: {} MAD",
        keyless_retry.is_ok(),
        keyless_retry.is_replay(),
        sofar(&session)
    );
}
