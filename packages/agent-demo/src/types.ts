/** Shared types for the agent loop, the model clients, and the transcript. */

/** A tool call the model decided to make. `args` is the model's own JSON. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** One assistant turn: the model's reasoning text plus any tool calls it made. */
export interface AssistantTurn {
  text: string;
  toolCalls: ToolCall[];
}

/** A tool definition surfaced to the model (name + description + JSON-Schema params). */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Provider-neutral conversation messages. */
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; turn: AssistantTurn }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** A model client: live (real API) or replay (recorded). Same interface either way. */
export interface ModelClient {
  /** Human label, e.g. "anthropic:claude-..." or "replay (recorded)". */
  readonly label: string;
  /** True for a real model API; false for the recorded replay. */
  readonly isLive: boolean;
  complete(req: { system: string; messages: Message[]; tools: ToolDef[] }): Promise<AssistantTurn>;
}

/** One entry in the readable transcript the demo prints. */
export type TranscriptEntry =
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; name: string; args: Record<string, unknown> }
  | { kind: "verdict"; ok: boolean; rule?: string; message?: string; fix?: string; alternatives?: string[] }
  | { kind: "final"; text: string };

/** The result of running the agent loop. */
export interface RunResult {
  entries: TranscriptEntry[];
  /** True if at least one proposed action was blocked and a later one passed. */
  blockedThenCorrected: boolean;
  /** The rule id of the first block (e.g. "I-1"), if any. */
  firstBlockRule?: string;
}

/** A recorded run: only the model's outputs are stored; Warp's verdicts are live on replay. */
export interface Fixture {
  meta: {
    recordedFrom: string;
    note: string;
    [k: string]: unknown;
  };
  turns: AssistantTurn[];
}
