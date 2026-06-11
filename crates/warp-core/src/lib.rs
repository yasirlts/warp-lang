//! warp-core
//!
//! Warp's execution layer. Wraps Restate's MIT-licensed SDK with
//! Warp-shaped primitives (commerce types, compiler, DSL runtime).
//!
//! Phase 1 adds the `types` module — Warp's commerce type system,
//! starting with [`types::commerce::Currency`]. The `poc` module is
//! retained as a Restate-primitive reference and will be removed when
//! the first Phase 1 nodes supersede each demo.

pub mod ai_builder;
pub mod api;
pub mod dsl;
pub mod poc;
pub mod templates;
pub mod types;

// The five Warp Commerce Model primitives — re-exported at the crate root
// for ergonomic access. Additive: the existing `types::commerce` exports
// are unchanged. See `crates/warp-core/src/types/model.rs`.
pub use types::model::{
    validate_commitment_transition, validate_fulfillment_transition, validate_intent_transition,
    AuctionCloseReason, AuctionMechanism, AuctionProcess, AuctionProcessID, AuctionState,
    CandidateState, Commitment, CommitmentID, CommitmentParties, CommitmentPartyRole,
    CommitmentState, CommitmentSubject, CommitmentTransition, Evidence, Fulfillment, FulfillmentID,
    FulfillmentMethod, FulfillmentState, FulfillmentTransition, Intent, IntentID, IntentState,
    IntentTransition, OfferedValue, Party, PartyCapacity, PartyID, PartyLocale, PartyRole,
    PartyType, PaymentTiming, RequestedValue, ResolutionCandidate, ResolutionOutcome,
    ResolutionProcess, ResolutionProcessID, ResolutionState,
};
