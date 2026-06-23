import { describe, expect, it } from "vitest";

import { commitmentVersion, type World } from "../src/guard.js";
import { commitmentId, newCommitment, partyId, valueId, type Commitment, type Value } from "../src/primitives.js";
import {
  compensate,
  compensateSession,
  planCompensation,
  validateCompensation,
  type ForwardStep,
} from "../src/saga.js";
import { createSession } from "../src/session.js";
import { SCHEMA_VERSION } from "../src/index.js";
import { applyCommitmentPath } from "../src/transitions.js";

const buyer = partyId("buyer");
const seller = partyId("seller");
const AT = "2026-03-01T00:00:00.000Z";

function moneyValue(amount: number): Value {
  return { id: valueId(), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } };
}

/** A commitment with id/amount driven to `to`. */
function commit(id: string, amount: number, to: Parameters<typeof applyCommitmentPath>[1]): Commitment {
  const base = { ...newCommitment(buyer, seller, { offered: [], requested: [moneyValue(amount)] }), id: commitmentId(id) };
  return applyCommitmentPath(base, to, seller);
}

function fulfilled(id: string, amount: number): Commitment {
  return commit(id, amount, { type: "Fulfilled" });
}

const fulfillStep = (id: string): ForwardStep => ({ commitment: id, to: { type: "Fulfilled" }, actor: seller });

describe("saga / compensation — validate compensating sequences for coherence", () => {
  it("plans a Refund to reverse a Fulfilled step (default mapping)", () => {
    const order = fulfilled("order-1", 200);
    const world: World = { commitments: [order], fulfillments: [], parties: [] };
    const plan = planCompensation(world, [fulfillStep("order-1")], AT);
    expect(plan.steps).toHaveLength(1);
    const action = plan.steps[0]?.action;
    expect(action).not.toBeNull();
    expect(action?.to.type).toBe("Refunded");
    if (action?.to.type === "Refunded") expect(action.to.amount.amount).toBe(200);
  });

  it("a valid compensation sequence completes, leaving a coherent (fully Refunded) world", () => {
    const order = fulfilled("order-1", 200);
    const { result } = compensate({ commitments: [order], fulfillments: [], parties: [] }, [fulfillStep("order-1")], AT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applied).toBe(1);
      const finalState = result.next.commitments.find((c) => (c.id as string) === "order-1")?.state.type;
      expect(finalState).toBe("Refunded");
    }
  });

  it("rejects an invariant-violating reversal: over-refund while reversing a partially-refunded flow", () => {
    // Forward flow: fulfill, then a partial refund of 50 tracked in the session ledger.
    const order = fulfilled("order-1", 200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    expect(session.propose({ commitment: "order-1", to: { type: "Refunded", amount: { amount: 50, currency: "MAD" }, at: AT }, actor: seller, idempotencyKey: "partial-50" }).ok).toBe(true);

    // Compensation that refunds the FULL 200 again → 50 + 200 = 250 > 200 (over-refund).
    const overRefund: ForwardStep[] = [
      { commitment: "order-1", to: { type: "Fulfilled" }, actor: seller, compensateWith: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: AT } },
    ];
    const { result } = compensateSession(session, overRefund, AT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedAt).toBe(0);
      expect(result.violations[0]?.rule).toBe("I-1");
      expect(result.violations[0]?.message).toContain("250");
      // Bounded guidance points at the remaining-refundable (150).
      const alt = (result.alternatives ?? []).find((a) => a.to === "Refunded");
      expect(alt?.bounded).toContain("150");
    }
  });

  it("the same partially-refunded flow accepts the bounded (remaining 150) compensation", () => {
    const order = fulfilled("order-1", 200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    session.propose({ commitment: "order-1", to: { type: "Refunded", amount: { amount: 50, currency: "MAD" }, at: AT }, actor: seller, idempotencyKey: "partial-50" });
    const remaining: ForwardStep[] = [
      { commitment: "order-1", to: { type: "Fulfilled" }, actor: seller, compensateWith: { type: "Refunded", amount: { amount: 150, currency: "MAD" }, at: AT } },
    ];
    const { result } = compensateSession(session, remaining, AT);
    expect(result.ok).toBe(true);
    expect(session.refundedSoFar("order-1")?.amount).toBe(200);
    expect(session.world.commitments.find((c) => (c.id as string) === "order-1")?.state.type).toBe("Refunded");
  });

  it("reverses a committed-but-not-delivered step (Active) by Cancellation (default mapping)", () => {
    const lease = commit("lease-1", 100, { type: "Active" });
    const { plan, result } = compensate({ commitments: [lease], fulfillments: [], parties: [] }, [{ commitment: "lease-1", to: { type: "Active" }, actor: seller }], AT);
    expect(plan.steps[0]?.action?.to.type).toBe("Cancelled");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.commitments.find((c) => (c.id as string) === "lease-1")?.state.type).toBe("Cancelled");
  });

  it("skips a step that has nothing to reverse (already Refunded — a terminal compensation target)", () => {
    const refunded = applyCommitmentPath({ ...newCommitment(buyer, seller, { offered: [], requested: [moneyValue(200)] }), id: commitmentId("order-2") }, { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: AT }, seller);
    const world: World = { commitments: [refunded], fulfillments: [], parties: [] };
    const plan = planCompensation(world, [{ commitment: "order-2", to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: AT }, actor: seller }], AT);
    expect(plan.steps[0]?.action).toBeNull();
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.reason).toContain("terminal");
  });

  it("rejects an illegal compensateWith override (not a legal transition from the current state)", () => {
    const fulfilledOrder = fulfilled("order-1", 200);
    const world: World = { commitments: [fulfilledOrder], fulfillments: [], parties: [] };
    // Fulfilled → Accepted is NOT a legal transition; an override demanding it is skipped with guidance.
    const plan = planCompensation(world, [{ commitment: "order-1", to: { type: "Fulfilled" }, actor: seller, compensateWith: { type: "Accepted" } }], AT);
    expect(plan.steps[0]?.action).toBeNull();
    expect(plan.skipped[0]?.reason).toContain("not a legal transition");
  });

  it("composes with F4 replay: re-validating the same compensation does not double-apply", () => {
    const order = fulfilled("order-1", 200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    const plan = planCompensation(session.world, [fulfillStep("order-1")], AT);
    const first = validateCompensation(session, plan);
    expect(first.ok).toBe(true);
    // Re-running the SAME plan against the same session is a replay — the order is
    // already fully refunded; the compensation's idempotency key dedups, no double refund.
    const again = validateCompensation(session, plan);
    expect(again.ok).toBe(true);
    expect(session.refundedSoFar("order-1")?.amount).toBe(200); // still 200, not 400
  });

  it("composes with F3 conflict: a stale-version compensation surfaces the conflict", () => {
    const order = fulfilled("order-1", 200);
    const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
    const staleVersion = commitmentVersion(session.world.commitments[0]!);
    // A concurrent actor disputes the order — a real transition that appends history,
    // so the planned `Fulfilled` version is now stale.
    expect(session.propose({ commitment: "order-1", to: { type: "Disputed", by: buyer, reason: "item missing", opened_at: AT }, actor: buyer }).ok).toBe(true);
    // A compensation planned against the stale version conflicts (re-read & re-plan).
    const stalePlan = planCompensation(session.world, [{ commitment: "order-1", to: { type: "Fulfilled" }, actor: seller, compensateWith: { type: "Refunded", amount: { amount: 100, currency: "MAD" }, at: AT } }], AT);
    const action = stalePlan.steps[0]?.action;
    expect(action).not.toBeNull();
    if (action) action.expectedVersion = staleVersion;
    const result = validateCompensation(session, stalePlan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toBe(true);
  });

  it("unwinds in reverse order (last forward step compensated first)", () => {
    const a = fulfilled("order-A", 100);
    const b = commit("order-B", 100, { type: "Active" });
    const world: World = { commitments: [a, b], fulfillments: [], parties: [] };
    const plan = planCompensation(world, [fulfillStep("order-A"), { commitment: "order-B", to: { type: "Active" }, actor: seller }], AT);
    // forward = [A, B] → unwind = [B first, A second].
    expect(plan.steps[0]?.forward.commitment).toBe("order-B");
    expect(plan.steps[1]?.forward.commitment).toBe("order-A");
  });

  it("schema is frozen (SCHEMA_VERSION unchanged by the saga module)", () => {
    expect(SCHEMA_VERSION).toBe("1.0.0");
  });
});
