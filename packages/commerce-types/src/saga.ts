/**
 * Saga / compensation — model the UNWINDING of a multi-step commerce flow as an
 * explicit, validated sequence of compensating actions, and check that the
 * compensation itself is coherent (a reversal that would violate an invariant —
 * e.g. an over-refund — is rejected).
 *
 * A "saga" here is an ordered set of forward actions (accept → fulfill → refund …)
 * together with the compensating actions that reverse their economic effect. Each
 * compensation is a LEGAL transition (read from the same generated transition table
 * as everything else: e.g. Fulfilled → Refunded, Accepted → Cancelled), and the net
 * economic effect of the whole sequence is validated for conservation (I-1) and the
 * rest of the six-invariant audit.
 *
 * This is a COMPOSITION over the already-proven primitives — it does NOT re-derive
 * invariant or transition logic:
 *   - {@link validTransitions} decides whether a compensation is a legal move from a
 *     commitment's current state (the model's transition table = I-2);
 *   - {@link createSession} runs the compensation sequence against the accumulated
 *     world, so the cumulative over-refund check, the F3 optimistic-conflict check,
 *     the F4 idempotency/replay dedup, and the six-invariant audit all apply to the
 *     compensation exactly as they apply to any other action;
 *   - the planning-oracle alternatives / bounded guidance surface unchanged on a
 *     rejected compensation, so a caller can correct an over-refund the same way it
 *     would correct any rejected action.
 *
 * SCOPE (honest): Warp VALIDATES that a compensation sequence is coherent — that each
 * compensating action is a legal transition reversing a prior step's effect and that
 * the net effect conserves value. Warp does NOT execute or orchestrate rollbacks on
 * external systems: a planned compensation is a sequence of validated descriptors, not
 * a runtime that calls Stripe/Shopify to undo anything. The interop emitters elsewhere
 * in this package are descriptors in the same sense. "Compensation" is a modelling and
 * validation affordance, not a distributed-transaction coordinator.
 *
 * WHAT REVERSES WHAT (the default mapping): the economic effect a forward step
 * committed determines its compensating transition. A step that drove a commitment to
 * `Fulfilled` (value delivered) is reversed by `Refunded` for the amount that step
 * committed; a step that left a commitment `Accepted` / `Active` / `Modified` /
 * `PartiallyFulfilled` (committed but not yet delivered) is reversed by `Cancelled`.
 * A forward step that itself ended `Cancelled` or `Refunded` is already a terminal
 * compensation target and has nothing to reverse. Callers may override the mapping
 * per step; an overridden target is still checked against the transition table and the
 * invariants, so an illegal or invariant-violating override is rejected with guidance.
 *
 * TypeScript first. Ports to Python / Rust / Go are roadmap.
 */

import type { GuardResult, GuardViolation, ProposedAction, TransitionAlternative, World } from "./guard.js";
import type { Money } from "./money.js";
import type { Commitment, PartyID } from "./primitives.js";
import { createSession, type Session } from "./session.js";
import type { CommitmentState } from "./states.js";
import { validTransitions } from "./transitions.js";

/**
 * A forward step that was applied to reach the current world, paired with the
 * commitment it acted on. This is the input to compensation planning: the saga reads
 * each step's committed effect and proposes the reversing action. The `to` is the
 * state the forward step drove the commitment to (the same shape a {@link ProposedAction}
 * carries), so an `amount` on a `Refunded`/`Tendered` forward step is available to the
 * compensation when it needs one.
 */
export interface ForwardStep {
  /** Id of the commitment the forward step acted on. */
  commitment: string;
  /** The state the forward step drove the commitment to. */
  to: CommitmentState;
  /** The actor who performed the forward step (carried onto the compensation by default). */
  actor: string;
  /**
   * Optional explicit compensation override for THIS step. When omitted, the default
   * mapping (see the module doc) is used. An override is still validated against the
   * transition table and the invariants — it is not a way to bypass either.
   */
  compensateWith?: CommitmentState;
  /** Optional timestamp for the compensating transition (defaults are caller-supplied; see {@link planCompensation}). */
  at?: string;
}

/** A single planned compensating action: the reversing transition for one forward step. */
export interface CompensationStep {
  /** The forward step this compensates. */
  forward: ForwardStep;
  /**
   * The compensating action to run through the session — null when the forward step
   * has nothing to reverse (it already ended in a terminal compensation target, or its
   * current state has no legal reversing move). A null step is reported in
   * {@link CompensationPlan.skipped} with the reason, not silently dropped.
   */
  action: ProposedAction | null;
  /** Why a null `action` was produced (present only when `action` is null). */
  skipReason?: string;
}

/**
 * The full plan: the compensating action for each forward step (in REVERSE order — a
 * saga unwinds last-applied first), plus the steps that had nothing to reverse.
 */
export interface CompensationPlan {
  /** The compensating actions, ordered last-forward-step-first (the unwind order). */
  steps: CompensationStep[];
  /** Forward steps that produced no compensating action, with the reason each was skipped. */
  skipped: Array<{ commitment: string; reason: string }>;
}

/**
 * The verdict of validating a whole compensation plan against a world. On success the
 * world is fully unwound and `next` is the resulting coherent world. On rejection,
 * `failedAt` is the index (into the plan's `steps`) of the compensation that was
 * rejected, and the usual `violations` / `alternatives` / conflict fields explain why —
 * so a caller corrects the offending compensation (e.g. an over-refund) exactly as it
 * would correct any rejected action. Additive over {@link GuardResult}.
 */
export type CompensationResult =
  | { ok: true; next: World; applied: number; skipped: number }
  | {
      ok: false;
      failedAt: number;
      violations: GuardViolation[];
      alternatives?: TransitionAlternative[];
      conflict?: boolean;
      expected?: string;
      actual?: string;
    };

/** Sum the Money in a commitment's `requested` subject (single currency), or null. */
function committedTotal(c: Commitment): Money | null {
  const monies: Money[] = [];
  for (const v of c.subject.requested) {
    if (v.form.kind === "Money") monies.push(v.form.money);
  }
  const first = monies[0];
  if (first === undefined) return null;
  if (monies.some((m) => m.currency !== first.currency)) return null;
  return monies.reduce((acc, m) => ({ amount: acc.amount + m.amount, currency: acc.currency }));
}

/**
 * The default compensating target for a forward step, given the commitment it acted on
 * (read from the CURRENT world so the move is legal from where the commitment now is).
 * Returns null when there is nothing to reverse. The choice is constrained to the
 * model's legal transitions via {@link validTransitions} — the saga never invents a
 * move the table does not allow.
 */
function defaultCompensation(forward: ForwardStep, current: Commitment, at: string): CompensationStep["action"] | { skip: string } {
  const legal = validTransitions(current.state);
  const effect = forward.to.type;

  // A forward step that delivered value (reached Fulfilled) is reversed by a Refund of
  // the committed amount — but only if Refunded is a legal move from where we are now.
  if (effect === "Fulfilled") {
    if (!legal.includes("Refunded")) {
      return { skip: `commitment ${forward.commitment} is in '${current.state.type}', from which Refunded is not a legal transition — nothing to reverse for the Fulfilled step` };
    }
    const committed = committedTotal(current);
    if (committed === null) {
      return { skip: `commitment ${forward.commitment} has no single-currency committed amount to refund` };
    }
    return {
      commitment: forward.commitment,
      to: { type: "Refunded", amount: committed, at },
      actor: forward.actor,
      reason: `compensation: reverse the Fulfilled step on ${forward.commitment}`,
      idempotencyKey: `comp:${forward.commitment}:Refunded`,
    };
  }

  // A forward step that committed-but-did-not-deliver (Accepted / Active / Modified /
  // PartiallyFulfilled) is reversed by Cancelling the commitment, when legal.
  if (effect === "Accepted" || effect === "Active" || effect === "Modified" || effect === "PartiallyFulfilled") {
    if (!legal.includes("Cancelled")) {
      return { skip: `commitment ${forward.commitment} is in '${current.state.type}', from which Cancelled is not a legal transition — nothing to reverse for the ${effect} step` };
    }
    return {
      commitment: forward.commitment,
      to: { type: "Cancelled", by: forward.actor as PartyID, reason: `compensation: reverse the ${effect} step on ${forward.commitment}`, at },
      actor: forward.actor,
      reason: `compensation: reverse the ${effect} step on ${forward.commitment}`,
      idempotencyKey: `comp:${forward.commitment}:Cancelled`,
    };
  }

  // Already a terminal compensation target, or a step with no economic reversal.
  if (effect === "Cancelled" || effect === "Refunded") {
    return { skip: `the forward step on ${forward.commitment} already ended in '${effect}', a terminal compensation target — nothing to reverse` };
  }
  return { skip: `the forward step on ${forward.commitment} (to '${effect}') has no defined economic reversal; supply compensateWith to model one explicitly` };
}

/**
 * Build the compensation plan for a sequence of forward steps against `world`.
 *
 * Each forward step is mapped to its reversing action (default mapping, or the step's
 * `compensateWith` override). The plan is returned in REVERSE order — a saga unwinds
 * the most-recently-applied step first — and steps with nothing to reverse are listed
 * in `skipped`. This only PLANS; {@link validateCompensation} runs the plan through a
 * session to check it is coherent.
 *
 * `at` is the timestamp stamped on compensating transitions that need one (Refunded,
 * Cancelled); pass a time no earlier than the world's last transition (I-4 temporal
 * integrity is checked when the plan is validated). A per-step `at` overrides it.
 */
export function planCompensation(world: World, forward: ForwardStep[], at: string): CompensationPlan {
  const byId = new Map(world.commitments.map((c) => [c.id as string, c]));
  const steps: CompensationStep[] = [];
  const skipped: Array<{ commitment: string; reason: string }> = [];

  // Unwind in reverse: the last forward step is compensated first.
  for (let i = forward.length - 1; i >= 0; i--) {
    const step = forward[i];
    if (step === undefined) continue;
    const stepAt = step.at ?? at;
    const current = byId.get(step.commitment);
    if (current === undefined) {
      const reason = `commitment ${step.commitment} is not present in the world — cannot compensate a step on it`;
      steps.push({ forward: step, action: null, skipReason: reason });
      skipped.push({ commitment: step.commitment, reason });
      continue;
    }

    // An explicit override is still bounded by the transition table: only a legal move
    // is accepted as a compensation; an illegal override is skipped with guidance (and
    // the session would reject it anyway if forced).
    if (step.compensateWith !== undefined) {
      const legal = validTransitions(current.state);
      if (!legal.includes(step.compensateWith.type)) {
        const reason = `compensateWith '${step.compensateWith.type}' is not a legal transition from '${current.state.type}' for ${step.commitment} (legal: ${legal.join(", ") || "none — terminal"})`;
        steps.push({ forward: step, action: null, skipReason: reason });
        skipped.push({ commitment: step.commitment, reason });
        continue;
      }
      steps.push({
        forward: step,
        action: {
          commitment: step.commitment,
          to: step.compensateWith,
          actor: step.actor,
          reason: `compensation (explicit) on ${step.commitment}`,
          idempotencyKey: `comp:${step.commitment}:${step.compensateWith.type}`,
        },
      });
      continue;
    }

    const planned = defaultCompensation(step, current, stepAt);
    if (planned !== null && "skip" in planned) {
      steps.push({ forward: step, action: null, skipReason: planned.skip });
      skipped.push({ commitment: step.commitment, reason: planned.skip });
      continue;
    }
    steps.push({ forward: step, action: planned });
  }

  return { steps, skipped };
}

/**
 * Validate a compensation plan by running every compensating action through a
 * {@link Session}. The session applies the SAME checks as any other action sequence —
 * the cumulative over-refund cap (I-1 across steps), the F3 optimistic-conflict check,
 * the F4 replay/idempotency dedup, and the six-invariant audit — so a compensation that
 * would itself violate an invariant (e.g. a refund that over-refunds while reversing) is
 * rejected, with the bounded/alternatives guidance the caller already knows how to act
 * on.
 *
 * IMPORTANT — pass the SAME session the forward flow ran in. The compensation continues
 * that session's accumulating ledger, so a prior PARTIAL refund (which the schema cannot
 * represent as a state, and which the session tracks in its own ledger) is correctly
 * counted: trying to refund the full committed amount again after a partial refund is
 * caught as a cumulative over-refund. If you instead validate against a fresh session
 * built from a world, that ledger context is lost — use {@link compensate} only when the
 * world's commitment states already reflect every prior effect (no session-only partial
 * refunds outstanding).
 *
 * On the first rejected compensation, validation STOPS and returns the rejection with
 * the index of the offending step (`failedAt`). On success the world is fully unwound
 * into a coherent state.
 */
export function validateCompensation(session: Session, plan: CompensationPlan): CompensationResult {
  let applied = 0;
  let skipped = 0;

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step === undefined) continue;
    if (step.action === null) {
      skipped += 1;
      continue;
    }
    const verdict: GuardResult = session.propose(step.action);
    if (!verdict.ok) {
      const out: CompensationResult = { ok: false, failedAt: i, violations: verdict.violations };
      if (verdict.alternatives !== undefined) out.alternatives = verdict.alternatives;
      if (verdict.conflict !== undefined) out.conflict = verdict.conflict;
      if (verdict.expected !== undefined) out.expected = verdict.expected;
      if (verdict.actual !== undefined) out.actual = verdict.actual;
      return out;
    }
    applied += 1;
  }

  return { ok: true, next: session.world, applied, skipped };
}

/**
 * Plan AND validate against an existing session in one call: build the compensation plan
 * for `forward` against the session's current world and immediately run it through that
 * SAME session, so any prior partial-refund ledger is honored. Returns both the plan (so
 * a caller can inspect what was/wasn't reversed) and the verdict. A convenience over
 * {@link planCompensation} + {@link validateCompensation}; no extra logic.
 */
export function compensateSession(
  session: Session,
  forward: ForwardStep[],
  at: string,
): { plan: CompensationPlan; result: CompensationResult } {
  const plan = planCompensation(session.world, forward, at);
  const result = validateCompensation(session, plan);
  return { plan, result };
}

/**
 * Plan AND validate against a FRESH session built from `world`. Use this when the
 * world's commitment states already reflect every prior effect — there is no
 * session-only partial-refund ledger to carry forward (e.g. unwinding a clean
 * accept→active flow). When a prior partial refund is outstanding in a live session,
 * use {@link compensateSession} so that ledger is honored. Returns the plan + verdict.
 */
export function compensate(
  world: World,
  forward: ForwardStep[],
  at: string,
): { plan: CompensationPlan; result: CompensationResult } {
  const session = createSession(world);
  const plan = planCompensation(world, forward, at);
  const result = validateCompensation(session, plan);
  return { plan, result };
}
