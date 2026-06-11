//! Integration tests for the Phase 3 commerce-advisor tools.
//!
//! These call the live Anthropic API (Claude-in-Claude), so they are all
//! `#[ignore]` — `cargo test` stays green without `ANTHROPIC_API_KEY`. Run
//! them deliberately with:
//!
//! ```text
//! ANTHROPIC_API_KEY=sk-... cargo test -p warp-mcp -- --ignored
//! ```
//!
//! The output is model-generated, so assertions check for the load-bearing
//! signal (a specific invariant id, a primitive name) rather than exact text.
//!
//! Pure, always-run unit tests (tool-list shape, JSON extraction, the
//! missing-key error message) live inline in `src/commerce/mod.rs` and
//! `src/tools.rs` and need no API key.

use serde_json::{json, Value};
use warp_mcp::commerce;

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn call(name: &str, args: Value) -> Value {
    commerce::dispatch(&client(), name, &args)
        .await
        .expect("name must be a commerce tool")
        .expect("advisor call must succeed (needs ANTHROPIC_API_KEY)")
}

fn invariants(result: &Value) -> Vec<String> {
    result["violations"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v["invariant"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
#[ignore = "calls the Anthropic API; run with --ignored and ANTHROPIC_API_KEY set"]
async fn test_validate_detects_currency_mixing() {
    let result = call(
        "warp_validate_commerce_code",
        json!({
            "code": "const price = 150;\nconst total = priceMAD + priceEUR;",
            "language": "typescript"
        }),
    )
    .await;
    assert!(
        invariants(&result).iter().any(|i| i == "I-1"),
        "expected an I-1 violation, got {result}"
    );
    assert_eq!(result["passed"], false);
}

#[tokio::test]
#[ignore = "calls the Anthropic API; run with --ignored and ANTHROPIC_API_KEY set"]
async fn test_validate_detects_backward_transition() {
    let result = call(
        "warp_validate_commerce_code",
        json!({
            "code": "order.status = 'fulfilled';\n// ...later...\norder.status = 'pending';",
            "language": "javascript"
        }),
    )
    .await;
    assert!(
        invariants(&result).iter().any(|i| i == "I-2"),
        "expected an I-2 violation, got {result}"
    );
}

#[tokio::test]
#[ignore = "calls the Anthropic API; run with --ignored and ANTHROPIC_API_KEY set"]
async fn test_validate_clean_code_passes() {
    let result = call(
        "warp_validate_commerce_code",
        json!({
            "code": "import { Money, transitionCommitment } from '@warp-lang/commerce-types';\n\
                     const price: Money = { amount: 150, currency: 'MAD' };\n\
                     const r = transitionCommitment(order, { type: 'Accepted' }, actorId);",
            "language": "typescript",
            "context": "uses @warp-lang/commerce-types correctly"
        }),
    )
    .await;
    assert_eq!(
        result["passed"], true,
        "expected clean code to pass, got {result}"
    );
}

#[tokio::test]
#[ignore = "calls the Anthropic API; run with --ignored and ANTHROPIC_API_KEY set"]
async fn test_explain_commitment_state() {
    let result = call(
        "warp_explain_commerce_type",
        json!({ "concept": "CommitmentState" }),
    )
    .await;
    let explanation = result["explanation"].as_str().unwrap_or("");
    for variant in ["Draft", "Proposed", "Accepted", "Fulfilled", "Cancelled"] {
        assert!(
            explanation.contains(variant) || result.to_string().contains(variant),
            "explanation should mention CommitmentState variant {variant}: {result}"
        );
    }
}

#[tokio::test]
#[ignore = "calls the Anthropic API; run with --ignored and ANTHROPIC_API_KEY set"]
async fn test_suggest_cart_recovery() {
    let result = call(
        "warp_suggest_commerce_pattern",
        json!({
            "description": "cart abandonment workflow with a 30 minute delay then a WhatsApp reminder",
            "language": "typescript"
        }),
    )
    .await;
    let blob = result.to_string();
    assert!(
        blob.contains("CartAbandoned"),
        "expected CartAbandoned in {blob}"
    );
    assert!(blob.contains("DelayFor"), "expected DelayFor in {blob}");
    assert!(
        blob.contains("WhatsApp") || blob.contains("whatsapp"),
        "expected a WhatsApp step in {blob}"
    );
}

#[tokio::test]
#[ignore = "calls the Anthropic API; run with --ignored and ANTHROPIC_API_KEY set"]
async fn test_translate_shopify_to_warp() {
    let result = call(
        "warp_translate_platform_code",
        json!({
            "code": "if (order.financial_status === 'paid') { markAccepted(order); }",
            "from_platform": "shopify",
            "to_platform": "warp-native",
            "language": "typescript"
        }),
    )
    .await;
    let code = result["translated_code"].as_str().unwrap_or("");
    assert!(
        code.contains("Commitment") || result.to_string().contains("Commitment"),
        "translation should reference the Commitment primitive: {result}"
    );
}
