/**
 * The agent loop.
 *
 * The model is given the customer task and the Warp tools. It proposes actions;
 * each `guard_action` proposal is checked by the REAL Warp MCP server before it
 * would be finalized. A block (with its rule + fix + alternatives) is fed back to
 * the model, which re-plans. The loop is identical in real-LLM and replay modes —
 * only the source of the model's turns differs. The harness never decides the
 * action; it only supplies the order's world and relays Warp's live verdict.
 */
import type { ModelClient, Message, RunResult, TranscriptEntry, ToolCall } from "./types.js";
import type { WarpMcp } from "./mcp.js";
import { buildWorld, systemPrompt, customerTask, modelToolDefs } from "./scenario.js";

const MAX_STEPS = 8;

function actionFrom(call: ToolCall): unknown {
  // The model supplies the action; the harness supplies the world. Be tolerant
  // of a model that nests under `action` or passes the action fields directly.
  const a = call.args["action"];
  return a !== undefined ? a : call.args;
}

export async function runAgent(model: ModelClient, warp: WarpMcp): Promise<RunResult> {
  const { world, orderId } = buildWorld();
  const tools = modelToolDefs();
  const system = systemPrompt(orderId);
  const messages: Message[] = [{ role: "user", content: customerTask() }];
  const entries: TranscriptEntry[] = [];

  let sawBlock = false;
  let blockedThenCorrected = false;
  let firstBlockRule: string | undefined;

  for (let step = 0; step < MAX_STEPS; step++) {
    const turn = await model.complete({ system, messages, tools });
    messages.push({ role: "assistant", turn });
    if (turn.text.trim()) entries.push({ kind: "reasoning", text: turn.text.trim() });

    if (turn.toolCalls.length === 0) {
      entries.push({ kind: "final", text: turn.text.trim() });
      break;
    }

    for (const call of turn.toolCalls) {
      entries.push({ kind: "tool_call", name: call.name, args: call.args });

      let verdict: any;
      if (call.name === "guard_action") {
        verdict = await warp.guardAction(world, actionFrom(call));
        const ok = verdict?.ok === true;
        const v = ok ? undefined : verdict?.violations?.[0];
        entries.push({
          kind: "verdict",
          ok,
          rule: v?.rule,
          message: v?.message,
          fix: v?.fix,
          alternatives: verdict?.alternatives?.map((a: any) => a.to),
        });
        if (!ok) {
          if (!sawBlock) firstBlockRule = v?.rule;
          sawBlock = true;
        } else if (sawBlock) {
          blockedThenCorrected = true;
        }
      } else if (call.name === "valid_transitions") {
        verdict = await warp.validTransitions(call.args["from"]);
        entries.push({ kind: "verdict", ok: true, message: `legal moves: ${(verdict?.legalMoves ?? []).join(", ")}` });
      } else {
        verdict = { ok: false, error: `unknown tool '${call.name}'` };
      }

      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(verdict),
      });
    }
  }

  return { entries, blockedThenCorrected, firstBlockRule };
}
