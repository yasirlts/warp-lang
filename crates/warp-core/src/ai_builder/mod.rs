//! Warp AI builder — natural language → compiled workflow.
//!
//! The merchant types "Send a WhatsApp 30 minutes after cart
//! abandonment" (in Arabic, Darija, French, or English). The
//! builder generates a `.warp` source, hands it to
//! [`crate::dsl::compile`], and either returns a [`TypedProject`]
//! that the canvas can install — or, after the correction-round
//! budget is spent, a [`AIBuilderResult::NeedsClarification`] with
//! the failing attempt and every compiler diagnostic.
//!
//! This is ADR-0004 wired up: AI output is *generation source*, not
//! installable runtime — only what passes the compiler reaches the
//! tenant.
//!
//! ## Layout
//!
//! - [`prompt`] — system / user / correction prompts. Pure
//!   functions; the system prompt is built from
//!   [`crate::dsl::BUILTIN_NODE_SPECS`].
//! - [`builder`] — the `AIBuilder` struct, the build loop, language
//!   detection, the mock-mode fallback, and the Anthropic API call.
//!
//! ## CI vs production
//!
//! Every test in this crate runs with `mock_mode=true` — no network
//! calls, no `ANTHROPIC_API_KEY` needed. In warp-server, the API
//! handler auto-flips to mock when the env var is missing so a
//! developer laptop without a key still gets a usable
//! `/api/v1/ai-builder/generate` surface.
//!
//! [`TypedProject`]: crate::dsl::TypedProject
//! [`AIBuilderResult::NeedsClarification`]: crate::ai_builder::AIBuilderResult::NeedsClarification

pub mod builder;
pub mod prompt;

pub use builder::{
    detect_language, extract_warp_source, AIBuilder, AIBuilderError, AIBuilderResult,
    DetectedLanguage,
};
pub use prompt::{correction_prompt, system_prompt, user_prompt};
