# Changelog — @warp-lang/commerce-mcp

## Unreleased

- **Protocol integrity bridge.** New `guard_protocol_action` tool: takes a commerce action shaped the way an agentic-commerce protocol carries it (checkout/order status, cart/order operation, a spending action under a payment mandate), maps it onto a Warp `ProposedAction`, and returns the verdict of the unmodified `guardAction` — so the integrity check can run before the protocol commits the action.
- Adapters for the three action shapes, each reporting what it read, what it deliberately did not interpret, and where a protocol concept has no sound Warp counterpart. An unmappable action returns `verdict: null` — explicitly not an approval.
- The bridge adds no integrity semantics: tests assert its verdict is identical to sending the mapped action to `guard_action` directly.
- New example `examples/protocol-bridge.mjs` (`npm run example:protocol`).
- Positioning: `docs/protocol-integrity.md` — the layer map, the integrity gap the protocols leave open by their own stated scope, and Warp's place beneath them. Gated by `scripts/overclaim-sweep.mjs`.

## 0.1.0

- First release.
- Exposes Warp's structural-coherence guardrail as Model Context Protocol tools, so any MCP-capable agent can validate a commerce action beneath the agentic-commerce protocols. It validates and returns verdicts; it does not authorize, execute, settle, or hold credentials.
