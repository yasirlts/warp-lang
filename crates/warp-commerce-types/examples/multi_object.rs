//! Multi-object coherence (F6): the session's cumulative checking spans a TREE of
//! related commitments — a parent order and its child line-item commitments. Refunds
//! spread across DIFFERENT children (each individually valid, each child reconciling to
//! the parent via I-6) cannot cumulatively exceed the PARENT's committed amount. Rust
//! twin of the TS / Python multi-object examples — same verdicts.
//!
//!   cargo run -p warp-commerce-types --example multi_object
//!
//! The unit is a parent + its children tree. This composes the existing tree structural
//! check (I-6, via the canonical scene audit) + the I-1 cumulative rule lifted to the
//! parent. BINDING SHAPE GAP: TS / Python call a standalone `checkI6TreeConsistency`;
//! the Rust runtime has I-6 inline in `audit_scene`, so the session audits the
//! root+children subset through that — same verdict, documented in the toolkit.

use serde_json::json;
use warp_commerce_types::generated::types::{Commitment, CommitmentState, Money};
use warp_commerce_types::toolkit::{create_session, ProposedAction, Session, World};

fn commit_linked(id: &str, amount: f64, parent: Option<&str>, children: &[&str]) -> Commitment {
    serde_json::from_value(json!({
        "id": id,
        "parties": {"initiator":"buyer","counterparty":"seller","intermediaries":[]},
        "subject": {"offered": [], "requested": [
            {"id":"v","form":{"kind":"Money","money":{"amount":amount,"currency":"MAD"}},"quantity":1,"state":{"type":"Available"}}
        ]},
        "state": {"type":"Fulfilled"},
        "history": [],
        "parent": parent,
        "children": children,
        "created_at": "2026-01-02T08:00:00.000Z"
    }))
    .expect("valid commitment")
}

fn refund(commitment: &str, amount: f64, key: &str) -> ProposedAction {
    let mut a = ProposedAction::new(
        commitment,
        CommitmentState::Refunded {
            amount: Money {
                amount,
                currency: "MAD".to_string(),
            },
            at: "2026-02-01T00:00:00.000Z".to_string(),
        },
        "agent",
    );
    a.idempotency_key = Some(key.to_string());
    a
}

fn tree_total(s: &Session, ids: &[&str]) -> f64 {
    ids.iter()
        .map(|id| s.refunded_so_far(id).map(|m| m.amount).unwrap_or(0.0))
        .sum()
}

fn main() {
    // A 200 MAD parent with two 100-children (100 + 100 = 200), all shipped.
    let parent = commit_linked("order-1", 200.0, None, &["line-A", "line-B"]);
    let line_a = commit_linked("line-A", 100.0, Some("order-1"), &[]);
    let line_b = commit_linked("line-B", 100.0, Some("order-1"), &[]);

    let mut session = create_session(World {
        commitments: vec![parent, line_a, line_b],
        fulfillments: vec![],
        parties: vec![],
    });
    let ids = ["order-1", "line-A", "line-B"];

    // Two line-item refunds, each ≤ its own child's committed (100). Individually valid.
    let a = session.propose(&refund("line-A", 80.0, "a"));
    println!(
        "refund line-A 80 -> {} (tree refunded: {} MAD)",
        if a.is_ok() { "accepted" } else { "rejected" },
        tree_total(&session, &ids) as i64
    );
    let b = session.propose(&refund("line-B", 80.0, "b"));
    println!(
        "refund line-B 80 -> {} (tree refunded: {} MAD)",
        if b.is_ok() { "accepted" } else { "rejected" },
        tree_total(&session, &ids) as i64
    );

    // A third refund — on the PARENT, 80 ≤ 200 on its own — but the TREE total would
    // reach 240 > 200. Caught at this step, with the remaining-refundable across the tree.
    let over = session.propose(&refund("order-1", 80.0, "p"));
    if let warp_commerce_types::toolkit::GuardResult::Rejected {
        violations,
        alternatives,
        ..
    } = &over
    {
        println!("\nrefund order-1 80 -> BLOCKED [{}]", violations[0].rule);
        println!("  {}", violations[0].message);
        if let Some(bounded) = alternatives.first().and_then(|x| x.bounded.as_deref()) {
            println!("  guidance: {bounded}");
        }
    }

    // Corrected to the remaining 40 across the tree -> completes.
    let fixed = session.propose(&refund("order-1", 40.0, "p2"));
    println!(
        "\ncorrected refund order-1 40 -> {}. tree refunded: {} MAD (== parent committed 200)",
        if fixed.is_ok() {
            "accepted"
        } else {
            "rejected"
        },
        tree_total(&session, &ids) as i64
    );

    // A fully-valid tree: refund each child within the parent (100 + 100 = 200).
    let p2 = commit_linked("order-2", 200.0, None, &["line-C", "line-D"]);
    let lc = commit_linked("line-C", 100.0, Some("order-2"), &[]);
    let ld = commit_linked("line-D", 100.0, Some("order-2"), &[]);
    let mut s2 = create_session(World {
        commitments: vec![p2, lc, ld],
        fulfillments: vec![],
        parties: vec![],
    });
    let c = s2.propose(&refund("line-C", 100.0, "c"));
    let d = s2.propose(&refund("line-D", 100.0, "d"));
    println!(
        "\nvalid tree: refund line-C 100 -> {}, line-D 100 -> {} (tree total 200 == parent 200, within the parent)",
        c.is_ok(),
        d.is_ok()
    );
}
