/** Render the run as a readable transcript so a viewer SEES the disaster averted. */
import type { RunResult, TranscriptEntry } from "./types.js";

function refundAmount(args: Record<string, unknown>): string | undefined {
  const action: any = (args as any).action ?? args;
  const amt = action?.to?.amount;
  if (amt && typeof amt.amount === "number") return `${amt.amount} ${amt.currency ?? ""}`.trim();
  return action?.to?.type;
}

function line(e: TranscriptEntry): string[] {
  switch (e.kind) {
    case "reasoning":
      return [`🧠 agent: ${e.text}`];
    case "tool_call": {
      const detail = e.name === "guard_action" ? ` (proposes: ${refundAmount(e.args) ?? "?"})` : ` ${JSON.stringify(e.args)}`;
      return [`🔧 → warp.${e.name}${detail}`];
    }
    case "verdict":
      if (e.ok) {
        return [`✅ warp: ok${e.message ? ` — ${e.message}` : " (structurally coherent)"}`];
      }
      return [
        `⛔ warp: BLOCKED [${e.rule}] ${e.message ?? ""}`,
        `   fix: ${e.fix ?? ""}`,
        ...(e.alternatives?.length ? [`   legal alternatives: ${e.alternatives.join(", ")}`] : []),
      ];
    case "final":
      return ["", `💬 agent → customer: ${e.text}`];
  }
}

export function renderTranscript(result: RunResult, opts: { live: boolean; modelLabel: string }): string {
  const out: string[] = [];
  out.push("──────────────────────────────────────────────────────────────");
  out.push(
    opts.live
      ? `LIVE run — model: ${opts.modelLabel}. The agent's actions are the model's own choices.`
      : `REPLAY of recorded agent behavior — NOT a live model (${opts.modelLabel}).`,
  );
  out.push("Warp's verdicts below are computed live by the real commerce-mcp server.");
  out.push("──────────────────────────────────────────────────────────────");
  out.push("");
  for (const e of result.entries) {
    for (const l of line(e)) out.push(l);
  }
  out.push("");
  out.push("──────────────────────────────────────────────────────────────");
  if (result.blockedThenCorrected) {
    out.push(
      `Warp blocked a structurally-invalid action [${result.firstBlockRule}] before it executed; ` +
        "the agent recovered using the returned guidance and proposed a valid action.",
    );
    out.push(
      "Precise scope: Warp caught this class of structural error (value conservation / " +
        "legal state move) via MCP. It does not make the agent globally safe — it is the " +
        "integrity check the agent's actions pass through.",
    );
  } else {
    out.push(
      "In this run the agent did not propose a blocked-then-corrected action. That is a " +
        "valid outcome: the bad action is the model's to make, not the harness's to force.",
    );
  }
  out.push("──────────────────────────────────────────────────────────────");
  return out.join("\n");
}
