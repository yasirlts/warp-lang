/**
 * CLI for the Warp agent demo.
 *
 *   node dist/index.js            # keyless REPLAY of a recorded run (default; CI-safe)
 *   node dist/index.js --real     # LIVE: call a real model API (needs a key in env)
 *   node dist/index.js --real --record   # LIVE and save the run as the replay fixture
 *
 * Both modes drive the SAME agent loop against the SAME real Warp MCP server.
 * Only the source of the model's turns differs (a live API vs. a recorded fixture).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AssistantTurn, Fixture, Message, ModelClient, ToolDef } from "./types.js";
import { connectWarp } from "./mcp.js";
import { runAgent } from "./agent.js";
import { renderTranscript } from "./transcript.js";
import { resolveLiveConfig, makeLiveClient, makeReplayClient } from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(here, "../fixtures/recovery.json");

function loadFixture(): Fixture | null {
  if (!existsSync(FIXTURE_PATH)) return null;
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

/** Wraps a live client and records each turn it produces, to save as a fixture. */
class RecordingClient implements ModelClient {
  readonly isLive = true;
  readonly label: string;
  readonly recorded: AssistantTurn[] = [];
  constructor(private inner: ModelClient) {
    this.label = inner.label;
  }
  async complete(req: { system: string; messages: Message[]; tools: ToolDef[] }): Promise<AssistantTurn> {
    const turn = await this.inner.complete(req);
    this.recorded.push(turn);
    return turn;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const record = args.includes("--record");
  const wantLive = args.includes("--real") || record;

  const warp = await connectWarp();
  try {
    let model: ModelClient;
    let recorder: RecordingClient | undefined;
    let liveModelLabel = "";

    if (wantLive) {
      const r = resolveLiveConfig();
      if (!r.ok) {
        console.error(`Cannot run a live model: ${r.reason}.`);
        console.error("Run without --real for the keyless replay, or set the env vars (see README).");
        process.exitCode = 2;
        return;
      }
      const base = makeLiveClient(r.cfg);
      liveModelLabel = base.label;
      if (record) {
        recorder = new RecordingClient(base);
        model = recorder;
      } else {
        model = base;
      }
    } else {
      const fixture = loadFixture();
      if (!fixture) {
        console.error(`No recorded fixture at ${FIXTURE_PATH}.`);
        console.error("Record one from a real run (needs an API key): npm run demo:record. See README.");
        process.exitCode = 2;
        return;
      }
      model = makeReplayClient(fixture);
    }

    const result = await runAgent(model, warp);
    console.log(renderTranscript(result, { live: model.isLive, modelLabel: model.label }));

    if (recorder) {
      const fixture: Fixture = {
        meta: {
          recordedFrom: liveModelLabel,
          recordedAt: new Date().toISOString(),
          note: "REPLAY of recorded agent behavior — not a live model. Only the agent's turns are recorded; Warp's verdicts are computed live on every replay.",
        },
        turns: recorder.recorded,
      };
      writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n");
      console.error(`\nRecorded ${recorder.recorded.length} agent turns to ${FIXTURE_PATH}`);
    }
  } finally {
    await warp.close();
  }
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
