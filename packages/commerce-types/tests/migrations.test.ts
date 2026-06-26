import { describe, expect, it } from "vitest";

import type { World } from "../src/guard.js";
import { commitmentId, newCommitment, partyId, valueId, type Commitment, type Value } from "../src/primitives.js";
import { applyCommitmentPath } from "../src/transitions.js";
import { defineMigration, migrate, SCHEMA_VERSION } from "../src/index.js";

const buyer = partyId("buyer");
const seller = partyId("seller");
const AT = "2026-03-01T00:00:00.000Z";

function moneyValue(amount: number): Value {
  return { id: valueId(), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } };
}

function commit(id: string, amount: number, to: Parameters<typeof applyCommitmentPath>[1]): Commitment {
  const base = { ...newCommitment(buyer, seller, { offered: [], requested: [moneyValue(amount)] }), id: commitmentId(id) };
  return applyCommitmentPath(base, to, seller);
}

/**
 * An ILLUSTRATIVE old-shaped record: a commitment written before `children` and
 * `history` were always present. Modelled by dropping those fields and viewing it
 * through the `World` shape — there is only one published schema version today, so
 * this stands in for "data from an older shape" to demonstrate the mechanism.
 */
function oldShapedWorld(): World {
  const c = commit("order-1", 200, { type: "Fulfilled" });
  const { children: _children, history: _history, ...withoutFields } = c;
  return { commitments: [withoutFields as unknown as Commitment], fulfillments: [], parties: [] };
}

/** The migration that brings the old shape to the current shape: default the missing arrays. */
const fillDefaults = defineMigration({
  from: "1.0.0",
  to: "1.1.0",
  transform: (world) => ({
    ...world,
    commitments: world.commitments.map((c) => ({ ...c, children: c.children ?? [], history: c.history ?? [] })),
  }),
});

describe("migrations — declarative data transform + re-audit (no schema edit)", () => {
  it("defineMigration validates its descriptor", () => {
    expect(() => defineMigration({ from: "", to: "1.1.0", transform: (w) => w })).toThrow();
    expect(() => defineMigration({ from: "1.0.0", to: "1.0.0", transform: (w) => w })).toThrow();
    // @ts-expect-error transform must be a function
    expect(() => defineMigration({ from: "1.0.0", to: "1.1.0", transform: null })).toThrow();
  });

  it("migrates an old-shaped world to the current shape and the audit passes", () => {
    const result = migrate(oldShapedWorld(), [fillDefaults], { from: "1.0.0", to: "1.1.0" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applied).toEqual(["1.0.0", "1.1.0"]);
      const c = result.world.commitments[0]!;
      expect(c.children).toEqual([]);
      expect(c.history).toEqual([]);
    }
  });

  it("applies migrations in provided order when no `from` is given", () => {
    const result = migrate(oldShapedWorld(), [fillDefaults]);
    expect(result.ok).toBe(true);
  });

  it("rejects a migration whose output violates an invariant (over-refund, I-1)", () => {
    // A transform that drives a 200-committed order into a Refunded state for 500 —
    // the existing audit (I-1 value conservation) catches it after the transform.
    const badRefund = defineMigration({
      from: "1.0.0",
      to: "1.1.0",
      transform: (world) => ({
        ...world,
        commitments: world.commitments.map((c) => ({
          ...c,
          children: [],
          history: [],
          state: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: AT } as Commitment["state"],
        })),
      }),
    });
    const result = migrate(oldShapedWorld(), [badRefund], { from: "1.0.0", to: "1.1.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("audit");
      expect(result.at).toBe("1.0.0→1.1.0");
      expect(result.violations.some((v) => v.rule === "I-1")).toBe(true);
    }
  });

  it("rejects a disconnected chain at resolution time", () => {
    const a = defineMigration({ from: "1.0.0", to: "1.1.0", transform: (w) => w });
    const c = defineMigration({ from: "1.2.0", to: "1.3.0", transform: (w) => w });
    const result = migrate(oldShapedWorld(), [a, c]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("chain");
  });

  it("chains multiple connected migrations in order", () => {
    const step1 = defineMigration({
      from: "1.0.0",
      to: "1.1.0",
      transform: (w) => ({ ...w, commitments: w.commitments.map((c) => ({ ...c, children: c.children ?? [], history: c.history ?? [] })) }),
    });
    const step2 = defineMigration({ from: "1.1.0", to: "1.2.0", transform: (w) => w });
    const result = migrate(oldShapedWorld(), [step1, step2], { from: "1.0.0", to: "1.2.0" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.applied).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
  });

  it("an empty migration set returns the world unchanged", () => {
    const world = commit("order-2", 100, { type: "Fulfilled" });
    const result = migrate({ commitments: [world], fulfillments: [], parties: [] }, []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.applied).toEqual([]);
  });

  it("the single live schema version remains 1.0.0 (this layer does not change it)", () => {
    expect(SCHEMA_VERSION).toBe("1.0.0");
  });
});
