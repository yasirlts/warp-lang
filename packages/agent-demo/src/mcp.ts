/**
 * A thin client to the REAL Warp commerce-mcp server.
 *
 * The demo spawns the on-repo commerce-mcp server (its built stdio binary) and
 * talks to it over the actual MCP stdio transport. Warp's verdicts are computed
 * live by that server every run — in both real-LLM and replay modes. Nothing
 * here re-implements or stubs Warp's checks.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

/** Resolve the built commerce-mcp server entry (its `bin`), or fail clearly. */
function resolveServerEntry(): string {
  const pkgJson = require.resolve("@warp-lang/commerce-mcp/package.json");
  const entry = resolve(dirname(pkgJson), "dist/index.js");
  if (!existsSync(entry)) {
    throw new Error(
      `commerce-mcp server is not built at ${entry}. Build it first: ` +
        `(cd ../commerce-mcp && npm install && npm run build).`,
    );
  }
  return entry;
}

export interface WarpMcp {
  guardAction(world: unknown, action: unknown): Promise<any>;
  validTransitions(from: unknown): Promise<any>;
  listToolNames(): Promise<string[]>;
  close(): Promise<void>;
}

/** Connect to the real Warp MCP server over stdio. */
export async function connectWarp(): Promise<WarpMcp> {
  const transport = new StdioClientTransport({ command: "node", args: [resolveServerEntry()] });
  const client = new Client({ name: "warp-agent-demo", version: "0.1.0" });
  await client.connect(transport);

  function parse(result: any): any {
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") return result;
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: text, isError: Boolean(result?.isError) };
    }
  }

  return {
    async guardAction(world, action) {
      return parse(await client.callTool({ name: "guard_action", arguments: { world, action } }));
    },
    async validTransitions(from) {
      return parse(await client.callTool({ name: "valid_transitions", arguments: { from } }));
    },
    async listToolNames() {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    },
    async close() {
      await client.close();
    },
  };
}
