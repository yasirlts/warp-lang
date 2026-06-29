/**
 * Bounded reachability checker (Phase 4.1). These tests pin its contract: it
 * enumerates the real lifecycle to a fixpoint with NO false violation, it catches
 * a reachable forbidden move on a broken graph WITH the correct counterexample
 * path, and it honestly distinguishes a bound-truncated search from a fixpoint.
 */
import { describe, it, expect } from "vitest";
import { reachableStates, verifyLifecycle, validTransitions } from "../src/index.js";
import type { StateType, TransitionFn } from "../src/verify.js";
import type { CommitmentState } from "../src/states.js";

const vt: TransitionFn = (s) => validTransitions({ type: s } as CommitmentState);

const REAL_STATES: StateType[] = [
  "Accepted", "Active", "Cancelled", "Disputed", "Draft", "Fulfilled",
  "Modified", "PartiallyFulfilled", "Proposed", "Refunded", "Tendered",
];

describe("reachableStates — BFS over the real transition graph", () => {
  it("enumerates the full reachable set from 'Draft' and reaches a fixpoint", () => {
    const r = reachableStates("Draft");
    expect(r.states).toEqual(REAL_STATES); // sorted, complete
    expect(r.explored).toBe(11);
    expect(r.fixpointReached).toBe(true);
    expect(r.bound).toBeNull();
  });

  it("a terminal state reaches only itself (fixpoint at depth 0)", () => {
    const r = reachableStates("Cancelled");
    expect(r.states).toEqual(["Cancelled"]);
    expect(r.fixpointReached).toBe(true);
    expect(r.depthReached).toBe(0);
  });

  it("respects a depth bound — a truncated search is NOT a fixpoint", () => {
    const r = reachableStates("Draft", { bound: 1 });
    // depth 0 = Draft; depth 1 = its direct successors only
    expect(r.states).toEqual(["Cancelled", "Draft", "Proposed", "Tendered"]);
    expect(r.fixpointReached).toBe(false); // Proposed/Tendered have unexplored successors
    expect(r.depthReached).toBe(1);
    expect(r.bound).toBe(1);
  });
});

describe("verifyLifecycle — the real model is sound at fixpoint (no false violation)", () => {
  it("reports 'fixpoint-sound' with zero violations on the real lifecycle", () => {
    const v = verifyLifecycle({ from: "Draft" });
    expect(v.verdict).toBe("fixpoint-sound");
    expect(v.violations).toEqual([]);
    expect(v.fixpointReached).toBe(true);
    expect(v.explored).toBe(11);
  });

  it("a bounded search with no reachable violation is 'sound-within-bound', not a fixpoint", () => {
    const v = verifyLifecycle({ from: "Draft", bound: 2 });
    expect(v.verdict).toBe("sound-within-bound");
    expect(v.violations).toEqual([]);
    expect(v.fixpointReached).toBe(false);
  });
});

describe("verifyLifecycle — catches a reachable forbidden move with its path", () => {
  // Inject a broken table: an extra 'Fulfilled' -> 'Active' edge the model forbids.
  const broken: TransitionFn = (s) => (s === "Fulfilled" ? [...vt(s), "Active"] : vt(s));

  it("finds the violation, labels it I-2, and returns the counterexample path", () => {
    const v = verifyLifecycle({ from: "Draft", transitions: broken });
    expect(v.verdict).toBe("violation-found");
    expect(v.violations).toHaveLength(1);
    const [first] = v.violations;
    expect(first!.rule).toBe("I-2");
    expect(first!.state).toBe("Active");
    // the path is legal moves up to Fulfilled, then the forbidden final hop
    expect(first!.path).toEqual(["Draft", "Proposed", "Accepted", "PartiallyFulfilled", "Fulfilled", "Active"]);
    expect(first!.path[first!.path.length - 1]).toBe("Active");
  });

  it("a forbidden self-loop on a terminal state is caught (Refunded -> Proposed)", () => {
    const reopen: TransitionFn = (s) => (s === "Refunded" ? ["Proposed"] : vt(s));
    const v = verifyLifecycle({ from: "Draft", transitions: reopen });
    expect(v.verdict).toBe("violation-found");
    expect(v.violations.some((x) => x.path.join(">").endsWith("Refunded>Proposed"))).toBe(true);
  });

  it("is total — always returns a result, never throws", () => {
    expect(() => verifyLifecycle({ from: "Fulfilled", transitions: broken })).not.toThrow();
  });
});
