//! Merchant onboarding API types.
//!
//! `CreateTenant*` is the surface a Warp operator (or a self-serve
//! signup flow) calls to register a new merchant. The response carries
//! the webhook URL the merchant configures on their commerce platform
//! — completing the loop from platform event → adapter → Warp trigger.

use serde::{Deserialize, Serialize};

use crate::types::commerce::{Platform, TenantId};

/// Onboarding request — register a merchant on a specific commerce
/// platform with the credentials Warp needs to talk to it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateTenantRequest {
    pub tenant_id: TenantId,
    pub platform: Platform,
    pub platform_config: PlatformConfig,
    /// Per-tenant ACP base URL override. Defaults to the global ACP
    /// endpoint when absent (most merchants share aimer.ma's ACP).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_base_url: Option<String>,
}

/// Credentials + base URL for the merchant's commerce platform. The
/// adapter is selected by [`AdapterType`]; the rest are optional
/// because a native [`AdapterType::Agora`] tenant needs neither a
/// webhook secret nor an API key (everything flows over the internal
/// event bus).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlatformConfig {
    pub adapter_type: AdapterType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// Which adapter to bind for this tenant. Mirrors
/// [`Platform`](crate::types::commerce::Platform) but distinguishes
/// `Custom(name)` for not-yet-built adapters (kept extensible so
/// onboarding doesn't gate on a code change).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
pub enum AdapterType {
    Agora,
    OpenCart,
    Shopify,
    WooCommerce,
    Custom(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateTenantResponse {
    pub tenant_id: TenantId,
    /// URL the merchant configures on their commerce platform's
    /// webhook settings. Carries the tenant in the path or query so
    /// inbound events route to the right Warp execution scope.
    pub webhook_url: String,
    pub status: TenantStatus,
    /// ISO 8601 timestamp of the create call.
    pub created_at: String,
    /// API key minted at tenant creation. Returned **once** in this
    /// response and never retrievable again (only a SHA-256 hash is
    /// stored server-side). `None` when storage isn't configured —
    /// dev mode leaves the field absent so the merchant onboarding
    /// flow still works without Postgres. Standard API-key pattern.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TenantStatus {
    Active,
    Pending,
    Suspended,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request() -> CreateTenantRequest {
        CreateTenantRequest {
            tenant_id: TenantId::new("tenant_aimer"),
            platform: Platform::Shopify,
            platform_config: PlatformConfig {
                adapter_type: AdapterType::Shopify,
                webhook_secret: Some("shpss_abc123".to_string()),
                api_key: None,
                base_url: Some("https://aimer.myshopify.com".to_string()),
            },
            acp_base_url: Some("https://acp.aimer.ma".to_string()),
        }
    }

    #[test]
    fn create_tenant_request_round_trips_through_json() {
        let req = sample_request();
        let json = serde_json::to_string(&req).unwrap();
        let back: CreateTenantRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req, back);
    }

    #[test]
    fn create_tenant_response_serializes_with_expected_status_string() {
        let resp = CreateTenantResponse {
            tenant_id: TenantId::new("tenant_aimer"),
            webhook_url: "https://warp.lamar.tech/v1/webhook/tenant_aimer".to_string(),
            status: TenantStatus::Active,
            created_at: "2026-05-25T12:00:00Z".to_string(),
            api_key: None,
        };
        let json = serde_json::to_value(&resp).unwrap();
        // snake_case discriminant — operators see "active", not "Active".
        assert_eq!(json["status"], serde_json::json!("active"));
        // api_key is omitted from JSON when absent (Option<String> +
        // skip_serializing_if). A response that carries one would
        // include "api_key": "warp_…" on the wire.
        assert!(json.get("api_key").is_none());
        let back: CreateTenantResponse = serde_json::from_value(json).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn create_tenant_response_serializes_api_key_when_present() {
        let resp = CreateTenantResponse {
            tenant_id: TenantId::new("tenant_aimer"),
            webhook_url: "/AgoraEventBridge/events".to_string(),
            status: TenantStatus::Active,
            created_at: "2026-05-26T22:23:45Z".to_string(),
            api_key: Some(
                "warp_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            ),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(
            json["api_key"],
            "warp_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        );
        let back: CreateTenantResponse = serde_json::from_value(json).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn tenant_status_variants_serialize_snake_case() {
        assert_eq!(
            serde_json::to_value(TenantStatus::Active).unwrap(),
            "active"
        );
        assert_eq!(
            serde_json::to_value(TenantStatus::Pending).unwrap(),
            "pending"
        );
        assert_eq!(
            serde_json::to_value(TenantStatus::Suspended).unwrap(),
            "suspended"
        );
    }

    #[test]
    fn adapter_type_custom_round_trips_with_name() {
        let custom = AdapterType::Custom("bigcommerce".to_string());
        let json = serde_json::to_value(&custom).unwrap();
        assert_eq!(json["kind"], "custom");
        assert_eq!(json["name"], "bigcommerce");
        let back: AdapterType = serde_json::from_value(json).unwrap();
        assert_eq!(back, custom);
    }

    #[test]
    fn adapter_type_known_variants_omit_name_field() {
        let agora = AdapterType::Agora;
        let json = serde_json::to_value(&agora).unwrap();
        assert_eq!(json["kind"], "agora");
        assert!(json.get("name").is_none());
        let back: AdapterType = serde_json::from_value(json).unwrap();
        assert_eq!(back, agora);
    }
}
