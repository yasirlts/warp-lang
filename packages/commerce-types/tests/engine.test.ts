/**
 * The engine is the testable heart of "commerce model in Warp, host does I/O".
 * These tests pin its contract: PURE (same input -> same output, modulo the one
 * clock-sampled transition timestamp), TOTAL (every event yields a result, never
 * throws), inputs never mutated, and the widened effect vocabulary emitted
 * correctly (blocked -> no effect).
 */
import { describe, it, expect } from "vitest";
import { newCommitment, applyCommitmentPath, partyId, valueId } from "../src/index.js";
import { step, run, type CommerceEvent } from "../src/engine.js";
import type { World, CommitmentState, ProposedAction } from "../src/index.js";

const seller = partyId("seller_1");
const buyer = partyId("buyer_1");

function order(amount: number, finalState: CommitmentState) {
  const o = newCommitment(buyer, seller, {
    offered: [],
    requested: [
      { id: valueId("v"), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } },
    ],
  });
  return applyCommitmentPath(o, finalState, seller);
}
const worldWith = (...cs: ReturnType<typeof order>[]): World => ({ commitments: cs, fulfillments: [], parties: [] });
const event = (commitment: string, to: CommitmentState): CommerceEvent => ({ type: "action", action: { commitment, to, actor: seller } as ProposedAction });

/** Normalize the single clock-sampled field (transition timestamps) for comparison. */
function normTimes<T>(value: T): T {
  const w = JSON.parse(JSON.stringify(value));
  for (const c of w?.commitments ?? []) for (const h of c?.history ?? []) if (h && typeof h.at === "string") h.at = "<t>";
  return w;
}
const refundTo = (amount: number): CommitmentState => ({ type: "Refunded", amount: { amount, currency: "MAD" }, at: "2026-03-01T00:00:00.000Z" });
// A fixed clock LATER than any wall-clock build time, so it is temporally valid.
const FIXED = () => "2030-01-01T00:00:00.000Z";

describe("engine — valid transitions advance the world and emit host effects", () => {
  it("refund: world advances, one refund descriptor", () => {
    const c = order(200, { type: "Fulfilled" });
    const r = step(worldWith(c), event(c.id, refundTo(200)));
    expect(r.verdict.ok).toBe(true);
    expect(r.world.commitments[0]!.state.type).toBe("Refunded");
    expect(r.effects).toEqual([{ kind: "refund", target: c.id, payload: { amount: { amount: 200, currency: "MAD" } } }]);
  });

  it("fulfill / settle / notify: each emits a host-actionable descriptor", () => {
    const f = order(100, { type: "PartiallyFulfilled", fulfilled_item_ids: ["a"], remaining_item_ids: ["b"] });
    const fulfilled = step(worldWith(f), event(f.id, { type: "Fulfilled" }));
    expect(fulfilled.effects.map((e) => e.kind)).toEqual(["fulfill"]);
    expect(fulfilled.effects[0]).toMatchObject({ kind: "fulfill", payload: { items: expect.any(Array) } });

    const p = order(100, { type: "Proposed" });
    const settled = step(worldWith(p), event(p.id, { type: "Accepted" }));
    // settle carries the committed amount the host captures (from the requested money).
    expect(settled.effects).toEqual([{ kind: "settle", target: p.id, payload: { amount: { amount: 100, currency: "MAD" } } }]);

    const d = order(100, { type: "Fulfilled" });
    const disputed = step(worldWith(d), event(d.id, { type: "Disputed", by: buyer, reason: "damaged", opened_at: "2026-03-01T00:00:00.000Z" }));
    expect(disputed.effects).toEqual([{ kind: "notify", target: d.id, payload: { reason: "damaged", by: buyer, openedAt: "2026-03-01T00:00:00.000Z" } }]);
  });
});

describe("engine — blocked events leave the world unchanged with no effect", () => {
  it("over-refund: I-1, world unchanged, no effect, verdict explains", () => {
    const c = order(100, { type: "Fulfilled" });
    const w = worldWith(c);
    const r = step(w, event(c.id, refundTo(500)));
    expect(r.verdict.ok).toBe(false);
    expect(r.effects).toEqual([]);
    expect(r.verdict.violations?.[0]?.rule).toBe("I-1");
    expect(r.world).toBe(w); // the SAME, unchanged world
  });
});

describe("engine — purity, totality, no mutation", () => {
  it("pure: same (world, event) -> same output, modulo the clock-sampled transition timestamp", () => {
    const c = order(200, { type: "Fulfilled" });
    const w = worldWith(c);
    const e = event(c.id, refundTo(200));
    const r1 = step(w, e); // step does not mutate w, so calling it twice is the purity check
    const r2 = step(w, e);
    // verdict + effects are timestamp-free -> byte-equal; world equal modulo transition `at`
    expect(r1.verdict).toEqual(r2.verdict);
    expect(r1.effects).toEqual(r2.effects);
    expect(normTimes(r1.world)).toEqual(normTimes(r2.world));
    // and the two outputs differ ONLY by that timestamp (nothing else clock-dependent)
    expect(JSON.stringify(normTimes(r1.world))).toBe(JSON.stringify(normTimes(r2.world)));
  });

  it("does not mutate its inputs", () => {
    const c = order(200, { type: "Fulfilled" });
    const w = worldWith(c);
    const e = event(c.id, refundTo(200));
    const wBefore = JSON.stringify(w);
    const eBefore = JSON.stringify(e);
    step(w, e);
    expect(JSON.stringify(w)).toBe(wBefore);
    expect(JSON.stringify(e)).toBe(eBefore);
  });

  it("total: a malformed event (unknown commitment) yields a block, never throws", () => {
    const c = order(200, { type: "Fulfilled" });
    let r!: ReturnType<typeof step>;
    expect(() => { r = step(worldWith(c), event("does-not-exist", refundTo(50))); }).not.toThrow();
    expect(r.verdict.ok).toBe(false);
    expect(r.effects).toEqual([]);
    expect(r.world.commitments[0]!.state.type).toBe("Fulfilled"); // unchanged
  });
});

describe("engine — injectable clock makes purity PROVABLE (Phase 3.1b)", () => {
  it("byte-for-byte deterministic with a fixed clock (not just modulo the timestamp)", () => {
    const c = order(200, { type: "Fulfilled" });
    const w = worldWith(c);
    const e = event(c.id, refundTo(200));
    const r1 = step(w, e, { clock: FIXED });
    const r2 = step(w, e, { clock: FIXED });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2)); // FULL byte-for-byte equality
    const h = r1.world.commitments[0]!.history;
    expect(h[h.length - 1]!.at).toBe("2030-01-01T00:00:00.000Z"); // the injected clock's value
  });

  it("run() with a fixed clock is byte-for-byte deterministic over a stream", () => {
    const a = order(200, { type: "Fulfilled" });
    const b = order(100, { type: "Proposed" });
    const w = worldWith(a, b);
    const events = [event(a.id, refundTo(200)), event(b.id, { type: "Accepted" })];
    expect(JSON.stringify(run(w, events, { clock: FIXED }))).toBe(JSON.stringify(run(w, events, { clock: FIXED })));
  });

  it("an injected NON-MONOTONIC clock is STILL rejected by I-4, with a legible message + fix", () => {
    const c = order(200, { type: "Fulfilled" }); // built with wall-clock history (~now)
    const earlier = () => "2000-01-01T00:00:00.000Z"; // before the existing history
    const r = step(worldWith(c), event(c.id, refundTo(200)), { clock: earlier });
    expect(r.verdict.ok).toBe(false);
    const v = r.verdict.violations?.[0];
    // legible like every other Warp rejection (I-1/I-2): a real rule, not "engine-error",
    expect(v?.rule).toBe("I-4");
    expect(v?.rule).not.toBe("engine-error");
    // a message that names the temporal-integrity invariant, and an actionable fix.
    expect(v?.message).toMatch(/Temporal Integrity|Invariant 4/);
    expect(v?.fix && v.fix.length).toBeGreaterThan(0);
    expect(r.effects).toEqual([]);
    expect(r.world.commitments[0]!.state.type).toBe("Fulfilled"); // unchanged (no behavior weakened)
  });

  it("default (no clock) is unchanged behavior — accepts and advances", () => {
    const c = order(200, { type: "Fulfilled" });
    const r = step(worldWith(c), event(c.id, refundTo(200)));
    expect(r.verdict.ok).toBe(true);
    expect(r.world.commitments[0]!.state.type).toBe("Refunded");
  });
});

describe("engine — run folds deterministically over an event stream", () => {
  it("folds events, accumulating effects + verdicts; deterministic modulo timestamps", () => {
    const a = order(200, { type: "Fulfilled" });
    const b = order(100, { type: "Proposed" });
    const w = worldWith(a, b);
    const events = [event(a.id, refundTo(200)), event(b.id, { type: "Accepted" })];
    const r1 = run(w, events);
    expect(r1.verdicts.map((v) => v.ok)).toEqual([true, true]);
    expect(r1.effects.map((e) => e.kind)).toEqual(["refund", "settle"]);
    // determinism: same inputs (run does not mutate them) -> same output modulo timestamps
    const r2 = run(w, events);
    expect(r2.verdicts).toEqual(r1.verdicts);
    expect(r2.effects).toEqual(r1.effects);
    expect(normTimes(r2.world)).toEqual(normTimes(r1.world));
  });
});

describe("engine — complete lifecycle, as in examples/complete-engine.mjs", () => {
  // An order offering goods, requesting money — drives create→accept→fulfill→refund.
  function newOrder(amount: number, sku: string) {
    return newCommitment(buyer, seller, {
      offered: [{ id: valueId("g"), form: { kind: "PhysicalGood", sku, condition: "New" }, quantity: 1, state: { type: "Available" } }],
      requested: [{ id: valueId("m"), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } }],
    });
  }
  const clock = () => "2026-06-29T10:00:00.000Z";

  it("runs the full lifecycle, emitting settle → fulfill → refund with real payloads", () => {
    const o = newOrder(200, "TEABOX-200");
    const events: CommerceEvent[] = [
      event(o.id, { type: "Proposed" }),
      event(o.id, { type: "Accepted" }),
      event(o.id, { type: "PartiallyFulfilled", fulfilled_item_ids: [], remaining_item_ids: ["g"] }),
      event(o.id, { type: "Fulfilled" }),
      event(o.id, { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-06-29T10:00:00.000Z" }),
    ];
    const r = run({ commitments: [o], fulfillments: [], parties: [] }, events, { clock });
    expect(r.verdicts.every((v) => v.ok)).toBe(true);
    expect(r.effects.map((e) => e.kind)).toEqual(["settle", "fulfill", "refund"]);
    expect(r.effects).toContainEqual({ kind: "settle", target: o.id, payload: { amount: { amount: 200, currency: "MAD" } } });
    expect(r.effects).toContainEqual({ kind: "fulfill", target: o.id, payload: { items: [{ description: "PhysicalGood TEABOX-200", quantity: 1 }] } });
    expect(r.world.commitments[0]!.state.type).toBe("Refunded");
  });

  it("blocks an over-refund at the end of the lifecycle with I-1 and no effect", () => {
    const o = newOrder(100, "MUG-100");
    const toFulfilled: CommerceEvent[] = [
      event(o.id, { type: "Proposed" }),
      event(o.id, { type: "Accepted" }),
      event(o.id, { type: "PartiallyFulfilled", fulfilled_item_ids: [], remaining_item_ids: ["g"] }),
      event(o.id, { type: "Fulfilled" }),
    ];
    const mid = run({ commitments: [o], fulfillments: [], parties: [] }, toFulfilled, { clock });
    const over = step(mid.world, event(o.id, { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-06-29T10:00:00.000Z" }), { clock });
    expect(over.verdict.ok).toBe(false);
    expect(over.verdict.violations?.[0]?.rule).toBe("I-1");
    expect(over.effects).toEqual([]);
    expect(over.world.commitments[0]!.state.type).toBe("Fulfilled"); // unchanged
  });
});
