import { describe, expect, it } from "vitest";
import {
  type CommitmentState,
  type Result,
  isValidCommitmentTransition,
  isValidFulfillmentTransition,
  isValidIntentTransition,
  newCommitment,
  newFulfillment,
  newIntent,
  partyId,
  transitionCommitment,
  transitionFulfillment,
  transitionIntent,
} from "../src/index.js";

/** Assert a Result is ok and return its value — narrows the union, so no `!`. */
function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.value;
}

/** Assert a Result is a failure and return its error — narrows the union. */
function unwrapErr<T>(r: Result<T>): string {
  if (r.ok) throw new Error("expected error, got ok");
  return r.error;
}

const p1 = partyId("p1");
const buyer = partyId("buyer");
const seller = partyId("seller");

// Commitment-state constructors with sample payloads.
const tendered: CommitmentState = {
  type: "Tendered",
  offer_amount: 100,
  offer_currency: "MAD",
  closes_at: "2099-01-01T00:00:00.000Z",
};
const modified: CommitmentState = { type: "Modified", modified_by: p1, reason: "x" };
const partially: CommitmentState = {
  type: "PartiallyFulfilled",
  fulfilled_item_ids: ["i1"],
  remaining_item_ids: ["i2"],
};
const cancelled: CommitmentState = { type: "Cancelled", by: p1, reason: "x", at: "2099-01-01T00:00:00.000Z" };
const disputed: CommitmentState = { type: "Disputed", by: p1, reason: "x", opened_at: "2099-01-01T00:00:00.000Z" };
const refunded: CommitmentState = { type: "Refunded", amount: { amount: 100, currency: "MAD" }, at: "2099-01-01T00:00:00.000Z" };

describe("commitment transition table", () => {
  const valid: Array<[CommitmentState, CommitmentState]> = [
    [{ type: "Draft" }, { type: "Proposed" }],
    [{ type: "Draft" }, tendered],
    [{ type: "Draft" }, cancelled],
    [{ type: "Proposed" }, { type: "Accepted" }],
    [{ type: "Proposed" }, cancelled],
    [{ type: "Proposed" }, modified],
    [tendered, { type: "Accepted" }],
    [tendered, cancelled],
    [{ type: "Accepted" }, modified],
    [{ type: "Accepted" }, partially],
    [{ type: "Accepted" }, { type: "Active" }],
    [{ type: "Accepted" }, cancelled],
    [{ type: "Accepted" }, disputed],
    [modified, { type: "Accepted" }],
    [modified, cancelled],
    [partially, { type: "Fulfilled" }],
    [partially, modified],
    [partially, cancelled],
    [{ type: "Active" }, modified],
    [{ type: "Active" }, cancelled],
    [{ type: "Active" }, disputed],
    [{ type: "Fulfilled" }, disputed],
    [{ type: "Fulfilled" }, refunded],
    [disputed, { type: "Fulfilled" }],
    [disputed, refunded],
    [disputed, cancelled],
  ];

  it("has exactly 26 valid transitions, all accepted", () => {
    expect(valid.length).toBe(26);
    for (const [from, to] of valid) {
      expect(isValidCommitmentTransition(from, to)).toBe(true);
    }
  });

  it("Draft → Fulfilled is invalid", () => {
    expect(isValidCommitmentTransition({ type: "Draft" }, { type: "Fulfilled" })).toBe(false);
  });

  it("Fulfilled → Accepted is invalid (Invariant 2)", () => {
    expect(isValidCommitmentTransition({ type: "Fulfilled" }, { type: "Accepted" })).toBe(false);
  });

  it("Cancelled → anything is invalid (terminal)", () => {
    expect(isValidCommitmentTransition(cancelled, { type: "Accepted" })).toBe(false);
    expect(isValidCommitmentTransition(cancelled, { type: "Fulfilled" })).toBe(false);
  });

  it("Modified → Accepted is valid (the loop missing from the diagram)", () => {
    expect(isValidCommitmentTransition(modified, { type: "Accepted" })).toBe(true);
  });

  it("Tendered → Accepted is valid (auction completion)", () => {
    expect(isValidCommitmentTransition(tendered, { type: "Accepted" })).toBe(true);
  });

  it("rejects all backward transitions", () => {
    const backward: Array<[CommitmentState, CommitmentState]> = [
      [{ type: "Fulfilled" }, { type: "Accepted" }],
      [{ type: "Accepted" }, { type: "Draft" }],
      [{ type: "Accepted" }, { type: "Proposed" }],
      [{ type: "Active" }, { type: "Fulfilled" }],
      [refunded, { type: "Accepted" }],
    ];
    for (const [from, to] of backward) {
      expect(isValidCommitmentTransition(from, to)).toBe(false);
    }
  });
});

describe("transitionCommitment", () => {
  it("advances through valid states and records history", () => {
    const c0 = newCommitment(buyer, seller);
    const r1 = transitionCommitment(c0, { type: "Proposed" }, buyer);
    expect(r1.ok).toBe(true);
    const r2 = transitionCommitment(unwrap(r1), { type: "Accepted" }, seller);
    expect(r2.ok).toBe(true);
    const c2 = unwrap(r2);
    expect(c2.state.type).toBe("Accepted");
    expect(c2.history.length).toBe(2);
  });

  it("rejects an invalid transition with a clear error", () => {
    const c0 = newCommitment(buyer, seller);
    const r = transitionCommitment(c0, { type: "Fulfilled" }, buyer);
    expect(r.ok).toBe(false);
    expect(unwrapErr(r)).toContain("Invariant 2");
  });

  it("is immutable and append-only — the input is never mutated", () => {
    const c0 = newCommitment(buyer, seller);
    const r = transitionCommitment(c0, { type: "Proposed" }, buyer);
    expect(r.ok).toBe(true);
    expect(c0.history.length).toBe(0); // original untouched
    expect(unwrap(r).history.length).toBe(1);
  });

  it("rejects a transition timestamped before the previous one (Invariant 4)", () => {
    const c0 = newCommitment(buyer, seller);
    c0.history.push({ from: { type: "Draft" }, to: { type: "Draft" }, at: "2999-01-01T00:00:00.000Z", actor: buyer });
    const r = transitionCommitment(c0, { type: "Proposed" }, buyer);
    expect(r.ok).toBe(false);
    expect(unwrapErr(r)).toContain("Invariant 4");
  });
});

describe("intent transitions", () => {
  it("Active → Abandoned is valid; Abandoned → Active is not", () => {
    expect(isValidIntentTransition({ type: "Active" }, { type: "Abandoned" })).toBe(true);
    expect(isValidIntentTransition({ type: "Abandoned" }, { type: "Active" })).toBe(false);
  });

  it("transitionIntent records the move", () => {
    const i = newIntent(buyer);
    const r = transitionIntent(i, { type: "Abandoned" }, buyer, "timeout");
    expect(r.ok).toBe(true);
    const moved = unwrap(r);
    expect(moved.state.type).toBe("Abandoned");
    expect(moved.history[0]!.reason).toBe("timeout");
  });
});

describe("fulfillment transitions", () => {
  it("Planned → InProgress valid; Planned → Completed invalid", () => {
    expect(isValidFulfillmentTransition({ type: "Planned" }, { type: "InProgress" })).toBe(true);
    expect(isValidFulfillmentTransition({ type: "Planned" }, { type: "Completed" })).toBe(false);
  });

  it("Failed retries to Planned only when recoverable", () => {
    expect(
      isValidFulfillmentTransition({ type: "Failed", reason: "x", recoverable: true }, { type: "Planned" }),
    ).toBe(true);
    expect(
      isValidFulfillmentTransition({ type: "Failed", reason: "x", recoverable: false }, { type: "Planned" }),
    ).toBe(false);
  });

  it("sets started_at and completed_at as it advances", () => {
    const f = newFulfillment(newCommitment(buyer, seller).id);
    const r1 = transitionFulfillment(f, { type: "InProgress" }, buyer);
    expect(r1.ok).toBe(true);
    const f1 = unwrap(r1);
    expect(f1.started_at).toBeDefined();
    const r2 = transitionFulfillment(f1, { type: "Completed" }, buyer);
    expect(unwrap(r2).completed_at).toBeDefined();
  });
});
