/**
 * Canned-demo test. Replays the recorded agent turns against the REAL Warp MCP
 * server (verdicts computed live) and asserts the disaster-averted path:
 *
 *   first proposed action is BLOCKED with I-1  ->  a corrected action passes
 *   ->  the transcript carries the averted-disaster beat.
 *
 * Only the agent's turns come from the fixture; Warp's verdicts are live, so this
 * is a real check of the integrity layer, not a string comparison.
 */
import { describe, it, expect } from "vitest";
import { connectWarp } from "../src/mcp.js";
import { runAgent } from "../src/agent.js";
import { makeReplayClient } from "../src/model.js";
import { renderTranscript } from "../src/transcript.js";
import fixture from "../fixtures/recovery.json";
import type { Fixture } from "../src/types.js";

describe("canned agent demo (recorded replay + live Warp verdicts)", () => {
  it("the recorded fixture is a real over-refund the agent reached for, not a hardcode", () => {
    const f = fixture as Fixture;
    // first guard_action the agent proposes is an over-refund (> 200 committed)
    const firstGuard = f.turns
      .flatMap((t) => t.toolCalls)
      .find((c) => c.name === "guard_action");
    expect(firstGuard).toBeDefined();
    const action: any = (firstGuard!.args as any).action ?? firstGuard!.args;
    expect(action.to.type).toBe("Refunded");
    expect(action.to.amount.amount).toBeGreaterThan(200);
  });

  it("first action is blocked with I-1; a corrected action passes; transcript shows the beat", async () => {
    const warp = await connectWarp();
    try {
      const result = await runAgent(makeReplayClient(fixture as Fixture), warp);

      // Warp (live) blocked the over-refund with I-1, then a later action passed.
      expect(result.firstBlockRule).toBe("I-1");
      expect(result.blockedThenCorrected).toBe(true);

      const blocked = result.entries.find((e) => e.kind === "verdict" && e.ok === false);
      expect(blocked).toBeDefined();
      const passed = result.entries.find((e) => e.kind === "verdict" && e.ok === true);
      expect(passed).toBeDefined();

      const transcript = renderTranscript(result, { live: false, modelLabel: "replay (recorded)" });
      expect(transcript).toMatch(/REPLAY of recorded agent behavior/);
      expect(transcript).toMatch(/BLOCKED \[I-1\]/);
      expect(transcript).toMatch(/recovered using the returned guidance/);
    } finally {
      await warp.close();
    }
  });
});
