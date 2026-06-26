/**
 * Tests for the file-backed audit store — the "survives the process" half of the
 * durable-execution reference. A run writes the log to a JSON-lines file; a fresh
 * store opened over the same path reads the log back and replays it to reproduce
 * the final state.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCommitmentPath,
  newCommitment,
  partyId,
  valueId,
  type ProposedAction,
  type World,
} from "@warp-lang/commerce-types";
import { CommerceRuntime, FileAuditStore, replayLog, worldsEqual } from "../src/index.js";

function fulfilledOrder(amount: number): { world: World; id: string } {
  const buyer = partyId("buyer_1");
  const seller = partyId("seller_1");
  const order = newCommitment(buyer, seller, {
    offered: [],
    requested: [
      {
        id: valueId("value:order-total"),
        form: { kind: "Money", money: { amount, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  const shipped = applyCommitmentPath(order, { type: "Fulfilled" }, seller);
  return { world: { commitments: [shipped], fulfillments: [], parties: [] }, id: shipped.id as string };
}

function refund(commitment: string, amount: number, at: string): ProposedAction {
  return { commitment, to: { type: "Refunded", amount: { amount, currency: "MAD" }, at }, actor: "agent" };
}

const FIXED_NOW = () => "2026-02-01T12:00:00.000Z";

describe("FileAuditStore — persistence and cross-process replay", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "warp-runtime-"));
    path = join(dir, "audit.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes one JSON line per entry, append order preserved", () => {
    const { world, id } = fulfilledOrder(200);
    const rt = new CommerceRuntime(world, { store: new FileAuditStore(path, { truncate: true }), now: FIXED_NOW });
    rt.run([refund(id, 500, "2026-02-01T00:00:00.000Z"), refund(id, 200, "2026-02-01T01:00:00.000Z")]);

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "").verdict.ok).toBe(false); // blocked
    expect(JSON.parse(lines[1] ?? "").verdict.ok).toBe(true); // accepted
  });

  it("a fresh store over the same file replays to the same final state (survives the process)", () => {
    const { world, id } = fulfilledOrder(200);

    // "Process 1": run and persist the log, then drop the live runtime.
    const live = new CommerceRuntime(world, { store: new FileAuditStore(path, { truncate: true }), now: FIXED_NOW });
    live.run([refund(id, 500, "2026-02-01T00:00:00.000Z"), refund(id, 200, "2026-02-01T01:00:00.000Z")]);
    const liveWorld = live.world;

    // "Process 2": open the persisted log fresh and replay it from the initial world.
    const reopened = new FileAuditStore(path); // no truncate — read existing lines
    expect(reopened.size()).toBe(2);
    const replay = replayLog(world, reopened);

    expect(worldsEqual(replay.world, liveWorld)).toBe(true);
    expect(replay.world.commitments[0]?.state.type).toBe("Refunded");
  });

  it("truncate resets the log; reopening without truncate preserves it", () => {
    const { world, id } = fulfilledOrder(200);
    const first = new FileAuditStore(path, { truncate: true });
    new CommerceRuntime(world, { store: first, now: FIXED_NOW }).process(
      refund(id, 200, "2026-02-01T00:00:00.000Z"),
    );
    expect(first.size()).toBe(1);

    expect(new FileAuditStore(path).size()).toBe(1); // reopen keeps it
    expect(new FileAuditStore(path, { truncate: true }).size()).toBe(0); // truncate clears it
  });
});
