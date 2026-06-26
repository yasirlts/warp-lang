# @warp-lang/agent-demo

A reference demo: a real LLM agent, working a customer-service task, **naturally
reaches for a structurally-invalid commerce action** — an over-refund — and is
**stopped by Warp** via the real [commerce-mcp](../commerce-mcp) server, then
self-corrects using the structured guidance Warp returns.

The point is to make the value *felt*, not described: you watch an agent attempt a
disaster and watch Warp catch it.

## What it shows (and the honest scope)

A support agent is told a customer paid 200 MAD for a delayed order and wants "a
full refund **and** something extra for the trouble." A naive agent rolls the
refund and the goodwill into a single 250 MAD refund against a 200 MAD order. Before
that action is finalized it is checked by Warp's `guard_action` tool, which returns:

```
BLOCKED [I-1] ... refunds 250 MAD but only 200 MAD was committed ...
fix: Refund at most the committed amount (200 MAD); to return more, the excess needs its own committed source.
```

The agent reads the rejection and re-plans: refund exactly 200 MAD, handle the
goodwill separately. That passes.

**The precise claim:** Warp caught *this class of structural error* (value
conservation / a legal state move) before it executed, and the agent recovered from
the returned guidance. It is **not** a claim that the agent is now safe in general.
Warp is the integrity check the agent's commerce actions pass through; it catches
structural incoherence, not every possible mistake.

**The honesty bar:** the bad action is **not hardcoded**. The task is a genuine
support situation; a careful agent refunds 200 and handles goodwill separately, a
naive one over-refunds. Which path the model takes is the model's own choice — Warp
is the only thing catching the bad one. In live mode the outcome is
non-deterministic, and that is the honest article.

## Two modes

### Canned (default, keyless, deterministic — what CI runs)

```bash
npm run demo
```

Replays the model turns recorded in [`fixtures/recovery.json`](fixtures/) — a
**REPLAY of recorded agent behavior, not a live model** (every run says so). Only
the agent's turns are recorded; **Warp's verdicts are computed live** by the real
commerce-mcp server on every replay. This is what makes the demo runnable with no
key and in CI while still exercising real Warp checks.

### Live (bring your own key, any provider)

```bash
# vendor-agnostic — point it at any Anthropic-style or OpenAI-compatible API
export WARP_DEMO_PROVIDER=anthropic        # or: openai
export WARP_DEMO_MODEL=<model-id>
export WARP_DEMO_API_KEY=<your-key>        # or ANTHROPIC_API_KEY / OPENAI_API_KEY
# optional: export WARP_DEMO_BASE_URL=<endpoint>   # e.g. an OpenAI-compatible gateway

npm run demo:real        # live run; the agent's actions are the model's own
npm run demo:record      # live run that saves the transcript as the replay fixture
```

No vendor is baked in and no key is ever committed — the key is read from the
environment only. Add your key via the env, not a file.

## How it works

- The agent loop ([`src/agent.ts`](src/agent.ts)) gives the model the task and the
  Warp tools, and runs proposed actions through the **real** commerce-mcp server
  ([`src/mcp.ts`](src/mcp.ts)) over the actual MCP stdio transport before they would
  be finalized. The harness supplies the order's `world` (the fixed scenario
  context); the agent chooses the `action`; Warp returns the live verdict. Nothing
  here re-implements or stubs Warp's checks, and it does not modify
  `commerce-types` or `commerce-mcp`.
- The model client ([`src/model.ts`](src/model.ts)) is provider-agnostic (Anthropic
  Messages or OpenAI-compatible chat completions, via `fetch`, no vendor SDK). The
  replay client implements the same interface with no network and no key.

## Recording the fixture

The committed fixture must come from a **genuine** `--record` run (it is captured
model behavior, not authored). Because the bad action emerges from the model, a
recording captures a run in which the over-refund actually occurred; if a given
model does not make that mistake on this task, that is reported rather than faked.

This package is `0.1.0` and unpublished.
