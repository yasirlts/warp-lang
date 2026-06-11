//! Commerce types — Warp's typed money, identifiers, and value objects.
//!
//! [`Currency`] is the first type Warp ships. It enforces what every
//! merchant operations team learns the hard way: MAD and EUR are not
//! interchangeable, and `f64` arithmetic on money silently corrupts.
//!
//! The contract this module guarantees:
//!   - Two `Currency` values cannot be combined unless their
//!     [`CurrencyCode`]s match. Mixing fails with [`CurrencyError`].
//!   - All arithmetic uses [`rust_decimal::Decimal`] — exact,
//!     no rounding drift.
//!   - Conversion between currencies is explicit and carries a rate;
//!     there is no implicit `MAD → EUR`.
//!
//! See C-01 in `CONTRACTS.md` for why this is non-negotiable.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::fmt;

// P2 (WARP_TYPE_DERIVATION Table B): the surface types in this module link
// to the model spine in [`super::model`]. CustomerProfile → Party,
// CartState → Intent, OrderID → CommitmentID, CustomerID → PartyID. The
// bridges are additive — every existing type keeps its shape.
use super::model::{
    CommitmentID, Intent, IntentID, IntentState, IntentTransition, IntentTransitionError, Party,
    PartyID, PartyIDError, PartyLocale,
};

/// A monetary value with its currency code attached.
///
/// `Currency` is the only type Warp nodes may use to represent money.
/// Raw numbers (`u64`, `Decimal`, `f64`) are rejected at compile time
/// in node signatures that handle money — per C-01.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Currency {
    #[serde(with = "rust_decimal::serde::str")]
    pub amount: Decimal,
    pub code: CurrencyCode,
}

/// Supported currency codes. MENA-first: MAD is the default,
/// EUR for cross-border merchant flows, USD for completeness.
/// Additional codes land per merchant demand, not speculatively.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CurrencyCode {
    MAD,
    EUR,
    USD,
}

impl Currency {
    /// Construct a MAD amount. Accepts any value convertible to
    /// `Decimal` (integers, parsed strings, existing decimals).
    pub fn mad(amount: impl Into<Decimal>) -> Self {
        Self {
            amount: amount.into(),
            code: CurrencyCode::MAD,
        }
    }

    /// Construct a EUR amount.
    pub fn eur(amount: impl Into<Decimal>) -> Self {
        Self {
            amount: amount.into(),
            code: CurrencyCode::EUR,
        }
    }

    /// Construct a USD amount.
    pub fn usd(amount: impl Into<Decimal>) -> Self {
        Self {
            amount: amount.into(),
            code: CurrencyCode::USD,
        }
    }

    /// Add two `Currency` values of the same code. Returns
    /// [`CurrencyError::MixedCurrencies`] if the codes differ — the
    /// caller must convert first.
    ///
    /// Intentionally not `impl std::ops::Add`: the trait's signature
    /// is infallible (`Output = Self`), but adding mixed currencies
    /// must surface as an error rather than silently corrupting money.
    #[allow(clippy::should_implement_trait)]
    pub fn add(self, other: Currency) -> Result<Currency, CurrencyError> {
        if self.code != other.code {
            return Err(CurrencyError::MixedCurrencies {
                left: self.code,
                right: other.code,
            });
        }
        Ok(Currency {
            amount: self.amount + other.amount,
            code: self.code,
        })
    }

    /// Convert this amount into `target` by multiplying by `rate`.
    ///
    /// `rate` is interpreted as "units of `target` per one unit of `self.code`".
    /// Example: `Currency::mad(1000).convert_to(EUR, 0.092)` ≈ `EUR(92)`.
    ///
    /// Conversion is explicit by design — there is no FX oracle in
    /// warp-core. Callers (typically nodes that wrap an FX adapter)
    /// pass the rate they were quoted.
    pub fn convert_to(self, target: CurrencyCode, rate: Decimal) -> Currency {
        Currency {
            amount: self.amount * rate,
            code: target,
        }
    }

    /// Threshold check: is `self >= other`? Only valid within the same
    /// currency code. Returns an error rather than silently comparing
    /// across codes.
    pub fn is_at_least(self, other: Currency) -> Result<bool, CurrencyError> {
        if self.code != other.code {
            return Err(CurrencyError::MixedCurrencies {
                left: self.code,
                right: other.code,
            });
        }
        Ok(self.amount >= other.amount)
    }
}

impl fmt::Display for Currency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:.2} {}", self.amount, self.code)
    }
}

impl fmt::Display for CurrencyCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            CurrencyCode::MAD => "MAD",
            CurrencyCode::EUR => "EUR",
            CurrencyCode::USD => "USD",
        };
        f.write_str(s)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CurrencyError {
    #[error("Cannot operate on mixed currencies: {left:?} and {right:?}. Use convert_to() first.")]
    MixedCurrencies {
        left: CurrencyCode,
        right: CurrencyCode,
    },
}

// ============================================================================
// PhoneNumber — the type that gates WhatsApp / SMS communication.
//
// A raw `String` cannot reach a `WhatsAppSend` node. Callers must hoist
// untrusted input through `PhoneNumber::parse`, which enforces E.164. This
// is the C-01 expression for telephony: if a node accepts a phone number,
// its signature names `PhoneNumber`, and a mistyped wire fails to compile.
// ============================================================================

/// An E.164-formatted phone number with a WhatsApp-routable flag.
///
/// Construction is gated by [`PhoneNumber::parse`]; the inner E.164 string
/// is private so the only way to obtain one is to pass through validation.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PhoneNumber {
    /// E.164 format: `+[country_code][number]`, e.g. `+212661234567`.
    e164: String,
    /// True once the number is confirmed reachable on WhatsApp (set by the
    /// WhatsApp adapter after a Business API check, never on construction).
    pub whatsapp_routable: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum PhoneNumberError {
    #[error("Invalid E.164 format: '{0}'. Must start with + followed by 7-15 digits.")]
    InvalidFormat(String),
}

impl PhoneNumber {
    /// Parse and validate an E.164 phone number string.
    /// The only way to construct a [`PhoneNumber`].
    pub fn parse(raw: impl Into<String>) -> Result<Self, PhoneNumberError> {
        let raw = raw.into();
        // E.164: leading '+', then 7-15 ASCII digits, no spaces or dashes.
        let valid = raw.starts_with('+')
            && raw.len() >= 8
            && raw.len() <= 16
            && raw[1..].chars().all(|c| c.is_ascii_digit());

        if !valid {
            return Err(PhoneNumberError::InvalidFormat(raw));
        }

        Ok(Self {
            e164: raw,
            whatsapp_routable: false,
        })
    }

    /// Mark this number as confirmed-reachable on WhatsApp. Called by the
    /// WhatsApp adapter after a Business API check succeeds.
    pub fn with_whatsapp(mut self) -> Self {
        self.whatsapp_routable = true;
        self
    }

    /// E.164 string for use in API calls.
    pub fn as_e164(&self) -> &str {
        &self.e164
    }
}

impl fmt::Display for PhoneNumber {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.e164)
    }
}

// ============================================================================
// TenantId — execution-isolation key (ADR-0002 phase 1).
//
// Every workflow input carries a TenantId. The Restate workflow key is
// formatted "{tenant_id}:{session_id}" so two tenants with the same
// session_id run as completely independent invocations. Full DB-side RLS
// lands in Phase 2 when the storage layer exists.
// ============================================================================

/// A tenant identifier. Opaque string, compared by value.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TenantId(String);

impl TenantId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TenantId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Compose the canonical Restate workflow key for a tenant-scoped
/// invocation: `"{tenant_id}:{primary}"`. `primary` is the natural
/// per-invocation identifier (session_id for cart workflows, order_id
/// for order workflows, etc.).
///
/// Two tenants with the same `primary` value produce distinct keys and
/// therefore run as fully independent Restate invocations — the
/// execution-layer half of ADR-0002 (storage-layer RLS lands in Phase 2).
pub fn tenant_workflow_key(tenant_id: &TenantId, primary: &str) -> String {
    format!("{}:{}", tenant_id, primary)
}

/// Error returned by [`assert_tenant_key`] when the runtime-supplied
/// workflow key does not match the `{tenant_id}:{primary}` form computed
/// from the input. This indicates the caller invoked the workflow with
/// the wrong key — either a bug in the adapter or a cross-tenant attempt.
#[derive(Debug, thiserror::Error)]
#[error("tenant-key mismatch: workflow key {actual:?} does not match expected {expected:?} (C-03)")]
pub struct TenantKeyMismatch {
    pub actual: String,
    pub expected: String,
}

/// Verify the running workflow's key matches `{tenant_id}:{primary}`.
/// Called once at the top of every tenant-scoped workflow body — if the
/// caller invoked us with the wrong key, fail terminally so the request
/// surfaces as an operator error rather than silently cross-contaminating.
pub fn assert_tenant_key(
    workflow_key: &str,
    tenant_id: &TenantId,
    primary: &str,
) -> Result<(), TenantKeyMismatch> {
    let expected = tenant_workflow_key(tenant_id, primary);
    if workflow_key != expected {
        return Err(TenantKeyMismatch {
            actual: workflow_key.to_string(),
            expected,
        });
    }
    Ok(())
}

// ============================================================================
// Platform — the commerce platform that produced an event.
//
// Tag enum carried by every typed trigger event so downstream nodes can
// branch on the source (Shopify and Agora differ on WhatsApp opt-in
// semantics, for example) and dashboards can attribute outcomes by
// platform. Listed in CLAUDE.md as a core commerce type; lives in
// warp-core so the merchant API surface can name it without pulling in
// warp-catalog (C-04: core is adapter-agnostic, but the tag is fine).
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Platform {
    Agora,
    Shopify,
    WooCommerce,
    OpenCart,
    Magento,
    /// First ERP-class platform — Odoo's sale.order events ride the
    /// same Warp triggers as the SaaS commerce adapters. Phase 2 session 8
    /// shipped the adapter; the variant is the contract that other
    /// systems implement against (per the Warp Type Spec).
    Odoo,
}

// ============================================================================
// Intelligence types — Customer profile, language, channel, strategy.
//
// These are the types ACP returns when Warp asks "who is this customer?" and
// "what should we offer them?" They flow on the canvas wires from
// ACPGetCustomerProfile / ACPEvaluateStrategy into communication nodes.
//
// Language and Channel are closed enums on purpose: every WhatsApp template
// and every notification node branches on them, so adding a new variant is
// a deliberate cross-cutting decision (P-7 — MENA is not an afterthought).
// ============================================================================

/// Languages Warp supports for customer-facing communication.
/// Darija routes to Hodio-enhanced templates downstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Language {
    Arabic,
    French,
    English,
    Darija,
}

impl fmt::Display for Language {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Language::Arabic => "Arabic",
            Language::French => "French",
            Language::English => "English",
            Language::Darija => "Darija",
        };
        f.write_str(s)
    }
}

impl Language {
    /// The BCP 47 language tag the model's `Locale.language` uses (P2,
    /// WARP_TYPE_DERIVATION Table B). The named variants stay for usability;
    /// this is the model-faithful wire form. Darija maps to `"zgh"`
    /// (Standard Moroccan Tamazight — the closest BCP 47 primary tag).
    pub fn to_bcp47(&self) -> &'static str {
        match self {
            Language::Arabic => "ar",
            Language::French => "fr",
            Language::English => "en",
            Language::Darija => "zgh",
        }
    }

    /// Parse a BCP 47 tag (with or without a region subtag) back to a
    /// [`Language`]. Returns `None` for tags Warp does not model.
    pub fn from_bcp47(code: &str) -> Option<Self> {
        match code {
            "ar" | "ar-MA" | "ar-DZ" => Some(Language::Arabic),
            "fr" | "fr-MA" | "fr-FR" => Some(Language::French),
            "en" | "en-US" | "en-GB" => Some(Language::English),
            "zgh" | "zgh-MA" | "ber" => Some(Language::Darija),
            _ => None,
        }
    }
}

/// Outbound channels Warp can reach a customer on. Used both by
/// [`CustomerProfile`] (the customer's preferred channel) and by
/// [`StrategyRecommendation`] (what ACP thinks is the best channel for
/// the next message, which may override the preference).
///
/// Renamed from `Channel` per WARP_TYPE_DERIVATION Table B: the model uses
/// "Channel" for an Intent's *engagement* channel ([`EngagementChannel`]:
/// Web | Mobile | Physical | Voice | Agent), a different concept from the
/// *outbound delivery* channel meant here. The `Channel` alias below
/// preserves every existing reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum OutboundChannel {
    WhatsApp,
    FCM,
    Email,
    SMS,
}

/// Backward-compatible alias. Existing code and serialized data that name
/// `Channel` continue to resolve to [`OutboundChannel`] unchanged.
pub type Channel = OutboundChannel;

impl fmt::Display for OutboundChannel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            OutboundChannel::WhatsApp => "WhatsApp",
            OutboundChannel::FCM => "FCM",
            OutboundChannel::Email => "Email",
            OutboundChannel::SMS => "SMS",
        };
        f.write_str(s)
    }
}

/// The model's Intent engagement channel — *how a party is engaging*
/// (model Primitive 3: IntentContext.channel). Distinct from
/// [`OutboundChannel`], which is how Warp reaches *out* to a customer.
/// Serializes snake_case per the model's serialization convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngagementChannel {
    Web,
    Mobile,
    Physical,
    Voice,
    Agent,
}

/// The typed customer record ACP returns. `phone` is a [`PhoneNumber`],
/// not a `String` — wiring this into a [`WhatsAppSend`-style](super) node
/// satisfies the C-01 type contract at compile time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomerProfile {
    /// Link to the canonical [`Party`] primitive (P2, WARP_TYPE_DERIVATION
    /// Table B). `Option` for backward compatibility: ACP responses and
    /// stored profiles that predate the model spine carry no `party_id`.
    /// `#[serde(default)]` lets such JSON deserialize to `None`.
    #[serde(default)]
    pub party_id: Option<PartyID>,
    /// Platform-specific customer identifier (kept as-is).
    pub customer_id: String,
    pub phone: PhoneNumber,
    pub language: Language,
    pub preferred_channel: Channel,
    pub email: Option<String>,
    pub name: Option<String>,
    /// The model's [`Party`] view of this customer (P3 node migration,
    /// WARP_TYPE_DERIVATION). Populated by `ACPGetCustomerProfile` so the
    /// loaded profile carries its `Party(Individual)` primitive directly.
    /// Additive and `Option`: `None` until built, and for profiles captured
    /// before the model spine existed (`#[serde(default)]`). Distinct from
    /// [`Self::as_party`], which derives a `Party` on demand from a `locale`;
    /// this field caches the one the node produced.
    #[serde(default)]
    pub party: Option<Party>,
}

impl CustomerProfile {
    /// Construct the model's [`Party`] view of this profile (P2 bridge).
    /// `PartyType::Individual` with default unverified capacity (Invariant 3
    /// — capacity is verified later, never assumed). Uses `party_id` when
    /// present, otherwise derives a [`PartyID`] from `customer_id`.
    pub fn as_party(&self, locale: PartyLocale) -> Party {
        let id = self.party_id.clone().unwrap_or_else(|| {
            PartyID::new(self.customer_id.clone())
                .unwrap_or_else(|_| PartyID::new("unknown_party").expect("non-empty literal"))
        });
        Party::individual(id, locale)
    }
}

/// ACP's recommendation for the next move on a given customer/cart.
/// `confidence` ranges `0.0..=1.0`; downstream nodes typically branch
/// on a threshold (e.g. `> 0.7` sends the discount, otherwise generic).
///
/// Not `Eq` because `f32` is not `Eq` — comparisons in tests use the
/// individual fields rather than struct equality.
///
/// This type is a Warp implementation type for marketing automation.
/// It is not derived from the Warp Commerce Model primitives.
/// It exists above the model layer as application-level strategy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyRecommendation {
    pub discount_code: Option<String>,
    pub recommended_products: Vec<String>,
    pub confidence: f32,
    pub rationale: String,
    pub recommended_channel: Channel,
}

// ============================================================================
// Identifier types — OrderID and CustomerID.
//
// Two newtypes that look superficially identical but are deliberately
// distinct at the type level so the compiler rejects accidental mixups
// (passing an OrderID where a CustomerID is expected, and vice versa).
// Validation rules are identical; the meaning is not. See the C-01
// contract — typed wrappers around String for domain identifiers.
// ============================================================================

const MAX_IDENTIFIER_LEN: usize = 128;

fn is_valid_identifier_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// A validated order identifier.
///
/// Two `OrderID`s with the same string are equal; an `OrderID` and a
/// [`CustomerID`] with the same string **do not** compare and cannot be
/// substituted for each other at function-call sites:
///
/// ```compile_fail
/// use warp_core::types::commerce::{CustomerID, OrderID};
/// fn accepts_customer_id(_id: CustomerID) {}
/// let order_id = OrderID::new("ord_123").unwrap();
/// accepts_customer_id(order_id); // <- type error, intentionally
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OrderID(String);

#[derive(Debug, thiserror::Error)]
pub enum OrderIDError {
    #[error("OrderID cannot be empty")]
    Empty,
    #[error("OrderID '{0}' exceeds 128 characters")]
    TooLong(String),
    #[error(
        "OrderID '{0}' contains invalid characters. Use alphanumeric, hyphens, underscores only."
    )]
    InvalidChars(String),
}

impl OrderID {
    pub fn new(id: impl Into<String>) -> Result<Self, OrderIDError> {
        let id = id.into();
        if id.is_empty() {
            return Err(OrderIDError::Empty);
        }
        if id.len() > MAX_IDENTIFIER_LEN {
            return Err(OrderIDError::TooLong(id));
        }
        if !id.chars().all(is_valid_identifier_char) {
            return Err(OrderIDError::InvalidChars(id));
        }
        Ok(Self(id))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Bridge to the model: an order **is** a Commitment (P2,
    /// WARP_TYPE_DERIVATION Table B; Invariant 5 — a platform's native order
    /// id maps to exactly one CommitmentID). Infallible: a validated
    /// `OrderID` is always a valid `CommitmentID` (non-empty by construction).
    pub fn to_commitment_id(&self) -> CommitmentID {
        CommitmentID::from_str(self.as_str())
            .expect("OrderID is non-empty by construction, so it is a valid CommitmentID")
    }
}

impl fmt::Display for OrderID {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

// Reverse bridge. Inherent impl on the model's `CommitmentID`, placed here
// with the platform `OrderID` it maps from (Rust allows inherent impls in
// any module of the defining crate).
impl CommitmentID {
    /// Construct a [`CommitmentID`] from a platform [`OrderID`], preserving
    /// the id value (Invariant 5).
    pub fn from_order_id(order_id: &OrderID) -> Self {
        CommitmentID::from_str(order_id.as_str())
            .expect("OrderID is non-empty by construction, so it is a valid CommitmentID")
    }
}

/// A validated customer identifier. Same shape as [`OrderID`] but a
/// distinct type — the type system prevents passing one where the
/// other is expected.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CustomerID(String);

#[derive(Debug, thiserror::Error)]
pub enum CustomerIDError {
    #[error("CustomerID cannot be empty")]
    Empty,
    #[error("CustomerID '{0}' exceeds 128 characters")]
    TooLong(String),
    #[error("CustomerID '{0}' contains invalid characters. Use alphanumeric, hyphens, underscores only.")]
    InvalidChars(String),
}

impl CustomerID {
    pub fn new(id: impl Into<String>) -> Result<Self, CustomerIDError> {
        let id = id.into();
        if id.is_empty() {
            return Err(CustomerIDError::Empty);
        }
        if id.len() > MAX_IDENTIFIER_LEN {
            return Err(CustomerIDError::TooLong(id));
        }
        if !id.chars().all(is_valid_identifier_char) {
            return Err(CustomerIDError::InvalidChars(id));
        }
        Ok(Self(id))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Bridge to the model: a customer is a [`Party`] playing the buyer role
    /// (P2, WARP_TYPE_DERIVATION Table B). Infallible — a validated
    /// `CustomerID` (≤128 chars) is always a valid `PartyID` (≤256).
    pub fn to_party_id(&self) -> PartyID {
        PartyID::new(self.as_str())
            .expect("CustomerID is a valid PartyID by construction (shorter length cap)")
    }
}

impl fmt::Display for CustomerID {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

// Reverse bridge, placed with the platform `CustomerID` it maps from.
impl PartyID {
    /// Construct a [`PartyID`] from a platform [`CustomerID`]. Returns
    /// [`PartyIDError`] if the value somehow violates `PartyID`'s rules
    /// (it cannot, for a validated `CustomerID`, but the signature is honest).
    pub fn from_customer_id(customer_id: &CustomerID) -> Result<Self, PartyIDError> {
        PartyID::new(customer_id.as_str())
    }
}

// ============================================================================
// CartState — the live cart.
//
// Aggregates CartItems and exposes derived values (total, item_count,
// vendor_count) so workflows don't recompute them by hand. `total()`
// surfaces currency mismatches across items as a CurrencyError — the
// C-01 contract for money holds inside the cart, not just on its
// boundaries.
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CartItem {
    pub product_id: String,
    pub name: String,
    pub quantity: u32,
    pub unit_price: Currency,
    pub vendor_id: String,
}

/// The live cart for a customer at a point in time. Adapter triggers
/// hoist a foreign cart payload into this shape; downstream
/// intelligence and communication nodes read from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CartState {
    /// Link to the model's [`Intent`] primitive (P2, WARP_TYPE_DERIVATION
    /// Table B): a live cart **is** an `Intent(Active)`. `Option` for
    /// backward compatibility with carts captured before the model spine
    /// existed; `#[serde(default)]` deserializes their JSON to `None`.
    #[serde(default)]
    pub intent_id: Option<IntentID>,
    pub cart_id: String,
    pub customer_id: CustomerID,
    pub items: Vec<CartItem>,
    /// What the cart was worth at snapshot time. Stored on the struct
    /// because most adapters report a server-computed subtotal that
    /// may include applied coupons / store credit; [`Self::total`]
    /// independently re-sums the items, so the two values can diverge
    /// when a discount is in play. Callers wanting "what the line items
    /// add to" call `total()`; "what the merchant's checkout said the
    /// customer owed" reads `subtotal`.
    pub subtotal: Currency,
    pub currency: CurrencyCode,
    pub vendor_ids: Vec<String>,
}

impl CartState {
    /// The model's [`Intent`] view of this cart: an `Intent` in state
    /// `Active` (P2 bridge, WARP_TYPE_DERIVATION Table B). Preserves the
    /// cart's `intent_id` when one is set, so the same intent identity
    /// flows through the model.
    pub fn as_intent(&self, party_id: PartyID) -> Intent {
        let mut intent = Intent::new(party_id);
        if let Some(id) = &self.intent_id {
            intent.id = id.clone();
        }
        intent
    }

    /// Produce the formal record of a cart abandonment: an [`Intent`] built
    /// from this cart, transitioned `Active → Abandoned` with full history.
    /// This is what a `CartAbandoned` firing produces in the model — the
    /// abandonment becomes a first-class state transition rather than an
    /// afterthought webhook.
    ///
    /// The returned Intent's history has two entries: an opening marker
    /// (the intent's creation, recorded as the self-contained start of the
    /// trail) followed by the `Active → Abandoned` transition. The opening
    /// marker is appended directly rather than through `transition` — the
    /// model starts an Intent in `Active` with no prior state, so "creation"
    /// is bookkeeping, not one of the model's valid state moves.
    pub fn abandon(
        &self,
        party_id: PartyID,
        actor: PartyID,
    ) -> Result<Intent, IntentTransitionError> {
        let mut intent = self.as_intent(party_id);
        let opened_at = intent.created_at.clone();
        intent.history.push(IntentTransition {
            from: IntentState::Active,
            to: IntentState::Active,
            at: opened_at,
            actor: actor.clone(),
            reason: Some("intent_opened".to_string()),
        });
        intent.transition(
            IntentState::Abandoned,
            actor,
            Some("cart_abandoned".to_string()),
        )?;
        Ok(intent)
    }

    /// Sum `unit_price * quantity` across all items.
    ///
    /// Fails with [`CurrencyError::MixedCurrencies`] if any two items
    /// disagree on currency code — a multi-currency cart in a single
    /// snapshot is a data bug we want to catch loudly.
    pub fn total(&self) -> Result<Currency, CurrencyError> {
        if self.items.is_empty() {
            return Ok(Currency {
                amount: Decimal::from(0),
                code: self.currency,
            });
        }
        // Start from the first item's currency; every subsequent item
        // must match or `add` returns MixedCurrencies.
        let first = &self.items[0];
        let mut running = Currency {
            amount: first.unit_price.amount * Decimal::from(first.quantity),
            code: first.unit_price.code,
        };
        for item in &self.items[1..] {
            let line = Currency {
                amount: item.unit_price.amount * Decimal::from(item.quantity),
                code: item.unit_price.code,
            };
            running = running.add(line)?;
        }
        Ok(running)
    }

    /// Total units across all items (sum of quantities, not number of
    /// distinct SKUs).
    pub fn item_count(&self) -> u32 {
        self.items.iter().map(|i| i.quantity).sum()
    }

    /// Number of distinct vendors represented in the cart. Multi-vendor
    /// carts get split per-vendor for fulfillment, so this number
    /// drives the fan-out factor downstream.
    pub fn vendor_count(&self) -> usize {
        let mut vendors: std::collections::HashSet<&str> = std::collections::HashSet::new();
        self.items.iter().for_each(|i| {
            vendors.insert(&i.vendor_id);
        });
        vendors.len()
    }
}

// ============================================================================
// Marketing types — Occasion, OccasionEvent, SegmentCriteria,
// CampaignAudience, ABTestVariant.
//
// The vocabulary for marketing automation. `Occasion` is a closed enum
// of MENA-first commerce occasions (Eid, Ramadan, Mother's Day,
// Valentine's, plus the universal birthday / anniversary / wedding
// anniversary). `Custom(String)` is the escape hatch for merchant-
// specific dates (a beauty shop's "first salon visit anniversary")
// without forcing every variant to land in the closed enum first.
//
// `OccasionEvent` is what `OccasionTrigger` emits: a typed signal that
// "customer X has occasion Y in `days_until` days." Downstream nodes
// branch on `occasion` and `days_until` rather than re-deriving them.
//
// `SegmentCriteria` + `CampaignAudience` are the audience pair —
// criteria-in, typed-audience-out. `CampaignAudience` is the typed
// list a `CampaignFanOut` node accepts. Carrying the source criteria
// on the audience lets dashboards explain "this campaign reached
// 1,247 customers because: spent ≥ MAD 500 AND French AND consented".
//
// `ABTestVariant` is the binary cohort `ABTestRoute` returns.
// Deterministic by construction — the routing logic is hash-of-id,
// not RNG, so a replay always lands in the same variant.
// ============================================================================

/// A customer-facing occasion campaigns may anchor on. Closed enum so
/// adding a variant is a cross-cutting decision (template library,
/// dashboard filters, AI builder vocabulary all branch on it).
/// `Custom` is the per-merchant escape hatch — the merchant supplies
/// a free-form occasion name without us having to extend the enum.
///
/// JSON wire format is snake_case per WARP_TYPE_SPEC v0.3's
/// Serialization Conventions: `Birthday → "birthday"`,
/// `MothersDay → "mothers_day"`, `WeddingAnniversary →
/// "wedding_anniversary"`. The `Custom(String)` variant serializes as
/// an object: `Custom("ramadan_night") → {"custom": "ramadan_night"}`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Occasion {
    /// Customer's date of birth.
    Birthday,
    /// Generic anniversary — first purchase, account creation, etc.
    Anniversary,
    /// Eid Al-Fitr / Eid Al-Adha. The merchant configures which one;
    /// the type doesn't distinguish (a gift campaign that fires N days
    /// before "Eid" works for both — different dates, same playbook).
    Eid,
    /// Start of Ramadan — campaigns typically fire a few days before
    /// the first day so customers can prep.
    Ramadan,
    /// Mother's Day — the international March/May date that ACP and
    /// most catalog merchants treat as one occasion.
    MothersDay,
    /// 14 February. Carried as a distinct variant because the gifting
    /// vertical reports it separately from Mother's Day.
    ValentinesDay,
    /// The customer's own wedding anniversary (distinct from the
    /// generic `Anniversary` above, which tracks merchant relationships).
    WeddingAnniversary,
    /// Corporate / B2B occasion (corporate gifting, client appreciation).
    /// Added per WARP_TYPE_DERIVATION Table B to match the model's
    /// `Occasion` enumeration.
    Corporate,
    /// Merchant-defined occasion. Free-form string — same shape as
    /// `Custom("Mawazine_Festival")` or `Custom("first_salon_visit")`.
    /// Lowercase + underscores recommended but not enforced; the
    /// merchant's templates name the same string.
    Custom(String),
}

impl fmt::Display for Occasion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Occasion::Birthday => f.write_str("Birthday"),
            Occasion::Anniversary => f.write_str("Anniversary"),
            Occasion::Eid => f.write_str("Eid"),
            Occasion::Ramadan => f.write_str("Ramadan"),
            Occasion::MothersDay => f.write_str("MothersDay"),
            Occasion::ValentinesDay => f.write_str("ValentinesDay"),
            Occasion::WeddingAnniversary => f.write_str("WeddingAnniversary"),
            Occasion::Corporate => f.write_str("Corporate"),
            Occasion::Custom(s) => write!(f, "Custom({})", s),
        }
    }
}

/// The typed event a [`Occasion`]-aware trigger emits. Carries who
/// the occasion is for, which occasion, how many days out, and the
/// occasion date in ISO 8601. Downstream nodes (`DelayUntil`,
/// `WhatsAppSend`, `CustomerSegment`) consume this without re-deriving.
///
/// `days_until` is `0` on the day-of, positive in advance, never
/// negative — past-occasion firings are not modeled at the event
/// shape; if a calendar lookup returns a past date the producer
/// either skips it or rolls forward to next year.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OccasionEvent {
    pub tenant_id: TenantId,
    pub customer_id: CustomerID,
    pub occasion: Occasion,
    /// 0 = today, 7 = a week away, 30 = a month out.
    pub days_until: u32,
    /// ISO 8601 date (no time) — `"2026-06-15"`. Time-of-day is
    /// chosen by the campaign downstream, typically via [`DelayUntil`].
    pub occasion_date: String,
    /// The model's [`Intent`] view of the occasion firing (P3 node migration,
    /// WARP_TYPE_DERIVATION). An occasion fires an `Intent(Active)` for the
    /// customer — the occasion context (campaign anchor) made first-class.
    /// Additive and `Option`: `None` for events captured before the model
    /// spine existed (`#[serde(default)]`).
    #[serde(default)]
    pub intent: Option<Intent>,
}

/// Criteria a [`CustomerSegment`] node filters by. Every field is
/// optional: a `SegmentCriteria::default()` matches every customer
/// in the input list. Each `Some(_)` field tightens the filter.
///
/// Monetary thresholds use `mad` units (whole MAD, not minor units)
/// because the merchant-facing canvas displays them as `MAD 500` and
/// the type round-trips through JSON for the canvas API.
///
/// This type is a Warp implementation type for marketing automation.
/// It is not derived from the Warp Commerce Model primitives.
/// It exists above the model layer as application-level strategy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SegmentCriteria {
    /// Minimum lifetime order count — `Some(2)` keeps only repeat buyers.
    pub min_order_count: Option<u32>,
    /// Minimum lifetime spend in MAD (whole units). Cross-currency
    /// customers convert to MAD at lookup time; conversion is the
    /// caller's job (the same Currency-convert contract as elsewhere).
    pub min_total_spent_mad: Option<u64>,
    /// Match a specific [`Language`] preference. `None` accepts all.
    pub language: Option<Language>,
    /// Customer made a purchase within the last N days. `Some(90)`
    /// is the common "active customer" cutoff.
    pub last_purchase_within_days: Option<u32>,
    /// Filter to customers who consented to WhatsApp marketing.
    /// MENA merchants are unlikely to ship a campaign without this set.
    pub has_whatsapp_consent: Option<bool>,
}

/// The typed list a [`CampaignFanOut`] node accepts. Carries the
/// audience members AND the criteria that produced them — so a
/// dashboard surfacing "this campaign reached N customers" can
/// also surface *why* those customers were in the audience.
///
/// `customers` is a `Vec<String>` of customer ids (not full
/// `CustomerProfile`) to keep the audience cheap to pass between
/// nodes. The fan-out node hydrates each id into a profile right
/// before the per-customer WhatsApp send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignAudience {
    pub tenant_id: TenantId,
    pub customers: Vec<String>,
    pub criteria: SegmentCriteria,
    /// Free-form label — surfaces on the merchant dashboard as the
    /// campaign's display name. Optional so a quick-fire campaign
    /// can omit it.
    pub label: Option<String>,
}

impl CampaignAudience {
    /// Number of customers in the audience. Avoid calling
    /// `audience.customers.len()` directly so the API can later
    /// switch to a paged/streamed shape without breaking callers.
    pub fn size(&self) -> usize {
        self.customers.len()
    }
}

/// A/B test variant. Two-way split today; multi-way arms are a Phase 4
/// extension (the trade-off is worth being deliberate about — three
/// arms multiply experiment cost, and most merchants run two).
///
/// This type is a Warp implementation type for marketing automation.
/// It is not derived from the Warp Commerce Model primitives.
/// It exists above the model layer as application-level strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ABTestVariant {
    A,
    B,
}

impl fmt::Display for ABTestVariant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ABTestVariant::A => f.write_str("A"),
            ABTestVariant::B => f.write_str("B"),
        }
    }
}

// ============================================================================
// Value lifecycle — ValueState + ReservationBasis (model Primitive 2).
//
// Added per WARP_TYPE_DERIVATION P1: the audit flagged both ValueState and
// ReservationBasis as MISSING (neither existed before). They are created
// here, model-faithful to the Commerce Model's Primitive 2 ValueState for
// physical goods and money. References to other model objects (commitment,
// fulfillment, auction process, party) are carried as `String` ids at this
// stage to keep `commerce.rs` decoupled from `super::model`; typing them as
// CommitmentID/FulfillmentID/PartyID is a later migration step.
//
// ReservationBasis is the field that makes Invariant 3 (Capacity
// Verification) honest: a Speculative reservation is allowed to reach
// Accepted, but the basis is recorded explicitly so risk is visible. The
// UnderAuction state (v0.2 of the model) keeps a value from being reserved
// or committed to any party while an auction controls its allocation.
// ============================================================================

/// Why a value is held against a commitment. Recorded on
/// [`ValueState::Reserved`] so capacity risk is explicit (model Primitive 2;
/// Invariant 3). `Speculative` is the honest representation of dropshipping
/// and made-to-order — availability is claimed, not verified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReservationBasis {
    /// The item exists in a warehouse or store.
    PhysicalStock,
    /// The item will be produced; capacity is confirmed.
    ProductionCapacity,
    /// A performer's time held for a service.
    TimeSlot {
        /// ISO 8601 start of the held slot.
        slot_start: String,
        /// ISO 8601 end of the held slot.
        slot_end: String,
        /// What the slot consumes, e.g. `"barber-time"`.
        capacity_unit: String,
    },
    /// Multiple future slots held (a recurring service).
    RecurringTimeSlot {
        /// `(start, end)` ISO 8601 pairs.
        slots: Vec<(String, String)>,
    },
    /// Gig economy: a specific driver allocated.
    DriverCapacity,
    /// No formal verification; risk accepted (dropshipping, made-to-order).
    Speculative,
}

/// The lifecycle state of a value instance for physical goods and money
/// (model Primitive 2). Id references to other model objects are carried as
/// strings at this stage (see module note above).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueState {
    /// No constraints; can be committed.
    Available,
    /// Allocated against a commitment, with a recorded basis (Invariant 3).
    Reserved {
        commitment_id: String,
        basis: ReservationBasis,
    },
    /// Subject to an active auction — cannot be reserved or committed to any
    /// party while the auction process controls allocation (model v0.2).
    UnderAuction {
        auction_process_id: String,
        current_high_commitment: Option<String>,
        current_high_offer_amount: Option<String>,
        current_high_offer_currency: Option<String>,
        /// ISO 8601 close time.
        closes_at: String,
    },
    /// Allocated; transfer imminent.
    Committed { commitment_id: String },
    /// Moving to its destination under a fulfillment.
    InTransit { fulfillment_id: String },
    /// Transferred to a party (the originator no longer holds it).
    Transferred {
        to: String,
        /// ISO 8601 transfer time.
        at: String,
    },
    /// Moving back from a party (a return).
    Returned {
        from: String,
        /// ISO 8601 initiation time.
        initiated_at: String,
    },
}

// ============================================================================
// Tests — these are the C-01 contract tests for the Currency type.
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn same_currency_adds_correctly() {
        let a = Currency::mad(580);
        let b = Currency::mad(200);
        let result = a.add(b).unwrap();
        assert_eq!(result.amount, Decimal::from(780));
        assert_eq!(result.code, CurrencyCode::MAD);
    }

    #[test]
    fn mixed_currency_add_fails_with_clear_error() {
        let mad = Currency::mad(580);
        let eur = Currency::eur(50);
        let result = mad.add(eur);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("MAD"));
        assert!(err.contains("EUR"));
        assert!(err.contains("convert_to"));
    }

    #[test]
    fn explicit_conversion_works() {
        let mad = Currency::mad(1000);
        let rate = Decimal::from_str("0.092").unwrap();
        let eur = mad.convert_to(CurrencyCode::EUR, rate);
        assert_eq!(eur.code, CurrencyCode::EUR);
        assert_eq!(eur.amount, Decimal::from_str("92.000").unwrap());
    }

    #[test]
    fn display_format_is_human_readable() {
        let c = Currency::mad(580);
        assert_eq!(format!("{}", c), "580.00 MAD");
    }

    #[test]
    fn is_at_least_works_same_currency() {
        let cart = Currency::mad(580);
        let threshold = Currency::mad(200);
        assert!(cart.is_at_least(threshold).unwrap());
    }

    #[test]
    fn is_at_least_fails_mixed_currency() {
        let cart = Currency::mad(580);
        let threshold = Currency::eur(50);
        assert!(cart.is_at_least(threshold).is_err());
    }

    // ========================================================================
    // PhoneNumber — C-01 contract for telephony.
    // ========================================================================

    #[test]
    fn valid_moroccan_number_parses() {
        let n = PhoneNumber::parse("+212661234567").unwrap();
        assert_eq!(n.as_e164(), "+212661234567");
        assert!(!n.whatsapp_routable);
    }

    #[test]
    fn with_whatsapp_sets_routable_flag() {
        let n = PhoneNumber::parse("+212661234567").unwrap().with_whatsapp();
        assert!(n.whatsapp_routable);
    }

    #[test]
    fn missing_plus_fails() {
        let result = PhoneNumber::parse("212661234567");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("E.164"));
    }

    #[test]
    fn too_short_fails() {
        let result = PhoneNumber::parse("+123");
        assert!(result.is_err());
    }

    #[test]
    fn spaces_in_number_fail() {
        let result = PhoneNumber::parse("+212 661 234 567");
        assert!(result.is_err());
    }

    #[test]
    fn display_shows_e164() {
        let n = PhoneNumber::parse("+212661234567").unwrap();
        assert_eq!(format!("{}", n), "+212661234567");
    }

    // ========================================================================
    // TenantId — opaque string identity for ADR-0002 phase 1 isolation.
    // ========================================================================

    #[test]
    fn tenant_id_roundtrips() {
        let t = TenantId::new("tenant_aimer");
        assert_eq!(t.as_str(), "tenant_aimer");
        assert_eq!(format!("{}", t), "tenant_aimer");
    }

    #[test]
    fn tenant_workflow_key_composes_pair() {
        let t = TenantId::new("tenant_aimer");
        assert_eq!(
            tenant_workflow_key(&t, "session_123"),
            "tenant_aimer:session_123"
        );
    }

    #[test]
    fn assert_tenant_key_accepts_matching_key() {
        let t = TenantId::new("tenant_aimer");
        assert!(assert_tenant_key("tenant_aimer:session_123", &t, "session_123").is_ok());
    }

    #[test]
    fn assert_tenant_key_rejects_cross_tenant_attempt() {
        // Caller invoked with the wrong tenant prefix — surface as error.
        let t = TenantId::new("tenant_aimer");
        let err = assert_tenant_key("tenant_other:session_123", &t, "session_123").unwrap_err();
        assert_eq!(err.actual, "tenant_other:session_123");
        assert_eq!(err.expected, "tenant_aimer:session_123");
    }

    // ========================================================================
    // Intelligence types — Language, Channel, CustomerProfile, Strategy.
    //
    // The JSON wire format is the contract surface for ACP. Round-trip
    // tests pin down the exact variant names so an ACP-side change
    // surfaces here as a compile or test failure rather than silent drift.
    // ========================================================================

    #[test]
    fn language_serializes_to_named_variant() {
        let arabic = serde_json::to_string(&Language::Arabic).unwrap();
        assert_eq!(arabic, "\"Arabic\"");
        let darija: Language = serde_json::from_str("\"Darija\"").unwrap();
        assert!(matches!(darija, Language::Darija));
    }

    #[test]
    fn channel_serializes_to_named_variant() {
        let whatsapp = serde_json::to_string(&Channel::WhatsApp).unwrap();
        assert_eq!(whatsapp, "\"WhatsApp\"");
        let fcm: Channel = serde_json::from_str("\"FCM\"").unwrap();
        assert!(matches!(fcm, Channel::FCM));
    }

    #[test]
    fn platform_serializes_to_named_variant_including_odoo() {
        // Every Platform variant round-trips by its PascalCase name.
        // The Odoo variant (Phase 2 session 8 — first ERP adapter)
        // serializes as "Odoo", not "odoo" or some snake-case form.
        assert_eq!(
            serde_json::to_string(&Platform::Agora).unwrap(),
            "\"Agora\""
        );
        assert_eq!(
            serde_json::to_string(&Platform::Shopify).unwrap(),
            "\"Shopify\""
        );
        assert_eq!(serde_json::to_string(&Platform::Odoo).unwrap(), "\"Odoo\"");
        let parsed: Platform = serde_json::from_str("\"Odoo\"").unwrap();
        assert!(matches!(parsed, Platform::Odoo));
    }

    #[test]
    fn customer_profile_round_trips_with_typed_phone() {
        let profile = CustomerProfile {
            party_id: None,
            customer_id: "cust_001".to_string(),
            phone: PhoneNumber::parse("+212661234567").unwrap().with_whatsapp(),
            language: Language::French,
            preferred_channel: Channel::WhatsApp,
            email: Some("test@aimer.ma".to_string()),
            name: Some("Test Customer".to_string()),
            party: None,
        };
        let json = serde_json::to_string(&profile).unwrap();
        let back: CustomerProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.customer_id, "cust_001");
        assert_eq!(back.phone.as_e164(), "+212661234567");
        assert!(back.phone.whatsapp_routable);
        assert!(matches!(back.language, Language::French));
        assert!(matches!(back.preferred_channel, Channel::WhatsApp));
    }

    #[test]
    fn strategy_recommendation_round_trips_with_confidence() {
        let rec = StrategyRecommendation {
            discount_code: Some("WARP10".to_string()),
            recommended_products: vec!["prod_001".to_string(), "prod_002".to_string()],
            confidence: 0.85,
            rationale: "Customer has high repeat purchase probability".to_string(),
            recommended_channel: Channel::WhatsApp,
        };
        let json = serde_json::to_string(&rec).unwrap();
        let back: StrategyRecommendation = serde_json::from_str(&json).unwrap();
        assert_eq!(back.discount_code.as_deref(), Some("WARP10"));
        assert_eq!(back.recommended_products.len(), 2);
        assert!(back.confidence > 0.0 && back.confidence <= 1.0);
        assert!(matches!(back.recommended_channel, Channel::WhatsApp));
    }

    // ========================================================================
    // OrderID + CustomerID — validated identifier newtypes.
    // ========================================================================

    #[test]
    fn valid_order_id_accepts_alphanumeric_hyphens_underscores() {
        let id = OrderID::new("ord_2026-05-24_abc123").unwrap();
        assert_eq!(id.as_str(), "ord_2026-05-24_abc123");
        assert_eq!(format!("{}", id), "ord_2026-05-24_abc123");
    }

    #[test]
    fn empty_order_id_fails() {
        assert!(matches!(OrderID::new(""), Err(OrderIDError::Empty)));
    }

    #[test]
    fn order_id_with_spaces_fails() {
        let err = OrderID::new("ord 123").unwrap_err();
        assert!(matches!(err, OrderIDError::InvalidChars(_)));
        assert!(err.to_string().contains("alphanumeric"));
    }

    #[test]
    fn order_id_over_128_chars_fails() {
        let long = "a".repeat(129);
        let err = OrderID::new(long).unwrap_err();
        assert!(matches!(err, OrderIDError::TooLong(_)));
    }

    #[test]
    fn customer_id_validates_same_rules_as_order_id() {
        // Same validation surface; distinct type. The compile_fail
        // doctest on `OrderID` proves the type-level distinction.
        assert!(CustomerID::new("cust_001").is_ok());
        assert!(matches!(CustomerID::new(""), Err(CustomerIDError::Empty)));
        assert!(matches!(
            CustomerID::new("cust 001"),
            Err(CustomerIDError::InvalidChars(_))
        ));
    }

    #[test]
    fn customer_id_and_order_id_are_distinct_types() {
        // Runtime evidence of the compile-time guarantee: even with
        // identical inner strings, the two newtypes are not the same
        // type — the compile_fail doctest on OrderID is the canonical
        // test. This assertion just exercises both Display impls so the
        // surface area is in the test record.
        let order_id = OrderID::new("xyz_42").unwrap();
        let customer_id = CustomerID::new("xyz_42").unwrap();
        assert_eq!(order_id.as_str(), customer_id.as_str());
        // No `assert_eq!(order_id, customer_id)` here — they don't
        // implement cross-type equality, which is the whole point.
    }

    // ========================================================================
    // CartState — derived totals + currency-safety.
    // ========================================================================

    fn cart_with(items: Vec<CartItem>, subtotal: Currency) -> CartState {
        CartState {
            intent_id: None,
            cart_id: "cart_001".to_string(),
            customer_id: CustomerID::new("cust_001").unwrap(),
            items,
            subtotal: subtotal.clone(),
            currency: subtotal.code,
            vendor_ids: vec![],
        }
    }

    #[test]
    fn cart_total_sums_correctly() {
        let cart = cart_with(
            vec![
                CartItem {
                    product_id: "sku_a".to_string(),
                    name: "A".to_string(),
                    quantity: 2,
                    unit_price: Currency::mad(290),
                    vendor_id: "v1".to_string(),
                },
                CartItem {
                    product_id: "sku_b".to_string(),
                    name: "B".to_string(),
                    quantity: 1,
                    unit_price: Currency::mad(170),
                    vendor_id: "v2".to_string(),
                },
            ],
            Currency::mad(750),
        );
        let total = cart.total().unwrap();
        assert_eq!(total.amount, Decimal::from(750));
        assert_eq!(total.code, CurrencyCode::MAD);
    }

    #[test]
    fn cart_total_fails_on_mixed_currencies() {
        let cart = cart_with(
            vec![
                CartItem {
                    product_id: "sku_a".to_string(),
                    name: "A".to_string(),
                    quantity: 1,
                    unit_price: Currency::mad(290),
                    vendor_id: "v1".to_string(),
                },
                CartItem {
                    product_id: "sku_b".to_string(),
                    name: "B".to_string(),
                    quantity: 1,
                    unit_price: Currency::eur(30),
                    vendor_id: "v2".to_string(),
                },
            ],
            Currency::mad(290),
        );
        let err = cart.total().unwrap_err();
        assert!(matches!(err, CurrencyError::MixedCurrencies { .. }));
    }

    #[test]
    fn cart_item_count_returns_sum_of_quantities() {
        let cart = cart_with(
            vec![
                CartItem {
                    product_id: "sku_a".to_string(),
                    name: "A".to_string(),
                    quantity: 3,
                    unit_price: Currency::mad(100),
                    vendor_id: "v1".to_string(),
                },
                CartItem {
                    product_id: "sku_b".to_string(),
                    name: "B".to_string(),
                    quantity: 5,
                    unit_price: Currency::mad(50),
                    vendor_id: "v1".to_string(),
                },
            ],
            Currency::mad(550),
        );
        // Three of A + five of B = eight units, despite only two SKUs.
        assert_eq!(cart.item_count(), 8);
    }

    #[test]
    fn cart_vendor_count_deduplicates_vendors() {
        let cart = cart_with(
            vec![
                CartItem {
                    product_id: "sku_a".to_string(),
                    name: "A".to_string(),
                    quantity: 1,
                    unit_price: Currency::mad(100),
                    vendor_id: "v1".to_string(),
                },
                CartItem {
                    product_id: "sku_b".to_string(),
                    name: "B".to_string(),
                    quantity: 1,
                    unit_price: Currency::mad(100),
                    vendor_id: "v2".to_string(),
                },
                CartItem {
                    product_id: "sku_c".to_string(),
                    name: "C".to_string(),
                    quantity: 1,
                    unit_price: Currency::mad(100),
                    vendor_id: "v1".to_string(), // duplicate
                },
            ],
            Currency::mad(300),
        );
        assert_eq!(cart.vendor_count(), 2);
    }

    // ========================================================================
    // Marketing types — Occasion, OccasionEvent, SegmentCriteria,
    // CampaignAudience, ABTestVariant.
    //
    // JSON wire format is the contract surface for the dashboard / AI
    // builder / merchant API; round-trip the variants so a rename
    // shows up as a test failure rather than silent dashboard drift.
    // ========================================================================

    #[test]
    fn occasion_round_trips_through_json_including_custom() {
        for occ in [
            Occasion::Birthday,
            Occasion::Anniversary,
            Occasion::Eid,
            Occasion::Ramadan,
            Occasion::MothersDay,
            Occasion::ValentinesDay,
            Occasion::WeddingAnniversary,
            Occasion::Custom("mawazine_festival".to_string()),
        ] {
            let json = serde_json::to_string(&occ).unwrap();
            let back: Occasion = serde_json::from_str(&json).unwrap();
            assert_eq!(occ, back, "occasion did not round-trip: {json}");
        }
    }

    /// Pins the wire format per v0.3's Serialization Conventions:
    /// all `Occasion` variants serialize to snake_case strings, and
    /// `Custom(String)` becomes an object `{"custom": value}`.
    /// A regression here would change every campaign's stored
    /// occasion tag on the dashboard.
    #[test]
    fn occasion_serializes_to_snake_case() {
        assert_eq!(
            serde_json::to_string(&Occasion::Birthday).unwrap(),
            "\"birthday\""
        );
        assert_eq!(
            serde_json::to_string(&Occasion::Anniversary).unwrap(),
            "\"anniversary\""
        );
        assert_eq!(serde_json::to_string(&Occasion::Eid).unwrap(), "\"eid\"");
        assert_eq!(
            serde_json::to_string(&Occasion::Ramadan).unwrap(),
            "\"ramadan\""
        );
        assert_eq!(
            serde_json::to_string(&Occasion::MothersDay).unwrap(),
            "\"mothers_day\""
        );
        assert_eq!(
            serde_json::to_string(&Occasion::ValentinesDay).unwrap(),
            "\"valentines_day\""
        );
        assert_eq!(
            serde_json::to_string(&Occasion::WeddingAnniversary).unwrap(),
            "\"wedding_anniversary\""
        );
        // Custom is an externally-tagged variant — serializes as
        // {"custom": "<value>"} (the snake_case-cased tag is the key,
        // the carried string is the value).
        assert_eq!(
            serde_json::to_string(&Occasion::Custom("diwali".to_string())).unwrap(),
            "{\"custom\":\"diwali\"}"
        );
    }

    #[test]
    fn occasion_display_format_is_stable() {
        // Display is consumed by log lines and dashboard text; pin the
        // exact strings so a Debug-vs-Display swap doesn't silently
        // change ops dashboards. Display intentionally stays PascalCase
        // even though the JSON wire is snake_case — Display is for
        // human-facing operators, the wire is for machine consumers.
        assert_eq!(format!("{}", Occasion::Eid), "Eid");
        assert_eq!(format!("{}", Occasion::MothersDay), "MothersDay");
        assert_eq!(
            format!("{}", Occasion::Custom("x".to_string())),
            "Custom(x)"
        );
    }

    #[test]
    fn occasion_event_round_trips_with_typed_customer_id() {
        let ev = OccasionEvent {
            tenant_id: TenantId::new("tenant_aimer"),
            customer_id: CustomerID::new("cust_001").unwrap(),
            occasion: Occasion::Birthday,
            days_until: 7,
            occasion_date: "2026-06-15".to_string(),
            intent: None,
        };
        let json = serde_json::to_string(&ev).unwrap();
        let back: OccasionEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.customer_id.as_str(), "cust_001");
        assert_eq!(back.days_until, 7);
        assert_eq!(back.occasion_date, "2026-06-15");
        assert!(matches!(back.occasion, Occasion::Birthday));
    }

    #[test]
    fn segment_criteria_default_is_all_none_and_matches_any_input() {
        let c = SegmentCriteria::default();
        assert!(c.min_order_count.is_none());
        assert!(c.min_total_spent_mad.is_none());
        assert!(c.language.is_none());
        assert!(c.last_purchase_within_days.is_none());
        assert!(c.has_whatsapp_consent.is_none());
    }

    #[test]
    fn segment_criteria_round_trips_through_json() {
        let c = SegmentCriteria {
            min_order_count: Some(3),
            min_total_spent_mad: Some(500),
            language: Some(Language::Arabic),
            last_purchase_within_days: Some(90),
            has_whatsapp_consent: Some(true),
        };
        let json = serde_json::to_string(&c).unwrap();
        let back: SegmentCriteria = serde_json::from_str(&json).unwrap();
        assert_eq!(back.min_order_count, Some(3));
        assert_eq!(back.min_total_spent_mad, Some(500));
        assert!(matches!(back.language, Some(Language::Arabic)));
        assert_eq!(back.last_purchase_within_days, Some(90));
        assert_eq!(back.has_whatsapp_consent, Some(true));
    }

    #[test]
    fn campaign_audience_size_returns_customer_count() {
        let a = CampaignAudience {
            tenant_id: TenantId::new("tenant_aimer"),
            customers: vec!["c1".into(), "c2".into(), "c3".into()],
            criteria: SegmentCriteria::default(),
            label: Some("Eid 2026 — Casablanca repeat buyers".to_string()),
        };
        assert_eq!(a.size(), 3);
    }

    #[test]
    fn campaign_audience_round_trips_through_json_with_criteria() {
        let a = CampaignAudience {
            tenant_id: TenantId::new("tenant_aimer"),
            customers: vec!["c1".into(), "c2".into()],
            criteria: SegmentCriteria {
                min_order_count: Some(2),
                ..SegmentCriteria::default()
            },
            label: None,
        };
        let json = serde_json::to_string(&a).unwrap();
        let back: CampaignAudience = serde_json::from_str(&json).unwrap();
        assert_eq!(back.size(), 2);
        assert_eq!(back.criteria.min_order_count, Some(2));
        assert!(back.label.is_none());
    }

    #[test]
    fn ab_test_variant_serializes_as_named_variant() {
        assert_eq!(serde_json::to_string(&ABTestVariant::A).unwrap(), "\"A\"");
        assert_eq!(serde_json::to_string(&ABTestVariant::B).unwrap(), "\"B\"");
        let back: ABTestVariant = serde_json::from_str("\"A\"").unwrap();
        assert!(matches!(back, ABTestVariant::A));
    }

    // ========================================================================
    // Value lifecycle — ReservationBasis + ValueState (model Primitive 2).
    // ========================================================================

    #[test]
    fn reservation_basis_speculative_serializes_correctly() {
        let b = ReservationBasis::Speculative;
        assert_eq!(serde_json::to_string(&b).unwrap(), "\"speculative\"");
        let back: ReservationBasis = serde_json::from_str("\"speculative\"").unwrap();
        assert!(matches!(back, ReservationBasis::Speculative));
    }

    #[test]
    fn value_state_under_auction_serializes_correctly() {
        let s = ValueState::UnderAuction {
            auction_process_id: "auc_001".to_string(),
            current_high_commitment: Some("cmt_001".to_string()),
            current_high_offer_amount: Some("12000".to_string()),
            current_high_offer_currency: Some("MAD".to_string()),
            closes_at: "2026-07-01T00:00:00+00:00".to_string(),
        };
        let json = serde_json::to_string(&s).unwrap();
        // snake_case tag per the model's serialization convention.
        assert!(json.contains("under_auction"), "got {json}");
        let back: ValueState = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn reservation_basis_time_slot_has_required_fields() {
        let b = ReservationBasis::TimeSlot {
            slot_start: "2026-06-10T09:00:00+00:00".to_string(),
            slot_end: "2026-06-10T10:00:00+00:00".to_string(),
            capacity_unit: "barber-time".to_string(),
        };
        let json = serde_json::to_string(&b).unwrap();
        let back: ReservationBasis = serde_json::from_str(&json).unwrap();
        match back {
            ReservationBasis::TimeSlot {
                slot_start,
                slot_end,
                capacity_unit,
            } => {
                assert_eq!(slot_start, "2026-06-10T09:00:00+00:00");
                assert_eq!(slot_end, "2026-06-10T10:00:00+00:00");
                assert_eq!(capacity_unit, "barber-time");
            }
            other => panic!("expected TimeSlot, got {other:?}"),
        }
    }

    // ========================================================================
    // P2 TABLE B revisions — surface types bridged to the model spine.
    // ========================================================================

    fn test_locale() -> PartyLocale {
        PartyLocale {
            language: "fr-MA".to_string(),
            currency: "MAD".to_string(),
            jurisdiction: "MA".to_string(),
        }
    }

    #[test]
    fn customer_profile_to_party_conversion() {
        let profile = CustomerProfile {
            party_id: None,
            customer_id: "cust_001".to_string(),
            phone: PhoneNumber::parse("+212661234567").unwrap(),
            language: Language::French,
            preferred_channel: Channel::WhatsApp,
            email: None,
            name: None,
            party: None,
        };
        let party = profile.as_party(test_locale());
        assert!(matches!(party.party_type, crate::PartyType::Individual));
        // Capacity starts unverified (Invariant 3).
        assert!(!party.capacity.can_buy);
        // With no explicit party_id, the id derives from customer_id.
        assert_eq!(party.id.as_str(), "cust_001");
    }

    #[test]
    fn customer_profile_party_id_is_optional_for_compat() {
        // JSON without a party_id field still deserializes (serde default).
        // PhoneNumber is a struct, so `phone` is an object, not a bare string.
        let json = r#"{"customer_id":"c1",
            "phone":{"e164":"+212661234567","whatsapp_routable":false},
            "language":"French","preferred_channel":"WhatsApp",
            "email":null,"name":null}"#;
        let p: CustomerProfile = serde_json::from_str(json).unwrap();
        assert!(p.party_id.is_none());
        // And an explicit party_id round-trips.
        let with_id = CustomerProfile {
            party_id: Some(PartyID::new("party_9").unwrap()),
            ..p
        };
        let back: CustomerProfile =
            serde_json::from_str(&serde_json::to_string(&with_id).unwrap()).unwrap();
        assert_eq!(back.party_id.unwrap().as_str(), "party_9");
    }

    #[test]
    fn order_id_to_commitment_id_round_trip() {
        let order_id = OrderID::new("ord_2026_abc").unwrap();
        let commitment_id = order_id.to_commitment_id();
        assert_eq!(commitment_id.as_str(), order_id.as_str());
    }

    #[test]
    fn commitment_id_from_order_id_preserves_value() {
        let order_id = OrderID::new("ord_xyz_42").unwrap();
        let commitment_id = CommitmentID::from_order_id(&order_id);
        assert_eq!(commitment_id.as_str(), "ord_xyz_42");
    }

    #[test]
    fn customer_id_to_party_id_round_trip() {
        let customer_id = CustomerID::new("cust_777").unwrap();
        let party_id = customer_id.to_party_id();
        assert_eq!(party_id.as_str(), customer_id.as_str());
        // Reverse bridge preserves the value too.
        let back = PartyID::from_customer_id(&customer_id).unwrap();
        assert_eq!(back.as_str(), "cust_777");
    }

    fn empty_cart() -> CartState {
        CartState {
            intent_id: None,
            cart_id: "cart_99".to_string(),
            customer_id: CustomerID::new("cust_99").unwrap(),
            items: vec![],
            subtotal: Currency::mad(0),
            currency: CurrencyCode::MAD,
            vendor_ids: vec![],
        }
    }

    #[test]
    fn cart_state_as_intent_produces_active_intent() {
        let cart = empty_cart();
        let party = cart.customer_id.to_party_id();
        let intent = cart.as_intent(party);
        assert!(matches!(intent.state, IntentState::Active));
    }

    #[test]
    fn cart_state_abandon_produces_abandoned_intent_with_history() {
        let cart = empty_cart();
        let party = cart.customer_id.to_party_id();
        let actor = PartyID::new("system_warp").unwrap();
        let intent = cart.abandon(party, actor).unwrap();
        assert!(matches!(intent.state, IntentState::Abandoned));
        assert!(!intent.history.is_empty());
    }

    #[test]
    fn abandoned_intent_history_has_two_entries() {
        // The opening (created) marker + the Active → Abandoned transition.
        let cart = empty_cart();
        let party = cart.customer_id.to_party_id();
        let actor = PartyID::new("system_warp").unwrap();
        let intent = cart.abandon(party, actor).unwrap();
        assert_eq!(intent.history.len(), 2);
        assert!(matches!(intent.history[1].to, IntentState::Abandoned));
    }

    #[test]
    fn language_arabic_to_bcp47() {
        assert_eq!(Language::Arabic.to_bcp47(), "ar");
        assert_eq!(Language::French.to_bcp47(), "fr");
        assert_eq!(Language::English.to_bcp47(), "en");
        assert_eq!(Language::Darija.to_bcp47(), "zgh");
    }

    #[test]
    fn language_darija_bcp47_roundtrip() {
        let code = Language::Darija.to_bcp47();
        assert_eq!(Language::from_bcp47(code), Some(Language::Darija));
    }

    #[test]
    fn language_from_bcp47_case_variants() {
        assert_eq!(Language::from_bcp47("ar-MA"), Some(Language::Arabic));
        assert_eq!(Language::from_bcp47("fr-FR"), Some(Language::French));
        assert_eq!(Language::from_bcp47("en-GB"), Some(Language::English));
        assert_eq!(Language::from_bcp47("zgh-MA"), Some(Language::Darija));
        assert_eq!(Language::from_bcp47("xx"), None);
    }

    #[test]
    fn outbound_channel_serializes_as_before() {
        // Backward compat: the rename to OutboundChannel must not change the
        // wire form, and the `Channel` alias must still resolve.
        assert_eq!(
            serde_json::to_string(&OutboundChannel::WhatsApp).unwrap(),
            "\"WhatsApp\""
        );
        let via_alias: Channel = Channel::FCM;
        assert_eq!(serde_json::to_string(&via_alias).unwrap(), "\"FCM\"");
    }

    #[test]
    fn engagement_channel_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&EngagementChannel::Web).unwrap(),
            "\"web\""
        );
        assert_eq!(
            serde_json::to_string(&EngagementChannel::Voice).unwrap(),
            "\"voice\""
        );
        let back: EngagementChannel = serde_json::from_str("\"agent\"").unwrap();
        assert!(matches!(back, EngagementChannel::Agent));
    }

    #[test]
    fn occasion_corporate_serializes_to_corporate() {
        assert_eq!(
            serde_json::to_string(&Occasion::Corporate).unwrap(),
            "\"corporate\""
        );
        let back: Occasion = serde_json::from_str("\"corporate\"").unwrap();
        assert!(matches!(back, Occasion::Corporate));
    }

    #[test]
    fn occasion_all_variants_serialize_deserialize() {
        for occ in [
            Occasion::Birthday,
            Occasion::Anniversary,
            Occasion::Eid,
            Occasion::Ramadan,
            Occasion::MothersDay,
            Occasion::ValentinesDay,
            Occasion::WeddingAnniversary,
            Occasion::Corporate,
            Occasion::Custom("mawazine_festival".to_string()),
        ] {
            let json = serde_json::to_string(&occ).unwrap();
            let back: Occasion = serde_json::from_str(&json).unwrap();
            assert_eq!(occ, back, "occasion did not round-trip: {json}");
        }
    }
}
