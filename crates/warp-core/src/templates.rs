//! Template-config primitive.
//!
//! A [`WorkflowConfig`] is what a catalog template produces when it is
//! installed for a merchant. It captures the template's identity (id +
//! version) so the merchant's running workflow stays pinned to the
//! template revision they installed (per ADR-0005), the tenant the
//! install belongs to, and an opaque JSON bag of template-specific
//! parameters (cart thresholds, delays, ACP URLs).
//!
//! Templates live in `warp-catalog` (they reference catalog nodes); the
//! [`WorkflowConfig`] type lives here in `warp-core` because every
//! tenant-bound execution surface — the merchant API, the canvas, the
//! installer — consumes it.

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

use crate::types::commerce::TenantId;

/// Produced by a template's `install()` method. Stored against a
/// tenant; consumed by the canvas / installer to materialize the
/// merchant's running workflow.
///
/// `template_id` and `version` are typed as `Cow<'static, str>` so a
/// template can construct one for free from its `&'static str`
/// constants while still being deserializable from arbitrary owned
/// strings on the API surface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowConfig {
    /// Stable catalog id of the template (e.g. `cart_recovery_v1`).
    pub template_id: Cow<'static, str>,
    /// ADR-0005 semver pin for the template revision.
    pub version: Cow<'static, str>,
    pub tenant_id: TenantId,
    /// Template-specific parameter blob. The schema is owned by the
    /// template itself; the installer round-trips this through JSON.
    pub params: serde_json::Value,
}
