/**
 * Model clients. All implement the same `ModelClient` interface so the agent
 * loop is identical regardless of source:
 *
 *  - `AnthropicClient` / `OpenAIClient` — real model APIs (bring your own key),
 *    via `fetch`. No vendor SDK and no hardcoded provider: endpoint, model, and
 *    key all come from the environment, so the demo points at any
 *    Anthropic-style or OpenAI-compatible API.
 *  - `ReplayClient` — replays the model turns recorded in a fixture. It calls no
 *    network and uses no key. This is the keyless, deterministic mode; it is a
 *    REPLAY of recorded agent behavior, not a live model.
 */
import type { ModelClient, Message, AssistantTurn, ToolDef, Fixture } from "./types.js";

// --- Provider-neutral -> Anthropic ------------------------------------------

function toAnthropic(messages: Message[]) {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    } else if (m.role === "assistant") {
      const content: any[] = [];
      if (m.turn.text.trim()) content.push({ type: "text", text: m.turn.text });
      for (const tc of m.turn.toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      out.push({ role: "assistant", content });
    } else {
      // tool result — merge into the previous user message if it is one
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

class AnthropicClient implements ModelClient {
  readonly isLive = true;
  readonly label: string;
  constructor(private cfg: { baseUrl: string; model: string; key: string }) {
    this.label = `anthropic:${cfg.model}`;
  }
  async complete(req: { system: string; messages: Message[]; tools: ToolDef[] }): Promise<AssistantTurn> {
    const res = await fetch(`${this.cfg.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: 1024,
        system: req.system,
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        messages: toAnthropic(req.messages),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    let text = "";
    const toolCalls: AssistantTurn["toolCalls"] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
    }
    return { text, toolCalls };
  }
}

// --- Provider-neutral -> OpenAI chat completions ----------------------------

function toOpenAI(system: string, messages: Message[]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const msg: any = { role: "assistant", content: m.turn.text || null };
      if (m.turn.toolCalls.length) {
        msg.tool_calls = m.turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }));
      }
      out.push(msg);
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

class OpenAIClient implements ModelClient {
  readonly isLive = true;
  readonly label: string;
  constructor(private cfg: { baseUrl: string; model: string; key: string }) {
    this.label = `openai:${cfg.model}`;
  }
  async complete(req: { system: string; messages: Message[]; tools: ToolDef[] }): Promise<AssistantTurn> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.key}` },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: toOpenAI(req.system, req.messages),
        tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: "auto",
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const toolCalls: AssistantTurn["toolCalls"] = (msg.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      args: JSON.parse(tc.function?.arguments || "{}"),
    }));
    return { text: msg.content ?? "", toolCalls };
  }
}

/** Replays recorded model turns. No network, no key. */
export class ReplayClient implements ModelClient {
  readonly isLive = false;
  readonly label = "replay (recorded)";
  private i = 0;
  constructor(private turns: AssistantTurn[]) {}
  async complete(): Promise<AssistantTurn> {
    const turn = this.turns[this.i++];
    return turn ?? { text: "", toolCalls: [] };
  }
}

/** Live model config resolved from the environment (vendor-agnostic). */
export interface LiveConfig {
  provider: "anthropic" | "openai";
  model: string;
  key: string;
  baseUrl: string;
}

/** Resolve a live config from env, or return a reason it is unavailable. */
export function resolveLiveConfig(): { ok: true; cfg: LiveConfig } | { ok: false; reason: string } {
  const provider = (process.env.WARP_DEMO_PROVIDER ?? "anthropic").toLowerCase();
  if (provider !== "anthropic" && provider !== "openai") {
    return { ok: false, reason: `WARP_DEMO_PROVIDER must be 'anthropic' or 'openai' (got '${provider}')` };
  }
  const key =
    process.env.WARP_DEMO_API_KEY ??
    (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);
  if (!key) {
    return {
      ok: false,
      reason: `no API key in the environment (set WARP_DEMO_API_KEY, or ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"})`,
    };
  }
  const model = process.env.WARP_DEMO_MODEL;
  if (!model) return { ok: false, reason: "set WARP_DEMO_MODEL to the model id you want to use" };
  const baseUrl =
    process.env.WARP_DEMO_BASE_URL ??
    (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
  return { ok: true, cfg: { provider, model, key, baseUrl } };
}

export function makeLiveClient(cfg: LiveConfig): ModelClient {
  return cfg.provider === "anthropic"
    ? new AnthropicClient({ baseUrl: cfg.baseUrl, model: cfg.model, key: cfg.key })
    : new OpenAIClient({ baseUrl: cfg.baseUrl, model: cfg.model, key: cfg.key });
}

export function makeReplayClient(fixture: Fixture): ModelClient {
  return new ReplayClient(fixture.turns);
}
