//! The five Warp Commerce Model primitives — the typed spine.
//!
//! This module implements the P1 ("the spine") slice of
//! [`docs/WARP_TYPE_DERIVATION.md`](../../../../docs/WARP_TYPE_DERIVATION.md),
//! derived from [`docs/WARP_COMMERCE_MODEL`](../../../../docs/WARP_COMMERCE_MODEL.md)
//! v0.2. It is **additive**: nothing in [`super::commerce`] is modified or
//! removed. The existing surface types (Currency, PhoneNumber, CartState,
//! …) keep working while this spine is built out; migration of those types
//! onto these primitives is later (P2/P3) work, not this session's.
//!
//! What lives here:
//!   * **Party** — Primitive 1. Who participates in commerce.
//!   * **Intent** — Primitive 3. A party's expressed desire before any
//!     Commitment (a live cart is `Intent(Active)`).
//!   * **Commitment** — Primitive 4. The central primitive: a formal
//!     agreement between parties to exchange value.
//!   * **Fulfillment** — Primitive 5. The execution of a Commitment.
//!   * Value-state extensions (`ReservationBasis`, `ValueState::UnderAuction`)
//!     live in [`super::commerce`], not here, because `ValueState` is part
//!     of the existing commerce type surface.
//!
//! The most important code in this module is the three transition
//! validators (`validate_intent_transition`,
//! `validate_commitment_transition`, `validate_fulfillment_transition`).
//! They encode the model's exhaustive valid-transition tables. Every
//! transition not in a table is rejected — this is how these runtime
//! validators enforce **Invariant 2 (State Monotonicity)**: an invalid
//! transition cannot be applied (the method returns an error). The
//! `transition` methods additionally enforce **Invariant 4 (Temporal
//! Integrity)**: history is append-only and a new transition's timestamp may
//! never be *earlier* than the previous one.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// P2 adapter-bridge types below reference the existing money / platform
// surface types. Intra-crate module cycle (commerce ↔ model) is fine.
use super::commerce::{Currency, Platform};

// ===========================================================================
// Shared helpers — timestamps (Invariant 4 substrate).
// ===========================================================================

/// Current instant as an RFC 3339 / ISO 8601 string (UTC). Used as the
/// `at` of every freshly recorded transition. A typed `Timestamp` is P2
/// work (see WARP_TYPE_DERIVATION Table C); P1 carries timestamps as the
/// ISO-8601 strings the model's prose uses.
fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

/// True if `new_at` is **not earlier** than `last_at` — the exact wording
/// of Invariant 4 ("No transition can have a timestamp earlier than any
/// previous transition"). Equal timestamps are permitted; only a move
/// backward in time is rejected. Parses both as RFC 3339 so that the `Z`
/// and `+00:00` UTC spellings compare correctly; falls back to byte
/// comparison only if either string is unparseable.
fn timestamp_not_before(new_at: &str, last_at: &str) -> bool {
    match (
        DateTime::parse_from_rfc3339(new_at),
        DateTime::parse_from_rfc3339(last_at),
    ) {
        (Ok(n), Ok(l)) => n >= l,
        _ => new_at >= last_at,
    }
}

// ===========================================================================
// PRIMITIVE 1 — Party
// ===========================================================================

/// Error constructing a [`PartyID`].
#[derive(Debug, thiserror::Error)]
pub enum PartyIDError {
    #[error("PartyID cannot be empty")]
    Empty,
    #[error("PartyID exceeds 256 characters (got {0})")]
    TooLong(usize),
}

/// A globally unique, immutable party identifier (Invariant 5). The model
/// places no format constraint beyond uniqueness — platforms use their own
/// id shapes — so validation is only non-empty and a generous length cap.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PartyID(String);

impl PartyID {
    /// Construct a `PartyID`. Validates non-empty, max 256 chars; the inner
    /// string may otherwise be any platform-native id.
    pub fn new(id: impl Into<String>) -> Result<Self, PartyIDError> {
        let id = id.into();
        if id.is_empty() {
            return Err(PartyIDError::Empty);
        }
        if id.len() > 256 {
            return Err(PartyIDError::TooLong(id.len()));
        }
        Ok(Self(id))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What kind of entity a party is. `System` is an AI agent or automated
/// system acting on behalf of a principal party — recording it precisely
/// is what makes AI-mediated commerce auditable (model, Primitive 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartyType {
    Individual,
    Organization,
    System,
}

/// A party's locale, mirroring the model's `Locale`. Stored as the string
/// standards the model names; typed `LanguageCode`/`CurrencyCode`/
/// `JurisdictionCode` newtypes are P2 work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartyLocale {
    /// BCP 47, e.g. `"fr-MA"`, `"ar-MA"`, `"zgh-MA"`.
    pub language: String,
    /// ISO 4217, e.g. `"MAD"`, `"EUR"`, `"USD"`.
    pub currency: String,
    /// ISO 3166-1 alpha-2, e.g. `"MA"`, `"FR"`.
    pub jurisdiction: String,
}

/// A party's verified capacity for the roles it may play. The basis of
/// **Invariant 3 (Capacity Verification)**: a Commitment cannot reach
/// `Accepted` unless the parties' capacity for their roles is verified.
/// Constructed unverified (all `false`); a system that verifies capacity
/// sets the relevant flags and updates `verified_at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartyCapacity {
    pub can_buy: bool,
    pub can_sell: bool,
    pub can_fulfill: bool,
    pub can_guarantee: bool,
    /// ISO 8601 timestamp of the last capacity verification.
    pub verified_at: String,
}

impl PartyCapacity {
    /// All capacities `false` — nothing has been verified yet. Construction
    /// time is recorded so a later verification can be distinguished.
    fn unverified() -> Self {
        Self {
            can_buy: false,
            can_sell: false,
            can_fulfill: false,
            can_guarantee: false,
            verified_at: now_iso(),
        }
    }
}

/// A party — any entity that can participate in commerce (Primitive 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Party {
    pub id: PartyID,
    pub party_type: PartyType,
    pub locale: PartyLocale,
    pub capacity: PartyCapacity,
}

impl Party {
    /// A natural person. Capacity starts unverified (Invariant 3) — a caller
    /// verifies and sets it before relying on it.
    pub fn individual(id: PartyID, locale: PartyLocale) -> Self {
        Self {
            id,
            party_type: PartyType::Individual,
            locale,
            capacity: PartyCapacity::unverified(),
        }
    }

    /// A legal entity (company, NGO, government). Capacity starts unverified.
    pub fn organization(id: PartyID, locale: PartyLocale) -> Self {
        Self {
            id,
            party_type: PartyType::Organization,
            locale,
            capacity: PartyCapacity::unverified(),
        }
    }

    /// An AI agent or automated system acting on behalf of a principal. Uses
    /// a default global locale (English / USD / MA) because a System party
    /// has no locale of its own — it acts through its principal. Capacity is
    /// unverified: a System party holds no independent commercial capacity.
    pub fn system(id: PartyID) -> Self {
        Self {
            id,
            party_type: PartyType::System,
            locale: PartyLocale {
                language: "en".to_string(),
                currency: "USD".to_string(),
                jurisdiction: "MA".to_string(),
            },
            capacity: PartyCapacity::unverified(),
        }
    }
}

// ===========================================================================
// PRIMITIVE 2 (here: Intent) — Intent, IntentState, transitions
//
// Intent is Primitive 3 in the model's numbering; it is grouped here as the
// second primitive built in this module. A live cart is `Intent(Active)`;
// cart abandonment is the formal transition `Active → Abandoned`.
// ===========================================================================

/// Error constructing an [`IntentID`].
#[derive(Debug, thiserror::Error)]
pub enum IntentIDError {
    #[error("IntentID cannot be empty")]
    Empty,
}

/// A globally unique, immutable intent identifier (Invariant 5). Minted as a
/// UUID v4 by Warp; `from_str` admits a stored value back.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct IntentID(String);

impl IntentID {
    /// Mint a fresh random (v4) intent id.
    pub fn new_v4() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    /// Rehydrate an intent id from its string form. Rejects empty.
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Result<Self, IntentIDError> {
        if s.is_empty() {
            return Err(IntentIDError::Empty);
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The lifecycle state of an [`Intent`] (model Primitive 3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentState {
    /// The party is engaged; the intent is open.
    Active,
    /// The party stopped without committing (a cart abandonment).
    Abandoned,
    /// The intent became a Commitment.
    Converted { commitment_id: CommitmentID },
    /// The time limit was reached without conversion.
    Expired,
}

/// One append-only entry in an [`Intent`]'s history (Invariant 4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntentTransition {
    pub from: IntentState,
    pub to: IntentState,
    /// ISO 8601 timestamp of the transition.
    pub at: String,
    pub actor: PartyID,
    pub reason: Option<String>,
}

/// Error from an attempted intent transition.
#[derive(Debug, thiserror::Error)]
pub enum IntentTransitionError {
    #[error("Intent cannot transition from '{from}' to '{to}' — not a valid transition (Invariant 2: State Monotonicity)")]
    NotAllowed { from: String, to: String },
    #[error("Intent transition timestamp '{attempted}' is earlier than the previous transition '{last}' — history moves forward only (Invariant 4: Temporal Integrity)")]
    TimestampNotMonotonic { last: String, attempted: String },
}

fn intent_state_name(s: &IntentState) -> &'static str {
    match s {
        IntentState::Active => "Active",
        IntentState::Abandoned => "Abandoned",
        IntentState::Converted { .. } => "Converted",
        IntentState::Expired => "Expired",
    }
}

/// Validate an intent state transition against the model's allowed list.
/// The complete set of valid intent transitions:
///
/// ```text
/// Active → Abandoned
/// Active → Converted
/// Active → Expired
/// ```
///
/// Every other transition is rejected.
pub fn validate_intent_transition(
    from: &IntentState,
    to: &IntentState,
) -> Result<(), IntentTransitionError> {
    use IntentState::*;
    match (from, to) {
        (Active, Abandoned) | (Active, Converted { .. }) | (Active, Expired) => Ok(()),
        _ => Err(IntentTransitionError::NotAllowed {
            from: intent_state_name(from).to_string(),
            to: intent_state_name(to).to_string(),
        }),
    }
}

/// A party's expressed desire to engage in commerce (Primitive 3). The
/// `desire`/constraints/context detail is P2 work; P1 carries the identity,
/// party, state, and the append-only history that makes Invariant 4
/// enforceable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Intent {
    pub id: IntentID,
    pub party: PartyID,
    pub state: IntentState,
    /// Append-only (Invariant 4). `transition` only ever pushes.
    pub history: Vec<IntentTransition>,
    pub created_at: String,
    pub expires_at: Option<String>,
    /// Platform-specific reference this intent originated from (e.g. a
    /// Shopify checkout token).
    pub originated_from: Option<String>,
}

impl Intent {
    /// A fresh intent for `party`, in state `Active`, with empty history.
    pub fn new(party: PartyID) -> Self {
        Self {
            id: IntentID::new_v4(),
            party,
            state: IntentState::Active,
            history: Vec::new(),
            created_at: now_iso(),
            expires_at: None,
            originated_from: None,
        }
    }

    /// Transition to `to`, recording the move in history. Enforces:
    ///   * only model-valid transitions (Invariant 2),
    ///   * the new timestamp is not earlier than the last (Invariant 4),
    ///   * history is append-only (this method never removes entries).
    pub fn transition(
        &mut self,
        to: IntentState,
        actor: PartyID,
        reason: Option<String>,
    ) -> Result<(), IntentTransitionError> {
        self.transition_at(to, actor, reason, now_iso())
    }

    /// Transition with an explicit timestamp. Private workhorse behind
    /// [`Self::transition`]; tests drive it directly to exercise the
    /// Invariant-4 timestamp guard.
    fn transition_at(
        &mut self,
        to: IntentState,
        actor: PartyID,
        reason: Option<String>,
        at: String,
    ) -> Result<(), IntentTransitionError> {
        validate_intent_transition(&self.state, &to)?;
        if let Some(last) = self.history.last() {
            if !timestamp_not_before(&at, &last.at) {
                return Err(IntentTransitionError::TimestampNotMonotonic {
                    last: last.at.clone(),
                    attempted: at,
                });
            }
        }
        self.history.push(IntentTransition {
            from: self.state.clone(),
            to: to.clone(),
            at,
            actor,
            reason,
        });
        self.state = to;
        Ok(())
    }
}

// ===========================================================================
// PRIMITIVE 3 (here) — Commitment, CommitmentState, transitions
//
// The central primitive. The transition table below is the single most
// important function in the type system: it encodes the model's exhaustive
// valid-transition list and rejects everything else, making the AI
// Contract's "impossible mistakes" (fulfilling a Cancelled commitment,
// cancelling a Fulfilled one) impossible to express.
// ===========================================================================

/// Error constructing a [`CommitmentID`].
#[derive(Debug, thiserror::Error)]
pub enum CommitmentIDError {
    #[error("CommitmentID cannot be empty")]
    Empty,
}

/// A globally unique, immutable commitment identifier (Invariant 5). A
/// platform's native order id maps to exactly one of these for life.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CommitmentID(String);

impl CommitmentID {
    pub fn new_v4() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Result<Self, CommitmentIDError> {
        if s.is_empty() {
            return Err(CommitmentIDError::Empty);
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The lifecycle state of a [`Commitment`] (Primitive 4). Variant payloads
/// carry the model's required context for each state. Money is carried as
/// `(amount: String, currency: String)` pairs at P1 (a typed `Money`/
/// `Currency` integration is P2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitmentState {
    /// Being assembled; not yet binding.
    Draft,
    /// Presented to the counterparty; binding on the initiator only.
    Proposed,
    /// Open offer to any qualifying counterparty (an auction bid).
    Tendered {
        offer_amount: String,
        offer_currency: String,
        closes_at: String,
        superseded_by: Option<CommitmentID>,
    },
    /// Binding on all parties; capacity verified (Invariant 3).
    Accepted,
    /// Terms changed after Accepted; returns to Accepted when affected
    /// parties agree.
    Modified {
        modified_by: PartyID,
        reason: String,
    },
    /// Some value transferred, not all.
    PartiallyFulfilled {
        fulfilled_item_ids: Vec<String>,
        remaining_item_ids: Vec<String>,
    },
    /// Perpetually in progress (subscriptions, ongoing services).
    Active,
    /// All obligations met by all parties.
    Fulfilled,
    /// Abandoned before fulfillment.
    Cancelled {
        by: PartyID,
        reason: String,
        at: String,
    },
    /// A party raised a claim.
    Disputed {
        by: PartyID,
        reason: String,
        opened_at: String,
    },
    /// Money moved back to the initiator.
    Refunded {
        amount_str: String,
        currency: String,
        at: String,
    },
}

/// One append-only entry in a [`Commitment`]'s history (Invariant 4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitmentTransition {
    pub from: CommitmentState,
    pub to: CommitmentState,
    pub at: String,
    pub actor: PartyID,
    pub reason: Option<String>,
}

/// The parties to a [`Commitment`]. Roles are contextual (the model: "Role
/// is contextual, not intrinsic") — a party is the initiator here and a
/// counterparty elsewhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitmentParties {
    pub initiator: PartyID,
    pub counterparty: PartyID,
    pub intermediaries: Vec<PartyID>,
}

/// Error from an attempted commitment transition.
#[derive(Debug, thiserror::Error)]
pub enum CommitmentTransitionError {
    #[error("Commitment cannot transition from '{from}' to '{to}' — not a valid transition. A terminal state cannot move backward; to reverse a Fulfilled commitment, create a new Commitment with the parties exchanged (Invariant 2: State Monotonicity)")]
    NotAllowed { from: String, to: String },
    #[error("Commitment transition timestamp '{attempted}' is earlier than the previous transition '{last}' — history moves forward only (Invariant 4: Temporal Integrity)")]
    TimestampNotMonotonic { last: String, attempted: String },
}

fn commitment_state_name(s: &CommitmentState) -> &'static str {
    match s {
        CommitmentState::Draft => "Draft",
        CommitmentState::Proposed => "Proposed",
        CommitmentState::Tendered { .. } => "Tendered",
        CommitmentState::Accepted => "Accepted",
        CommitmentState::Modified { .. } => "Modified",
        CommitmentState::PartiallyFulfilled { .. } => "PartiallyFulfilled",
        CommitmentState::Active => "Active",
        CommitmentState::Fulfilled => "Fulfilled",
        CommitmentState::Cancelled { .. } => "Cancelled",
        CommitmentState::Disputed { .. } => "Disputed",
        CommitmentState::Refunded { .. } => "Refunded",
    }
}

/// Validate a commitment state transition against the model's exhaustive
/// valid-transition table. **This is the heart of Invariant 2.** The
/// complete set of valid transitions (every other pair is rejected):
///
/// ```text
/// Draft              → Proposed, Tendered, Cancelled
/// Proposed           → Accepted, Cancelled, Modified
/// Tendered           → Accepted, Cancelled
/// Accepted           → Modified, PartiallyFulfilled, Active, Cancelled, Disputed
/// Modified           → Accepted, Cancelled
/// PartiallyFulfilled → Fulfilled, Modified, Cancelled
/// Active             → Modified, Cancelled, Disputed
/// Fulfilled          → Disputed, Refunded
/// Disputed           → Fulfilled, Refunded, Cancelled
/// ```
pub fn validate_commitment_transition(
    from: &CommitmentState,
    to: &CommitmentState,
) -> Result<(), CommitmentTransitionError> {
    use CommitmentState::*;
    let ok = matches!(
        (from, to),
        (Draft, Proposed)
            | (Draft, Tendered { .. })
            | (Draft, Cancelled { .. })
            | (Proposed, Accepted)
            | (Proposed, Cancelled { .. })
            | (Proposed, Modified { .. })
            | (Tendered { .. }, Accepted)
            | (Tendered { .. }, Cancelled { .. })
            | (Accepted, Modified { .. })
            | (Accepted, PartiallyFulfilled { .. })
            | (Accepted, Active)
            | (Accepted, Cancelled { .. })
            | (Accepted, Disputed { .. })
            | (Modified { .. }, Accepted)
            | (Modified { .. }, Cancelled { .. })
            | (PartiallyFulfilled { .. }, Fulfilled)
            | (PartiallyFulfilled { .. }, Modified { .. })
            | (PartiallyFulfilled { .. }, Cancelled { .. })
            | (Active, Modified { .. })
            | (Active, Cancelled { .. })
            | (Active, Disputed { .. })
            | (Fulfilled, Disputed { .. })
            | (Fulfilled, Refunded { .. })
            | (Disputed { .. }, Fulfilled)
            | (Disputed { .. }, Refunded { .. })
            | (Disputed { .. }, Cancelled { .. })
    );
    if ok {
        Ok(())
    } else {
        Err(CommitmentTransitionError::NotAllowed {
            from: commitment_state_name(from).to_string(),
            to: commitment_state_name(to).to_string(),
        })
    }
}

/// A formal agreement between parties to exchange value (Primitive 4 — the
/// central primitive). The `subject`/`terms` detail is P2 work; P1 carries
/// identity, parties, state, append-only history, and the structural
/// relationships (parent/children/originated_from) the invariants need.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Commitment {
    pub id: CommitmentID,
    pub parties: CommitmentParties,
    pub state: CommitmentState,
    /// Append-only (Invariant 4).
    pub history: Vec<CommitmentTransition>,
    pub parent: Option<CommitmentID>,
    pub children: Vec<CommitmentID>,
    pub originated_from: Option<IntentID>,
    pub created_at: String,
    pub expires_at: Option<String>,
}

impl Commitment {
    /// A fresh commitment between `initiator` and `counterparty`, in state
    /// `Draft`, with no intermediaries and empty history.
    pub fn new(initiator: PartyID, counterparty: PartyID) -> Self {
        Self {
            id: CommitmentID::new_v4(),
            parties: CommitmentParties {
                initiator,
                counterparty,
                intermediaries: Vec::new(),
            },
            state: CommitmentState::Draft,
            history: Vec::new(),
            parent: None,
            children: Vec::new(),
            originated_from: None,
            created_at: now_iso(),
            expires_at: None,
        }
    }

    /// Transition to `to`, enforcing the valid-transition table
    /// (Invariant 2), timestamp monotonicity (Invariant 4), and append-only
    /// history.
    pub fn transition(
        &mut self,
        to: CommitmentState,
        actor: PartyID,
        reason: Option<String>,
    ) -> Result<(), CommitmentTransitionError> {
        self.transition_at(to, actor, reason, now_iso())
    }

    fn transition_at(
        &mut self,
        to: CommitmentState,
        actor: PartyID,
        reason: Option<String>,
        at: String,
    ) -> Result<(), CommitmentTransitionError> {
        validate_commitment_transition(&self.state, &to)?;
        if let Some(last) = self.history.last() {
            if !timestamp_not_before(&at, &last.at) {
                return Err(CommitmentTransitionError::TimestampNotMonotonic {
                    last: last.at.clone(),
                    attempted: at,
                });
            }
        }
        self.history.push(CommitmentTransition {
            from: self.state.clone(),
            to: to.clone(),
            at,
            actor,
            reason,
        });
        self.state = to;
        Ok(())
    }
}

// ===========================================================================
// PRIMITIVE 4 (here) — Fulfillment, FulfillmentState, transitions
// ===========================================================================

/// Error constructing a [`FulfillmentID`].
#[derive(Debug, thiserror::Error)]
pub enum FulfillmentIDError {
    #[error("FulfillmentID cannot be empty")]
    Empty,
}

/// A globally unique, immutable fulfillment identifier (Invariant 5).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FulfillmentID(String);

impl FulfillmentID {
    pub fn new_v4() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Result<Self, FulfillmentIDError> {
        if s.is_empty() {
            return Err(FulfillmentIDError::Empty);
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The lifecycle state of a [`Fulfillment`] (Primitive 5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FulfillmentState {
    /// Scheduled, not yet started.
    Planned,
    /// Movement or service delivery has begun.
    InProgress,
    /// Value received by destination; evidence recorded.
    Completed,
    /// Movement failed. `recoverable` distinguishes retry from terminal.
    Failed { reason: String, recoverable: bool },
    /// Value moving back (return or refund).
    Reversed {
        reason: String,
        initiated_by: PartyID,
        at: String,
    },
}

/// One append-only entry in a [`Fulfillment`]'s history (Invariant 4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FulfillmentTransition {
    pub from: FulfillmentState,
    pub to: FulfillmentState,
    pub at: String,
    pub actor: PartyID,
}

/// Error from an attempted fulfillment transition.
#[derive(Debug, thiserror::Error)]
pub enum FulfillmentTransitionError {
    #[error("Fulfillment cannot transition from '{from}' to '{to}' — not a valid transition (Invariant 2: State Monotonicity)")]
    NotAllowed { from: String, to: String },
    #[error("Fulfillment transition timestamp '{attempted}' is earlier than the previous transition '{last}' — history moves forward only (Invariant 4: Temporal Integrity)")]
    TimestampNotMonotonic { last: String, attempted: String },
}

fn fulfillment_state_name(s: &FulfillmentState) -> &'static str {
    match s {
        FulfillmentState::Planned => "Planned",
        FulfillmentState::InProgress => "InProgress",
        FulfillmentState::Completed => "Completed",
        FulfillmentState::Failed { .. } => "Failed",
        FulfillmentState::Reversed { .. } => "Reversed",
    }
}

/// Validate a fulfillment state transition. The complete set of valid
/// transitions (every other pair is rejected):
///
/// ```text
/// Planned    → InProgress, Failed
/// InProgress → Completed, Failed, Reversed
/// Completed  → Reversed
/// Failed     → Planned   (only if the failure was recoverable)
/// Reversed   → (terminal)
/// ```
///
/// A `Failed → Planned` retry is permitted only when the failure recorded
/// `recoverable: true`; a terminal (non-recoverable) failure cannot retry.
pub fn validate_fulfillment_transition(
    from: &FulfillmentState,
    to: &FulfillmentState,
) -> Result<(), FulfillmentTransitionError> {
    use FulfillmentState::*;
    let ok = match (from, to) {
        (Planned, InProgress) | (Planned, Failed { .. }) => true,
        (InProgress, Completed) | (InProgress, Failed { .. }) | (InProgress, Reversed { .. }) => {
            true
        }
        (Completed, Reversed { .. }) => true,
        // Retry only a recoverable failure.
        (Failed { recoverable, .. }, Planned) => *recoverable,
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(FulfillmentTransitionError::NotAllowed {
            from: fulfillment_state_name(from).to_string(),
            to: fulfillment_state_name(to).to_string(),
        })
    }
}

/// The execution of a Commitment — the actual movement of value
/// (Primitive 5). One Commitment produces many Fulfillments; the `items`/
/// `method`/`evidence` detail is P2 work. P1 carries identity, the owning
/// commitment, state, append-only history, and the timing fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fulfillment {
    pub id: FulfillmentID,
    pub commitment: CommitmentID,
    pub state: FulfillmentState,
    /// Append-only (Invariant 4).
    pub history: Vec<FulfillmentTransition>,
    /// `(start, end)` ISO 8601 — the period a service fulfillment covers.
    pub period: Option<(String, String)>,
    pub planned_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    /// How the value moved (P2, WARP_TYPE_DERIVATION Table C). `Option`
    /// because it is recorded as the fulfillment progresses, not at creation.
    pub method: Option<FulfillmentMethod>,
    /// Proof the fulfillment occurred (P3). Empty until evidence is captured.
    pub evidence: Vec<Evidence>,
}

impl Fulfillment {
    /// A fresh fulfillment for `commitment`, in state `Planned`.
    pub fn new(commitment: CommitmentID) -> Self {
        Self {
            id: FulfillmentID::new_v4(),
            commitment,
            state: FulfillmentState::Planned,
            history: Vec::new(),
            period: None,
            planned_at: now_iso(),
            started_at: None,
            completed_at: None,
            method: None,
            evidence: Vec::new(),
        }
    }

    /// Transition to `to`, enforcing the valid-transition table
    /// (Invariant 2), timestamp monotonicity (Invariant 4), and append-only
    /// history. Populates `started_at`/`completed_at` as the natural
    /// timing of `InProgress`/`Completed`.
    pub fn transition(
        &mut self,
        to: FulfillmentState,
        actor: PartyID,
    ) -> Result<(), FulfillmentTransitionError> {
        self.transition_at(to, actor, now_iso())
    }

    fn transition_at(
        &mut self,
        to: FulfillmentState,
        actor: PartyID,
        at: String,
    ) -> Result<(), FulfillmentTransitionError> {
        validate_fulfillment_transition(&self.state, &to)?;
        if let Some(last) = self.history.last() {
            if !timestamp_not_before(&at, &last.at) {
                return Err(FulfillmentTransitionError::TimestampNotMonotonic {
                    last: last.at.clone(),
                    attempted: at,
                });
            }
        }
        match &to {
            FulfillmentState::InProgress if self.started_at.is_none() => {
                self.started_at = Some(at.clone());
            }
            FulfillmentState::Completed => self.completed_at = Some(at.clone()),
            _ => {}
        }
        self.history.push(FulfillmentTransition {
            from: self.state.clone(),
            to: to.clone(),
            at,
            actor,
        });
        self.state = to;
        Ok(())
    }
}

// ===========================================================================
// ADAPTER BRIDGE TYPES (P2)
//
// Typed surfaces the platform-adapter layer needs to map native payloads
// onto the model faithfully (WARP_TYPE_DERIVATION Table C, P2). They describe
// a Commitment's subject, the roles parties play, and how a Fulfillment moved
// value — fields the P1 primitives intentionally deferred. Value/Money
// references are carried at the granularity an adapter has at P2 (string ids,
// the existing Currency type).
// ===========================================================================

/// When payment is due relative to delivery or performance
/// (model Primitive 4: CommitmentTerms → PaymentTerms → PaymentTiming).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentTiming {
    Immediate,
    Upfront,
    OnDelivery,
    OnServiceCompletion,
    Installments { count: u32, interval_days: u32 },
    Milestone,
    Recurring { interval_days: u32 },
    Metered,
}

/// A value the counterparty provides under a Commitment — the "offered" side
/// of the subject. `value_id` is a string at P2; a typed `ValueID`/`Value`
/// is later work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OfferedValue {
    pub value_id: String,
    /// Human-readable, e.g. `"SKU-JACKET-BLUE-L"`.
    pub description: String,
    pub quantity: u32,
    pub platform: Option<Platform>,
}

/// What the initiator provides in return — the "requested" side. Usually
/// Money, with its payment timing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestedValue {
    pub amount: Currency,
    pub payment_timing: PaymentTiming,
}

/// The subject of a Commitment: what is offered and what is requested
/// (model Primitive 4: Commitment.subject).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitmentSubject {
    pub offered: Vec<OfferedValue>,
    pub requested: Vec<RequestedValue>,
}

/// The role a party plays in a specific Commitment. Roles are contextual,
/// not intrinsic (model Primitive 1: PartyRole).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartyRole {
    Initiator,
    Counterparty,
    Intermediary,
    Fulfiller,
    Guarantor,
}

/// Binds a party to the role it plays in a Commitment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitmentPartyRole {
    pub party: PartyID,
    pub role: PartyRole,
}

/// How a [`Fulfillment`] moved value (model Primitive 4: DeliveryMethod,
/// recorded on the Fulfillment that executes it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FulfillmentMethod {
    PhysicalDelivery {
        carrier: Option<String>,
        tracking: Option<String>,
        destination: Option<String>,
    },
    InPersonHandover {
        location: String,
    },
    DigitalDelivery {
        mechanism: String,
        access_token: Option<String>,
    },
    MoneyTransfer {
        mechanism: String,
        reference: Option<String>,
    },
    ServicePerformance {
        performer: Option<PartyID>,
        location: Option<String>,
        scheduled_at: Option<String>,
    },
    InternalTransfer {
        from: String,
        to: String,
    },
}

// ===========================================================================
// ── P3 TYPES ──
//
// The final slice of model coverage (WARP_TYPE_DERIVATION Table C, P3):
// fulfillment Evidence, the multi-vendor ResolutionProcess, and the
// market-making AuctionProcess (model v0.2). Monetary values are carried as
// `(amount: String, currency: String)` pairs at this stage, matching the
// adapter-bridge convention.
// ===========================================================================

/// Proof that a Fulfillment occurred (model Primitive 5: Evidence).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Evidence {
    ProofOfDelivery {
        photo_url: Option<String>,
        signature: Option<String>,
        timestamp: String,
        location: Option<String>,
        recipient: PartyID,
    },
    PaymentReceipt {
        reference: String,
        amount: String,
        currency: String,
        timestamp: String,
    },
    AccessGrant {
        token: String,
        granted_at: String,
        expires_at: Option<String>,
    },
    ServiceCompletion {
        confirmed_by: PartyID,
        timestamp: String,
        duration_minutes: Option<u32>,
        notes: Option<String>,
    },
    TriggerVerification {
        trigger_type: String,
        fired: bool,
        timestamp: String,
    },
}

// --- ResolutionProcess (multi-vendor stock-failure resolution) -------------

/// Identifier for a [`ResolutionProcess`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ResolutionProcessID(String);

impl ResolutionProcessID {
    pub fn new_v4() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Result<Self, ResolutionProcessIDError> {
        if s.is_empty() {
            return Err(ResolutionProcessIDError::Empty);
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Error constructing a [`ResolutionProcessID`].
#[derive(Debug, thiserror::Error)]
pub enum ResolutionProcessIDError {
    #[error("ResolutionProcessID cannot be empty")]
    Empty,
}

/// Where a resolution stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionState {
    AwaitingCustomerDecision,
    Resolved { outcome: ResolutionOutcome },
    Expired,
}

/// How a resolution concluded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionOutcome {
    SubstituteAccepted { candidate_id: String },
    ItemCancelled,
}

/// A proposed substitute for an unresolved item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolutionCandidate {
    pub id: String,
    pub proposed_by: PartyID,
    pub description: String,
    pub price_delta_str: String,
    pub price_delta_currency: String,
    pub new_total_str: String,
    pub new_total_currency: String,
    pub delivery_window_change_hours: i32,
    pub state: CandidateState,
}

/// The state of a single [`ResolutionCandidate`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateState {
    Pending,
    Accepted,
    Rejected,
}

/// The resolution opened for each unresolved item when a Commitment reaches
/// `PartiallyFulfilled` (model Primitive 4: The Resolution Process).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolutionProcess {
    pub id: ResolutionProcessID,
    pub parent_commitment: CommitmentID,
    pub unresolved_item_description: String,
    pub original_value_str: String,
    pub original_value_currency: String,
    pub candidates: Vec<ResolutionCandidate>,
    pub state: ResolutionState,
    pub deadline: String,
}

// --- AuctionProcess (market-making, model v0.2) ----------------------------

/// Identifier for an [`AuctionProcess`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AuctionProcessID(String);

impl AuctionProcessID {
    pub fn new_v4() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Result<Self, AuctionProcessIDError> {
        if s.is_empty() {
            return Err(AuctionProcessIDError::Empty);
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Error constructing an [`AuctionProcessID`].
#[derive(Debug, thiserror::Error)]
pub enum AuctionProcessIDError {
    #[error("AuctionProcessID cannot be empty")]
    Empty,
}

/// The price-discovery mechanism coordinating an auction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuctionMechanism {
    English {
        reserve_price_str: Option<String>,
        reserve_currency: Option<String>,
        min_increment_str: Option<String>,
    },
    Dutch {
        start_price_str: String,
        start_currency: String,
        decrement_str: String,
        interval_seconds: u32,
    },
    SealedBid {
        reserve_price_str: Option<String>,
        reserve_currency: Option<String>,
    },
    Vickrey {
        reserve_price_str: Option<String>,
        reserve_currency: Option<String>,
    },
}

/// Why an auction closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuctionCloseReason {
    NormalClose,
    ReserveNotMet,
    SellerCancelled,
}

/// The lifecycle of an auction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuctionState {
    Scheduled,
    Open,
    Closed {
        winning_commitment: Option<CommitmentID>,
        winning_price_str: Option<String>,
        winning_currency: Option<String>,
        reason: AuctionCloseReason,
    },
}

/// The auxiliary coordination record that manages Tendered Commitments and
/// determines the winner when the auction closes (model Primitive 4:
/// AuctionProcess, v0.2). Not a sixth primitive — built from existing ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuctionProcess {
    pub id: AuctionProcessID,
    pub subject_description: String,
    pub seller: PartyID,
    pub mechanism: AuctionMechanism,
    pub tendered_commitments: Vec<CommitmentID>,
    pub opens_at: String,
    pub closes_at: String,
    pub state: AuctionState,
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- shared helpers ---------------------------------------------------

    fn pid(s: &str) -> PartyID {
        PartyID::new(s).unwrap()
    }

    fn sys() -> PartyID {
        pid("system_warp")
    }

    fn locale() -> PartyLocale {
        PartyLocale {
            language: "fr-MA".to_string(),
            currency: "MAD".to_string(),
            jurisdiction: "MA".to_string(),
        }
    }

    // Commitment-state constructors with sample payloads.
    fn tendered() -> CommitmentState {
        CommitmentState::Tendered {
            offer_amount: "100".to_string(),
            offer_currency: "MAD".to_string(),
            closes_at: "2099-01-01T00:00:00+00:00".to_string(),
            superseded_by: None,
        }
    }
    fn modified() -> CommitmentState {
        CommitmentState::Modified {
            modified_by: pid("p1"),
            reason: "price change".to_string(),
        }
    }
    fn partially() -> CommitmentState {
        CommitmentState::PartiallyFulfilled {
            fulfilled_item_ids: vec!["i1".to_string()],
            remaining_item_ids: vec!["i2".to_string()],
        }
    }
    fn cancelled() -> CommitmentState {
        CommitmentState::Cancelled {
            by: pid("p1"),
            reason: "out of stock".to_string(),
            at: "2099-01-01T00:00:00+00:00".to_string(),
        }
    }
    fn disputed() -> CommitmentState {
        CommitmentState::Disputed {
            by: pid("p1"),
            reason: "item not as described".to_string(),
            opened_at: "2099-01-01T00:00:00+00:00".to_string(),
        }
    }
    fn refunded() -> CommitmentState {
        CommitmentState::Refunded {
            amount_str: "100".to_string(),
            currency: "MAD".to_string(),
            at: "2099-01-01T00:00:00+00:00".to_string(),
        }
    }

    // ========================================================================
    // PRIMITIVE 1 — Party
    // ========================================================================

    #[test]
    fn party_id_rejects_empty() {
        assert!(matches!(PartyID::new(""), Err(PartyIDError::Empty)));
    }

    #[test]
    fn party_id_rejects_over_256_chars() {
        let long = "a".repeat(257);
        assert!(matches!(
            PartyID::new(long),
            Err(PartyIDError::TooLong(257))
        ));
    }

    #[test]
    fn party_id_accepts_valid_platform_native_id() {
        // Platforms use their own formats — a Shopify gid is fine.
        let id = PartyID::new("gid://shopify/Customer/1099").unwrap();
        assert_eq!(id.as_str(), "gid://shopify/Customer/1099");
    }

    #[test]
    fn individual_party_has_correct_type() {
        let p = Party::individual(pid("cust_1"), locale());
        assert!(matches!(p.party_type, PartyType::Individual));
    }

    #[test]
    fn organization_party_has_correct_type() {
        let p = Party::organization(pid("org_1"), locale());
        assert!(matches!(p.party_type, PartyType::Organization));
    }

    #[test]
    fn system_party_defaults_capacity_correctly() {
        // A System party holds no independent commercial capacity; all
        // capacity flags default to false (unverified) per Invariant 3.
        let p = Party::system(pid("warp_agent"));
        assert!(matches!(p.party_type, PartyType::System));
        assert!(!p.capacity.can_buy);
        assert!(!p.capacity.can_sell);
        assert!(!p.capacity.can_fulfill);
        assert!(!p.capacity.can_guarantee);
        assert!(!p.capacity.verified_at.is_empty());
    }

    #[test]
    fn party_serializes_and_deserializes() {
        let p = Party::individual(pid("cust_1"), locale());
        let json = serde_json::to_string(&p).unwrap();
        let back: Party = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn party_type_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&PartyType::Individual).unwrap(),
            "\"individual\""
        );
        assert_eq!(
            serde_json::to_string(&PartyType::System).unwrap(),
            "\"system\""
        );
    }

    // ========================================================================
    // PRIMITIVE — Intent
    // ========================================================================

    #[test]
    fn intent_starts_in_active_state() {
        let i = Intent::new(pid("cust_1"));
        assert!(matches!(i.state, IntentState::Active));
        assert!(i.history.is_empty());
    }

    #[test]
    fn intent_id_new_v4_is_unique() {
        assert_ne!(IntentID::new_v4(), IntentID::new_v4());
    }

    #[test]
    fn intent_id_from_str_rejects_empty() {
        assert!(matches!(IntentID::from_str(""), Err(IntentIDError::Empty)));
    }

    #[test]
    fn intent_valid_transition_active_to_abandoned() {
        let mut i = Intent::new(pid("cust_1"));
        i.transition(IntentState::Abandoned, sys(), Some("timeout".into()))
            .unwrap();
        assert!(matches!(i.state, IntentState::Abandoned));
        assert_eq!(i.history.len(), 1);
    }

    #[test]
    fn intent_valid_transition_active_to_converted() {
        let mut i = Intent::new(pid("cust_1"));
        i.transition(
            IntentState::Converted {
                commitment_id: CommitmentID::new_v4(),
            },
            sys(),
            None,
        )
        .unwrap();
        assert!(matches!(i.state, IntentState::Converted { .. }));
    }

    #[test]
    fn intent_valid_transition_active_to_expired() {
        let mut i = Intent::new(pid("cust_1"));
        i.transition(IntentState::Expired, sys(), None).unwrap();
        assert!(matches!(i.state, IntentState::Expired));
    }

    #[test]
    fn intent_invalid_transition_abandoned_to_active_rejected() {
        // Once abandoned, an intent cannot return to active (Invariant 2).
        let err =
            validate_intent_transition(&IntentState::Abandoned, &IntentState::Active).unwrap_err();
        assert!(matches!(err, IntentTransitionError::NotAllowed { .. }));
    }

    #[test]
    fn intent_invalid_transition_converted_to_active_rejected() {
        // Replaces the brief's `fulfilled_to_draft` example, which named
        // states that do not exist on IntentState; this tests the same
        // backward-transition guard with real states.
        let err = validate_intent_transition(
            &IntentState::Converted {
                commitment_id: CommitmentID::new_v4(),
            },
            &IntentState::Active,
        )
        .unwrap_err();
        assert!(matches!(err, IntentTransitionError::NotAllowed { .. }));
    }

    #[test]
    fn intent_invalid_transition_expired_to_abandoned_rejected() {
        let err =
            validate_intent_transition(&IntentState::Expired, &IntentState::Abandoned).unwrap_err();
        assert!(matches!(err, IntentTransitionError::NotAllowed { .. }));
    }

    #[test]
    fn intent_transition_method_rejects_invalid() {
        // Drive an intent to Abandoned, then attempt any further transition.
        let mut i = Intent::new(pid("cust_1"));
        i.transition(IntentState::Abandoned, sys(), None).unwrap();
        let err = i.transition(IntentState::Expired, sys(), None).unwrap_err();
        assert!(matches!(err, IntentTransitionError::NotAllowed { .. }));
        // State unchanged after a rejected transition.
        assert!(matches!(i.state, IntentState::Abandoned));
    }

    #[test]
    fn intent_history_is_append_only() {
        let mut i = Intent::new(pid("cust_1"));
        i.transition(IntentState::Abandoned, sys(), None).unwrap();
        assert_eq!(i.history.len(), 1);
        let first = i.history[0].clone();
        // A rejected further transition must not touch history.
        let _ = i.transition(IntentState::Active, sys(), None);
        assert_eq!(i.history.len(), 1);
        assert_eq!(i.history[0], first);
    }

    #[test]
    fn intent_transition_timestamp_must_be_after_last() {
        // Seed a future-dated history entry, then a real (now) transition is
        // earlier than it and must be rejected (Invariant 4).
        let mut i = Intent::new(pid("cust_1"));
        i.history.push(IntentTransition {
            from: IntentState::Active,
            to: IntentState::Active,
            at: "2999-01-01T00:00:00+00:00".to_string(),
            actor: sys(),
            reason: None,
        });
        let err = i
            .transition(IntentState::Abandoned, sys(), None)
            .unwrap_err();
        assert!(matches!(
            err,
            IntentTransitionError::TimestampNotMonotonic { .. }
        ));
    }

    #[test]
    fn intent_serializes_with_full_history() {
        let mut i = Intent::new(pid("cust_1"));
        i.transition(IntentState::Abandoned, sys(), Some("left site".into()))
            .unwrap();
        let json = serde_json::to_string(&i).unwrap();
        let back: Intent = serde_json::from_str(&json).unwrap();
        assert_eq!(i, back);
        assert_eq!(back.history.len(), 1);
    }

    // ========================================================================
    // PRIMITIVE — Commitment (the transition table is the critical surface)
    // ========================================================================

    #[test]
    fn commitment_starts_in_draft() {
        let c = Commitment::new(pid("buyer"), pid("seller"));
        assert!(matches!(c.state, CommitmentState::Draft));
        assert!(c.history.is_empty());
    }

    #[test]
    fn commitment_id_new_v4_is_unique() {
        assert_ne!(CommitmentID::new_v4(), CommitmentID::new_v4());
    }

    #[test]
    fn commitment_id_from_str_rejects_empty() {
        assert!(matches!(
            CommitmentID::from_str(""),
            Err(CommitmentIDError::Empty)
        ));
    }

    // ---- individual valid transitions (one assertion each) ----------------

    #[test]
    fn draft_to_proposed_valid() {
        assert!(validate_commitment_transition(
            &CommitmentState::Draft,
            &CommitmentState::Proposed
        )
        .is_ok());
    }
    #[test]
    fn draft_to_tendered_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Draft, &tendered()).is_ok());
    }
    #[test]
    fn draft_to_cancelled_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Draft, &cancelled()).is_ok());
    }
    #[test]
    fn draft_to_accepted_invalid() {
        assert!(validate_commitment_transition(
            &CommitmentState::Draft,
            &CommitmentState::Accepted
        )
        .is_err());
    }
    #[test]
    fn proposed_to_accepted_valid() {
        assert!(validate_commitment_transition(
            &CommitmentState::Proposed,
            &CommitmentState::Accepted
        )
        .is_ok());
    }
    #[test]
    fn proposed_to_modified_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Proposed, &modified()).is_ok());
    }
    #[test]
    fn proposed_to_cancelled_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Proposed, &cancelled()).is_ok());
    }
    #[test]
    fn proposed_to_fulfilled_invalid() {
        assert!(validate_commitment_transition(
            &CommitmentState::Proposed,
            &CommitmentState::Fulfilled
        )
        .is_err());
    }
    #[test]
    fn tendered_to_accepted_valid() {
        assert!(validate_commitment_transition(&tendered(), &CommitmentState::Accepted).is_ok());
    }
    #[test]
    fn tendered_to_cancelled_valid() {
        assert!(validate_commitment_transition(&tendered(), &cancelled()).is_ok());
    }
    #[test]
    fn accepted_to_modified_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Accepted, &modified()).is_ok());
    }
    #[test]
    fn accepted_to_partially_fulfilled_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Accepted, &partially()).is_ok());
    }
    #[test]
    fn accepted_to_active_valid() {
        assert!(validate_commitment_transition(
            &CommitmentState::Accepted,
            &CommitmentState::Active
        )
        .is_ok());
    }
    #[test]
    fn accepted_to_cancelled_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Accepted, &cancelled()).is_ok());
    }
    #[test]
    fn accepted_to_disputed_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Accepted, &disputed()).is_ok());
    }
    #[test]
    fn modified_to_accepted_valid() {
        // The loop that was missing from the model's lifecycle diagram.
        assert!(validate_commitment_transition(&modified(), &CommitmentState::Accepted).is_ok());
    }
    #[test]
    fn modified_to_cancelled_valid() {
        assert!(validate_commitment_transition(&modified(), &cancelled()).is_ok());
    }
    #[test]
    fn partially_fulfilled_to_fulfilled_valid() {
        assert!(validate_commitment_transition(&partially(), &CommitmentState::Fulfilled).is_ok());
    }
    #[test]
    fn partially_fulfilled_to_modified_valid() {
        assert!(validate_commitment_transition(&partially(), &modified()).is_ok());
    }
    #[test]
    fn partially_fulfilled_to_cancelled_valid() {
        assert!(validate_commitment_transition(&partially(), &cancelled()).is_ok());
    }
    #[test]
    fn active_to_modified_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Active, &modified()).is_ok());
    }
    #[test]
    fn active_to_cancelled_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Active, &cancelled()).is_ok());
    }
    #[test]
    fn active_to_disputed_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Active, &disputed()).is_ok());
    }
    #[test]
    fn fulfilled_to_disputed_valid() {
        // Return window still open.
        assert!(validate_commitment_transition(&CommitmentState::Fulfilled, &disputed()).is_ok());
    }
    #[test]
    fn fulfilled_to_refunded_valid() {
        assert!(validate_commitment_transition(&CommitmentState::Fulfilled, &refunded()).is_ok());
    }
    #[test]
    fn disputed_to_fulfilled_valid() {
        assert!(validate_commitment_transition(&disputed(), &CommitmentState::Fulfilled).is_ok());
    }
    #[test]
    fn disputed_to_refunded_valid() {
        assert!(validate_commitment_transition(&disputed(), &refunded()).is_ok());
    }
    #[test]
    fn disputed_to_cancelled_valid() {
        assert!(validate_commitment_transition(&disputed(), &cancelled()).is_ok());
    }

    // ---- backward / terminal transitions rejected (Invariant 2) -----------

    #[test]
    fn fulfilled_to_accepted_invalid() {
        assert!(validate_commitment_transition(
            &CommitmentState::Fulfilled,
            &CommitmentState::Accepted
        )
        .is_err());
    }
    #[test]
    fn cancelled_to_accepted_invalid() {
        assert!(validate_commitment_transition(&cancelled(), &CommitmentState::Accepted).is_err());
    }

    #[test]
    fn all_valid_transitions_accepted() {
        let pairs: Vec<(CommitmentState, CommitmentState)> = vec![
            (CommitmentState::Draft, CommitmentState::Proposed),
            (CommitmentState::Draft, tendered()),
            (CommitmentState::Draft, cancelled()),
            (CommitmentState::Proposed, CommitmentState::Accepted),
            (CommitmentState::Proposed, cancelled()),
            (CommitmentState::Proposed, modified()),
            (tendered(), CommitmentState::Accepted),
            (tendered(), cancelled()),
            (CommitmentState::Accepted, modified()),
            (CommitmentState::Accepted, partially()),
            (CommitmentState::Accepted, CommitmentState::Active),
            (CommitmentState::Accepted, cancelled()),
            (CommitmentState::Accepted, disputed()),
            (modified(), CommitmentState::Accepted),
            (modified(), cancelled()),
            (partially(), CommitmentState::Fulfilled),
            (partially(), modified()),
            (partially(), cancelled()),
            (CommitmentState::Active, modified()),
            (CommitmentState::Active, cancelled()),
            (CommitmentState::Active, disputed()),
            (CommitmentState::Fulfilled, disputed()),
            (CommitmentState::Fulfilled, refunded()),
            (disputed(), CommitmentState::Fulfilled),
            (disputed(), refunded()),
            (disputed(), cancelled()),
        ];
        // The model's table has exactly 26 valid transitions.
        assert_eq!(pairs.len(), 26);
        for (from, to) in pairs {
            assert!(
                validate_commitment_transition(&from, &to).is_ok(),
                "expected VALID: {:?} -> {:?}",
                from,
                to
            );
        }
    }

    #[test]
    fn all_invalid_backward_transitions_rejected() {
        let pairs: Vec<(CommitmentState, CommitmentState)> = vec![
            (CommitmentState::Fulfilled, CommitmentState::Accepted),
            (cancelled(), CommitmentState::Accepted),
            (CommitmentState::Draft, CommitmentState::Accepted),
            (CommitmentState::Proposed, CommitmentState::Fulfilled),
            (CommitmentState::Accepted, CommitmentState::Proposed),
            (CommitmentState::Accepted, CommitmentState::Draft),
            (CommitmentState::Fulfilled, CommitmentState::Draft),
            (refunded(), CommitmentState::Accepted),
            (CommitmentState::Active, CommitmentState::Fulfilled),
            (
                CommitmentState::Fulfilled,
                CommitmentState::Cancelled {
                    by: pid("p1"),
                    reason: "x".to_string(),
                    at: "2099-01-01T00:00:00+00:00".to_string(),
                },
            ),
        ];
        for (from, to) in pairs {
            assert!(
                validate_commitment_transition(&from, &to).is_err(),
                "expected INVALID: {:?} -> {:?}",
                from,
                to
            );
        }
    }

    #[test]
    fn commitment_transition_method_drives_state() {
        let mut c = Commitment::new(pid("buyer"), pid("seller"));
        c.transition(CommitmentState::Proposed, pid("buyer"), None)
            .unwrap();
        c.transition(CommitmentState::Accepted, pid("seller"), None)
            .unwrap();
        assert!(matches!(c.state, CommitmentState::Accepted));
        assert_eq!(c.history.len(), 2);
    }

    #[test]
    fn commitment_history_append_only() {
        let mut c = Commitment::new(pid("buyer"), pid("seller"));
        c.transition(CommitmentState::Proposed, pid("buyer"), None)
            .unwrap();
        let len = c.history.len();
        // Invalid transition must not alter history.
        let _ = c.transition(CommitmentState::Fulfilled, pid("buyer"), None);
        assert_eq!(c.history.len(), len);
    }

    #[test]
    fn commitment_transition_timestamp_monotonic() {
        let mut c = Commitment::new(pid("buyer"), pid("seller"));
        c.transition_at(
            CommitmentState::Proposed,
            pid("buyer"),
            None,
            "2099-01-01T00:00:00+00:00".to_string(),
        )
        .unwrap();
        let err = c
            .transition_at(
                CommitmentState::Accepted,
                pid("seller"),
                None,
                "2000-01-01T00:00:00+00:00".to_string(),
            )
            .unwrap_err();
        assert!(matches!(
            err,
            CommitmentTransitionError::TimestampNotMonotonic { .. }
        ));
    }

    #[test]
    fn commitment_serializes_with_history() {
        let mut c = Commitment::new(pid("buyer"), pid("seller"));
        c.transition(CommitmentState::Proposed, pid("buyer"), None)
            .unwrap();
        let json = serde_json::to_string(&c).unwrap();
        let back: Commitment = serde_json::from_str(&json).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn commitment_state_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&CommitmentState::Draft).unwrap(),
            "\"draft\""
        );
        assert!(serde_json::to_string(&CommitmentState::PartiallyFulfilled {
            fulfilled_item_ids: vec![],
            remaining_item_ids: vec![],
        })
        .unwrap()
        .contains("partially_fulfilled"));
    }

    // ========================================================================
    // PRIMITIVE — Fulfillment
    // ========================================================================

    #[test]
    fn fulfillment_starts_planned() {
        let f = Fulfillment::new(CommitmentID::new_v4());
        assert!(matches!(f.state, FulfillmentState::Planned));
        assert!(f.history.is_empty());
    }

    #[test]
    fn fulfillment_id_new_v4_is_unique() {
        assert_ne!(FulfillmentID::new_v4(), FulfillmentID::new_v4());
    }

    #[test]
    fn fulfillment_id_from_str_rejects_empty() {
        assert!(matches!(
            FulfillmentID::from_str(""),
            Err(FulfillmentIDError::Empty)
        ));
    }

    #[test]
    fn planned_to_in_progress_valid() {
        assert!(validate_fulfillment_transition(
            &FulfillmentState::Planned,
            &FulfillmentState::InProgress
        )
        .is_ok());
    }

    #[test]
    fn planned_to_failed_valid() {
        assert!(validate_fulfillment_transition(
            &FulfillmentState::Planned,
            &FulfillmentState::Failed {
                reason: "carrier rejected".to_string(),
                recoverable: true,
            }
        )
        .is_ok());
    }

    #[test]
    fn planned_to_completed_invalid() {
        // Must pass through InProgress.
        assert!(validate_fulfillment_transition(
            &FulfillmentState::Planned,
            &FulfillmentState::Completed
        )
        .is_err());
    }

    #[test]
    fn in_progress_to_completed_valid() {
        assert!(validate_fulfillment_transition(
            &FulfillmentState::InProgress,
            &FulfillmentState::Completed
        )
        .is_ok());
    }

    #[test]
    fn in_progress_to_failed_valid() {
        assert!(validate_fulfillment_transition(
            &FulfillmentState::InProgress,
            &FulfillmentState::Failed {
                reason: "lost in transit".to_string(),
                recoverable: false,
            }
        )
        .is_ok());
    }

    #[test]
    fn in_progress_to_reversed_valid() {
        assert!(validate_fulfillment_transition(
            &FulfillmentState::InProgress,
            &FulfillmentState::Reversed {
                reason: "customer refused".to_string(),
                initiated_by: pid("cust_1"),
                at: "2026-06-08T00:00:00+00:00".to_string(),
            }
        )
        .is_ok());
    }

    #[test]
    fn completed_to_reversed_valid() {
        // For returns.
        assert!(validate_fulfillment_transition(
            &FulfillmentState::Completed,
            &FulfillmentState::Reversed {
                reason: "return".to_string(),
                initiated_by: pid("cust_1"),
                at: "2026-06-08T00:00:00+00:00".to_string(),
            }
        )
        .is_ok());
    }

    #[test]
    fn completed_to_planned_invalid() {
        // Invariant 2 — no backward transition.
        assert!(validate_fulfillment_transition(
            &FulfillmentState::Completed,
            &FulfillmentState::Planned
        )
        .is_err());
    }

    #[test]
    fn failed_recoverable_to_planned_valid() {
        assert!(validate_fulfillment_transition(
            &FulfillmentState::Failed {
                reason: "temporary".to_string(),
                recoverable: true,
            },
            &FulfillmentState::Planned
        )
        .is_ok());
    }

    #[test]
    fn failed_not_recoverable_to_planned_invalid() {
        // A terminal failure cannot retry.
        assert!(validate_fulfillment_transition(
            &FulfillmentState::Failed {
                reason: "destroyed".to_string(),
                recoverable: false,
            },
            &FulfillmentState::Planned
        )
        .is_err());
    }

    #[test]
    fn reversed_is_terminal() {
        let reversed = FulfillmentState::Reversed {
            reason: "return".to_string(),
            initiated_by: pid("cust_1"),
            at: "2026-06-08T00:00:00+00:00".to_string(),
        };
        assert!(validate_fulfillment_transition(&reversed, &FulfillmentState::Planned).is_err());
        assert!(validate_fulfillment_transition(&reversed, &FulfillmentState::Completed).is_err());
    }

    #[test]
    fn fulfillment_history_append_only() {
        let mut f = Fulfillment::new(CommitmentID::new_v4());
        f.transition(FulfillmentState::InProgress, sys()).unwrap();
        let len = f.history.len();
        let _ = f.transition(FulfillmentState::Planned, sys()); // invalid
        assert_eq!(f.history.len(), len);
    }

    #[test]
    fn fulfillment_transition_sets_started_and_completed() {
        let mut f = Fulfillment::new(CommitmentID::new_v4());
        f.transition(FulfillmentState::InProgress, sys()).unwrap();
        assert!(f.started_at.is_some());
        f.transition(FulfillmentState::Completed, sys()).unwrap();
        assert!(f.completed_at.is_some());
        assert!(matches!(f.state, FulfillmentState::Completed));
    }

    #[test]
    fn fulfillment_transition_timestamp_monotonic() {
        let mut f = Fulfillment::new(CommitmentID::new_v4());
        f.transition_at(
            FulfillmentState::InProgress,
            sys(),
            "2099-01-01T00:00:00+00:00".to_string(),
        )
        .unwrap();
        let err = f
            .transition_at(
                FulfillmentState::Completed,
                sys(),
                "2000-01-01T00:00:00+00:00".to_string(),
            )
            .unwrap_err();
        assert!(matches!(
            err,
            FulfillmentTransitionError::TimestampNotMonotonic { .. }
        ));
    }

    #[test]
    fn fulfillment_serializes_with_history() {
        let mut f = Fulfillment::new(CommitmentID::new_v4());
        f.transition(FulfillmentState::InProgress, sys()).unwrap();
        let json = serde_json::to_string(&f).unwrap();
        let back: Fulfillment = serde_json::from_str(&json).unwrap();
        assert_eq!(f, back);
    }

    #[test]
    fn fulfillment_state_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&FulfillmentState::InProgress).unwrap(),
            "\"in_progress\""
        );
    }

    // ========================================================================
    // P2 adapter-bridge types.
    // ========================================================================

    #[test]
    fn commitment_subject_serializes_correctly() {
        let subject = CommitmentSubject {
            offered: vec![OfferedValue {
                value_id: "val_1".to_string(),
                description: "SKU-JACKET-BLUE-L".to_string(),
                quantity: 2,
                platform: Some(Platform::Shopify),
            }],
            requested: vec![RequestedValue {
                amount: Currency::mad(580),
                payment_timing: PaymentTiming::Immediate,
            }],
        };
        let json = serde_json::to_string(&subject).unwrap();
        let back: CommitmentSubject = serde_json::from_str(&json).unwrap();
        assert_eq!(subject, back);
        assert_eq!(back.offered[0].quantity, 2);
        assert_eq!(back.requested[0].amount.code, super::Currency::mad(0).code);
    }

    #[test]
    fn payment_timing_installments_has_count_and_interval() {
        let t = PaymentTiming::Installments {
            count: 3,
            interval_days: 30,
        };
        let json = serde_json::to_string(&t).unwrap();
        assert!(json.contains("installments"), "got {json}");
        let back: PaymentTiming = serde_json::from_str(&json).unwrap();
        match back {
            PaymentTiming::Installments {
                count,
                interval_days,
            } => {
                assert_eq!(count, 3);
                assert_eq!(interval_days, 30);
            }
            other => panic!("expected Installments, got {other:?}"),
        }
    }

    #[test]
    fn party_role_all_variants_serialize() {
        let pairs = [
            (PartyRole::Initiator, "\"initiator\""),
            (PartyRole::Counterparty, "\"counterparty\""),
            (PartyRole::Intermediary, "\"intermediary\""),
            (PartyRole::Fulfiller, "\"fulfiller\""),
            (PartyRole::Guarantor, "\"guarantor\""),
        ];
        for (role, expected) in pairs {
            assert_eq!(serde_json::to_string(&role).unwrap(), expected);
        }
        // And it binds to a party.
        let bound = CommitmentPartyRole {
            party: PartyID::new("p1").unwrap(),
            role: PartyRole::Guarantor,
        };
        let back: CommitmentPartyRole =
            serde_json::from_str(&serde_json::to_string(&bound).unwrap()).unwrap();
        assert!(matches!(back.role, PartyRole::Guarantor));
    }

    #[test]
    fn fulfillment_physical_delivery_serializes() {
        let m = FulfillmentMethod::PhysicalDelivery {
            carrier: Some("CTM".to_string()),
            tracking: Some("TRK-001".to_string()),
            destination: Some("Casablanca".to_string()),
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("physical_delivery"), "got {json}");
        let back: FulfillmentMethod = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);

        // And it attaches to a Fulfillment.
        let mut f = Fulfillment::new(CommitmentID::new_v4());
        f.method = Some(m);
        let back_f: Fulfillment =
            serde_json::from_str(&serde_json::to_string(&f).unwrap()).unwrap();
        assert_eq!(f, back_f);
        assert!(back_f.method.is_some());
    }

    #[test]
    fn fulfillment_money_transfer_has_reference() {
        let m = FulfillmentMethod::MoneyTransfer {
            mechanism: "bank_transfer".to_string(),
            reference: Some("PAY-REF-42".to_string()),
        };
        let back: FulfillmentMethod =
            serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        match back {
            FulfillmentMethod::MoneyTransfer { reference, .. } => {
                assert_eq!(reference.as_deref(), Some("PAY-REF-42"));
            }
            other => panic!("expected MoneyTransfer, got {other:?}"),
        }
    }

    // ========================================================================
    // P3 types — Evidence, ResolutionProcess, AuctionProcess.
    // ========================================================================

    #[test]
    fn evidence_proof_of_delivery_serializes() {
        let e = Evidence::ProofOfDelivery {
            photo_url: Some("https://x/pod.jpg".to_string()),
            signature: None,
            timestamp: "2026-06-10T12:00:00+00:00".to_string(),
            location: Some("Casablanca".to_string()),
            recipient: pid("cust_1"),
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("proof_of_delivery"), "got {json}");
        let back: Evidence = serde_json::from_str(&json).unwrap();
        assert_eq!(e, back);
    }

    #[test]
    fn evidence_payment_receipt_has_currency() {
        let e = Evidence::PaymentReceipt {
            reference: "RC-1".to_string(),
            amount: "580".to_string(),
            currency: "MAD".to_string(),
            timestamp: "2026-06-10T12:00:00+00:00".to_string(),
        };
        let back: Evidence = serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
        match back {
            Evidence::PaymentReceipt {
                currency, amount, ..
            } => {
                assert_eq!(currency, "MAD");
                assert_eq!(amount, "580");
            }
            other => panic!("expected PaymentReceipt, got {other:?}"),
        }
    }

    #[test]
    fn fulfillment_with_evidence_roundtrips() {
        let mut f = Fulfillment::new(CommitmentID::new_v4());
        f.evidence.push(Evidence::AccessGrant {
            token: "tok_1".to_string(),
            granted_at: "2026-06-10T12:00:00+00:00".to_string(),
            expires_at: None,
        });
        let back: Fulfillment = serde_json::from_str(&serde_json::to_string(&f).unwrap()).unwrap();
        assert_eq!(f, back);
        assert_eq!(back.evidence.len(), 1);
    }

    #[test]
    fn resolution_process_starts_awaiting_decision() {
        let rp = ResolutionProcess {
            id: ResolutionProcessID::new_v4(),
            parent_commitment: CommitmentID::new_v4(),
            unresolved_item_description: "SKU out of stock".to_string(),
            original_value_str: "300".to_string(),
            original_value_currency: "MAD".to_string(),
            candidates: vec![],
            state: ResolutionState::AwaitingCustomerDecision,
            deadline: "2026-06-12T00:00:00+00:00".to_string(),
        };
        assert!(matches!(
            rp.state,
            ResolutionState::AwaitingCustomerDecision
        ));
        let back: ResolutionProcess =
            serde_json::from_str(&serde_json::to_string(&rp).unwrap()).unwrap();
        assert_eq!(rp, back);
    }

    #[test]
    fn resolution_candidate_accepted_state_serializes() {
        let c = ResolutionCandidate {
            id: "cand_1".to_string(),
            proposed_by: pid("vendor_1"),
            description: "Blue variant".to_string(),
            price_delta_str: "20".to_string(),
            price_delta_currency: "MAD".to_string(),
            new_total_str: "320".to_string(),
            new_total_currency: "MAD".to_string(),
            delivery_window_change_hours: 24,
            state: CandidateState::Accepted,
        };
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("accepted"), "got {json}");
        let back: ResolutionCandidate = serde_json::from_str(&json).unwrap();
        assert!(matches!(back.state, CandidateState::Accepted));
    }

    #[test]
    fn resolution_outcome_substitute_has_candidate_id() {
        let o = ResolutionOutcome::SubstituteAccepted {
            candidate_id: "cand_9".to_string(),
        };
        let back: ResolutionOutcome =
            serde_json::from_str(&serde_json::to_string(&o).unwrap()).unwrap();
        match back {
            ResolutionOutcome::SubstituteAccepted { candidate_id } => {
                assert_eq!(candidate_id, "cand_9");
            }
            other => panic!("expected SubstituteAccepted, got {other:?}"),
        }
    }

    #[test]
    fn auction_process_english_serializes() {
        let a = AuctionProcess {
            id: AuctionProcessID::new_v4(),
            subject_description: "Vintage painting".to_string(),
            seller: pid("seller_1"),
            mechanism: AuctionMechanism::English {
                reserve_price_str: Some("10000".to_string()),
                reserve_currency: Some("MAD".to_string()),
                min_increment_str: Some("500".to_string()),
            },
            tendered_commitments: vec![],
            opens_at: "2026-06-10T00:00:00+00:00".to_string(),
            closes_at: "2026-06-17T00:00:00+00:00".to_string(),
            state: AuctionState::Open,
        };
        let json = serde_json::to_string(&a).unwrap();
        assert!(json.contains("english"), "got {json}");
        let back: AuctionProcess = serde_json::from_str(&json).unwrap();
        assert_eq!(a, back);
    }

    #[test]
    fn auction_process_closed_with_winner_serializes() {
        let state = AuctionState::Closed {
            winning_commitment: Some(CommitmentID::new_v4()),
            winning_price_str: Some("12000".to_string()),
            winning_currency: Some("MAD".to_string()),
            reason: AuctionCloseReason::NormalClose,
        };
        let back: AuctionState =
            serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        match back {
            AuctionState::Closed {
                winning_price_str,
                reason,
                ..
            } => {
                assert_eq!(winning_price_str.as_deref(), Some("12000"));
                assert!(matches!(reason, AuctionCloseReason::NormalClose));
            }
            other => panic!("expected Closed, got {other:?}"),
        }
    }

    #[test]
    fn auction_state_normal_close_reason() {
        assert_eq!(
            serde_json::to_string(&AuctionCloseReason::NormalClose).unwrap(),
            "\"normal_close\""
        );
        assert_eq!(
            serde_json::to_string(&AuctionCloseReason::ReserveNotMet).unwrap(),
            "\"reserve_not_met\""
        );
    }
}
