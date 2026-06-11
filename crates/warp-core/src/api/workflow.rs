//! Workflow + execution API types.
//!
//! `InstallTemplate*` is the surface a tenant calls to spin up a
//! pre-built workflow from the catalog template registry. The
//! installer reads `template_id`, looks it up in
//! `warp_catalog::templates::TEMPLATE_REGISTRY`, calls the template's
//! `install()` method with the supplied `config` blob, and stores the
//! resulting [`crate::templates::WorkflowConfig`] under the tenant.
//!
//! `ExecutionSummary` is what the dashboard reads back to surface
//! "what ran, when, for whom, was it billed?" The shape is intentionally
//! flat — list views, search, and CSV export are all served by it.

use serde::{Deserialize, Serialize};

use crate::types::commerce::TenantId;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallTemplateRequest {
    pub tenant_id: TenantId,
    pub template_id: String,
    /// Template-specific parameters. Shape matches the template's
    /// `default_for()` / installer struct. Validated by the installer
    /// before a `WorkflowConfig` is materialized.
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallTemplateResponse {
    pub workflow_id: String,
    pub template_id: String,
    pub tenant_id: TenantId,
    pub status: WorkflowStatus,
    /// ISO 8601 timestamp of the install.
    pub installed_at: String,
}

/// Lifecycle state of a workflow installed for a tenant.
///
/// `Error(reason)` carries the human-readable cause — surfaced to the
/// merchant on the canvas. The String is the message ops would post in
/// a Slack channel: "Postgres failed to connect during template
/// install"; the canvas renders it directly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", content = "reason", rename_all = "snake_case")]
pub enum WorkflowStatus {
    Active,
    Paused,
    Draft,
    Error(String),
}

/// One execution of a workflow — a single chain run. The dashboard
/// shows a paginated list of these; billing rolls them up by
/// `billing_units`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionSummary {
    pub execution_id: String,
    pub workflow_id: String,
    pub tenant_id: TenantId,
    pub status: ExecutionStatus,
    pub billing_units: u32,
    /// ISO 8601.
    pub started_at: String,
    /// `None` while the execution is still running or paused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", content = "reason", rename_all = "snake_case")]
pub enum ExecutionStatus {
    Running,
    Completed,
    Failed(String),
    /// Waiting on a `HumanQuery` (vendor approval, leave request, etc.).
    /// Phase 3 surfaces these to the merchant for resolution.
    Paused,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_template_request_round_trips_through_json() {
        let req = InstallTemplateRequest {
            tenant_id: TenantId::new("tenant_aimer"),
            template_id: "cart_recovery_v1".to_string(),
            config: serde_json::json!({
                "min_cart_value_mad": 200,
                "delay_minutes": 30,
                "follow_up_delay_hours": 24,
                "acp_base_url": "https://acp.aimer.ma",
                "mock_mode": true
            }),
        };
        let json = serde_json::to_string(&req).unwrap();
        let back: InstallTemplateRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req, back);
    }

    #[test]
    fn install_template_response_round_trips_with_status() {
        let resp = InstallTemplateResponse {
            workflow_id: "wf_01HZ7Z3...".to_string(),
            template_id: "cart_recovery_v1".to_string(),
            tenant_id: TenantId::new("tenant_aimer"),
            status: WorkflowStatus::Active,
            installed_at: "2026-05-25T12:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let back: InstallTemplateResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn workflow_status_error_round_trips_with_reason() {
        let s = WorkflowStatus::Error("ACP base URL unreachable".to_string());
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["state"], "error");
        assert_eq!(json["reason"], "ACP base URL unreachable");
        let back: WorkflowStatus = serde_json::from_value(json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn execution_summary_with_completed_at_none_serializes_cleanly() {
        let s = ExecutionSummary {
            execution_id: "exec_01HZ8...".to_string(),
            workflow_id: "wf_01HZ7Z3...".to_string(),
            tenant_id: TenantId::new("tenant_aimer"),
            status: ExecutionStatus::Running,
            billing_units: 6,
            started_at: "2026-05-25T12:00:00Z".to_string(),
            completed_at: None,
        };
        let json = serde_json::to_value(&s).unwrap();
        // `completed_at` is omitted, not serialized as null.
        assert!(json.get("completed_at").is_none(), "got json = {}", json);
        let back: ExecutionSummary = serde_json::from_value(json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn execution_status_failed_round_trips_with_reason() {
        let s = ExecutionStatus::Failed("ACP timeout after 30s".to_string());
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["state"], "failed");
        assert_eq!(json["reason"], "ACP timeout after 30s");
        let back: ExecutionStatus = serde_json::from_value(json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn execution_status_unit_variants_serialize_snake_case() {
        let running = serde_json::to_value(ExecutionStatus::Running).unwrap();
        assert_eq!(running["state"], "running");
        let completed = serde_json::to_value(ExecutionStatus::Completed).unwrap();
        assert_eq!(completed["state"], "completed");
        let paused = serde_json::to_value(ExecutionStatus::Paused).unwrap();
        assert_eq!(paused["state"], "paused");
    }
}
