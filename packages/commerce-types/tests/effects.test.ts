import { describe, expect, it, vi } from "vitest";

import { toEffect, toEffects } from "../src/effects.js";
import type { ProposedAction } from "../src/guard.js";
import { partyId } from "../src/primitives.js";

const refund = (amount: number): ProposedAction => ({
  commitment: "order_123",
  to: { type: "Refunded", amount: { amount, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
  actor: "agent",
});

const cancel: ProposedAction = {
  commitment: "order_123",
  to: { type: "Cancelled", by: partyId("agent"), reason: "customer changed mind", at: "2026-03-01T00:00:00.000Z" },
  actor: "agent",
};

const accept: ProposedAction = { commitment: "order_123", to: { type: "Accepted" }, actor: "agent" };
const fulfill: ProposedAction = { commitment: "order_123", to: { type: "Fulfilled" }, actor: "agent" };
const dispute: ProposedAction = { commitment: "order_123", to: { type: "Disputed", by: partyId("agent"), reason: "damaged", opened_at: "2026-03-01T00:00:00.000Z" }, actor: "agent" };
// `Active` is a real transition with NO host-agnostic effect — the engine emits none for it.
const activate: ProposedAction = { commitment: "order_123", to: { type: "Active" }, actor: "agent" };

describe("toEffect — host-agnostic effect descriptors (describe, not execute)", () => {
  it("describes a refund as a neutral { kind, target, payload } descriptor", () => {
    const e = toEffect(refund(40));
    expect(e.ok).toBe(true);
    if (e.ok) {
      expect(e.platform).toBe("host");
      expect(e.descriptor).toEqual({
        kind: "refund",
        target: "order_123",
        payload: { amount: { amount: 40, currency: "MAD" } },
      });
    }
  });

  it("describes a cancel with an empty payload", () => {
    const e = toEffect(cancel);
    expect(e.ok).toBe(true);
    if (e.ok) {
      expect(e.descriptor).toEqual({ kind: "cancel", target: "order_123", payload: {} });
    }
  });

  it("describes fulfill, settle, and notify for their transitions", () => {
    const f = toEffect(fulfill);
    expect(f.ok && f.descriptor).toEqual({ kind: "fulfill", target: "order_123", payload: {} });
    const s = toEffect(accept);
    expect(s.ok && s.descriptor).toEqual({ kind: "settle", target: "order_123", payload: {} });
    const n = toEffect(dispute);
    expect(n.ok && n.descriptor).toEqual({ kind: "notify", target: "order_123", payload: { reason: "damaged" } });
  });

  it("returns an honest non-ok result for an action with no host-agnostic effect", () => {
    const e = toEffect(activate);
    expect(e.ok).toBe(false);
    if (!e.ok) {
      expect(e.platform).toBe("host");
      expect(e.reason).toContain("no host-agnostic effect");
      expect(e.reason).toContain("Active");
    }
  });

  it("never throws on a non-representable action — it returns a result", () => {
    expect(() => toEffect(activate)).not.toThrow();
  });

  it("is pure data — the descriptor carries no functions and is not a promise", () => {
    const e = toEffect(refund(10));
    expect(typeof e).toBe("object");
    if (e.ok) {
      expect(typeof (e.descriptor as { then?: unknown }).then).toBe("undefined");
      for (const v of Object.values(e.descriptor)) {
        expect(typeof v).not.toBe("function");
      }
    }
  });

  it("performs no I/O while describing (no network, no side effect)", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      toEffect(refund(40));
      toEffect(cancel);
      toEffect(accept);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not mutate the input action", () => {
    const action = refund(40);
    const snapshot = JSON.stringify(action);
    toEffect(action);
    expect(JSON.stringify(action)).toBe(snapshot);
  });
});

describe("toEffects — batch, order- and slot-preserving", () => {
  it("maps each action one-to-one, preserving order", () => {
    const results = toEffects([refund(40), cancel]);
    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(true);
    if (results[0]?.ok) expect(results[0].descriptor.kind).toBe("refund");
    if (results[1]?.ok) expect(results[1].descriptor.kind).toBe("cancel");
  });

  it("a non-representable action yields a non-ok result in its slot, not a thrown batch", () => {
    const results = toEffects([refund(40), activate, cancel]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
  });

  it("an empty batch yields an empty array", () => {
    expect(toEffects([])).toEqual([]);
  });
});
