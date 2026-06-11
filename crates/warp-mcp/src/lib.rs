//! Warp MCP server — library half.
//!
//! Exposes Warp's workflow management surface as
//! [Model Context Protocol](https://modelcontextprotocol.io/) tools so
//! any MCP-compatible AI agent (Claude, GPT, etc.) can generate
//! workflows, install templates, and check executions on behalf of
//! merchants without bespoke API glue.
//!
//! The binary half lives in `src/main.rs` and does nothing more than
//! parse a few env vars and call [`server::run`]. Splitting the library
//! out lets the tests drive [`tools`] + [`server::handle_request`]
//! directly without spawning a process.
//!
//! ## Wire shape
//!
//! Standard MCP stdio: one JSON-RPC 2.0 message per line on stdin,
//! one response per line on stdout. Three methods are recognized:
//!
//!   - `initialize`        → returns server info + capabilities
//!   - `tools/list`        → returns the four tools (see [`tools::list_tools`])
//!   - `tools/call`        → dispatches to one of the four tool impls
//!
//! Every other method returns a JSON-RPC `-32601` ("Method not found")
//! error. The MCP spec requires that the server keeps responding to
//! `notifications/*` (which carry no `id` and expect no response); for
//! v0.1 we treat them as no-ops and stay in the loop.
//!
//! ## Auth
//!
//! None. The MCP server is meant to run inside the same trust boundary
//! as warp-server itself (typically a local desktop or a Lamar-Tech-
//! operated host). Phase 3 will add a bearer-token mechanism aligned
//! with whatever the management API picks for its own auth surface.

pub mod commerce;
pub mod server;
pub mod tools;

/// Public server name string. Returned in `initialize`, included in
/// log lines, and matched against by integration tests.
pub const SERVER_NAME: &str = "warp-mcp";

/// Public server version string. Tracks the workspace version so an
/// MCP client can pin against a known Warp release.
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// MCP protocol version we implement. Matches the published spec we
/// were tested against — this is what gets reflected back in the
/// `initialize` response.
pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
