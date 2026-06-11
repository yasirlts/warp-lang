//! `AIBuilder` — natural-language → typed Warp workflow.
//!
//! The merchant types a description ("Send a WhatsApp 30 min after
//! cart abandonment"). The builder runs that through Claude, gets
//! back a `.warp` source string, and feeds it to
//! [`crate::dsl::compile`]. If the compiler accepts the source, we
//! return a [`TypedProject`]. If the compiler rejects it, we splice
//! the errors back into a correction prompt and let Claude try
//! again — up to [`AIBuilder::max_rounds`] times. After the budget
//! is spent, [`AIBuilderResult::NeedsClarification`] hands control
//! back to the merchant with the failing attempt and the diagnostic
//! list.
//!
//! ## Safety: compiler is the safety net (C-06)
//!
//! Whatever Claude emits, only a source that passes the full
//! `lex → parse → type-check` pipeline returns
//! [`AIBuilderResult::Success`]. The compiler is the gate; the AI is
//! just a generation source whose output we discard if it doesn't
//! type-check. That is ADR-0004 in code form.
//!
//! ## mock_mode
//!
//! Every test in CI runs against `mock_mode=true`. The mock emits a
//! canonical 3-node `.warp` source (`CartAbandoned → profile →
//! WhatsAppSend`) instead of calling the API; the rest of the build
//! pipeline runs identically. Operators flip `mock_mode=false` when
//! `ANTHROPIC_API_KEY` is set in the warp-server environment.

use serde::Serialize;

use crate::ai_builder::prompt::{correction_prompt, system_prompt, user_prompt};
use crate::dsl::{compile, CompileError, TypedProject};

// ===========================================================================
// Public types.
// ===========================================================================

/// Configuration for the AI builder. One `AIBuilder` typically lives
/// for the lifetime of warp-server and serves every merchant.
#[derive(Debug, Clone)]
pub struct AIBuilder {
    /// `None` = the builder will refuse non-mock requests. The
    /// warp-server wiring reads `ANTHROPIC_API_KEY` from the env;
    /// missing env var means every request degrades to mock.
    pub api_key: Option<String>,
    /// Model id passed to the Anthropic Messages API. Defaults to
    /// the latest stable Opus per the env-context guidance; ops can
    /// pin to a specific version via `WARP_AI_MODEL`.
    pub model: String,
    /// Max correction rounds before we give up and return
    /// [`AIBuilderResult::NeedsClarification`]. Default 3.
    pub max_rounds: u32,
}

impl Default for AIBuilder {
    fn default() -> Self {
        Self {
            api_key: None,
            model: "claude-opus-4-7".to_string(),
            max_rounds: 3,
        }
    }
}

/// Successful or terminal outcome of [`AIBuilder::build`].
///
/// `Serialize`-only — the typed project is carried internally for
/// callers that want to install the workflow; downstream API
/// handlers project to a `Serialize`-friendly response shape
/// without re-deserializing.
///
/// The variants intentionally use Latin `C` in `NeedsClarification`
/// (the brief used a Cyrillic glyph that doesn't survive Rust
/// identifier rules).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AIBuilderResult {
    /// Compiler accepted Claude's output.
    Success {
        #[serde(skip)]
        typed_project: TypedProject,
        /// The `.warp` source that compiled. Serialized as
        /// `warp_source` on the wire — the API surface drops the
        /// `generated_` prefix because in context (inside `Success`)
        /// the source is obviously the one we generated.
        #[serde(rename = "warp_source")]
        generated_warp_source: String,
        /// Project name pulled from the typed project.
        workflow_name: String,
        /// How many nodes the project declared.
        node_count: usize,
        /// 1-based round count. `1` means Claude got it right on the
        /// first try; `3` means we hit the correction-loop ceiling.
        rounds_taken: u32,
        /// Heuristic language tag for the merchant's input. Drives
        /// future per-language analytics; the .warp output is ASCII
        /// regardless.
        detected_language: DetectedLanguage,
    },
    /// We exhausted `max_rounds` without a clean compile. The
    /// merchant gets the last attempt, every compiler diagnostic, and
    /// a follow-up question to nudge them toward a fix.
    NeedsClarification {
        question: String,
        partial_attempt: Option<String>,
        errors: Vec<String>,
        detected_language: DetectedLanguage,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedLanguage {
    Arabic,
    Darija,
    French,
    English,
}

/// Errors the build path itself can return (separate from
/// [`AIBuilderResult::NeedsClarification`], which is a *successful*
/// outcome where the merchant needs to refine their description).
/// These cover infrastructure failures, not compiler diagnostics.
#[derive(Debug, Clone, thiserror::Error)]
pub enum AIBuilderError {
    /// `mock_mode=false` but the builder has no `api_key`. The
    /// caller should either flip mock on or set
    /// `ANTHROPIC_API_KEY`.
    #[error("AI builder requested non-mock mode but no API key is configured")]
    MissingApiKey,
    /// HTTP transport failed before Anthropic could respond.
    #[error("network error talking to Anthropic API: {0}")]
    NetworkError(String),
    /// Anthropic returned a non-2xx status. `body` is the response
    /// body for operator debugging; it may include rate-limit info.
    #[error("Anthropic API returned status {status}: {body}")]
    ApiError { status: u16, body: String },
    /// We could not parse Anthropic's response into our expected
    /// shape. Usually means the API schema changed; verify
    /// `anthropic-version` header.
    #[error("could not parse Anthropic response: {0}")]
    ParseError(String),
}

// ===========================================================================
// Build loop.
// ===========================================================================

impl AIBuilder {
    /// Run the natural-language → typed-project pipeline.
    ///
    /// `mock_mode=true` skips every API call and returns a canonical
    /// 3-node workflow (compiled, same shape as the live success
    /// path). This is the path every CI test runs through.
    pub async fn build(
        &self,
        description: &str,
        tenant_id: &str,
        mock_mode: bool,
    ) -> Result<AIBuilderResult, AIBuilderError> {
        let detected_language = detect_language(description);

        if mock_mode {
            return Ok(self.mock_build(description, tenant_id, detected_language));
        }
        // Live path. Refuse explicitly when there's no key — better
        // than a 401 from Anthropic two HTTP hops later.
        let api_key = self
            .api_key
            .as_deref()
            .ok_or(AIBuilderError::MissingApiKey)?;

        let mut last_attempt = String::new();
        let mut last_errors: Vec<String> = Vec::new();

        for round in 0..self.max_rounds {
            let user = if round == 0 {
                user_prompt(description, tenant_id)
            } else {
                correction_prompt(&last_attempt, &last_errors)
            };
            let response = call_claude(api_key, &self.model, &user).await?;
            last_attempt = extract_warp_source(&response);

            match compile(&last_attempt) {
                Ok(result) => {
                    return Ok(success(
                        result.project,
                        last_attempt,
                        round + 1,
                        detected_language,
                    ));
                }
                Err(e) => {
                    last_errors = render_compile_errors(&e);
                }
            }
        }

        Ok(AIBuilderResult::NeedsClarification {
            question: clarification_question(detected_language),
            partial_attempt: if last_attempt.is_empty() {
                None
            } else {
                Some(last_attempt)
            },
            errors: last_errors,
            detected_language,
        })
    }

    fn mock_build(
        &self,
        _description: &str,
        tenant_id: &str,
        detected_language: DetectedLanguage,
    ) -> AIBuilderResult {
        let mock_warp = mock_warp_source(tenant_id);
        // Run the mock through the real compile path — the test value
        // of mock_mode is "everything except the API call runs," and
        // that includes compile.
        try_compile_into_result(mock_warp, 1, detected_language)
    }
}

/// Build a [`AIBuilderResult`] from a candidate `.warp` source.
/// Exposed at module scope so [`mock_build`] and the unit-test
/// helpers share it.
pub(crate) fn try_compile_into_result(
    warp_source: String,
    round: u32,
    detected_language: DetectedLanguage,
) -> AIBuilderResult {
    match compile(&warp_source) {
        Ok(result) => success(result.project, warp_source, round, detected_language),
        Err(e) => AIBuilderResult::NeedsClarification {
            question: clarification_question(detected_language),
            partial_attempt: Some(warp_source),
            errors: render_compile_errors(&e),
            detected_language,
        },
    }
}

fn success(
    typed_project: TypedProject,
    warp_source: String,
    rounds_taken: u32,
    detected_language: DetectedLanguage,
) -> AIBuilderResult {
    let workflow_name = typed_project.name.clone();
    let node_count = typed_project.nodes.len();
    AIBuilderResult::Success {
        typed_project,
        generated_warp_source: warp_source,
        workflow_name,
        node_count,
        rounds_taken,
        detected_language,
    }
}

// ===========================================================================
// Mock source.
// ===========================================================================

/// The canonical fallback workflow the mock returns. Three nodes —
/// trigger, profile lookup, WhatsApp — proves the full pipeline
/// (parse → type-check) without exercising any branching path. Real
/// merchant workflows are richer; the mock just proves the wire.
pub(crate) fn mock_warp_source(tenant_id: &str) -> String {
    format!(
        r#"project "generated_workflow" {{
  version = "1.0.0"
  tenant  = "{tenant_id}"

  CartAbandoned trigger {{
    min_value: Currency(0, MAD)
    after:     Duration(30, minutes)
  }}

  ACPGetCustomerProfile profile {{
    customer_id: trigger.customer_id
  }}

  WhatsAppSend message {{
    to:       profile.phone
    template: "cart_reminder"
    lang:     profile.language
  }}
}}
"#,
        tenant_id = tenant_id,
    )
}

// ===========================================================================
// Language detection — heuristic only. Good enough for analytics,
// not a substitute for a real classifier.
// ===========================================================================

/// Light-touch language detection. Sufficient for "tag this build
/// for the dashboard"; a future revision can swap in a real
/// classifier without changing this signature.
pub fn detect_language(text: &str) -> DetectedLanguage {
    let arabic_chars = text
        .chars()
        .filter(|c| ('\u{0600}'..='\u{06FF}').contains(c))
        .count();
    if arabic_chars > 3 {
        // Darija = vernacular Arabic with characteristic vocabulary.
        // Most Darija prompts will contain at least one of these
        // markers; pure MSA prompts won't. A miss here only affects
        // the analytics tag, not the build outcome.
        const DARIJA_MARKERS: &[&str] = &["واش", "كيفاش", "دابا", "بزاف", "مزيان"];
        if DARIJA_MARKERS.iter().any(|m| text.contains(m)) {
            return DetectedLanguage::Darija;
        }
        return DetectedLanguage::Arabic;
    }
    let lower = text.to_lowercase();
    // Words that are unambiguously French in our problem domain: any
    // hit flips to French. "abandon", "client", "message", and
    // "minutes" are shared with English and are NOT in this list.
    const UNAMBIGUOUSLY_FRENCH: &[&str] = &[
        "envoyer",   // to send
        "après",     // after (accented)
        "livraison", // delivery
        "panier",    // cart / basket
        "délai",     // delay (accented)
        "commande",  // order
    ];
    if UNAMBIGUOUSLY_FRENCH.iter().any(|m| lower.contains(m)) {
        return DetectedLanguage::French;
    }
    DetectedLanguage::English
}

// ===========================================================================
// Anthropic API client. Tiny — one POST, one parse. The reqwest dep
// already exists in warp-catalog; warp-core picks it up here for the
// AI builder path.
// ===========================================================================

async fn call_claude(
    api_key: &str,
    model: &str,
    user_prompt_body: &str,
) -> Result<String, AIBuilderError> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "system": system_prompt(),
        "messages": [
            {"role": "user", "content": user_prompt_body}
        ]
    });
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AIBuilderError::NetworkError(e.to_string()))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AIBuilderError::NetworkError(e.to_string()))?;
    if !status.is_success() {
        return Err(AIBuilderError::ApiError {
            status: status.as_u16(),
            body: text,
        });
    }
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AIBuilderError::ParseError(format!("response not JSON: {}", e)))?;
    parsed["content"][0]["text"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| AIBuilderError::ParseError("missing content[0].text in response".into()))
}

// ===========================================================================
// Output cleanup. Claude sometimes wraps `.warp` in a ```warp ... ```
// fence despite rule #1; peel it defensively so a single misbehaving
// generation doesn't cost a full correction round.
// ===========================================================================

/// Strip surrounding code fences and trim whitespace. If the source
/// is already raw `.warp`, returns it unchanged.
pub fn extract_warp_source(raw: &str) -> String {
    let trimmed = raw.trim();
    let stripped = strip_code_fence(trimmed);
    stripped.trim().to_string()
}

fn strip_code_fence(text: &str) -> &str {
    if let Some(rest) = text.strip_prefix("```") {
        // Drop the language tag on the opening fence (```warp, ```)
        let after_tag = match rest.find('\n') {
            Some(idx) => &rest[idx + 1..],
            None => rest,
        };
        if let Some(stripped) = after_tag.strip_suffix("```") {
            return stripped;
        }
        return after_tag;
    }
    text
}

// ===========================================================================
// Helpers.
// ===========================================================================

fn render_compile_errors(err: &CompileError) -> Vec<String> {
    match err {
        CompileError::TypeErrors(es) => es.iter().map(|e| e.to_string()).collect(),
        other => vec![other.to_string()],
    }
}

fn clarification_question(lang: DetectedLanguage) -> String {
    // The question echoes back in the language we detected so the
    // merchant doesn't get an English nudge after typing in Arabic.
    match lang {
        DetectedLanguage::Arabic => {
            "هل يمكنك وصف سير العمل بمزيد من التفاصيل؟ ما الذي يجب أن يحدث أولاً، وما الذي يجب أن يحدث بعد ذلك؟"
                .to_string()
        }
        DetectedLanguage::Darija => {
            "واش تقدر توصف الـ workflow بزاف بالتفصيل؟ شنو خاصو يوقع لول، وشنو يوقع من بعد؟"
                .to_string()
        }
        DetectedLanguage::French => {
            "Pouvez-vous décrire votre workflow plus en détail ? Que doit-il se passer en premier, et que doit-il se passer ensuite ?"
                .to_string()
        }
        DetectedLanguage::English => {
            "Could you describe your workflow in more detail? What should happen first, and what should happen after?"
                .to_string()
        }
    }
}

// ===========================================================================
// Tests — every one runs against mock_mode or pure-function helpers.
// No network, no API key required.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn builder() -> AIBuilder {
        AIBuilder::default()
    }

    #[tokio::test]
    async fn ai_builder_mock_returns_success_for_english_input() {
        let b = builder();
        let result = b
            .build(
                "Send a WhatsApp after cart abandonment",
                "tenant_aimer_prod_001",
                true,
            )
            .await
            .expect("mock build must not fail");
        match result {
            AIBuilderResult::Success {
                rounds_taken,
                detected_language,
                node_count,
                ..
            } => {
                assert_eq!(rounds_taken, 1);
                assert_eq!(node_count, 3);
                assert_eq!(detected_language, DetectedLanguage::English);
            }
            other => panic!("expected Success, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn ai_builder_mock_returns_success_for_french_input() {
        let b = builder();
        let result = b
            .build(
                "Envoyer un WhatsApp après abandon du panier",
                "tenant_aimer_prod_001",
                true,
            )
            .await
            .expect("mock build must not fail");
        match result {
            AIBuilderResult::Success {
                detected_language, ..
            } => {
                assert_eq!(detected_language, DetectedLanguage::French);
            }
            other => panic!("expected Success, got {:?}", other),
        }
    }

    #[test]
    fn ai_builder_detects_arabic_script() {
        // Modern Standard Arabic — no Darija markers, just plenty of
        // Arabic Unicode characters.
        let lang = detect_language("أرسل رسالة بعد ثلاثين دقيقة من ترك السلة");
        assert_eq!(lang, DetectedLanguage::Arabic);
    }

    #[test]
    fn ai_builder_detects_darija() {
        // Darija marker `واش` flips Arabic-script detection to
        // Darija.
        let lang = detect_language("واش تقدر تصيفط رسالة من بعد ما يخلي العميل السلة؟");
        assert_eq!(lang, DetectedLanguage::Darija);
    }

    #[tokio::test]
    async fn ai_builder_mock_compiles_to_valid_typed_project() {
        let b = builder();
        let result = b
            .build("anything", "tenant_aimer_prod_001", true)
            .await
            .unwrap();
        match result {
            AIBuilderResult::Success { typed_project, .. } => {
                assert_eq!(typed_project.nodes.len(), 3);
                assert_eq!(typed_project.nodes[0].node_type, "CartAbandoned");
                assert_eq!(typed_project.nodes[1].node_type, "ACPGetCustomerProfile");
                assert_eq!(typed_project.nodes[2].node_type, "WhatsAppSend");
            }
            other => panic!("expected Success, got {:?}", other),
        }
    }

    #[test]
    fn ai_builder_clarification_when_compile_fails() {
        // Inject a deliberately broken `.warp` source through the
        // same helper the live build path uses. The compile fails,
        // so we get a NeedsClarification — proving the fallback
        // route works without spinning up the API loop.
        let broken = r#"
            project "broken" {
                version = "1.0.0"
                tenant  = "tenant_x"
                WhatappSend bad {
                    to:       "+212661234567"
                    template: "cart_reminder"
                }
            }
        "#
        .to_string();
        let result = try_compile_into_result(broken, 3, DetectedLanguage::English);
        match result {
            AIBuilderResult::NeedsClarification {
                errors,
                partial_attempt,
                ..
            } => {
                assert!(partial_attempt.is_some(), "echoes the failed attempt");
                assert!(
                    !errors.is_empty(),
                    "should surface at least one compiler error"
                );
                // The English-detected clarification echoes in English.
            }
            other => panic!("expected NeedsClarification, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn ai_builder_non_mock_without_api_key_returns_missing_api_key_error() {
        let b = AIBuilder {
            api_key: None,
            ..AIBuilder::default()
        };
        let err = b
            .build("desc", "tenant_x", false)
            .await
            .expect_err("must refuse non-mock without API key");
        assert!(matches!(err, AIBuilderError::MissingApiKey));
    }

    #[test]
    fn extract_warp_source_strips_markdown_fences() {
        let raw = "```warp\nproject \"x\" { }\n```";
        let cleaned = extract_warp_source(raw);
        assert_eq!(cleaned, "project \"x\" { }");
    }

    #[test]
    fn extract_warp_source_passes_clean_source_through() {
        let raw = "project \"x\" { }";
        assert_eq!(extract_warp_source(raw), raw);
    }

    #[test]
    fn clarification_question_speaks_the_detected_language() {
        // Each variant should produce a non-empty string in its own
        // script — the merchant doesn't get nudged in English after
        // typing in Arabic.
        let en = clarification_question(DetectedLanguage::English);
        let fr = clarification_question(DetectedLanguage::French);
        let ar = clarification_question(DetectedLanguage::Arabic);
        let dr = clarification_question(DetectedLanguage::Darija);
        assert!(!en.is_empty() && !fr.is_empty() && !ar.is_empty() && !dr.is_empty());
        assert!(en.contains("workflow"));
        assert!(fr.contains("workflow") || fr.contains("Que"));
        // Arabic + Darija should contain Arabic-script characters.
        assert!(ar.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c)));
        assert!(dr.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c)));
    }
}
