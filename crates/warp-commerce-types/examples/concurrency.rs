//! Optimistic-concurrency: two actors on the same commitment; one planned against
//! a stale version is rejected as a CONFLICT so it re-reads and re-plans. Rust twin
//! of examples/concurrency.mjs — same outcomes (the version string differs in form:
//! the conformance-shaped Rust runtime advances state without re-appending history,
//! so the version advances via the state fingerprint, e.g. "0:Accepted" -> "0:Active";
//! the conflict verdict is identical).
//!
//! Scope: OPTIMISTIC concurrency over the caller's view. NOT a lock, distributed
//! consensus, or a transaction manager.
//!
//!   cargo run -p warp-commerce-types --example concurrency

use serde_json::json;
use warp_commerce_types::generated::types::{Commitment, CommitmentState};
use warp_commerce_types::toolkit::{
    commitment_version, create_session, GuardResult, ProposedAction, World,
};

fn accepted_order(id: &str) -> Commitment {
    serde_json::from_value(json!({
        "id": id,
        "parties": {"initiator":"buyer","counterparty":"seller","intermediaries":[]},
        "subject": {"offered": [], "requested": [
            {"id":"v","form":{"kind":"Money","money":{"amount":200,"currency":"MAD"}},"quantity":1,"state":{"type":"Available"}}
        ]},
        "state": {"type":"Accepted"},
        "history": [],
        "children": [],
        "created_at": "2026-01-02T08:00:00.000Z"
    }))
    .expect("valid commitment")
}

fn disputed() -> CommitmentState {
    CommitmentState::Disputed {
        by: "buyer".to_string(),
        reason: "item issue".to_string(),
        opened_at: "2026-03-01T00:00:00.000Z".to_string(),
    }
}

fn main() {
    let mut session = create_session(World {
        commitments: vec![accepted_order("order_1")],
        fulfillments: vec![],
        parties: vec![],
    });
    let version =
        |s: &warp_commerce_types::toolkit::Session| commitment_version(&s.world().commitments[0]);

    let planned = version(&session);
    println!("both actors planned against version: {planned}");

    // Actor A activates — applied.
    let mut a = ProposedAction::new("order_1", CommitmentState::Active, "seller");
    a.expected_version = Some(planned.clone());
    a.idempotency_key = Some("A-activate".to_string());
    let av = session.propose(&a);
    println!(
        "\nActor A: activate (planned {planned}) -> ok: {}. commitment is now version {}",
        av.is_ok(),
        version(&session)
    );

    // Actor B planned against the stale version — CONFLICT.
    let mut b = ProposedAction::new("order_1", disputed(), "buyer");
    b.expected_version = Some(planned.clone());
    b.idempotency_key = Some("B-dispute".to_string());
    if let GuardResult::Rejected {
        violations,
        conflict: true,
        expected,
        actual,
        ..
    } = session.propose(&b)
    {
        println!("\nActor B: dispute (planned {planned}) -> CONFLICT");
        println!(
            "  expected {}, but actual is {}",
            expected.unwrap_or_default(),
            actual.unwrap_or_default()
        );
        println!("  {}", violations[0].fix);
    }

    // Actor B re-reads and re-plans — applies.
    let current = version(&session);
    let mut b2 = ProposedAction::new("order_1", disputed(), "buyer");
    b2.expected_version = Some(current.clone());
    b2.idempotency_key = Some("B-dispute-2".to_string());
    let b2v = session.propose(&b2);
    println!(
        "\nActor B re-reads (version {current}) and re-plans -> ok: {}. commitment is now {}",
        b2v.is_ok(),
        serde_json::to_value(&session.world().commitments[0].state).unwrap()["type"]
            .as_str()
            .unwrap_or("?")
    );

    // Backward-compatible: no expected version.
    let mut s2 = create_session(World {
        commitments: vec![accepted_order("order_2")],
        fulfillments: vec![],
        parties: vec![],
    });
    let nov = s2.propose(&ProposedAction::new(
        "order_2",
        CommitmentState::Active,
        "seller",
    ));
    println!(
        "\nno expectedVersion supplied -> applied unconditionally (backward-compatible): {}",
        nov.is_ok()
    );

    // Replay is not a conflict.
    let replay = session.propose(&a);
    println!("replay of Actor A (same key, stale version) -> replay: {}, conflict: {} (a retry is a replay, not a conflict)", replay.is_replay(), replay.is_conflict());
}
