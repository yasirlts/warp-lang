//! `warp-mcp` — Model Context Protocol server binary.
//!
//! Reads JSON-RPC 2.0 requests from stdin (one per line), dispatches
//! them through [`warp_mcp::server::handle_request`], writes responses
//! to stdout. See the crate docs for the wire shape and the four tools
//! exposed.
//!
//! ## Configuration
//!
//! - `WARP_MANAGEMENT_URL` — base URL of the warp-server management
//!   API. Defaults to `http://localhost:8081`.
//! - `RUST_LOG` — standard tracing filter. Logs go to **stderr** so
//!   they never interleave with JSON-RPC responses on stdout.
//!
//! Returns process exit code 0 on a clean EOF (stdin closed by the
//! parent MCP client), non-zero only on irrecoverable I/O errors.

use warp_mcp::server;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // Logs go to stderr so they don't corrupt the JSON-RPC stream on
    // stdout. MCP clients parse stdout line-by-line and will choke on
    // anything that isn't a JSON object.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "warp_mcp=info".into()),
        )
        .init();

    let base_url = std::env::var("WARP_MANAGEMENT_URL")
        .unwrap_or_else(|_| "http://localhost:8081".to_string());

    // Commerce-advisor tools (validate/explain/suggest/translate) need an
    // Anthropic key. The workflow-management tools do not — surface the
    // posture at startup so an operator sees why the advisor tools error.
    let advisor_enabled = std::env::var("ANTHROPIC_API_KEY")
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false);
    if advisor_enabled {
        tracing::info!("warp-mcp: ANTHROPIC_API_KEY set — commerce-advisor tools enabled");
    } else {
        tracing::warn!(
            "warp-mcp: ANTHROPIC_API_KEY not set — commerce-advisor tools \
             (warp_validate_commerce_code, warp_explain_commerce_type, \
             warp_suggest_commerce_pattern, warp_translate_platform_code) will return a \
             configuration error; workflow-management tools work normally"
        );
    }

    tracing::info!(
        server_name = warp_mcp::SERVER_NAME,
        server_version = warp_mcp::SERVER_VERSION,
        protocol_version = warp_mcp::MCP_PROTOCOL_VERSION,
        management_url = base_url.as_str(),
        "warp-mcp: starting stdio JSON-RPC loop"
    );

    server::run(&base_url).await
}
