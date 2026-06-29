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
  FulfillmentState,
  IntentState,
} from "./states.js";

/**
 * An injectable clock: returns an ISO-8601 instant for a transition's
 * `history[].at`. Defaults to the real wall clock ({@link now}). Supplying a
 * FIXED clock makes a transition — and the engine that composes it — byte-for-byte
 * deterministic (replay, simulation, tests). The injected time is NOT exempt from
 * Invariant 4 (Temporal Integrity): a time earlier than the previous transition is
 * still rejected, exactly as a wall-clock time would be. The clock is injectable;
 * temporal integrity is not negotiable.
 */
export type Clock = () => string;
// The valid-transition tables are GENERATED from schema/behavior/transitions.json
// (the 26 commitment edges, intent, and fulfillment maps) — they are no longer
// hand-maintained here. The Failed -> Planned recoverable special case below is
// applied in code, exactly as the schema's transitions.json note documents.
import {
  COMMITMENT_TRANSITIONS,
  FULFILLMENT_TRANSITIONS,
  INTENT_TRANSITIONS,
} from "./generated/transitions.generated.js";

/**
 * A fallible result: either a success carrying `value`, or a failure carrying
 * `error`. Discriminated on `ok` — `if (r.ok)` narrows to the success branch, so
 * `r.value` is available with no non-null assertion (and `r.error` only exists on
 * the failure branch).
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

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
// Valid-transition checks (tables generated from schema/behavior/transitions.json)
// ---------------------------------------------------------------------------

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
// Move enumeration — the legal target states from a given state. These are a
// pure read of the SAME generated tables the `isValid*` checks consult, so the
// set is correct by construction: `validTransitions(s)` lists exactly the
// targets for which `isValidCommitmentTransition(s, { type })` is true. A
// terminal state (Cancelled, Refunded) returns an empty array.
//
// This is the planning-oracle primitive: when an action is rejected, an agent
// can read the legal alternatives from the current state and pick one, instead
// of blindly retrying. The returned targets are LEGAL TRANSITIONS — not
// guaranteed-safe actions: a move may be a valid transition yet still be
// rejected by another invariant (e.g. Fulfilled -> Refunded is legal, but an
// over-refund still fails I-1 on amount).
// ---------------------------------------------------------------------------

export function validTransitions(from: CommitmentState): CommitmentState["type"][] {
  return [...COMMITMENT_TRANSITIONS[from.type]];
}

export function validIntentTransitions(from: IntentState): IntentState["type"][] {
  return [...INTENT_TRANSITIONS[from.type]];
}

export function validFulfillmentTransitions(from: FulfillmentState): FulfillmentState["type"][] {
  // Mirror isValidFulfillmentTransition: the Failed -> Planned retry is gated on
  // `recoverable` and is intentionally NOT in the generated table, so apply the
  // same rule here rather than reading a non-existent row entry.
  if (from.type === "Failed") {
    return from.recoverable ? ["Planned"] : [];
  }
  return [...FULFILLMENT_TRANSITIONS[from.type]];
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
  clock: Clock = now,
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
  const at = clock();
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
  clock: Clock = now,
): Result<Intent> {
  if (!isValidIntentTransition(intent.state, to)) {
    return {
      ok: false,
      error: `Intent cannot transition from '${intent.state.type}' to '${to.type}' — not a valid transition (Invariant 2).`,
    };
  }
  const at = clock();
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
  clock: Clock = now,
): Result<Fulfillment> {
  if (!isValidFulfillmentTransition(fulfillment.state, to)) {
    return {
      ok: false,
      error: `Fulfillment cannot transition from '${fulfillment.state.type}' to '${to.type}' — not a valid transition (Invariant 2).`,
    };
  }
  const at = clock();
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

// ---------------------------------------------------------------------------
// History synthesis — reconstruct a *valid* history for an object known only in
// its final state.
//
// A platform adapter that maps, say, a paid+fulfilled Shopify order knows the
// final state (`Fulfilled`) but not the path that produced it. Setting the
// final state with an empty history makes the object fail the package's own
// auditor: `checkI4TemporalIntegrity` derives "did this reach Accepted?" from
// history entries, so an empty-history Fulfilled order falsely reports an
// Invariant-4 violation. These helpers replay the canonical path from the
// initial state through the transition functions above, so the synthesized
// history is valid by construction and the auditor passes.
// ---------------------------------------------------------------------------

/** The states to pass through (after Draft) to reach `target`. */
function commitmentPath(target: CommitmentState): CommitmentState[] {
  const proposed: CommitmentState = { type: "Proposed" };
  const accepted: CommitmentState = { type: "Accepted" };
  const partiallyFulfilled: CommitmentState = {
    type: "PartiallyFulfilled",
    fulfilled_item_ids: [],
    remaining_item_ids: [],
  };
  const fulfilled: CommitmentState = { type: "Fulfilled" };
  switch (target.type) {
    case "Draft":
      return [];
    case "Proposed":
    case "Tendered":
    case "Cancelled":
      return [target]; // Draft → {Proposed | Tendered | Cancelled} are all valid
    case "Accepted":
      return [proposed, target];
    case "Modified":
    case "Active":
    case "Disputed":
    case "PartiallyFulfilled":
      return [proposed, accepted, target];
    case "Fulfilled":
      return [proposed, accepted, partiallyFulfilled, target];
    case "Refunded":
      return [proposed, accepted, partiallyFulfilled, fulfilled, target];
  }
}

/**
 * Return a copy of `commitment` driven to `target` with a synthesized, valid
 * history (every step applied through {@link transitionCommitment}). Pass a
 * freshly created `Draft` commitment (e.g. from `newCommitment`). On the
 * impossible event that a step is rejected, falls back to setting the final
 * state directly so the adapter still returns a usable object.
 */
export function applyCommitmentPath(
  commitment: Commitment,
  target: CommitmentState,
  actor: PartyID,
  reason?: string,
): Commitment {
  let current = commitment;
  for (const step of commitmentPath(target)) {
    const result = transitionCommitment(current, step, actor, reason);
    if (!result.ok) return { ...commitment, state: target };
    current = result.value;
  }
  return current;
}

/** The states to pass through (after Planned) to reach `target`. */
function fulfillmentPath(target: FulfillmentState): FulfillmentState[] {
  const inProgress: FulfillmentState = { type: "InProgress" };
  switch (target.type) {
    case "Planned":
      return [];
    case "InProgress":
    case "Failed":
      return [target]; // Planned → {InProgress | Failed} are valid
    case "Completed":
    case "Reversed":
      return [inProgress, target]; // via InProgress
  }
}

/**
 * Return a copy of `fulfillment` driven to `target` with a synthesized, valid
 * history (every step through {@link transitionFulfillment}, which also stamps
 * `started_at` / `completed_at`). Pass a freshly created `Planned` fulfillment.
 */
export function applyFulfillmentPath(
  fulfillment: Fulfillment,
  target: FulfillmentState,
  actor: PartyID,
): Fulfillment {
  let current = fulfillment;
  for (const step of fulfillmentPath(target)) {
    const result = transitionFulfillment(current, step, actor);
    if (!result.ok) return { ...fulfillment, state: target };
    current = result.value;
  }
  return current;
}
