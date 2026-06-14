# warp-mcp — one example integration surface

`warp-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server
that exposes Warp to agent runtimes that speak MCP. It is **one example
integration surface, not the way to use Warp.**

## The provider-neutral path comes first

The universal, stack- and provider-neutral way to use Warp is the **frozen schema**
plus the **published packages** — no MCP server, no specific agent runtime, no
particular model vendor required:

- Schema (single source of truth): [`schema/`](../../schema/)
- Specification: [`spec/COMMERCE_MODEL.md`](../../spec/COMMERCE_MODEL.md)
- TypeScript / JavaScript: `npm install @warp-lang/commerce-types`
- Python: `pip install warp-commerce-types`

Any language can generate its own types from the schema and validate against the
same conformance fixtures. Any agent — Claude, GPT, Gemini, a local open model, or
a human — can import the packages directly. Start there. Reach for the MCP server
only when your agent runtime is already MCP-based and you want Warp surfaced as
tools.

For the rules an agent should follow when emitting commerce code, see
[`AGENTS.md`](../../AGENTS.md).

## What this server provides

The server speaks MCP over stdio (JSON-RPC) and proxies to a running
`warp-server`. It exposes **8 tools** in two groups.

**Workflow tools** (proxy to `warp-server`):

| Tool | Purpose |
|------|---------|
| `warp_generate_workflow` | Generate a `.warp` workflow from a natural-language description (AR / FR / EN). |
| `warp_install_workflow` | Install a workflow template for a tenant. |
| `warp_list_executions` | List recent workflow executions for a tenant. |
| `warp_check_execution` | Check the status of a specific execution. |

**Commerce-advisor tools** (semantic reasoning):

| Tool | Purpose |
|------|---------|
| `warp_validate_commerce_code` | Check code against the six invariants and return violations. |
| `warp_explain_commerce_type` | Explain a Warp commerce type. |
| `warp_suggest_commerce_pattern` | Suggest a modelling pattern for a commerce scenario. |
| `warp_translate_platform_code` | Translate platform-specific code into the Warp model. |

## Provider note — be honest about what is neutral

The **structural** value of Warp — the schema, the types, the transition tables,
the invariant checks — is fully provider-neutral and lives in the packages above.

The four **commerce-advisor** tools in this server do semantic reasoning the server
cannot do structurally, and in this implementation they call the **Anthropic
Messages API** to do it (model configurable via `WARP_ADVISOR_MODEL`, key via
`ANTHROPIC_API_KEY`). That is an implementation detail of this one server, not a
requirement of Warp: the same validation those tools perform is available
deterministically and provider-free through `auditCommerce` / `audit_commerce` and
the `checkI*` / `check_i*` functions in the packages. `warp_generate_workflow`
defaults to `mock_mode`, so the workflow tools are usable without any API budget.

If you do not want any third-party model call, use the packages and schema
directly — that path has no provider dependency at all.

## Run it

```bash
cargo build -p warp-mcp
cargo run   -p warp-mcp        # serves MCP over stdio; point your MCP client at it
```

Configure it in any MCP-capable client by registering the built binary as a stdio
server.
