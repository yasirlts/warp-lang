//! Rust binding for the Warp Commerce Model.
//!
//! - [`generated`] holds the structural types generated FROM the canonical
//!   schema spine (`schema/structure/*.schema.json`) by
//!   `scripts/generate-rust.mjs`. Never edit those files by hand; edit the
//!   schema and regenerate. The schema is the language-neutral source of truth
//!   shared with the TypeScript (`@warp-lang/commerce-types`) and Python
//!   (`warp_commerce_types`) bindings.
//! - [`runtime`] is the hand-written behavioral layer — a faithful port of the
//!   normative conformance runner (`conformance/runner/run.mjs`): transition
//!   validity (including the fulfillment `Failed -> Planned` recoverable-only
//!   special case), the six-invariant scene audit, and money precision /
//!   tolerance / breakdown-sum rules. It consumes the generated types.
//!
//! The `crosscheck-rust` binary emits per-fixture verdicts in the shared JSON
//! shape so the conformance cross-check can prove TS, Python, and Rust agree.

pub mod generated {
    pub mod transitions;
    pub mod types;
}

pub mod runtime;

/// The agent toolkit — guardrail, planning oracle, session coherence, and
/// interop — a COMPOSITION over [`runtime`] (transition validity + the scene
/// audit) and the generated transition table. It mirrors the TypeScript /
/// Python toolkits behaviourally; it does not re-derive any invariant or
/// transition logic.
pub mod toolkit;

pub use generated::types::SCHEMA_VERSION;
