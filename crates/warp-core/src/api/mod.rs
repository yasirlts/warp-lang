//! Public API surface for the merchant-facing HTTP layer.
//!
//! Phase 2 session 3 ships the *types* only. The HTTP routes that
//! consume them — `POST /v1/tenants`, `POST /v1/workflows/install`,
//! `GET /v1/workflows/{id}/executions` — land in the next session
//! inside `warp-server`. Keeping the request/response shapes in
//! `warp-core` means the canvas, the CLI, and the eventual SDK can
//! depend on them without pulling in the Restate runtime.
//!
//! Every type here is `Serialize + Deserialize` and goes through a
//! serde round-trip test so the JSON wire format is the single source
//! of truth for the API contract.

pub mod merchant;
pub mod workflow;

pub use merchant::{
    AdapterType, CreateTenantRequest, CreateTenantResponse, PlatformConfig, TenantStatus,
};
pub use workflow::{
    ExecutionStatus, ExecutionSummary, InstallTemplateRequest, InstallTemplateResponse,
    WorkflowStatus,
};
