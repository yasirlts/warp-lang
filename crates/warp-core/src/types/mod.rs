//! Warp's commerce type system.
//!
//! Per CLAUDE.md and C-01 (type safety is absolute), commerce nodes
//! never accept raw `String` where a typed alternative exists. Every
//! type in this module is a domain-modeled value: validated at the
//! boundary, then carried through workflows by type, not by string.
//!
//! Phase 1 ships [`commerce::Currency`] (MAD/EUR/USD),
//! [`commerce::PhoneNumber`] (E.164 + WhatsApp-routable flag), and
//! [`commerce::TenantId`] (ADR-0002 phase 1 execution-isolation key).
//!
//! Phase 2 adds the intelligence types ACP returns:
//! [`commerce::Language`], [`commerce::Channel`],
//! [`commerce::CustomerProfile`], [`commerce::StrategyRecommendation`].
//! Phase 2 session 2 adds the identifier + cart types:
//! [`commerce::OrderID`], [`commerce::CustomerID`],
//! [`commerce::CartItem`], [`commerce::CartState`].

pub mod commerce;

/// The five Warp Commerce Model primitives (Party, Intent, Commitment,
/// Fulfillment) and their state machines — the P1 "spine" from
/// `docs/WARP_TYPE_DERIVATION.md`. Additive to [`commerce`]; nothing there
/// is modified. See the module docs for the model mapping.
pub mod model;
