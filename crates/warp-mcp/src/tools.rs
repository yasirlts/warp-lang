//! Tool catalog + dispatch.
//!
//! Four tools surface Warp's workflow management to MCP-compatible
//! agents. Each tool is a thin proxy to the warp-server management API
//! on port 8081 — the MCP layer adds no business logic of its own. The
//! `inputSchema` block on every tool follows JSON Schema draft 7 so
//! Claude (and other MCP clients) can render the tool's parameters
//! before calling.
//!
//! ## Why proxy rather than link in
//!
//! warp-mcp deliberately avoids depending on warp-catalog or
//! warp-storage. The management API is the public contract the MCP
//! server speaks; if a future Warp release moves storage to a different
//! backend, the MCP server doesn't need to know. The dependency line
//! reads `warp-mcp → HTTP → warp-server`, nothing more.

use serde_json::{json, Value};

use crate::server::ERROR_INVALID_PARAMS;

/// JSON Schema fragment for a free-form object input — used for the
/// optional `config` field on `warp_install_workflow`. We don't lock
/// it down further because each template has its own param shape and
/// the dashboard / agent should be able to pass any of them.
fn object_schema() -> Value {
    json!({ "type": "object", "additionalProperties": true })
}

/// Return the list of tools the server exposes. Shape matches the MCP
/// spec's `tools/list` response: a top-level `tools` array, each entry
/// carrying `name`, `description`, and `inputSchema`.
pub fn list_tools() -> Value {
    let mut listing = json!({
        "tools": [
            {
                "name": "warp_generate_workflow",
                "description": "Generate a Warp commerce workflow from a natural \
                    language description. Supports Arabic, French, and English.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tenant_id":   { "type": "string", "description": "Tenant identifier the workflow will be installed against." },
                        "description": { "type": "string", "description": "Free-text description of the workflow to build." },
                        "mock_mode":   { "type": "boolean", "description": "Force mock mode (no Anthropic API call). Defaults to true so MCP clients without an API budget still get a working sample.", "default": true }
                    },
                    "required": ["tenant_id", "description"]
                }
            },
            {
                "name": "warp_install_workflow",
                "description": "Install a workflow template for a merchant tenant.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tenant_id":   { "type": "string", "description": "Tenant the template is installed for." },
                        "template_id": { "type": "string", "description": "Template id from the catalog — currently 'cart_recovery_v1' or 'post_purchase_v1'." },
                        "config":      object_schema()
                    },
                    "required": ["tenant_id", "template_id"]
                }
            },
            {
                "name": "warp_list_executions",
                "description": "List recent workflow executions for a tenant.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tenant_id": { "type": "string", "description": "Tenant whose executions to list." },
                        "limit":     { "type": "integer", "description": "Maximum number of executions to return. Defaults to 10.", "default": 10, "minimum": 1, "maximum": 100 }
                    },
                    "required": ["tenant_id"]
                }
            },
            {
                "name": "warp_check_execution",
                "description": "Check the status of a specific workflow execution.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "execution_id": { "type": "string", "description": "Execution identifier returned by warp_list_executions or the install endpoint." },
                        "tenant_id":    { "type": "string", "description": "Tenant the execution belongs to — required for RLS isolation on the lookup." }
                    },
                    "required": ["execution_id", "tenant_id"]
                }
            }
        ]
    });
    // Phase 3: append the commerce-advisor tools (validate / explain /
    // suggest / translate) to the four workflow-management tools above.
    if let Some(arr) = listing["tools"].as_array_mut() {
        arr.extend(crate::commerce::commerce_tool_defs());
    }
    listing
}

/// Dispatch a `tools/call` request. `params` is the raw JSON-RPC
/// `params` object — it carries `name` (tool name) and `arguments`
/// (tool input). The return value is the MCP `result` payload (with
/// `content` array, per the protocol); errors propagate up to the
/// caller as JSON-RPC errors.
pub async fn call_tool(
    client: &reqwest::Client,
    base_url: &str,
    params: &Value,
) -> Result<Value, ToolError> {
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or_else(|| ToolError::InvalidParams("tools/call: missing 'name'".to_string()))?;
    let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);

    let result = match name {
        "warp_generate_workflow" => generate_workflow(client, base_url, &arguments).await?,
        "warp_install_workflow" => install_workflow(client, base_url, &arguments).await?,
        "warp_list_executions" => list_executions(client, base_url, &arguments).await?,
        "warp_check_execution" => check_execution(client, base_url, &arguments).await?,
        other => match crate::commerce::dispatch(client, other, &arguments).await {
            Some(result) => result?,
            None => return Err(ToolError::UnknownTool(other.to_string())),
        },
    };

    // MCP wraps every tool result in a `content` array of typed parts.
    // Warp's tools return structured JSON; the convention is to
    // stringify it under a `text` part. Clients render the text or
    // re-parse depending on context.
    Ok(json!({
        "content": [
            { "type": "text", "text": serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string()) }
        ],
        "structuredContent": result
    }))
}

#[derive(Debug)]
pub enum ToolError {
    InvalidParams(String),
    UnknownTool(String),
    UpstreamHttp(String),
    UpstreamStatus {
        status: u16,
        body: String,
    },
    /// A commerce-advisor tool was called but `ANTHROPIC_API_KEY` is unset.
    MissingApiKey,
    /// The commerce advisor's response could not be used (non-JSON, etc.).
    AdvisorError(String),
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolError::InvalidParams(s) => write!(f, "invalid params: {}", s),
            ToolError::UnknownTool(s) => write!(f, "unknown tool: {}", s),
            ToolError::UpstreamHttp(s) => write!(f, "upstream HTTP error: {}", s),
            ToolError::UpstreamStatus { status, body } => {
                write!(f, "upstream returned HTTP {}: {}", status, body)
            }
            ToolError::MissingApiKey => write!(
                f,
                "Commerce advisor tools require ANTHROPIC_API_KEY. Set this environment \
                 variable to enable warp_validate_commerce_code and related tools."
            ),
            ToolError::AdvisorError(s) => write!(f, "commerce advisor error: {}", s),
        }
    }
}

impl std::error::Error for ToolError {}

impl From<&ToolError> for i32 {
    fn from(e: &ToolError) -> i32 {
        match e {
            ToolError::InvalidParams(_) | ToolError::UnknownTool(_) => ERROR_INVALID_PARAMS,
            _ => crate::server::ERROR_INTERNAL,
        }
    }
}

// ---------------------------------------------------------------------------
// Tool 1: warp_generate_workflow
// ---------------------------------------------------------------------------

/// Build the JSON body warp_generate_workflow proxies to
/// `POST /api/v1/ai-builder/generate`. Pure function so the request
/// shape is unit-testable without spinning up an HTTP listener.
pub fn build_generate_request(arguments: &Value) -> Result<Value, ToolError> {
    let tenant_id = arguments
        .get("tenant_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidParams("tenant_id is required".to_string()))?;
    let description = arguments
        .get("description")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidParams("description is required".to_string()))?;
    // Default to mock_mode=true so an MCP client without an Anthropic
    // budget still gets a working sample. Production agents pass
    // false explicitly.
    let mock_mode = arguments
        .get("mock_mode")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    Ok(json!({
        "tenant_id": tenant_id,
        "description": description,
        "mock_mode": mock_mode,
    }))
}

async fn generate_workflow(
    client: &reqwest::Client,
    base_url: &str,
    arguments: &Value,
) -> Result<Value, ToolError> {
    let body = build_generate_request(arguments)?;
    let url = format!(
        "{}/api/v1/ai-builder/generate",
        base_url.trim_end_matches('/')
    );
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| ToolError::UpstreamHttp(e.to_string()))?;
    parse_json_response(resp).await
}

// ---------------------------------------------------------------------------
// Tool 2: warp_install_workflow
// ---------------------------------------------------------------------------

/// Build the JSON body warp_install_workflow proxies to
/// `POST /api/v1/workflows/install`. The management API expects
/// `config` to be an object (it gets merged with the tenant id) — we
/// default it to `{}` if the MCP caller omits it.
pub fn build_install_request(arguments: &Value) -> Result<Value, ToolError> {
    let tenant_id = arguments
        .get("tenant_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidParams("tenant_id is required".to_string()))?;
    let template_id = arguments
        .get("template_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidParams("template_id is required".to_string()))?;
    let config = arguments
        .get("config")
        .cloned()
        .unwrap_or_else(|| json!({}));

    Ok(json!({
        "tenant_id": tenant_id,
        "template_id": template_id,
        "config": config,
    }))
}

async fn install_workflow(
    client: &reqwest::Client,
    base_url: &str,
    arguments: &Value,
) -> Result<Value, ToolError> {
    let body = build_install_request(arguments)?;
    let url = format!(
        "{}/api/v1/workflows/install",
        base_url.trim_end_matches('/')
    );
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| ToolError::UpstreamHttp(e.to_string()))?;
    parse_json_response(resp).await
}

// ---------------------------------------------------------------------------
// Tool 3: warp_list_executions
// ---------------------------------------------------------------------------

/// Build the URL warp_list_executions proxies to. The management API
/// returns an unpaginated list of up to 100 rows; the MCP caller-side
/// `limit` is enforced by slicing the response client-side.
pub fn build_list_executions_url(base_url: &str, arguments: &Value) -> Result<String, ToolError> {
    let tenant_id = arguments
        .get("tenant_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidParams("tenant_id is required".to_string()))?;
    Ok(format!(
        "{}/api/v1/executions/{}",
        base_url.trim_end_matches('/'),
        tenant_id
    ))
}

async fn list_executions(
    client: &reqwest::Client,
    base_url: &str,
    arguments: &Value,
) -> Result<Value, ToolError> {
    let url = build_list_executions_url(base_url, arguments)?;
    let limit = arguments
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(10) as usize;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| ToolError::UpstreamHttp(e.to_string()))?;
    let body = parse_json_response(resp).await?;
    let truncated = match body.as_array() {
        Some(arr) => Value::Array(arr.iter().take(limit).cloned().collect()),
        None => body,
    };
    Ok(truncated)
}

// ---------------------------------------------------------------------------
// Tool 4: warp_check_execution
// ---------------------------------------------------------------------------

/// Build the URL warp_check_execution proxies to. v0.1's management
/// API has no per-execution endpoint, so we go through the list and
/// filter client-side; the tool surface stays stable when a dedicated
/// route lands.
pub fn build_check_execution_url(base_url: &str, arguments: &Value) -> Result<String, ToolError> {
    let _execution_id = arguments
        .get("execution_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidParams("execution_id is required".to_string()))?;
    let tenant_id = arguments
        .get("tenant_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidParams("tenant_id is required".to_string()))?;
    Ok(format!(
        "{}/api/v1/executions/{}",
        base_url.trim_end_matches('/'),
        tenant_id
    ))
}

async fn check_execution(
    client: &reqwest::Client,
    base_url: &str,
    arguments: &Value,
) -> Result<Value, ToolError> {
    let url = build_check_execution_url(base_url, arguments)?;
    let execution_id = arguments
        .get("execution_id")
        .and_then(|v| v.as_str())
        .expect("validated by build_check_execution_url");

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| ToolError::UpstreamHttp(e.to_string()))?;
    let body = parse_json_response(resp).await?;

    if let Some(arr) = body.as_array() {
        for entry in arr {
            if entry.get("execution_id").and_then(|v| v.as_str()) == Some(execution_id) {
                return Ok(entry.clone());
            }
        }
        return Ok(json!({
            "execution_id": execution_id,
            "status": "not_found",
            "message": "no execution with that id exists for this tenant"
        }));
    }
    Ok(body)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async fn parse_json_response(resp: reqwest::Response) -> Result<Value, ToolError> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| ToolError::UpstreamHttp(e.to_string()))?;
    if !status.is_success() {
        return Err(ToolError::UpstreamStatus {
            status: status.as_u16(),
            body: text,
        });
    }
    // Empty bodies are valid (e.g. 204 No Content from a future
    // endpoint). Treat them as `null`.
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| ToolError::UpstreamHttp(format!("invalid json: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `tools/list` must return exactly four tools and every tool must
    /// carry name + description + inputSchema. MCP clients fail-closed
    /// on a missing description, so this guards against accidental
    /// regressions in the catalog.
    #[test]
    fn mcp_tools_list_returns_all_tools() {
        let listing = list_tools();
        let tools = listing["tools"].as_array().expect("tools must be an array");
        assert_eq!(
            tools.len(),
            8,
            "expected 8 tools (4 workflow + 4 commerce advisor), got {}",
            tools.len()
        );
        let expected_names = [
            // workflow-management tools (unchanged)
            "warp_generate_workflow",
            "warp_install_workflow",
            "warp_list_executions",
            "warp_check_execution",
            // commerce-advisor tools (Phase 3)
            "warp_validate_commerce_code",
            "warp_explain_commerce_type",
            "warp_suggest_commerce_pattern",
            "warp_translate_platform_code",
        ];
        for expected in &expected_names {
            let found = tools
                .iter()
                .find(|t| t["name"].as_str() == Some(*expected))
                .unwrap_or_else(|| panic!("missing tool {}", expected));
            assert!(
                !found["description"].as_str().unwrap_or("").is_empty(),
                "tool {} has empty description",
                expected
            );
            assert!(
                found["inputSchema"].is_object(),
                "tool {} has no inputSchema object",
                expected
            );
            assert_eq!(
                found["inputSchema"]["type"], "object",
                "tool {} inputSchema.type must be 'object'",
                expected
            );
            assert!(
                found["inputSchema"]["required"].is_array(),
                "tool {} inputSchema.required must be an array",
                expected
            );
        }
    }

    /// The body warp_generate_workflow forwards must carry the three
    /// fields the AI builder endpoint expects, with mock_mode defaulted
    /// to true. The endpoint accepts the request shape iff serde sees
    /// these exact field names — pin them.
    #[test]
    fn mcp_tool_generate_workflow_request_shape() {
        let arguments = json!({
            "tenant_id": "tenant_aimer_prod_001",
            "description": "Send a WhatsApp 30 min after cart abandonment"
        });
        let body = build_generate_request(&arguments).expect("must build");
        assert_eq!(body["tenant_id"], "tenant_aimer_prod_001");
        assert_eq!(
            body["description"],
            "Send a WhatsApp 30 min after cart abandonment"
        );
        assert_eq!(
            body["mock_mode"], true,
            "mock_mode must default to true when the MCP caller omits it"
        );

        // Explicit override honored.
        let with_override = build_generate_request(&json!({
            "tenant_id": "t",
            "description": "d",
            "mock_mode": false
        }))
        .expect("must build");
        assert_eq!(with_override["mock_mode"], false);

        // Missing tenant_id surfaces an InvalidParams.
        let err = build_generate_request(&json!({ "description": "d" }))
            .expect_err("missing tenant_id must error");
        assert!(matches!(err, ToolError::InvalidParams(_)));
    }

    /// The body warp_install_workflow forwards must carry tenant_id,
    /// template_id, and a `config` object (defaulted to `{}` if
    /// omitted) — the install handler refuses anything else.
    #[test]
    fn mcp_tool_install_workflow_request_shape() {
        let arguments = json!({
            "tenant_id": "tenant_aimer_prod_001",
            "template_id": "cart_recovery_v1",
            "config": { "min_cart_value_mad": 200, "delay_minutes": 30 }
        });
        let body = build_install_request(&arguments).expect("must build");
        assert_eq!(body["tenant_id"], "tenant_aimer_prod_001");
        assert_eq!(body["template_id"], "cart_recovery_v1");
        assert_eq!(body["config"]["min_cart_value_mad"], 200);

        // Omitted config defaults to an empty object — never null, so
        // the install handler's `merge_tenant_into_config` sees an
        // object it can insert into.
        let minimal = build_install_request(&json!({
            "tenant_id": "t",
            "template_id": "post_purchase_v1"
        }))
        .expect("must build");
        assert_eq!(minimal["config"], json!({}));
    }

    /// `warp_list_executions` and `warp_check_execution` both route
    /// through `/api/v1/executions/{tenant_id}` on the management API.
    /// Pin the path so a refactor surfaces here, not in a manual probe.
    #[test]
    fn mcp_tool_executions_url_shape() {
        let url = build_list_executions_url(
            "http://localhost:8081",
            &json!({ "tenant_id": "tenant_aimer" }),
        )
        .expect("must build");
        assert_eq!(url, "http://localhost:8081/api/v1/executions/tenant_aimer");

        // Trailing slash on the base URL is tolerated.
        let url_with_slash = build_list_executions_url(
            "http://localhost:8081/",
            &json!({ "tenant_id": "tenant_aimer" }),
        )
        .expect("must build");
        assert_eq!(
            url_with_slash,
            "http://localhost:8081/api/v1/executions/tenant_aimer"
        );

        let check_url = build_check_execution_url(
            "http://localhost:8081",
            &json!({ "execution_id": "exec_abc", "tenant_id": "tenant_aimer" }),
        )
        .expect("must build");
        assert_eq!(
            check_url,
            "http://localhost:8081/api/v1/executions/tenant_aimer"
        );

        // execution_id is required even though it doesn't appear in the
        // URL — the tool uses it to filter the list response.
        let err = build_check_execution_url(
            "http://localhost:8081",
            &json!({ "tenant_id": "tenant_aimer" }),
        )
        .expect_err("missing execution_id must error");
        assert!(matches!(err, ToolError::InvalidParams(_)));
    }
}
