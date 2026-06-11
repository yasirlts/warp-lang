//! MCP JSON-RPC server loop + request dispatch.
//!
//! The stdio loop and the per-request dispatch are split deliberately:
//! [`run`] owns the I/O, [`handle_request`] owns the protocol. Tests
//! drive [`handle_request`] directly with a synthetic `reqwest::Client`
//! base URL and never touch stdio.

use serde_json::{json, Value};

use crate::{tools, MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION};

/// JSON-RPC error code for "Method not found" per the JSON-RPC 2.0
/// spec. We surface this for any method outside the three MCP methods
/// we implement.
pub const ERROR_METHOD_NOT_FOUND: i32 = -32601;

/// JSON-RPC error code for "Invalid params" — surfaced when a known
/// method receives a malformed `params` object (e.g. a `tools/call`
/// missing `name`).
pub const ERROR_INVALID_PARAMS: i32 = -32602;

/// JSON-RPC error code for "Internal error" — surfaced for everything
/// that doesn't have a more specific code (e.g. a failed HTTP call to
/// the warp-server management API).
pub const ERROR_INTERNAL: i32 = -32603;

/// Read JSON-RPC requests from stdin, dispatch each one, write the
/// response to stdout. Loops until EOF on stdin. Returns Ok on a clean
/// shutdown; surfaces only fatal I/O errors.
pub async fn run(base_url: &str) -> std::io::Result<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut stdout = tokio::io::stdout();
    let mut line = String::new();

    let client = reqwest::Client::new();

    loop {
        line.clear();
        let bytes = reader.read_line(&mut line).await?;
        if bytes == 0 {
            tracing::info!("warp-mcp: stdin EOF — shutting down cleanly");
            return Ok(());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                // Per JSON-RPC, malformed JSON has no recoverable `id`.
                // Reply with `null` so the client at least sees the
                // parse-error code.
                let resp = error_response(Value::Null, -32700, &format!("parse error: {}", e));
                write_response(&mut stdout, &resp).await?;
                continue;
            }
        };

        let response = handle_request(&client, base_url, request).await;
        if let Some(resp) = response {
            write_response(&mut stdout, &resp).await?;
        }
    }
}

async fn write_response<W>(stdout: &mut W, response: &Value) -> std::io::Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    let serialized = serde_json::to_string(response)
        .unwrap_or_else(|_| r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"failed to serialize response"}}"#.to_string());
    stdout.write_all(serialized.as_bytes()).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

/// Dispatch one JSON-RPC request. Returns `None` for notifications
/// (no `id` field) per the JSON-RPC spec — the loop must not write a
/// response in that case. Returns `Some(response_value)` otherwise.
///
/// `client` is reused so that connection pooling kicks in across many
/// tool invocations against the same management API host. Test callers
/// can build a default `reqwest::Client` and use a non-routable
/// `base_url`; tests that check shapes never actually fire the HTTP
/// call.
pub async fn handle_request(
    client: &reqwest::Client,
    base_url: &str,
    request: Value,
) -> Option<Value> {
    let id = request.get("id").cloned();
    let is_notification = id.is_none();
    // For responses we echo back whatever the client sent; for
    // notifications we still build a value for tracing but never emit.
    let response_id = id.clone().unwrap_or(Value::Null);

    let method = match request.get("method").and_then(|m| m.as_str()) {
        Some(m) => m.to_string(),
        None => {
            if is_notification {
                return None;
            }
            return Some(error_response(
                response_id,
                ERROR_INVALID_PARAMS,
                "missing 'method' field",
            ));
        }
    };

    let params = request.get("params").cloned().unwrap_or(Value::Null);

    let result = match method.as_str() {
        "initialize" => Ok(server_info()),
        "initialized" | "notifications/initialized" => {
            // Notification — no response per JSON-RPC.
            return None;
        }
        "tools/list" => Ok(tools::list_tools()),
        "tools/call" => match tools::call_tool(client, base_url, &params).await {
            Ok(v) => Ok(v),
            Err(e) => Err((ERROR_INTERNAL, e.to_string())),
        },
        other => Err((
            ERROR_METHOD_NOT_FOUND,
            format!("method not found: {}", other),
        )),
    };

    if is_notification {
        // Defensive: a method other than the documented notifications
        // arrived without an `id`. Treat as notification per spec.
        return None;
    }

    match result {
        Ok(value) => Some(json!({
            "jsonrpc": "2.0",
            "id": response_id,
            "result": value,
        })),
        Err((code, message)) => Some(error_response(response_id, code, &message)),
    }
}

/// Build the `initialize` response. The shape follows the MCP spec —
/// `protocolVersion`, `capabilities`, and `serverInfo` are the
/// well-known fields a client checks before issuing `tools/list`.
pub fn server_info() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {
            "tools": { "listChanged": false }
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "version": SERVER_VERSION,
        },
    })
}

pub(crate) fn error_response(id: Value, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn client() -> reqwest::Client {
        reqwest::Client::new()
    }

    /// `initialize` returns server name `warp-mcp` and a version string
    /// so the MCP client can pin against a known Warp release.
    #[tokio::test]
    async fn mcp_initialize_returns_server_info() {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {}
        });
        let resp = handle_request(&client(), "http://nowhere", req)
            .await
            .expect("initialize must produce a response");
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 1);
        let server_info = &resp["result"]["serverInfo"];
        assert_eq!(server_info["name"], SERVER_NAME);
        assert_eq!(
            server_info["version"], SERVER_VERSION,
            "version field must mirror the crate version"
        );
        assert_eq!(resp["result"]["protocolVersion"], MCP_PROTOCOL_VERSION);
    }

    /// Unknown methods must produce a JSON-RPC error object with
    /// `code: -32601` ("Method not found") so an MCP client can
    /// distinguish a typo from a transport failure.
    #[tokio::test]
    async fn mcp_unknown_method_returns_error() {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "unknown/method",
            "params": {}
        });
        let resp = handle_request(&client(), "http://nowhere", req)
            .await
            .expect("unknown method must still produce a response");
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 42);
        assert_eq!(resp["error"]["code"], ERROR_METHOD_NOT_FOUND);
        assert!(
            resp["error"]["message"]
                .as_str()
                .unwrap()
                .contains("unknown/method"),
            "error message should name the offending method"
        );
    }

    /// JSON-RPC notifications (no `id`) must not produce a response.
    /// `notifications/initialized` is sent by every MCP client after a
    /// successful handshake — if we replied to it the client would see
    /// an unsolicited message and likely disconnect.
    #[tokio::test]
    async fn mcp_notification_initialized_produces_no_response() {
        let req = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        });
        let resp = handle_request(&client(), "http://nowhere", req).await;
        assert!(
            resp.is_none(),
            "notifications must never produce a response (got {:?})",
            resp
        );
    }
}
