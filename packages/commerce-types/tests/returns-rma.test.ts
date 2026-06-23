import { describe, expect, it } from "vitest";

import { createReturnsSession } from "../src/returns.js";
import type { World } from "../src/guard.js";
import { commitmentId, newCommitment, partyId, valueId, type Commitment, type Value } from "../src/primitives.js";
import { applyCommitmentPath } from "../src/transitions.js";

const buyer = partyId("buyer");
const seller = partyId("seller");

function moneyValue(amount: number): Value {
  return { id: valueId(), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } };
}

function commit(id: string, amount: number, links: Partial<Pick<Commitment, "parent" | "children">> = {}): Commitment {
  const base = { ...newCommitment(buyer, seller, { offered: [], requested: [moneyValue(amount)] }), id: commitmentId(id), ...links };
  return applyCommitmentPath(base, { type: "Fulfilled" }, seller);
}

/** A 200 order with two fulfilled line children (120 + 80) reconciling via I-6. */
function orderWorld(): World {
  return {
    commitments: [
      commit("order-1", 200, { children: [commitmentId("line-A"), commitmentId("line-B")] }),
      commit("line-A", 120, { parent: commitmentId("order-1") }),
      commit("line-B", 80, { parent: commitmentId("order-1") }),
    ],
    fulfillments: [],
    parties: [],
  };
}

function walkToInspected(session: ReturnType<typeof createReturnsSession>, rmaId: string) {
  for (const stage of ["authorized", "in_transit", "received", "inspected"] as const) {
    session.advance(rmaId, stage);
  }
}

describe("createReturnsSession — RMA lifecycle as a session-layer profile", () => {
  it("opens an RMA against an order line and starts at 'requested'", () => {
    const session = createReturnsSession(orderWorld());
    const opened = session.open({ id: "rma-1", order: "order-1", lines: [{ line: "line-A", amount: { amount: 120, currency: "MAD" } }] });
    expect(opened.ok).toBe(true);
    expect(session.rma("rma-1")?.stage).toBe("requested");
  });

  it("rejects opening against an order or line not in the world", () => {
    const session = createReturnsSession(orderWorld());
    expect(session.open({ id: "x", order: "missing", lines: [{ line: "line-A", amount: { amount: 1, currency: "MAD" } }] }).ok).toBe(false);
    expect(session.open({ id: "y", order: "order-1", lines: [{ line: "missing-line", amount: { amount: 1, currency: "MAD" } }] }).ok).toBe(false);
  });

  it("gates the refund: settling before 'inspected' is rejected as a stage violation", () => {
    const session = createReturnsSession(orderWorld());
    session.open({ id: "rma-1", order: "order-1", lines: [{ line: "line-A", amount: { amount: 120, currency: "MAD" } }] });
    const early = session.settle("rma-1", seller);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.violations[0]?.rule).toBe("rma-stage");
  });

  it("rejects an illegal stage move with the legal alternatives (overlay only)", () => {
    const session = createReturnsSession(orderWorld());
    session.open({ id: "rma-1", order: "order-1", lines: [{ line: "line-A", amount: { amount: 120, currency: "MAD" } }] });
    const bad = session.advance("rma-1", "received"); // requested → received skips authorized/in_transit
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.legal).toContain("authorized");
  });

  it("a partial return refunds its line and completes to 'refunded'", () => {
    const session = createReturnsSession(orderWorld());
    session.open({ id: "rma-1", order: "order-1", lines: [{ line: "line-A", amount: { amount: 120, currency: "MAD" } }] });
    walkToInspected(session, "rma-1");
    const settled = session.settle("rma-1", seller);
    expect(settled.ok).toBe(true);
    expect(session.refundedSoFar("line-A")?.amount).toBe(120);
    expect(session.rma("rma-1")?.stage).toBe("refunded");
  });

  it("an over-return is caught by the existing cap (line-B worth 80, return 120)", () => {
    const session = createReturnsSession(orderWorld());
    session.open({ id: "rma-2", order: "order-1", lines: [{ line: "line-B", amount: { amount: 120, currency: "MAD" } }] });
    walkToInspected(session, "rma-2");
    const over = session.settle("rma-2", seller);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.violations[0]?.rule).toBe("I-1");
  });

  it("over-return spread across RMAs is caught by the per-tree cap", () => {
    const session = createReturnsSession(orderWorld());
    // Return line-A fully (120) — fine.
    session.open({ id: "rma-1", order: "order-1", lines: [{ line: "line-A", amount: { amount: 120, currency: "MAD" } }] });
    walkToInspected(session, "rma-1");
    expect(session.settle("rma-1", seller).ok).toBe(true);
    // Now return line-B for 120 — each line under nothing, but the tree already has 120
    // of 200 refunded; 120 more would reach 240 > 200. Caught by the tree cap. (line-B's
    // own committed is 80, so this is caught regardless; the point is no over-return slips.)
    session.open({ id: "rma-2", order: "order-1", lines: [{ line: "line-B", amount: { amount: 120, currency: "MAD" } }] });
    walkToInspected(session, "rma-2");
    const over = session.settle("rma-2", seller);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.violations[0]?.rule).toBe("I-1");
  });

  it("a valid full return across both lines completes within the order total", () => {
    const session = createReturnsSession(orderWorld());
    session.open({ id: "rma-a", order: "order-1", lines: [{ line: "line-A", amount: { amount: 120, currency: "MAD" } }] });
    walkToInspected(session, "rma-a");
    expect(session.settle("rma-a", seller).ok).toBe(true);
    session.open({ id: "rma-b", order: "order-1", lines: [{ line: "line-B", amount: { amount: 80, currency: "MAD" } }] });
    walkToInspected(session, "rma-b");
    expect(session.settle("rma-b", seller).ok).toBe(true);
    const treeTotal = ["line-A", "line-B"].reduce((s, id) => s + (session.refundedSoFar(id)?.amount ?? 0), 0);
    expect(treeTotal).toBe(200); // == order committed
  });

  it("a rejected RMA (failed inspection) is terminal and cannot settle", () => {
    const session = createReturnsSession(orderWorld());
    session.open({ id: "rma-1", order: "order-1", lines: [{ line: "line-A", amount: { amount: 120, currency: "MAD" } }] });
    session.advance("rma-1", "authorized");
    expect(session.advance("rma-1", "rejected").ok).toBe(true);
    expect(session.advance("rma-1", "in_transit").ok).toBe(false); // terminal
    expect(session.settle("rma-1", seller).ok).toBe(false); // not inspected
  });

  it("reaching 'refunded' via advance() is not allowed — it is the settled stage", () => {
    const session = createReturnsSession(orderWorld());
    session.open({ id: "rma-1", order: "order-1", lines: [{ line: "line-A", amount: { amount: 120, currency: "MAD" } }] });
    for (const stage of ["authorized", "in_transit", "received", "inspected"] as const) session.advance("rma-1", stage);
    const bad = session.advance("rma-1", "refunded");
    expect(bad.ok).toBe(false);
  });
});
