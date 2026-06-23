/**
 * Multi-agent verification — make it first-class that several NAMED agents act on
 * a SHARED world, so the invariants hold over their COMBINED actions, with per-actor
 * attribution.
 *
 * This is NOT new invariant logic. The model is already actor-agnostic: a
 * {@link World} holds many commitments, every {@link ProposedAction} carries an
 * `actor`, and {@link createSession} accumulates a world across actions regardless of
 * who made each — so the cumulative refund check and the six invariants already catch
 * a violation that EMERGES from the combined valid actions of different agents (three
 * agents each refunding 80 against a 200 commitment is caught at the third, exactly as
 * one agent doing it three times would be). This module composes that existing
 * session; it does not fork or re-derive any check.
 *
 * What it adds is ergonomics + ATTRIBUTION: run a sequence of actions from different
 * actors against one shared world, record which actor performed each accepted action,
 * and — on a rejection — name the actor whose action, applied to the accumulated
 * shared world, tipped it into violation.
 *
 * SCOPE (honest): this is shared-world invariant enforcement WITH attribution. The
 * attribution is "which action tipped the world into violation" — the proposing actor
 * of the step that failed the check. It is NOT collusion, conspiracy, or multi-party
 * intent detection: Warp does not infer that several actors coordinated, only that a
 * violation emerged over the world they share and which single action triggered it.
 *
 * TypeScript first. Ports to Python / Rust / Go are roadmap.
 */

import type { GuardViolation, ProposedAction, TransitionAlternative, World } from "./guard.js";
import type { Money } from "./money.js";
import type { CommitmentState } from "./states.js";
import { createSession } from "./session.js";

/** One accepted action, with the actor who performed it (the who-did-what log). */
export interface AgentActionRecord {
  actor: string;
  commitment: string;
  to: CommitmentState["type"];
}

/**
 * A multi-agent verdict: the session's verdict plus the `actor` of this action. On a
 * rejection, `actor` is the actor whose action — applied to the accumulated shared
 * world — tipped it into violation, and `attribution` spells that out against the
 * prior accepted actors. (Additive: every field the single-actor session returns is
 * still present.)
 */
export type MultiAgentResult =
  | { ok: true; next: World; replay?: boolean; actor: string }
  | {
      ok: false;
      violations: GuardViolation[];
      alternatives?: TransitionAlternative[];
      conflict?: boolean;
      expected?: string;
      actual?: string;
      actor: string;
      attribution: string;
    };

/** A stateful sequence validator over a shared world spanning several named agents. */
export interface MultiAgentSession {
  /**
   * Validate `action` (from `action.actor`) against the ACCUMULATED shared world,
   * apply it on success, and return the verdict with per-actor attribution. The
   * cumulative / conflict / replay checks all apply across actors, because the
   * underlying session is actor-agnostic.
   */
  propose(action: ProposedAction): MultiAgentResult;
  /** The current accumulated shared world (updated only on accepted actions). */
  readonly world: World;
  /** The amount refunded so far for a commitment across all agents, or null. */
  refundedSoFar(commitmentId: string): Money | null;
  /** The accepted actions in order, each tagged with the actor who performed it. */
  readonly log: ReadonlyArray<AgentActionRecord>;
  /** A per-actor count of accepted actions (who did how much). */
  actorsSummary(): Record<string, number>;
}

export function createMultiAgentSession(initialWorld: World): MultiAgentSession {
  // Compose the existing session — same accumulated world, same actor-agnostic
  // cumulative / conflict / replay checks. This wrapper only adds attribution.
  const session = createSession(initialWorld);
  const log: AgentActionRecord[] = [];

  /** Distinct actors who have an accepted action so far (the accumulated context). */
  function priorActors(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of log) {
      if (!seen.has(r.actor)) {
        seen.add(r.actor);
        out.push(r.actor);
      }
    }
    return out;
  }

  function propose(action: ProposedAction): MultiAgentResult {
    const actor = String(action.actor);
    const verdict = session.propose(action);
    if (verdict.ok) {
      // A replay applied nothing new; only log genuinely-applied actions.
      if (verdict.replay !== true) {
        log.push({ actor, commitment: action.commitment, to: action.to.type });
      }
      return { ...verdict, actor };
    }

    const others = priorActors().filter((a) => a !== actor);
    const context = others.length > 0 ? `the accumulated actions of ${others.join(", ")}` : "no prior actions";
    const rule = verdict.violations[0]?.rule ?? "an invariant";
    const what = verdict.conflict
      ? "conflicts with the commitment's current version (a concurrent actor advanced it)"
      : `tipped the shared world into violation of ${rule}`;
    const attribution = `${actor}'s action, applied after ${context}, ${what}.`;
    return { ...verdict, actor, attribution };
  }

  return {
    propose,
    get world() {
      return session.world;
    },
    refundedSoFar(commitmentId: string): Money | null {
      return session.refundedSoFar(commitmentId);
    },
    get log() {
      return log;
    },
    actorsSummary(): Record<string, number> {
      const out: Record<string, number> = {};
      for (const r of log) out[r.actor] = (out[r.actor] ?? 0) + 1;
      return out;
    },
  };
}
