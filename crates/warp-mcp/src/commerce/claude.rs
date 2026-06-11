//! Shared "Claude-in-Claude" client for the commerce-advisor tools.
//!
//! The four commerce tools (validate / explain / suggest / translate) all do
//! semantic reasoning the MCP server can't do structurally, so they call the
//! Anthropic Messages API with the Warp Commerce Model as context and return
//! structured JSON. [`CommerceAdvisor`] is the one place that talks to the API.
//!
//! The model text is embedded at compile time via `include_str!` so the binary
//! is self-contained — no runtime file path to get wrong on a deployed host.

use serde_json::{json, Value};

use crate::tools::ToolError;

/// The formal commerce model, embedded at build time. Used as context for the
/// explain / suggest / translate prompts.
pub const COMMERCE_MODEL: &str = include_str!("../../../../docs/WARP_COMMERCE_MODEL.md");

/// Default model. Overridable with `WARP_ADVISOR_MODEL`. We pin a current
/// Sonnet rather than a dated snapshot id.
const DEFAULT_MODEL: &str = "claude-sonnet-4-6";

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// The validation system prompt. The six invariants are inlined here (no need
/// to ship the whole model for this call) so validation stays cheap and fast.
const VALIDATE_SYSTEM: &str = r#"You are a commerce code validator using the Warp Commerce Model.
You check code against six invariants and return violations.

Invariant 1 — Value Conservation:
  Money must always carry currency denomination.
  MAD and EUR cannot be mixed without explicit conversion.
  Flag: any money/price/amount variable without currency attached.
  Flag: any arithmetic combining money values of different currencies.

Invariant 2 — State Monotonicity:
  Order/commitment states follow directed paths. No backward transitions.
  Valid CommitmentState transitions only:
  Draft->Proposed,Tendered,Cancelled
  Proposed->Accepted,Cancelled,Modified
  Tendered->Accepted,Cancelled
  Accepted->Modified,PartiallyFulfilled,Active,Cancelled,Disputed
  Modified->Accepted,Cancelled
  PartiallyFulfilled->Fulfilled,Modified,Cancelled
  Active->Modified,Cancelled,Disputed
  Fulfilled->Disputed,Refunded
  Disputed->Fulfilled,Refunded,Cancelled
  Flag: any status assignment not in this list.
  Flag: string-based status comparisons that allow arbitrary transitions.

Invariant 3 — Capacity Verification:
  Party capacity must be verified before any commitment reaches Accepted.
  Flag: any order acceptance without a prior capacity/credit check.

Invariant 4 — Temporal Integrity:
  Fulfillment cannot precede Commitment.
  Flag: any shipping/delivery before order acceptance.
  Flag: any payment capture before order confirmation.

Invariant 5 — Identity Permanence:
  IDs are immutable after creation. Never reassigned or reused.
  Flag: any code that reassigns an order ID or entity ID.

Invariant 6 — Commitment Tree Consistency:
  Child order values must sum to parent order value.
  Flag: split orders where children do not sum to parent.

Return ONLY valid JSON in this exact format, with no prose and no markdown fences:
{
  "violations": [
    {
      "invariant": "I-1",
      "invariant_name": "Value Conservation",
      "severity": "error",
      "description": "price variable has no currency denomination",
      "location": "line 23",
      "fix": "Change `price: number = 150` to `price: Money = { amount: 150, currency: 'MAD' }`"
    }
  ],
  "summary": "2 violations found: 1 error (I-1), 1 warning (I-3)",
  "invariants_checked": ["I-1", "I-2", "I-3", "I-4", "I-5", "I-6"],
  "passed": false
}
If there are no violations, return an empty "violations" array and "passed": true."#;

const EXPLAIN_INSTRUCTION: &str = r#"You are a Warp Commerce Model expert. A developer asks about a commerce concept.
Return ONLY valid JSON (no prose, no markdown fences) in this exact shape:
{
  "explanation": "clear formal explanation grounded in the model",
  "model_source": "where in the Warp Commerce Model this comes from (primitive/invariant/section)",
  "code_example": "a TypeScript example using @warp-lang/commerce-types",
  "related_concepts": ["other relevant concepts"]
}
The full Warp Commerce Model follows for your reference."#;

const SUGGEST_INSTRUCTION: &str = r#"You are a Warp Commerce Model expert. A developer describes a commerce problem.
Return ONLY valid JSON (no prose, no markdown fences) in this exact shape:
{
  "pattern_name": "name of the pattern",
  "explanation": "why this is the correct Warp-derived approach",
  "code": "complete, working code in the requested language",
  "warp_primitives": ["which of Party/Value/Intent/Commitment/Fulfillment this uses"],
  "invariants_relevant": ["I-1".."I-6 that apply"],
  "npm_imports": "the exact import line from @warp-lang/commerce-types"
}
The generated code must respect all six invariants. The full Warp Commerce Model follows for your reference."#;

const TRANSLATE_INSTRUCTION: &str = r#"You are a Warp Commerce Model expert. Translate commerce code from one platform to another, using the Warp model as the intermediate representation.
Return ONLY valid JSON (no prose, no markdown fences) in this exact shape:
{
  "translated_code": "the translated code",
  "mapping_notes": ["what changed and why"],
  "warp_model_path": "the model path this translation follows, e.g. Order(paid) -> Commitment(Accepted)",
  "warnings": ["things that may not map cleanly"]
}
The full Warp Commerce Model follows for your reference."#;

/// The shared advisor. Borrows the server's pooled `reqwest::Client`.
pub struct CommerceAdvisor<'a> {
    client: &'a reqwest::Client,
    api_key: String,
    model: String,
}

impl<'a> CommerceAdvisor<'a> {
    /// Build from the environment. Fails fast with [`ToolError::MissingApiKey`]
    /// when `ANTHROPIC_API_KEY` is unset — the caller surfaces the clear
    /// "advisor tools require ANTHROPIC_API_KEY" message.
    pub fn from_env(client: &'a reqwest::Client) -> Result<Self, ToolError> {
        let api_key = std::env::var("ANTHROPIC_API_KEY").map_err(|_| ToolError::MissingApiKey)?;
        if api_key.trim().is_empty() {
            return Err(ToolError::MissingApiKey);
        }
        let model =
            std::env::var("WARP_ADVISOR_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
        Ok(Self {
            client,
            api_key,
            model,
        })
    }

    async fn call(&self, system: &str, user: &str, max_tokens: u32) -> Result<String, ToolError> {
        let body = json!({
            "model": self.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{ "role": "user", "content": user }],
        });
        let resp = self
            .client
            .post(ANTHROPIC_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| ToolError::UpstreamHttp(e.to_string()))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ToolError::UpstreamHttp(e.to_string()))?;
        if !status.is_success() {
            return Err(ToolError::UpstreamStatus {
                status: status.as_u16(),
                body: text,
            });
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| {
            ToolError::AdvisorError(format!("Anthropic response was not JSON: {e}"))
        })?;
        v["content"][0]["text"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| {
                ToolError::AdvisorError("Anthropic response missing content[0].text".into())
            })
    }

    pub async fn validate(
        &self,
        code: &str,
        language: &str,
        context: Option<&str>,
    ) -> Result<Value, ToolError> {
        let user = format!(
            "Language: {language}\nContext: {}\n\nValidate this code:\n```{language}\n{code}\n```",
            context.unwrap_or("(none)")
        );
        let raw = self.call(VALIDATE_SYSTEM, &user, 4096).await?;
        extract_json(&raw)
    }

    pub async fn explain(&self, concept: &str) -> Result<Value, ToolError> {
        let system =
            format!("{EXPLAIN_INSTRUCTION}\n\n=== WARP COMMERCE MODEL ===\n{COMMERCE_MODEL}");
        let raw = self
            .call(&system, &format!("Explain: {concept}"), 3000)
            .await?;
        extract_json(&raw)
    }

    pub async fn suggest(
        &self,
        description: &str,
        language: &str,
        platform: Option<&str>,
    ) -> Result<Value, ToolError> {
        let system =
            format!("{SUGGEST_INSTRUCTION}\n\n=== WARP COMMERCE MODEL ===\n{COMMERCE_MODEL}");
        let user = format!(
            "Problem: {description}\nLanguage: {language}\nPlatform: {}",
            platform.unwrap_or("custom")
        );
        let raw = self.call(&system, &user, 6000).await?;
        extract_json(&raw)
    }

    pub async fn translate(
        &self,
        code: &str,
        from: &str,
        to: &str,
        language: Option<&str>,
    ) -> Result<Value, ToolError> {
        let system =
            format!("{TRANSLATE_INSTRUCTION}\n\n=== WARP COMMERCE MODEL ===\n{COMMERCE_MODEL}");
        let user = format!(
            "From platform: {from}\nTo platform: {to}\nTarget language: {}\n\nCode:\n```\n{code}\n```",
            language.unwrap_or("(same as source)")
        );
        let raw = self.call(&system, &user, 6000).await?;
        extract_json(&raw)
    }
}

/// Pull a JSON object out of a model response. Models occasionally wrap JSON in
/// ```` ```json ```` fences or add a sentence; this tolerates both by stripping
/// fences and, failing that, slicing from the first `{` to the last `}`.
pub(crate) fn extract_json(text: &str) -> Result<Value, ToolError> {
    let trimmed = text.trim();
    // 1. Strip a ```json ... ``` (or bare ```) fence if present.
    let unfenced = if let Some(rest) = trimmed.strip_prefix("```") {
        let body = rest.strip_prefix("json").unwrap_or(rest);
        body.trim_start_matches('\n').trim_end_matches('`').trim()
    } else {
        trimmed
    };
    if let Ok(v) = serde_json::from_str::<Value>(unfenced) {
        return Ok(v);
    }
    // 2. Fall back to the outermost {...} span.
    if let (Some(start), Some(end)) = (unfenced.find('{'), unfenced.rfind('}')) {
        if end > start {
            if let Ok(v) = serde_json::from_str::<Value>(&unfenced[start..=end]) {
                return Ok(v);
            }
        }
    }
    Err(ToolError::AdvisorError(format!(
        "advisor did not return parseable JSON (got {} chars)",
        text.len()
    )))
}
