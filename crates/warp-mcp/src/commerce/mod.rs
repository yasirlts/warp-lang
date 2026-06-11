//! Commerce-advisor MCP tools (Phase 3).
//!
//! Four tools that turn the Warp MCP server into a real-time commerce code
//! validator and advisor for AI coding agents:
//!
//!   - `warp_validate_commerce_code` — check code against the six invariants
//!   - `warp_explain_commerce_type`  — formal explanation of a commerce concept
//!   - `warp_suggest_commerce_pattern` — correct implementation pattern
//!   - `warp_translate_platform_code` — cross-platform translation
//!
//! All four reason via the Anthropic API (see [`claude::CommerceAdvisor`]) with
//! the Warp Commerce Model as context, and require `ANTHROPIC_API_KEY`. The
//! existing workflow-management tools in [`crate::tools`] do not.

mod claude;

pub use claude::{CommerceAdvisor, COMMERCE_MODEL};

use serde_json::{json, Value};

use crate::tools::ToolError;

/// The four commerce-advisor tool definitions, appended to the MCP
/// `tools/list` response by [`crate::tools::list_tools`]. Descriptions are
/// written for the agent: they say *when* to call the tool.
pub fn commerce_tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": "warp_validate_commerce_code",
            "description": "Validate commerce code against the Warp Commerce Model's six \
                invariants. Use this whenever you generate or review code that handles orders, \
                payments, fulfillment, cart management, or any commerce state. Returns specific \
                violations with line numbers and exact fixes. Works with TypeScript, Python, \
                Rust, JavaScript.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "code":     { "type": "string", "description": "The code to validate (any language)." },
                    "language": { "type": "string", "description": "typescript | python | rust | javascript | other." },
                    "context":  { "type": "string", "description": "Optional: what platform/framework this code is for." }
                },
                "required": ["code", "language"]
            }
        }),
        json!({
            "name": "warp_explain_commerce_type",
            "description": "Explain any Warp Commerce Model concept formally. Use this when you \
                need to understand how to correctly implement a commerce pattern — CommitmentState \
                transitions, Party capacity, Money types, BNPL, subscriptions, auctions, or any \
                commerce concept. Returns a formal definition plus a working TypeScript code example.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "concept": { "type": "string", "description": "A commerce concept or question, e.g. 'CommitmentState', 'Invariant 2', 'how does BNPL work'." }
                },
                "required": ["concept"]
            }
        }),
        json!({
            "name": "warp_suggest_commerce_pattern",
            "description": "Get the correct Warp-derived implementation pattern for a commerce \
                problem. Use this before generating commerce code — describe what you need and \
                receive the formally correct implementation with complete code. Covers cart \
                recovery, subscriptions, BNPL, refunds, multi-vendor orders, occasions, and all \
                major commerce patterns.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "description": { "type": "string", "description": "What you need to build, e.g. 'subscription cancellation', 'BNPL', 'cart abandonment with 30min delay'." },
                    "language":    { "type": "string", "description": "typescript | python | rust." },
                    "platform":    { "type": "string", "description": "Optional: shopify | woocommerce | custom." }
                },
                "required": ["description", "language"]
            }
        }),
        json!({
            "name": "warp_translate_platform_code",
            "description": "Translate commerce code between platforms using the Warp model as the \
                translation layer. Shopify to WooCommerce, WooCommerce to Agora, Stripe to custom \
                — any direction. Returns translated code plus mapping notes explaining what \
                changed and why.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "code":          { "type": "string", "description": "The commerce code to translate." },
                    "from_platform": { "type": "string", "description": "shopify | woocommerce | magento | opencart | stripe | custom." },
                    "to_platform":   { "type": "string", "description": "Target platform, or 'warp-native'." },
                    "language":      { "type": "string", "description": "Optional: target language if different from the source." }
                },
                "required": ["code", "from_platform", "to_platform"]
            }
        }),
    ]
}

/// Names of the four commerce-advisor tools (for routing + tests).
pub fn commerce_tool_names() -> [&'static str; 4] {
    [
        "warp_validate_commerce_code",
        "warp_explain_commerce_type",
        "warp_suggest_commerce_pattern",
        "warp_translate_platform_code",
    ]
}

/// Dispatch a commerce-advisor tool by name. Returns `None` when `name` is not
/// one of the four — the caller then treats it as an unknown tool. Returns
/// `Some(Err(MissingApiKey))` when `ANTHROPIC_API_KEY` is unset, which the
/// caller renders as the clear "advisor tools require ANTHROPIC_API_KEY" error.
pub async fn dispatch(
    client: &reqwest::Client,
    name: &str,
    args: &Value,
) -> Option<Result<Value, ToolError>> {
    match name {
        "warp_validate_commerce_code" => Some(validate(client, args).await),
        "warp_explain_commerce_type" => Some(explain(client, args).await),
        "warp_suggest_commerce_pattern" => Some(suggest(client, args).await),
        "warp_translate_platform_code" => Some(translate(client, args).await),
        _ => None,
    }
}

fn require_str<'v>(args: &'v Value, key: &str) -> Result<&'v str, ToolError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ToolError::InvalidParams(format!("{key} is required")))
}

fn opt_str<'v>(args: &'v Value, key: &str) -> Option<&'v str> {
    args.get(key).and_then(|v| v.as_str())
}

async fn validate(client: &reqwest::Client, args: &Value) -> Result<Value, ToolError> {
    let code = require_str(args, "code")?;
    let language = opt_str(args, "language").unwrap_or("other");
    let context = opt_str(args, "context");
    CommerceAdvisor::from_env(client)?
        .validate(code, language, context)
        .await
}

async fn explain(client: &reqwest::Client, args: &Value) -> Result<Value, ToolError> {
    let concept = require_str(args, "concept")?;
    CommerceAdvisor::from_env(client)?.explain(concept).await
}

async fn suggest(client: &reqwest::Client, args: &Value) -> Result<Value, ToolError> {
    let description = require_str(args, "description")?;
    let language = opt_str(args, "language").unwrap_or("typescript");
    let platform = opt_str(args, "platform");
    CommerceAdvisor::from_env(client)?
        .suggest(description, language, platform)
        .await
}

async fn translate(client: &reqwest::Client, args: &Value) -> Result<Value, ToolError> {
    let code = require_str(args, "code")?;
    let from = require_str(args, "from_platform")?;
    let to = require_str(args, "to_platform")?;
    let language = opt_str(args, "language");
    CommerceAdvisor::from_env(client)?
        .translate(code, from, to, language)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commerce_tool_defs_are_well_formed() {
        let defs = commerce_tool_defs();
        assert_eq!(defs.len(), 4);
        for d in &defs {
            assert!(d["name"].as_str().is_some_and(|n| n.starts_with("warp_")));
            assert!(!d["description"].as_str().unwrap_or("").is_empty());
            assert_eq!(d["inputSchema"]["type"], "object");
            assert!(d["inputSchema"]["required"].is_array());
        }
    }

    #[test]
    fn commerce_model_is_embedded() {
        // The model is compiled in via include_str!; sanity-check it loaded.
        assert!(COMMERCE_MODEL.contains("WARP COMMERCE MODEL"));
        assert!(COMMERCE_MODEL.contains("Primitive 4: Commitment"));
    }

    #[test]
    fn extract_json_handles_fences_and_prose() {
        // bare object
        assert_eq!(claude::extract_json(r#"{"a":1}"#).unwrap()["a"], 1);
        // ```json fence
        let fenced = "```json\n{\"passed\": true}\n```";
        assert_eq!(claude::extract_json(fenced).unwrap()["passed"], true);
        // prose around an object
        let prosey = "Here is the result:\n{\"x\": 2}\nHope that helps.";
        assert_eq!(claude::extract_json(prosey).unwrap()["x"], 2);
        // non-JSON fails cleanly
        assert!(claude::extract_json("no json here").is_err());
    }

    #[test]
    fn missing_api_key_error_message_is_clear() {
        let msg = ToolError::MissingApiKey.to_string();
        assert!(msg.contains("ANTHROPIC_API_KEY"));
        assert!(msg.contains("warp_validate_commerce_code"));
    }
}
