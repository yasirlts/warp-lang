# @warp-lang/commerce-mcp

Warp's commerce-integrity guardrail, exposed as [Model Context Protocol](https://modelcontextprotocol.io) (MCP) tools.

Any MCP-capable agent can call these tools to check that a proposed commerce
action is **structurally coherent** — value is conserved, state moves are legal,
refunds and settlements reconcile, compensations are valid — **before** that
action flows onward to payment authorization or checkout.

This package is a **thin wrapper** over the published
[`@warp-lang/commerce-types`](https://www.npmjs.com/package/@warp-lang/commerce-types).
Every tool calls a published function and returns its verdict. No invariant or
guard logic is re-implemented here. The server **validates and returns verdicts**;
it does not execute payments, run checkout, settle funds, hold credentials, or
make network calls.

## Where Warp sits: beneath the agentic-commerce protocols

Warp is **complementary to**, and sits **beneath**, the payment and checkout
protocols. It answers a different question than they do:

| Layer | Question it answers | Examples |
| --- | --- | --- |
| Identity / authorization | *Who authorized this payment, and may they?* | AP2 |
| Checkout / execution | *Carry out the purchase / move the money.* | ACP, UCP |
| Transport | *How does the agent call a tool?* | MCP |
| **Structural integrity (Warp)** | *Is this action internally coherent commerce?* | **this package** |

Concretely: before a refund, settlement, or order action is **authorized** (AP2)
and **executed at checkout** (ACP/UCP), an agent can ask Warp's MCP tool whether
the action conserves value and is a legal state move. Warp catches an over-refund,
a settlement that does not reconcile, or an illegal state change as a structural
problem — independent of who authorized it or how it executes.

Warp does **not** do payment authorization, checkout execution, settlement, or
agent identity, and it is not a substitute for any of those protocols. It is the
integrity check that can run beneath them. (This describes an integration
capability on Warp's side only; it makes no claim that these protocols or their
maintainers have adopted, integrated, or recommended Warp.)

## Tools

Each tool takes an untrusted, agent-supplied input (validated server-side, see
[Security](#security-untrusted-input)) and returns a **structured JSON verdict**
the agent can act on — `ok`, or the violation `rule` + `message` + `fix` and the
legal `alternatives` from the current state.

| Tool | Wraps | What it checks |
| --- | --- | --- |
| `guard_action` | `guardAction` | A single proposed action (move a commitment to a new state) is coherent — e.g. blocks an over-refund (I-1) or an illegal backward move (I-2), and returns the legal alternatives. |
| `validate_settlement` | `validateSettlement` | A multi-component settlement (principal / tax / fees / shipping) reconciles to the committed total in one currency (I-1). Reconciliation only — it does not compute tax. |
| `check_compensation` | `planCompensation` + `validateCompensation` | A compensating (unwinding) sequence for a set of forward steps validates coherently; reports the step that fails (e.g. an over-refund). Validates the unwind; it does not execute any rollback. |
| `valid_transitions` | `validTransitions` | The planning oracle: the legal target states from a given state, read from the frozen transition table. A listed move is legal, not guaranteed safe — check the concrete move with `guard_action`. |
| `unify_sources` | `unify` | Caller-corresponded platform objects (e.g. a Shopify order and a Stripe charge) merge into one validated commitment and conserve value — a cross-source amount mismatch is caught as I-1. |

## Run it

Build, then launch over **stdio** (the transport local MCP hosts use):

```bash
npm install
npm run build
node dist/index.js     # or: npx warp-commerce-mcp
```

### Add to an MCP host

Claude Desktop / Cursor / VS Code (MCP config), pointing at the built entry:

```jsonc
{
  "mcpServers": {
    "warp-commerce-integrity": {
      "command": "node",
      "args": ["/absolute/path/to/packages/commerce-mcp/dist/index.js"]
    }
  }
}
```

### See it work

```bash
npm run example
```

The example spawns the server over stdio, connects an MCP client, and calls
`guard_action` with an over-refund → gets `BLOCKED [I-1]` with the fix → corrects
the amount → gets `ok`. It frames the layering explicitly: Warp confirms the
action is internally coherent commerce; authorization (AP2) and checkout
execution (ACP/UCP) remain the job of those protocols.

## Security: untrusted input

Tool inputs come from an LLM, not a human, so they are validated server-side
before reaching Warp's guard ([Zod](https://zod.dev) schemas), in two tiers by
what the value is:

- **Agent-authored action payloads** — what the agent is *proposing to do* (a
  target `CommitmentState`, a `ProposedAction`, a `ForwardStep`, a money
  breakdown) — are **strict** (`additionalProperties: false`). An unexpected key
  is a malformed proposal and is rejected with a structured error, not run.
- **Pre-existing world state** the agent merely *passes through* (the commitment
  objects it read from its system) is structurally validated — required fields
  are typed — but unknown keys are stripped rather than rejected. Warp's guard
  reads a fixed, known field set and is the authoritative validator; an extra
  field on a passed-through commitment cannot change the verdict, and enumerating
  the full generated commerce schema here would duplicate it and reject genuine,
  richer payloads.

Malformed input yields a clean validation error result; it does not crash the
server. This distrust-the-caller posture is the same thing Warp is for: the
server's job is to validate the agent's proposed action rather than assume it is
correct.

## Versions

- **MCP spec:** targets the current stable spec `2025-11-25`, built on the
  official `@modelcontextprotocol/sdk` **v1.x** (`McpServer` + Zod tool schemas).
- **Commerce model:** wraps `@warp-lang/commerce-types@^1.3.0`, which tracks the
  Warp Commerce Model schema frozen at v1.0.0. This package does not modify the
  schema or the commerce-types package.

This package is `0.1.0` and unpublished; it depends on the published commerce
types and adds the MCP surface.
