/**
 * Bounded temporal verification — a reachability checker over the commitment
 * lifecycle's STATE MACHINE (Phase 4.1).
 *
 * The question it answers: "exploring the legal moves from a start state, up to a
 * bound, does the lifecycle ever reach a state via a transition the frozen model
 * FORBIDS?" — and, when it does, it returns the exact path (the counterexample a
 * developer can act on).
 *
 * WHAT THIS IS — bounded model-checking of the lifecycle's finite state machine.
 * The transition graph is finite ({@link validTransitions} gives the edges) and
 * the legality predicate is fixed ({@link isValidCommitmentTransition}, the model's
 * Invariant-2 / State-Monotonicity oracle), so reachability over it is tractable
 * and enumerable. It COMPOSES those two — it does not reimplement either.
 *
 * WHAT THIS IS NOT — it is NOT an unbounded proof, NOT complete over data values,
 * and NOT a statement that the system "can never fail". A reachable-violation
 * search returns one of three honest verdicts:
 *   - "violation-found"   — a reachable transition the model forbids, WITH its path.
 *   - "fixpoint-sound"    — the ENTIRE reachable set was enumerated (a true fixpoint:
 *                           no new states) and every explored transition is legal.
 *                           The reachable state-machine is sound. (This is a
 *                           statement about the STATE MACHINE, not about data-level
 *                           violations such as a specific over-refund amount — those
 *                           are I-1/I-3/I-4, a different axis, checked per concrete
 *                           event by `guardAction` / `step`.)
 *   - "sound-within-bound"— no reachable violation found UP TO the depth bound; the
 *                           graph was not fully explored (not a fixpoint).
 *
 * Where it is genuinely useful: testing a HYPOTHETICAL transition table (e.g. a
 * proposed new edge) against the real model's legality — "is adding this move
 * sound?" On the real, frozen table the answer is "fixpoint-sound" by construction;
 * the value is in catching a broken or proposed graph before it ships.
 */
import type { CommitmentState } from "./states.js";
import { validTransitions, isValidCommitmentTransition } from "./transitions.js";

/** A commitment state's discriminant — the node type in the reachability graph. */
export type StateType = CommitmentState["type"];

/**
 * The reachability graph as a function: the legal next state-types from a state.
 * Defaults to the real model ({@link validTransitions}); inject a different one to
 * verify a HYPOTHETICAL or deliberately-broken table against the real legality
 * oracle (this is how a proposed edge is checked for soundness, and how the demo
 * proves the checker actually catches a reachable violation).
 */
export type TransitionFn = (state: StateType) => StateType[];

/** The real model's edges, lifted to operate on bare state-types. */
const realTransitions: TransitionFn = (s) => validTransitions({ type: s } as CommitmentState);

export interface ReachOptions {
  /** Max BFS depth to explore. Omit to explore to fixpoint (the graph is finite). */
  bound?: number;
  /** The graph to explore. Defaults to the real model's {@link validTransitions}. */
  transitions?: TransitionFn;
}

export interface ReachResult {
  /** The reachable state-types (including the start), sorted for stable output. */
  states: StateType[];
  /** How many distinct states were reached. */
  explored: number;
  /**
   * True iff the reachable set was fully enumerated within the bound — a true
   * fixpoint (no unexplored successors remain). False means the bound truncated
   * exploration, so the set may be incomplete.
   */
  fixpointReached: boolean;
  /** The greatest BFS depth reached. */
  depthReached: number;
  /** The depth bound in effect, or null if unbounded. */
  bound: number | null;
}

/**
 * BFS over the transition graph from a start state, up to an optional depth bound.
 * Detects a fixpoint (no new states ⇒ the full reachable set was explored).
 * Composes {@link validTransitions}; reimplements no transition logic.
 */
export function reachableStates(from: StateType, opts: ReachOptions = {}): ReachResult {
  const transitions = opts.transitions ?? realTransitions;
  const bound = opts.bound ?? null;
  const depthOf = new Map<StateType, number>([[from, 0]]);
  const queue: StateType[] = [from];
  let truncated = false;
  let depthReached = 0;
  while (queue.length > 0) {
    const s = queue.shift() as StateType;
    const d = depthOf.get(s) as number;
    if (d > depthReached) depthReached = d;
    if (bound !== null && d >= bound) {
      // At the bound: do not expand. If this state has unexplored successors, the
      // bound truncated the search — not a fixpoint.
      if (transitions(s).some((t) => !depthOf.has(t))) truncated = true;
      continue;
    }
    for (const t of transitions(s)) {
      if (!depthOf.has(t)) {
        depthOf.set(t, d + 1);
        queue.push(t);
      }
    }
  }
  return {
    states: [...depthOf.keys()].sort(),
    explored: depthOf.size,
    fixpointReached: !truncated,
    depthReached,
    bound,
  };
}

/** A reachable transition the frozen model forbids, with the path that reaches it. */
export interface Violation {
  /** The state reached by the forbidden move. */
  state: StateType;
  /** The invariant the move violates (I-2: State Monotonicity / transition legality). */
  rule: string;
  /** The counterexample: legal states leading up to, then the forbidden final hop. */
  path: StateType[];
  /** A developer-facing explanation of the forbidden move. */
  message: string;
}

export type Verdict = "violation-found" | "fixpoint-sound" | "sound-within-bound";

export interface VerificationResult {
  /** The start state of the exploration. */
  start: StateType;
  /** How many distinct states were explored. */
  explored: number;
  /** True iff the reachable set was fully enumerated (a fixpoint). */
  fixpointReached: boolean;
  /** The depth bound in effect, or null if unbounded. */
  bound: number | null;
  /** Every distinct forbidden reachable transition found, each with its path. */
  violations: Violation[];
  /** The honest verdict — see the module doc for exact meaning. */
  verdict: Verdict;
}

export interface VerifyOptions {
  /** Start state. Defaults to "Draft" (the lifecycle entry). */
  from?: StateType;
  /** Max BFS depth. Omit to explore to fixpoint. */
  bound?: number;
  /**
   * The graph to verify. Defaults to the real model. Inject a hypothetical or
   * broken table to check whether IT ever permits a move the real model forbids.
   */
  transitions?: TransitionFn;
}

/**
 * Explore the reachable states of a commitment lifecycle and report whether any
 * reachable transition is one the frozen model forbids — and if so, the path.
 *
 * The oracle is the real {@link isValidCommitmentTransition} (the model's
 * Invariant-2 legality predicate). On the real {@link validTransitions} table
 * every edge is legal by construction, so the verdict is "fixpoint-sound": the
 * whole reachable state-machine was enumerated and is sound. Pass a hypothetical
 * `transitions` table to test a proposed change — a forbidden reachable move is
 * returned as a "violation-found" with its counterexample path.
 *
 * Pure: no I/O, no clock, no mutation; total: it always returns a result.
 */
export function verifyLifecycle(opts: VerifyOptions = {}): VerificationResult {
  const from: StateType = opts.from ?? "Draft";
  const transitions = opts.transitions ?? realTransitions;
  const bound = opts.bound ?? null;
  const depthOf = new Map<StateType, number>([[from, 0]]);
  const parent = new Map<StateType, StateType | null>([[from, null]]);
  const queue: StateType[] = [from];
  const violations: Violation[] = [];
  const seenForbiddenEdge = new Set<string>();
  let truncated = false;

  const pathTo = (s: StateType): StateType[] => {
    const path: StateType[] = [];
    let cur: StateType | null | undefined = s;
    while (cur != null) {
      path.unshift(cur);
      cur = parent.get(cur);
    }
    return path;
  };

  while (queue.length > 0) {
    const s = queue.shift() as StateType;
    const d = depthOf.get(s) as number;
    if (bound !== null && d >= bound) {
      if (transitions(s).some((t) => !depthOf.has(t))) truncated = true;
      continue;
    }
    for (const t of transitions(s)) {
      // The oracle: is this reachable edge legal in the frozen model? (Invariant 2)
      const legal = isValidCommitmentTransition(
        { type: s } as CommitmentState,
        { type: t } as CommitmentState,
      );
      if (!legal) {
        const key = `${s}->${t}`;
        if (!seenForbiddenEdge.has(key)) {
          seenForbiddenEdge.add(key);
          violations.push({
            state: t,
            rule: "I-2",
            path: [...pathTo(s), t],
            message:
              `Reachable transition '${s}' → '${t}' is not a legal move in the frozen model ` +
              `(Invariant 2: State Monotonicity). The explored graph permits a state the model forbids.`,
          });
        }
      }
      if (!depthOf.has(t)) {
        depthOf.set(t, d + 1);
        parent.set(t, s);
        queue.push(t);
      }
    }
  }

  const fixpointReached = !truncated;
  const verdict: Verdict =
    violations.length > 0 ? "violation-found" : fixpointReached ? "fixpoint-sound" : "sound-within-bound";
  return { start: from, explored: depthOf.size, fixpointReached, bound, violations, verdict };
}
