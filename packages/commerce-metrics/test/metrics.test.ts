/**
 * Tests for the metrics wrapper. They assert three things:
 *   1. the wrapper returns a verdict IDENTICAL to raw guardAction (no behavior change);
 *   2. blocks increment the right rule and scope counters;
 *   3. valid actions do not increment any block counter.
 *
 * Fixtures are built with the published commerce-types helpers, so the wrapper is
 * exercised against genuine objects and genuine verdicts.
 */
import { describe, it, expect } from "vitest";
import { newCommitment, applyCommitmentPath, partyId, valueId, guardAction } from "@warp-lang/commerce-types";
import type { CommitmentState, ProposedAction, World } from "@warp-lang/commerce-types";
import { withMetrics, MetricsCollector } from "../src/index.js";

function fulfilledOrder(amount = 200, currency = "MAD") {
  const buyer = partyId("buyer_1");
  const seller = partyId("seller_1");
  const order = newCommitment(buyer, seller, {
    offered: [],
    requested: [
      {
        id: valueId("value:order-total"),
        form: { kind: "Money", money: { amount, currency } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  const shipped = applyCommitmentPath(order, { type: "Fulfilled" }, seller);
  const world: World = { commitments: [shipped], fulfillments: [], parties: [] };
  return { shipped, seller, world };
}

const refundTo = (amount: number, currency = "MAD"): CommitmentState => ({
  type: "Refunded",
  amount: { amount, currency },
  at: "2026-02-01T00:00:00.000Z",
});

describe("withMetrics — verdict parity", () => {
  it("returns a verdict identical to raw guardAction for a valid action", () => {
    const { shipped, seller, world } = fulfilledOrder(200);
    const action: ProposedAction = { commitment: shipped.id, to: refundTo(200), actor: seller };

    const raw = guardAction(world, action);
    const guarded = withMetrics()(structuredClone(world), structuredClone(action));

    expect(guarded).toEqual(raw);
    expect(guarded.ok).toBe(true);
  });

  it("returns a verdict identical to raw guardAction for a blocked action", () => {
    const { shipped, seller, world } = fulfilledOrder(200);
    const action: ProposedAction = { commitment: shipped.id, to: refundTo(500), actor: seller };

    const raw = guardAction(world, action);
    const guarded = withMetrics()(structuredClone(world), structuredClone(action));

    expect(guarded).toEqual(raw);
    expect(guarded.ok).toBe(false);
  });
});

describe("withMetrics — block counting", () => {
  it("increments I-1 for an over-refund", () => {
    const collector = new MetricsCollector();
    const guard = withMetrics(undefined, collector);
    const { shipped, seller, world } = fulfilledOrder(200);

    const verdict = guard(world, { commitment: shipped.id, to: refundTo(500), actor: seller });

    expect(verdict.ok).toBe(false);
    const snap = collector.snapshot();
    expect(snap.totalBlocks).toBe(1);
    expect(snap.byRule["I-1"]).toBe(1);
    expect(snap.byScope["Refunded"]).toBe(1);
  });

  it("increments I-2 for an illegal backward move", () => {
    const collector = new MetricsCollector();
    const guard = withMetrics(undefined, collector);
    const { shipped, seller, world } = fulfilledOrder(200);

    const verdict = guard(world, { commitment: shipped.id, to: { type: "Draft" }, actor: seller });

    expect(verdict.ok).toBe(false);
    const snap = collector.snapshot();
    expect(snap.totalBlocks).toBe(1);
    expect(snap.byRule["I-2"]).toBe(1);
    expect(snap.byScope["Draft"]).toBe(1);
  });

  it("accumulates counts per rule across several actions", () => {
    const collector = new MetricsCollector();
    const guard = withMetrics(undefined, collector);

    {
      const { shipped, seller, world } = fulfilledOrder(200);
      guard(world, { commitment: shipped.id, to: refundTo(500), actor: seller }); // I-1
    }
    {
      const { shipped, seller, world } = fulfilledOrder(200);
      guard(world, { commitment: shipped.id, to: refundTo(300), actor: seller }); // I-1
    }
    {
      const { shipped, seller, world } = fulfilledOrder(200);
      guard(world, { commitment: shipped.id, to: { type: "Draft" }, actor: seller }); // I-2
    }

    const snap = collector.snapshot();
    expect(snap.totalBlocks).toBe(3);
    expect(snap.byRule["I-1"]).toBe(2);
    expect(snap.byRule["I-2"]).toBe(1);
    expect(snap.byScope["Refunded"]).toBe(2);
    expect(snap.byScope["Draft"]).toBe(1);
  });
});

describe("withMetrics — valid actions do not increment block counters", () => {
  it("records allowed and leaves byRule/byScope empty for valid actions", () => {
    const collector = new MetricsCollector();
    const guard = withMetrics(undefined, collector);

    {
      const { shipped, seller, world } = fulfilledOrder(200);
      const v = guard(world, { commitment: shipped.id, to: refundTo(200), actor: seller });
      expect(v.ok).toBe(true);
    }
    {
      const { shipped, seller, world } = fulfilledOrder(150);
      const v = guard(world, { commitment: shipped.id, to: refundTo(150), actor: seller });
      expect(v.ok).toBe(true);
    }

    const snap = collector.snapshot();
    expect(snap.totalAllowed).toBe(2);
    expect(snap.totalBlocks).toBe(0);
    expect(Object.keys(snap.byRule)).toHaveLength(0);
    expect(Object.keys(snap.byScope)).toHaveLength(0);
  });

  it("counts only the blocks in a mixed sequence", () => {
    const collector = new MetricsCollector();
    const guard = withMetrics(undefined, collector);

    {
      const { shipped, seller, world } = fulfilledOrder(200);
      guard(world, { commitment: shipped.id, to: refundTo(200), actor: seller }); // ok
    }
    {
      const { shipped, seller, world } = fulfilledOrder(200);
      guard(world, { commitment: shipped.id, to: refundTo(500), actor: seller }); // I-1
    }

    const snap = collector.snapshot();
    expect(snap.totalAllowed).toBe(1);
    expect(snap.totalBlocks).toBe(1);
    expect(snap.byRule["I-1"]).toBe(1);
  });
});

describe("withMetrics — custom scope", () => {
  it("uses a caller-supplied scopeOf", () => {
    const collector = new MetricsCollector();
    const guard = withMetrics(undefined, collector, { scopeOf: () => "refunds-team" });
    const { shipped, seller, world } = fulfilledOrder(200);

    guard(world, { commitment: shipped.id, to: refundTo(500), actor: seller });

    const snap = collector.snapshot();
    expect(snap.byScope["refunds-team"]).toBe(1);
  });
});

describe("MetricsCollector", () => {
  it("reset clears all counters", () => {
    const collector = new MetricsCollector();
    collector.recordBlock({ rules: ["I-1"], scope: "Refunded" });
    collector.recordAllowed();
    collector.reset();

    const snap = collector.snapshot();
    expect(snap.totalBlocks).toBe(0);
    expect(snap.totalAllowed).toBe(0);
    expect(Object.keys(snap.byRule)).toHaveLength(0);
    expect(Object.keys(snap.byScope)).toHaveLength(0);
  });

  it("a single block citing two rules increments both", () => {
    const collector = new MetricsCollector();
    collector.recordBlock({ rules: ["I-1", "I-3"], scope: "Refunded" });

    const snap = collector.snapshot();
    expect(snap.totalBlocks).toBe(1);
    expect(snap.byRule["I-1"]).toBe(1);
    expect(snap.byRule["I-3"]).toBe(1);
  });
});
