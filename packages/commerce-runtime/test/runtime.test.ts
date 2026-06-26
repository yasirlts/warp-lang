/**
 * Tests for the reference durable-execution runtime.
 *
 * Three properties the runtime must hold, each mapped to the F25 spec:
 *   - REPLAY DETERMINISM: re-running the recorded log over the same initial world
 *     reproduces the same final model state and the same per-action verdicts.
 *   - AUDIT COMPLETENESS: every processed action is logged (accepted, blocked,
 *     replay, conflict alike), with its action, verdict, and resulting version.
 *   - BLOCKED ACTION: an unsafe action is logged AND does not advance the world.
 *
 * The runtime is a thin composition over the published commerce-types primitives
 * (createSession + guardAction); these tests assert the runtime's own contract,
 * not the invariant logic (which is proven and cross-checked in commerce-types).
 */

import { describe, expect, it } from "vitest";
import {
  applyCommitmentPath,
  newCommitment,
  partyId,
  valueId,
  type ProposedAction,
  type World,
} from "@warp-lang/commerce-types";
import {
  CommerceRuntime,
  InMemoryAuditStore,
  describeEffects,
  replayLog,
  worldsEqual,
} from "../src/index.js";

// guardAction stamps each applied transition's history[].at with wall-clock time,
// which the runtime's injected clock does not control; a replay re-stamps it. The
// meaningful determinism (final state, verdict ok/blocked) is asserted elsewhere;
// here we normalize that timestamp so a verdict comparison is not clock-flaky.
function normTimes<T>(value: T): T {
  const cloned = structuredClone(value) as any;
  const fix = (verdict: any) => {
    for (const cm of verdict?.next?.commitments ?? [])
      for (const h of cm?.history ?? []) if (h && typeof h.at === "string") h.at = "<t>";
  };
  if (Array.isArray(cloned)) cloned.forEach(fix);
  else fix(cloned);
  return cloned;
}

/** A Fulfilled order committed at `amount` MAD, in a world by itself. */
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

function refund(commitment: string, amount: number, at: string, reason?: string): ProposedAction {
  return { commitment, to: { type: "Refunded", amount: { amount, currency: "MAD" }, at }, actor: "agent", reason };
}

const FIXED_NOW = () => "2026-02-01T12:00:00.000Z";

describe("CommerceRuntime — processing and the audit log", () => {
  it("logs an accepted action and advances the world", () => {
    const { world, id } = fulfilledOrder(200);
    const rt = new CommerceRuntime(world, { now: FIXED_NOW });

    const result = rt.process(refund(id, 200, "2026-02-01T00:00:00.000Z"));

    expect(result.advanced).toBe(true);
    expect(result.entry.verdict.ok).toBe(true);
    expect(rt.world.commitments[0]?.state.type).toBe("Refunded");
    expect(rt.store.size()).toBe(1);
  });

  it("audit completeness: every processed action is logged with action, verdict, and version", () => {
    const { world, id } = fulfilledOrder(200);
    const rt = new CommerceRuntime(world, { now: FIXED_NOW });

    const events: ProposedAction[] = [
      refund(id, 500, "2026-02-01T00:00:00.000Z"), // blocked over-refund
      refund(id, 120, "2026-02-01T01:00:00.000Z"), // accepted partial
      refund(id, 80, "2026-02-01T02:00:00.000Z"), // accepted, completes the refund
    ];
    rt.run(events);

    const log = rt.store.entries();
    expect(log).toHaveLength(events.length);
    log.forEach((entry, i) => {
      expect(entry.action).toEqual(events[i]); // the action, verbatim
      expect(entry.verdict).toBeDefined(); // the verdict
      expect(entry.version.seq).toBe(i + 1); // monotonic per-log sequence
      expect(entry.version.commitment).toBe(id);
      expect(typeof entry.at).toBe("string"); // wall-clock stamp metadata
    });
  });

  it("blocked action: an over-refund is logged but does not advance the world", () => {
    const { world, id } = fulfilledOrder(200);
    const rt = new CommerceRuntime(world, { now: FIXED_NOW });
    const before = rt.world.commitments[0]?.state.type;

    const result = rt.process(refund(id, 500, "2026-02-01T00:00:00.000Z"));

    // The verdict is a rejection...
    expect(result.advanced).toBe(false);
    expect(result.entry.verdict.ok).toBe(false);
    if (result.entry.verdict.ok === false) {
      expect(result.entry.verdict.violations[0]?.rule).toBe("I-1");
    }
    // ...it is logged...
    expect(rt.store.size()).toBe(1);
    // ...and the world is unchanged (still Fulfilled, not Refunded).
    expect(rt.world.commitments[0]?.state.type).toBe(before);
    expect(rt.world.commitments[0]?.state.type).toBe("Fulfilled");
  });

  it("logs a blocked action targeting an unknown commitment without advancing", () => {
    const { world } = fulfilledOrder(200);
    const rt = new CommerceRuntime(world, { now: FIXED_NOW });

    const result = rt.process(refund("does-not-exist", 50, "2026-02-01T00:00:00.000Z"));

    expect(result.advanced).toBe(false);
    expect(result.entry.verdict.ok).toBe(false);
    expect(result.entry.version.commitmentVersion).toBeNull();
    expect(rt.store.size()).toBe(1);
  });
});

describe("CommerceRuntime — replay determinism", () => {
  it("replaying the log from the same initial world reproduces the final state", () => {
    const { world, id } = fulfilledOrder(200);
    const live = new CommerceRuntime(world, { now: FIXED_NOW });
    live.run([
      refund(id, 500, "2026-02-01T00:00:00.000Z"), // blocked
      refund(id, 200, "2026-02-01T01:00:00.000Z"), // accepted
    ]);

    const replay = replayLog(world, live.store);

    expect(worldsEqual(replay.world, live.world)).toBe(true);
    expect(replay.world.commitments[0]?.state.type).toBe("Refunded");
  });

  it("replay reproduces the per-action verdicts (a blocked action stays blocked)", () => {
    const { world, id } = fulfilledOrder(200);
    const live = new CommerceRuntime(world, { now: FIXED_NOW });
    const events: ProposedAction[] = [
      refund(id, 500, "2026-02-01T00:00:00.000Z"),
      refund(id, 200, "2026-02-01T01:00:00.000Z"),
    ];
    live.run(events);

    const replay = replayLog(world, live.store);

    expect(replay.verdicts).toHaveLength(events.length);
    expect(replay.verdicts[0]?.ok).toBe(false); // the over-refund stays blocked
    expect(replay.verdicts[1]?.ok).toBe(true); // the corrected refund stays accepted
    const liveVerdicts = live.store.entries().map((e) => e.verdict);
    expect(normTimes(replay.verdicts)).toEqual(normTimes(liveVerdicts));
  });

  it("replay is itself idempotent: replaying the replay's log reproduces the same state", () => {
    const { world, id } = fulfilledOrder(300);
    const live = new CommerceRuntime(world, { now: FIXED_NOW });
    live.run([refund(id, 100, "2026-02-01T00:00:00.000Z"), refund(id, 200, "2026-02-01T01:00:00.000Z")]);

    const first = replayLog(world, live.store);
    const second = replayLog(world, first.runtime.store);

    expect(worldsEqual(second.world, first.world)).toBe(true);
    expect(worldsEqual(second.world, live.world)).toBe(true);
  });
});

describe("CommerceRuntime — stores and effect descriptors", () => {
  it("the in-memory store is append-only from the caller's side", () => {
    const store = new InMemoryAuditStore();
    const { world, id } = fulfilledOrder(200);
    const rt = new CommerceRuntime(world, { store, now: FIXED_NOW });
    rt.process(refund(id, 200, "2026-02-01T00:00:00.000Z"));

    const snapshot = store.entries();
    snapshot.length = 0; // mutating the returned copy...
    expect(store.size()).toBe(1); // ...does not truncate the log
  });

  it("describeEffects yields Boundary-A descriptors only for accepted actions", () => {
    const { world, id } = fulfilledOrder(200);
    const rt = new CommerceRuntime(world, { now: FIXED_NOW });
    rt.run([
      refund(id, 500, "2026-02-01T00:00:00.000Z"), // blocked -> no effect
      refund(id, 200, "2026-02-01T01:00:00.000Z"), // accepted -> one refund effect
    ]);

    const effects = describeEffects(rt.store);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toEqual({
      ok: true,
      effect: { kind: "refund", target: id, payload: { amount: { amount: 200, currency: "MAD" } } },
    });
  });
});
