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
import { transitionCommitment, validTransitions, type Clock } from "./transitions.js";

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
  /**
   * Optional idempotency key — a stable, caller-supplied identity for this action,
   * so a retried/duplicated action is recognized as the SAME operation (see
   * {@link createSession}'s replay detection). This is a runtime input, NOT a
   * schema field; the model schema stays frozen. When omitted, a session derives a
   * fingerprint (commitment + target type + amount + actor) instead — so two
   * genuinely-distinct but structurally-identical actions (e.g. two separate refunds
   * of the same order) must carry distinct keys to be applied separately.
   */
  idempotencyKey?: string;
  /**
   * Optional optimistic-concurrency token — the version the caller PLANNED
   * against, as returned by {@link commitmentVersion} when they read the
   * commitment. If supplied and it no longer matches the commitment's current
   * version (a concurrent actor advanced it), the action is rejected as a
   * CONFLICT (re-read and re-plan) rather than applied. This is a runtime input,
   * NOT a schema field — the version is derived from the commitment's existing
   * append-only history + state, so the model schema stays frozen. Omit it for
   * the unconditional, backward-compatible behaviour.
   */
  expectedVersion?: string;
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
 * A legal target state from the current state — a move the agent may pick
 * instead of the rejected one. This is the planning-oracle payload: when an
 * action is rejected, the guard returns the set of legal moves so an agent can
 * choose a valid one rather than blindly retrying.
 *
 * These are **legal transitions from the current state**, read from the model's
 * generated transition table — NOT guaranteed-safe actions. A listed move is a
 * valid state transition; reaching it with particular data may still be rejected
 * by another invariant. The absence of `bounded` does not promise safety.
 */
export interface TransitionAlternative {
  /** The legal target state type, from the model's transition table. */
  to: CommitmentState["type"];
  /** A short, agent-readable label for the move. */
  label: string;
  /**
   * Present when this target is a legal transition but reaching it with the
   * proposed data was rejected by another invariant — e.g. a Fulfilled →
   * Refunded move whose amount exceeds what was committed (I-1). The string
   * states the constraint to satisfy: retry the SAME move with corrected data,
   * don't pick a different state.
   */
  bounded?: string;
}

/**
 * The guard's verdict. On success, `next` is the resulting valid world (for
 * {@link guardObject} it is the same world, validated). On rejection, `violations`
 * lists every reason, each actionable; `alternatives` (when present) lists the
 * legal transitions from the current state so an agent can self-correct. The
 * field is additive — existing consumers that read only `violations` are
 * unaffected.
 */
export type GuardResult =
  | { ok: true; next: World; replay?: boolean }
  | {
      ok: false;
      violations: GuardViolation[];
      alternatives?: TransitionAlternative[];
      /**
       * Set when the rejection is an optimistic-concurrency CONFLICT (the action
       * was planned against a stale version), distinct from an invariant
       * violation. `expected` is the caller's planned version, `actual` is the
       * commitment's current version. The caller should re-read and re-plan.
       */
      conflict?: boolean;
      expected?: string;
      actual?: string;
    };

/** Map an audit `InvariantViolation` to the guard's actionable shape. */
function fromInvariant(v: InvariantViolation): GuardViolation {
  return { rule: v.invariant, message: v.description, fix: v.fix };
}

/** A short fingerprint of a commitment state — the type, plus the amount for a Refunded. */
function stateFingerprint(s: CommitmentState): string {
  if (s.type === "Refunded") return `Refunded:${s.amount.amount}:${s.amount.currency}`;
  return s.type;
}

/**
 * The optimistic-concurrency version of a commitment, derived entirely from its
 * existing append-only history and current state (NOT a schema field). It is the
 * history length plus a state fingerprint, so it advances when a new transition is
 * appended ("more entries") and when the current state changes ("state changed").
 * A caller computes this when they read a commitment and passes it back as
 * {@link ProposedAction.expectedVersion}; if the commitment has since advanced,
 * the action is rejected as a conflict.
 *
 * Scope: this is OPTIMISTIC concurrency over the caller's world view — it detects
 * a stale plan. It is **not** a lock, distributed consensus, or a transaction
 * manager; Warp does not serialize concurrent writers.
 */
export function commitmentVersion(c: Commitment): string {
  return `${c.history.length}:${stateFingerprint(c.state)}`;
}

/**
 * If `expectedVersion` is supplied and no longer matches the commitment's current
 * version, return the CONFLICT result (re-read and re-plan); otherwise null. Used
 * by {@link guardAction} and by the session layer (whose partial-refund path does
 * not route through guardAction).
 */
export function checkVersion(target: Commitment, expectedVersion: string | undefined): GuardResult | null {
  if (expectedVersion === undefined) return null;
  const actual = commitmentVersion(target);
  if (expectedVersion === actual) return null;
  return {
    ok: false,
    conflict: true,
    expected: expectedVersion,
    actual,
    violations: [
      {
        rule: "version-conflict",
        message:
          `This action was planned against version '${expectedVersion}', but commitment ` +
          `'${target.id}' is now at version '${actual}' — it changed since you planned (a ` +
          `concurrent actor advanced it). The change conflicts, so it was not applied.`,
        fix:
          "Re-read the commitment, recompute its version with commitmentVersion(), and re-plan " +
          "your action against the current version. This is optimistic concurrency — Warp detects " +
          "the stale plan; it does not lock or serialize writers.",
      },
    ],
  };
}

/** Name the invariant a transition error cites, so the rule matches the message. */
export function ruleFromTransitionError(error: string): string {
  const m = /Invariant (\d)/.exec(error);
  return m ? `I-${m[1]}` : "I-2";
}

/** True when an error message carries a recognizable invariant marker. */
export function isInvariantError(message: string): boolean {
  return /Invariant \d/.test(message);
}

/**
 * The canonical "how to fix it" guidance for each invariant rule — so a rejection
 * reads the same wherever it is surfaced (the guard, or the engine's safety net).
 */
export function fixForRule(rule: string): string {
  switch (rule) {
    case "I-1":
      return "Conserve value: a refund cannot exceed what was committed (same currency). Lower the amount or model a partial refund.";
    case "I-2":
      return "Use only the model's valid transitions, or model a reversal as a new forward commitment with the parties exchanged.";
    case "I-4":
      return "Record the move at a time no earlier than the last transition (Invariant 4: Temporal Integrity).";
    default:
      return "Adjust the action so the resulting world satisfies the invariant.";
  }
}

/** Short, agent-readable labels for each commitment move. */
const COMMITMENT_MOVE_LABELS: Record<CommitmentState["type"], string> = {
  Draft: "return to draft",
  Proposed: "propose to the counterparty",
  Tendered: "tender as an open offer",
  Accepted: "accept the commitment",
  Modified: "modify the terms",
  PartiallyFulfilled: "mark partially fulfilled",
  Active: "activate the commitment",
  Fulfilled: "mark fulfilled",
  Cancelled: "cancel the commitment",
  Disputed: "open a dispute",
  Refunded: "refund the commitment",
};

/**
 * The legal moves from `from`, read from the generated transition table (via
 * {@link validTransitions}). If `bounded` is given, the matching target is
 * annotated as reachable-but-constrained.
 */
function commitmentAlternatives(
  from: CommitmentState,
  bounded?: { to: CommitmentState["type"]; constraint: string },
): TransitionAlternative[] {
  return validTransitions(from).map((to) => {
    const alt: TransitionAlternative = { to, label: COMMITMENT_MOVE_LABELS[to] };
    if (bounded && bounded.to === to) alt.bounded = bounded.constraint;
    return alt;
  });
}

/** A one-line, human-readable summary of the legal moves, for the `fix` field. */
function summarizeAlternatives(alts: TransitionAlternative[]): string {
  if (alts.length === 0) {
    return "There are no legal transitions from this state — it is terminal.";
  }
  const list = alts
    .map((a) => (a.bounded ? `${a.to} (${a.bounded})` : a.to))
    .join(", ");
  return `Legal transitions from here: ${list}.`;
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
export function guardAction(world: World, action: ProposedAction, clock?: Clock): GuardResult {
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

  // 0. Optimistic-concurrency check: if the caller planned against a version that
  //    no longer matches, the commitment advanced under them — reject as a CONFLICT
  //    (re-read and re-plan), distinct from an invariant violation. Backward-
  //    compatible: with no expectedVersion this is a no-op.
  const conflict = checkVersion(target, action.expectedVersion);
  if (conflict) return conflict;

  // 1. Validate the proposed move + replay history (composes transitionCommitment:
  //    the transition table is Invariant 2; timestamp monotonicity is Invariant 4).
  const moved = transitionCommitment(target, action.to, action.actor as PartyID, action.reason, clock);
  if (!moved.ok) {
    const rule = ruleFromTransitionError(moved.error);
    // A transition-table rejection (I-2) is the planning case: enumerate the
    // legal moves from the current state so the agent can pick a valid one. A
    // timestamp rejection (I-4) is NOT fixed by choosing a different target, so
    // no alternatives are offered there.
    if (rule === "I-2") {
      const alternatives = commitmentAlternatives(target.state);
      return {
        ok: false,
        violations: [
          {
            rule,
            message: moved.error,
            fix:
              `Only the model's valid transitions are allowed. ${summarizeAlternatives(alternatives)} ` +
              `Pick one of those, or model a reversal as a NEW forward commitment with the parties ` +
              `exchanged — never move a finalized state backward.`,
          },
        ],
        alternatives,
      };
    }
    return {
      ok: false,
      violations: [
        {
          rule,
          message: moved.error,
          fix: "The target state is reachable, but the transition timestamp is not monotonic — record the move at a time no earlier than the last transition (Invariant 4: Temporal Integrity).",
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
    // The move itself was a LEGAL transition (it passed step 1), but the
    // resulting world is rejected. List the legal moves from the original state,
    // and where a violation cites the moved commitment, annotate the attempted
    // target as reachable-but-bounded — so the agent corrects the DATA (e.g. a
    // refund amount) rather than picking a different state.
    const movedId = target.id as string;
    const cited = violations.filter((v) => v.description.includes(movedId));
    const bounded =
      cited.length > 0
        ? { to: action.to.type, constraint: cited.map((v) => v.fix).join(" ") }
        : undefined;
    return {
      ok: false,
      violations: violations.map(fromInvariant),
      alternatives: commitmentAlternatives(target.state, bounded),
    };
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
