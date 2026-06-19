/**
 * Agent guardrail — validate a proposed commerce action *before* it executes.
 *
 * An AI agent proposes an action near money (refund this order, accept this
 * commitment, ship this); the guardrail answers **safe** or
 * **not-safe-with-an-actionable-reason** before anything happens. The reasons are
 * written so an LLM can read the rejection and self-correct.
 *
 * This is a thin COMPOSITION over the package's already-proven, cross-checked
 * logic — it does NOT re-derive invariants or the transition table:
 *   - {@link transitionCommitment} validates the proposed state move (the model's
 *     transition table = Invariant 2) and replays append-only history;
 *   - {@link auditCommerce} runs the six-invariant audit over the resulting world.
 * If both pass, the action is safe and the post-action world is returned.
 *
 * Scope: TypeScript first. Ports to Python / Rust / Go are roadmap — this is the
 * wedge, proven in one language before it is carried to the others.
 *
 * It returns a discriminated result; it never throws on a rejected action and
 * never coerces an unsafe action into a safe-looking one.
 */

import { auditCommerce, type InvariantViolation } from "./invariants.js";
import type { Commitment, Fulfillment, Party, PartyID } from "./primitives.js";
import type { CommitmentState } from "./states.js";
import { transitionCommitment } from "./transitions.js";

/** The current commerce world the agent is acting on — however you already hold it. */
export interface World {
  commitments: Commitment[];
  fulfillments: Fulfillment[];
  parties: Party[];
}

/**
 * A proposed commerce action: move one commitment in the world to a new state.
 * The target state carries any amounts the move needs (e.g. a `Refunded` state
 * carries its `amount`), exactly as the model defines them.
 */
export interface ProposedAction {
  /** Id of the commitment in `world` to transition. */
  commitment: string;
  /** The state to move it to (a valid `CommitmentState`, with its data). */
  to: CommitmentState;
  /** Who proposes the action. */
  actor: PartyID | string;
  /** Optional human/agent note recorded on the transition. */
  reason?: string;
}

/** One reason an action or world was rejected — written for an agent to act on. */
export interface GuardViolation {
  /** The rule that rejected it: an invariant id ("I-1".."I-6") or a guard rule. */
  rule: string;
  /** What is wrong, in commerce language. */
  message: string;
  /** How to make it valid — the self-correction hint. */
  fix: string;
}

/**
 * The guard's verdict. On success, `next` is the resulting valid world (for
 * {@link guardObject} it is the same world, validated). On rejection, `violations`
 * lists every reason, each actionable.
 */
export type GuardResult =
  | { ok: true; next: World }
  | { ok: false; violations: GuardViolation[] };

/** Map an audit `InvariantViolation` to the guard's actionable shape. */
function fromInvariant(v: InvariantViolation): GuardViolation {
  return { rule: v.invariant, message: v.description, fix: v.fix };
}

/** Name the invariant a transition error cites, so the rule matches the message. */
function ruleFromTransitionError(error: string): string {
  const m = /Invariant (\d)/.exec(error);
  return m ? `I-${m[1]}` : "I-2";
}

/**
 * Guard a proposed transition-level action (the real wedge). Validates the move
 * against the transition table, applies it (preserving append-only history), and
 * audits the resulting world — all by composing the proven functions.
 *
 * ```ts
 * const verdict = guardAction(world, { commitment: "c1", to: { type: "Refunded", amount, at }, actor: "agent" });
 * if (verdict.ok) {
 *   // verdict.next is the post-action world — safe to persist
 * } else {
 *   verdict.violations; // [{ rule, message, fix }] — feed back to the agent
 * }
 * ```
 */
export function guardAction(world: World, action: ProposedAction): GuardResult {
  const target = world.commitments.find((c) => (c.id as string) === action.commitment);
  if (target === undefined) {
    return {
      ok: false,
      violations: [
        {
          rule: "unknown-commitment",
          message: `No commitment '${action.commitment}' exists in the current world; an action must target a commitment that is present.`,
          fix: "Reference a commitment id that exists in the `world` you pass to guardAction (the agent may be acting on a stale or hallucinated id).",
        },
      ],
    };
  }

  // 1. Validate the proposed move + replay history (composes transitionCommitment:
  //    the transition table is Invariant 2; timestamp monotonicity is Invariant 4).
  const moved = transitionCommitment(target, action.to, action.actor as PartyID, action.reason);
  if (!moved.ok) {
    return {
      ok: false,
      violations: [
        {
          rule: ruleFromTransitionError(moved.error),
          message: moved.error,
          fix: "Only the model's valid transitions are allowed. Pick a target state reachable from the current one, or model a reversal as a NEW forward commitment with the parties exchanged — never move a finalized state backward.",
        },
      ],
    };
  }

  // 2. Build the resulting world: the target commitment, transitioned.
  const next: World = {
    commitments: world.commitments.map((c) =>
      (c.id as string) === (target.id as string) ? moved.value : c,
    ),
    fulfillments: world.fulfillments,
    parties: world.parties,
  };

  // 3. Audit the RESULTING world (composes auditCommerce: the six invariants).
  const violations = auditCommerce(next.commitments, next.fulfillments, next.parties);
  if (violations.length > 0) {
    return { ok: false, violations: violations.map(fromInvariant) };
  }

  // 4. Valid edge + clean world → safe.
  return { ok: true, next };
}

/**
 * Guard a fully-constructed world (the object-level case: the agent built the
 * whole thing, check it). A thin layer over {@link auditCommerce}.
 *
 * ```ts
 * const verdict = guardObject(commitments, fulfillments, parties);
 * if (!verdict.ok) verdict.violations; // [{ rule, message, fix }]
 * ```
 */
export function guardObject(
  commitments: Commitment[],
  fulfillments: Fulfillment[],
  parties: Party[],
): GuardResult {
  const violations = auditCommerce(commitments, fulfillments, parties);
  if (violations.length > 0) {
    return { ok: false, violations: violations.map(fromInvariant) };
  }
  return { ok: true, next: { commitments, fulfillments, parties } };
}
