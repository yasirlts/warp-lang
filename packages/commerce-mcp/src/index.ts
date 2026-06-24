/**
 * Entry point: run the Warp commerce-integrity MCP server over stdio.
 *
 * stdio is the simplest transport and works with local MCP hosts (Claude
 * Desktop, Cursor, VS Code). The server reads JSON-RPC from stdin and writes to
 * stdout, so nothing else may be written to stdout — diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWarpMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const server = createWarpMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the JSON-RPC channel.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio`);
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
