//! Warp as the neutral model between platforms: unify caller-corresponded objects,
//! validate, emit a platform-shaped descriptor. Rust twin of the TS/Python
//! cross-platform example — same verdicts.
//!
//! NOTE: the Rust binding ships no platform inbound mappers, so the "platform
//! objects" are built directly here (the same shape the mappers would produce);
//! `unify` is platform-agnostic. No network, no execution — descriptors only.
//!
//!   cargo run -p warp-commerce-types --example cross_platform

use serde_json::json;
use warp_commerce_types::generated::types::{Commitment, CommitmentState, Money};
use warp_commerce_types::toolkit::{
    guard_action, to_stripe_action, unify, EmitResult, GuardResult, ProposedAction, UnifyResult,
    UnifySource,
};

fn order(id: &str, amount: f64) -> Commitment {
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
    // Two platform objects for the SAME transaction (the caller asserts they correspond).
    let shopify = order("order_123", 200.0);
    let stripe = order("pi_abc", 200.0);

    let unified = unify(
        &[
            UnifySource {
                platform: "shopify".into(),
                commitment: shopify.clone(),
            },
            UnifySource {
                platform: "stripe".into(),
                commitment: stripe,
            },
        ],
        Some("order_123"),
    );

    if let UnifyResult::Unified { commitment, world } = unified {
        let st = serde_json::to_value(&commitment.state).unwrap();
        println!(
            "unify (200 MAD == 200 MAD) -> ok: true, one commitment '{}' in state {}",
            commitment.id,
            st["type"].as_str().unwrap_or("?")
        );

        // An agent over-refunds 500 vs 200 — caught with bounded guidance.
        let over = guard_action(
            &world,
            &ProposedAction::new("order_123", refund(500.0), "agent"),
        );
        if let GuardResult::Rejected {
            violations,
            alternatives,
            ..
        } = &over
        {
            let b = alternatives
                .iter()
                .find(|a| a.to == "Refunded")
                .and_then(|a| a.bounded.clone())
                .unwrap_or_default();
            println!(
                "\nover-refund 500 MAD -> BLOCKED [{}]; Refunded bounded: {}",
                violations[0].rule, b
            );
        }

        // A valid refund of 40 MAD: validate, then emit the Stripe-shaped descriptor.
        let action = ProposedAction::new("order_123", refund(40.0), "agent");
        let verdict = guard_action(&world, &action);
        println!("\nvalid refund 40 MAD -> accepted: {}", verdict.is_ok());
        if verdict.is_ok() {
            if let EmitResult::Descriptor { descriptor, .. } = to_stripe_action(&action) {
                println!("emit (no API call — a descriptor only): {descriptor}");
            }
        }
    }

    // Inbound mismatch — 200 vs 150 does not conserve.
    let stripe_short = order("pi_short", 150.0);
    let mismatch = unify(
        &[
            UnifySource {
                platform: "shopify".into(),
                commitment: shopify,
            },
            UnifySource {
                platform: "stripe".into(),
                commitment: stripe_short,
            },
        ],
        None,
    );
    if let UnifyResult::Rejected { violations } = mismatch {
        println!(
            "\nunify (200 MAD vs 150 MAD) -> BLOCKED [{}]: {}",
            violations[0].rule, violations[0].message
        );
    }
}
