//! Saga / compensation (F7): model the UNWINDING of a multi-step flow as an explicit,
//! validated sequence of compensating actions, and check the compensation is coherent
//! (a reversal that would over-refund is rejected with guidance). Rust twin of the TS /
//! Python saga examples — same verdicts.
//!
//!   cargo run -p warp-commerce-types --example saga
//!
//! Scope (honest): Warp VALIDATES the compensation sequence — each compensating action
//! is a legal reversing transition and the net effect conserves value. Warp does NOT
//! execute or orchestrate rollbacks on external systems; the plan is a sequence of
//! validated descriptors. Composes valid_transitions + create_session; it does not fork
//! invariant or transition logic.

use serde_json::json;
use warp_commerce_types::generated::types::{Commitment, CommitmentState, Money};
use warp_commerce_types::saga::{compensate, compensate_session, CompensationResult, ForwardStep};
use warp_commerce_types::toolkit::{create_session, ProposedAction, World};

const AT: &str = "2026-03-01T00:00:00.000Z";

fn order_in(id: &str, amount: f64, state: serde_json::Value) -> Commitment {
    serde_json::from_value(json!({
        "id": id,
        "parties": {"initiator":"buyer","counterparty":"seller","intermediaries":[]},
        "subject": {"offered": [], "requested": [
            {"id":"v","form":{"kind":"Money","money":{"amount":amount,"currency":"MAD"}},"quantity":1,"state":{"type":"Available"}}
        ]},
        "state": state,
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
        at: AT.to_string(),
    }
}

fn final_state(world: &World, id: &str) -> String {
    world
        .commitments
        .iter()
        .find(|c| c.id == id)
        .map(|c| {
            serde_json::to_value(&c.state).expect("serialize")["type"]
                .as_str()
                .unwrap_or("?")
                .to_string()
        })
        .unwrap_or_else(|| "?".to_string())
}

fn main() {
    // ── Forward flow: accept → fulfill → partial refund 50 of 200 ──────────────────
    // We drive a 200 MAD order to Fulfilled, then a partial refund of 50 is applied in a
    // session (the schema has no partial-refund state, so the session tracks it and keeps
    // the order in Fulfilled). This is the world we now need to UNWIND.
    let mut session = create_session(World {
        commitments: vec![order_in("order-1", 200.0, json!({ "type": "Fulfilled" }))],
        fulfillments: vec![],
        parties: vec![],
    });
    let mut partial = ProposedAction::new("order-1", refund_state(50.0), "seller");
    partial.idempotency_key = Some("partial-50".to_string());
    let p = session.propose(&partial);
    println!(
        "forward flow: accept → fulfill → partial refund 50 → applied: {}. refunded so far: {} MAD of 200",
        p.is_ok(),
        session.refunded_so_far("order-1").map(|m| m.amount).unwrap_or(0.0) as i64
    );

    // ── INVALID compensation: reverse the Fulfilled step by refunding the FULL 200
    // again. Validated IN THE SAME SESSION, so the 50 already refunded is counted: 50 +
    // 200 = 250 > 200. The session rejects it with the remaining-refundable guidance. ──
    let mut over_step = ForwardStep::new("order-1", CommitmentState::Fulfilled, "seller");
    over_step.compensate_with = Some(refund_state(200.0));
    let (_, bad) = compensate_session(&mut session, &[over_step], AT);
    if let CompensationResult::Rejected {
        failed_at,
        violations,
        alternatives,
        ..
    } = &bad
    {
        println!(
            "\nINVALID compensation (refund full 200 while 50 already refunded) → BLOCKED at step {} [{}]",
            failed_at, violations[0].rule
        );
        println!("  {}", violations[0].message);
        if let Some(bounded) = alternatives
            .iter()
            .find(|a| a.to == "Refunded")
            .and_then(|a| a.bounded.as_deref())
        {
            println!("  guidance: {bounded}");
        }
    }

    // ── VALID compensation: reverse the Fulfilled step by refunding the REMAINING 150.
    // The cumulative cap accepts it (50 + 150 = 200 == committed); the session marks the
    // order fully Refunded, and the world is coherent. ─────────────────────────────────
    let mut ok_step = ForwardStep::new("order-1", CommitmentState::Fulfilled, "seller");
    ok_step.compensate_with = Some(refund_state(150.0));
    let (_, good) = compensate_session(&mut session, &[ok_step], AT);
    if let CompensationResult::Ok {
        next,
        applied,
        skipped,
    } = &good
    {
        println!("\nVALID compensation (refund the remaining 150) → applied: true");
        println!("  compensating actions applied: {applied}, skipped: {skipped}");
        println!(
            "  refunded total: {} MAD; order-1 final state: {} (50 + 150 = 200 == committed; value conserved)",
            session.refunded_so_far("order-1").map(|m| m.amount).unwrap_or(0.0) as i64,
            final_state(next, "order-1")
        );
    }

    // ── Default mapping over a fresh accept→active flow unwound by Cancellation. ───────
    let lease_world = World {
        commitments: vec![order_in("lease-1", 100.0, json!({ "type": "Active" }))],
        fulfillments: vec![],
        parties: vec![],
    };
    let (lease_plan, lease_result) = compensate(
        &lease_world,
        &[ForwardStep::new(
            "lease-1",
            CommitmentState::Active,
            "seller",
        )],
        AT,
    );
    let reversing = lease_plan
        .steps
        .iter()
        .filter(|s| s.action.is_some())
        .count();
    println!(
        "\ndefault mapping: Active commitment unwound by Cancellation → applied: {} (plan reverses {} step)",
        lease_result.is_ok(),
        reversing
    );
    if let CompensationResult::Ok { next, .. } = &lease_result {
        println!(
            "  lease-1 final state: {} (committed-but-not-delivered → Cancelled)",
            final_state(next, "lease-1")
        );
    }
}
