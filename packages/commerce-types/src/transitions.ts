/**
 * Transition validators — the heart of the package. They encode the exhaustive
 * valid-transition tables from WARP_COMMERCE_MODEL.md. Every transition not in
 * a table is rejected. This is how Invariant 2 (State Monotonicity) is enforced
 * at runtime; the `transition*` functions additionally enforce Invariant 4
 * (Temporal Integrity): history is append-only and timestamps never move
 * backward.
 */

import type {
  Commitment,
  CommitmentTransition,
  Fulfillment,
  FulfillmentTransition,
  Intent,
  IntentTransition,
  PartyID,
} from "./primitives.js";
import { now } from "./primitives.js";
import type {
  CommitmentState,
  CommitmentStateType,
  FulfillmentState,
  FulfillmentStateType,
  IntentState,
  IntentStateType,
} from "./states.js";

/** A fallible result. `error` is set (and `ok` is false) on failure. */
export interface Result<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** Thrown by callers who choose to `throw` on a failed transition. */
export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

/** Thrown when a party lacks the capacity required for an operation. */
export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

// ---------------------------------------------------------------------------
// Valid-transition tables (exhaustive)
// ---------------------------------------------------------------------------

/** The model's 26 valid commitment transitions. Every other pair is rejected. */
const COMMITMENT_TRANSITIONS: Record<CommitmentStateType, readonly CommitmentStateType[]> = {
  Draft: ["Proposed", "Tendered", "Cancelled"],
  Proposed: ["Accepted", "Cancelled", "Modified"],
  Tendered: ["Accepted", "Cancelled"],
  Accepted: ["Modified", "PartiallyFulfilled", "Active", "Cancelled", "Disputed"],
  Modified: ["Accepted", "Cancelled"],
  PartiallyFulfilled: ["Fulfilled", "Modified", "Cancelled"],
  Active: ["Modified", "Cancelled", "Disputed"],
  Fulfilled: ["Disputed", "Refunded"],
  Cancelled: [],
  Disputed: ["Fulfilled", "Refunded", "Cancelled"],
  Refunded: [],
};

const INTENT_TRANSITIONS: Record<IntentStateType, readonly IntentStateType[]> = {
  Active: ["Abandoned", "Converted", "Expired"],
  Abandoned: [],
  Converted: [],
  Expired: [],
};

const FULFILLMENT_TRANSITIONS: Record<FulfillmentStateType, readonly FulfillmentStateType[]> = {
  Planned: ["InProgress", "Failed"],
  InProgress: ["Completed", "Failed", "Reversed"],
  Completed: ["Reversed"],
  Failed: [], // Failed → Planned is handled specially (recoverable only)
  Reversed: [],
};

export function isValidCommitmentTransition(from: CommitmentState, to: CommitmentState): boolean {
  return COMMITMENT_TRANSITIONS[from.type].includes(to.type);
}

export function isValidIntentTransition(from: IntentState, to: IntentState): boolean {
  return INTENT_TRANSITIONS[from.type].includes(to.type);
}

export function isValidFulfillmentTransition(
  from: FulfillmentState,
  to: FulfillmentState,
): boolean {
  // A failed fulfillment may retry to Planned only if the failure was recoverable.
  if (from.type === "Failed") {
    return to.type === "Planned" ? from.recoverable : false;
  }
  return FULFILLMENT_TRANSITIONS[from.type].includes(to.type);
}

// ---------------------------------------------------------------------------
// Temporal integrity (Invariant 4)
// ---------------------------------------------------------------------------

/** True if `next` is not earlier than `prev` (equal is allowed). */
function timestampNotBefore(next: string, prev: string): boolean {
  const n = Date.parse(next);
  const p = Date.parse(prev);
  if (Number.isNaN(n) || Number.isNaN(p)) return next >= prev;
  return n >= p;
}

// ---------------------------------------------------------------------------
// State-advancing functions — immutable, append-only.
// ---------------------------------------------------------------------------

export function transitionCommitment(
  commitment: Commitment,
  to: CommitmentState,
  actor: PartyID,
  reason?: string,
): Result<Commitment> {
  if (!isValidCommitmentTransition(commitment.state, to)) {
    return {
      ok: false,
      error:
        `Commitment cannot transition from '${commitment.state.type}' to '${to.type}' — ` +
        `not a valid transition. A terminal state cannot move backward; to reverse a ` +
        `Fulfilled commitment, create a new Commitment with the parties exchanged ` +
        `(Invariant 2: State Monotonicity).`,
    };
  }
  const at = now();
  const last = commitment.history[commitment.history.length - 1];
  if (last && !timestampNotBefore(at, last.at)) {
    return {
      ok: false,
      error: `Transition timestamp '${at}' is earlier than the previous transition '${last.at}' (Invariant 4: Temporal Integrity).`,
    };
  }
  const entry: CommitmentTransition = {
    from: commitment.state,
    to,
    at,
    actor,
    ...(reason !== undefined ? { reason } : {}),
  };
  return { ok: true, value: { ...commitment, state: to, history: [...commitment.history, entry] } };
}

export function transitionIntent(
  intent: Intent,
  to: IntentState,
  actor: PartyID,
  reason?: string,
): Result<Intent> {
  if (!isValidIntentTransition(intent.state, to)) {
    return {
      ok: false,
      error: `Intent cannot transition from '${intent.state.type}' to '${to.type}' — not a valid transition (Invariant 2).`,
    };
  }
  const at = now();
  const last = intent.history[intent.history.length - 1];
  if (last && !timestampNotBefore(at, last.at)) {
    return {
      ok: false,
      error: `Intent transition timestamp '${at}' is earlier than the previous transition '${last.at}' (Invariant 4).`,
    };
  }
  const entry: IntentTransition = {
    from: intent.state,
    to,
    at,
    actor,
    ...(reason !== undefined ? { reason } : {}),
  };
  return { ok: true, value: { ...intent, state: to, history: [...intent.history, entry] } };
}

export function transitionFulfillment(
  fulfillment: Fulfillment,
  to: FulfillmentState,
  actor: PartyID,
): Result<Fulfillment> {
  if (!isValidFulfillmentTransition(fulfillment.state, to)) {
    return {
      ok: false,
      error: `Fulfillment cannot transition from '${fulfillment.state.type}' to '${to.type}' — not a valid transition (Invariant 2).`,
    };
  }
  const at = now();
  const last = fulfillment.history[fulfillment.history.length - 1];
  if (last && !timestampNotBefore(at, last.at)) {
    return {
      ok: false,
      error: `Fulfillment transition timestamp '${at}' is earlier than the previous transition '${last.at}' (Invariant 4).`,
    };
  }
  const entry: FulfillmentTransition = { from: fulfillment.state, to, at, actor };
  const next: Fulfillment = {
    ...fulfillment,
    state: to,
    history: [...fulfillment.history, entry],
  };
  if (to.type === "InProgress" && next.started_at === undefined) next.started_at = at;
  if (to.type === "Completed") next.completed_at = at;
  return { ok: true, value: next };
}
