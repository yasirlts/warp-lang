/**
 * Returns / RMA lifecycle — a SESSION-LAYER profile over the existing model, with
 * NO schema change.
 *
 * A merchant authorises a return, the goods come back, get inspected, and money is
 * refunded. Platforms call the tracking artifact an RMA (Return Merchandise
 * Authorization) and march it through stages: requested → authorized → in_transit →
 * received → inspected → refunded (or rejected). None of those stages is a committed
 * state, and they MUST NOT be: the model's commitment states are the frozen 11-variant
 * set, and the schema's own monotonicity note is explicit that a reversal "is never a
 * backward state change on the original object — it is a NEW forward-moving Commitment
 * with the parties exchanged". This profile never moves the order backward.
 *
 * HOW THE MODEL ALREADY CARRIES A RETURN (what the schema represents):
 *   - A return targets the order's LINE ITEMS, which the model already carries as CHILD
 *     commitments of the order (the F6 tree — the append-only `parent` / `children`
 *     fields). The original order is never moved backward; the return is a refund
 *     against the relevant child line(s).
 *   - The MONEY of a return is a refund, settled through the SAME proven path the
 *     session already uses: a partial return refunds one or more child lines and is held
 *     in the per-tree refund ledger; the refund is bounded by the PER-TREE cap
 *     (checkI6TreeConsistency reconciling the children to the parent + the I-1 cumulative
 *     probe lifted to the parent, both unchanged). An over-return — returning more than
 *     the order was worth, in one return or spread across lines and several RMAs — is
 *     caught by that existing cap, not by new logic here.
 *
 * WHAT THIS PROFILE ADDS (the session-layer overlay — explicitly NOT in the schema):
 *   - The RMA STAGE machine. Stages live in this module's in-memory state, exactly as
 *     the session's partial-refund ledger and idempotency set do. They order the
 *     operational steps (you cannot refund a return whose goods were never received and
 *     inspected) and they are a workflow overlay, not commitment states. The committed
 *     states stay frozen; the only real commitment transition this profile drives is the
 *     final Fulfilled → Refunded settlement of a line, through the session.
 *
 * COMPOSITION (no reimplemented logic):
 *   - {@link createSession} owns the world, the per-commitment and per-tree refund
 *     ledgers, replay/idempotency, and the actual Fulfilled → Refunded transition.
 *   - The session's tree path invokes {@link checkI6TreeConsistency} to reconcile the
 *     order's line children against the parent, then caps the cumulative refund across
 *     the tree against the parent's committed amount. We do not re-sum or re-cap.
 *   - The stage transitions are the ONLY new state, and they gate WHEN a refund may be
 *     proposed; they never touch the invariant or transition machinery.
 *
 * SCOPE (honest): the RMA stages are a session-layer overlay. They are per-session and
 * in-memory, like the session's other cross-step state — durable, cross-session RMA
 * tracking would need a persistent store and is not provided here. The refund-amount
 * safety (no over-return) is the existing tree cap, not a new guarantee added here. This
 * profile does not decide return ELIGIBILITY (windows, restocking policy) — those are
 * platform policy, not model invariants. The order and its line children must already be
 * in the world (this profile reverses an order; it does not create one).
 *
 * TypeScript first. Ports to Python / Rust / Go are roadmap.
 */

import type { GuardResult, ProposedAction, World } from "./guard.js";
import type { Money } from "./money.js";
import type { PartyID } from "./primitives.js";
import { createSession, type Session } from "./session.js";

/**
 * The RMA lifecycle stages — a SESSION-LAYER overlay, NOT commitment states. The happy
 * path is requested → authorized → in_transit → received → inspected → refunded;
 * `rejected` is a terminal off-ramp (failed inspection, out of policy). These order the
 * operational workflow; the committed states remain the frozen set.
 */
export type RmaStage =
  | "requested"
  | "authorized"
  | "in_transit"
  | "received"
  | "inspected"
  | "refunded"
  | "rejected";

/** Legal RMA stage transitions — every pair not listed is rejected (overlay only). */
const RMA_STAGES: Record<RmaStage, RmaStage[]> = {
  requested: ["authorized", "rejected"],
  authorized: ["in_transit", "rejected"],
  in_transit: ["received", "rejected"],
  received: ["inspected", "rejected"],
  inspected: ["refunded", "rejected"],
  refunded: [],
  rejected: [],
};

/** The terminal RMA stages — no further stage transition is legal from these. */
const RMA_TERMINAL: ReadonlySet<RmaStage> = new Set<RmaStage>(["refunded", "rejected"]);

/**
 * A single line being returned: the order's LINE-ITEM child commitment to refund
 * against, and the amount. The amount is bounded twice by the session — by the line
 * child's own committed amount, and by the per-tree cap against the parent order.
 */
export interface ReturnLine {
  /** The id of the order's line-item CHILD commitment this return refunds against. */
  line: string;
  /** The money to refund for this line — bounded by the line and the tree cap. */
  amount: Money;
  /** Optional human/agent reason recorded on the refund transition. */
  reason?: string;
}

/** The verdict of advancing an RMA's stage (overlay-only; never a commitment move). */
export type RmaStageResult =
  | { ok: true; stage: RmaStage }
  | { ok: false; reason: string; legal: RmaStage[] };

/**
 * One return-merchandise authorization: the original order it reverses (the tree
 * parent), the line-item children being returned, and its current overlay stage.
 */
export interface Rma {
  /** Stable RMA id. */
  readonly id: string;
  /** The original order commitment this return reverses (the parent in the tree). */
  readonly order: string;
  /** The lines being returned (each refunds against an order line child). */
  readonly lines: ReadonlyArray<ReturnLine>;
  /** The current overlay stage. */
  readonly stage: RmaStage;
}

/**
 * A returns session: a {@link Session} (the proven world + refund ledgers + tree cap +
 * the real Fulfilled → Refunded transition) plus the RMA stage overlay. The money path
 * is entirely the session's; this only adds the stage machine and the convenience of
 * building the return as a child commitment against the parent order.
 */
export interface ReturnsSession {
  /**
   * Open an RMA against an order already present in the world. Validates that the order
   * and every referenced line-item child are present, and starts the RMA at the
   * `requested` stage. Returns the RMA, or a reason if the order/line is not in the world.
   */
  open(rma: { id: string; order: string; lines: ReturnLine[] }): { ok: true; rma: Rma } | { ok: false; reason: string };
  /**
   * Advance an RMA to the next overlay stage (e.g. authorize, mark received, inspect).
   * Rejects an illegal stage move with the legal alternatives — the same shape the
   * commitment guard uses, but over the OVERLAY, not the committed states.
   */
  advance(rmaId: string, to: RmaStage): RmaStageResult;
  /**
   * Settle the refund for an RMA. Only legal once the RMA has reached `inspected`
   * (goods back and checked) — this is where the overlay GATES the money move. Composes
   * the session: each return line is refunded against its order line-item child, bounded
   * by that child's committed amount AND the per-tree cap against the parent order; an
   * over-return is caught there. On full settlement the RMA advances to `refunded`.
   * Returns the session verdict for the settling refund (or the first rejection), so the
   * caller gets the actionable, self-correcting message.
   */
  settle(rmaId: string, actor: PartyID | string): GuardResult;
  /** The current RMA record, or null if unknown. */
  rma(rmaId: string): Rma | null;
  /** The amount refunded so far for a commitment across this session, or null. */
  refundedSoFar(commitmentId: string): Money | null;
  /** The underlying accumulated world (read-only view). */
  readonly world: World;
}

export function createReturnsSession(initialWorld: World): ReturnsSession {
  const session: Session = createSession(initialWorld);
  const rmas = new Map<string, Rma>();

  function open(input: { id: string; order: string; lines: ReturnLine[] }): { ok: true; rma: Rma } | { ok: false; reason: string } {
    if (rmas.has(input.id)) {
      return { ok: false, reason: `An RMA '${input.id}' already exists in this session; use a distinct RMA id.` };
    }
    const order = session.world.commitments.find((c) => (c.id as string) === input.order);
    if (order === undefined) {
      return {
        ok: false,
        reason:
          `No order '${input.order}' exists in the current world; an RMA must reverse an order that is present. ` +
          `Add the original order commitment to the world before opening a return against it.`,
      };
    }
    if (input.lines.length === 0) {
      return { ok: false, reason: `RMA '${input.id}' has no return lines; a return must carry at least one line.` };
    }
    // Every returned line must reference a line-item child commitment present in the
    // world — the return refunds against it, and the session's tree path reconciles the
    // children to the parent (I-6) before applying the cap.
    for (const line of input.lines) {
      const child = session.world.commitments.find((c) => (c.id as string) === line.line);
      if (child === undefined) {
        return { ok: false, reason: `RMA '${input.id}' references line '${line.line}', which is not a commitment in the world.` };
      }
      if (child.parent !== order.id) {
        return { ok: false, reason: `RMA '${input.id}' line '${line.line}' is not a child of order '${input.order}'; a return reverses the order's own lines.` };
      }
    }
    const rma: Rma = { id: input.id, order: input.order, lines: [...input.lines], stage: "requested" };
    rmas.set(input.id, rma);
    return { ok: true, rma };
  }

  function advance(rmaId: string, to: RmaStage): RmaStageResult {
    const rma = rmas.get(rmaId);
    if (rma === undefined) {
      return { ok: false, reason: `No RMA '${rmaId}' in this session.`, legal: [] };
    }
    if (RMA_TERMINAL.has(rma.stage)) {
      return {
        ok: false,
        reason: `RMA '${rmaId}' is at terminal stage '${rma.stage}'; no further stage transition is legal.`,
        legal: [],
      };
    }
    // `refunded` is reached via settle(), not advance() — it is the money-settled stage.
    if (to === "refunded") {
      return {
        ok: false,
        reason: `Stage 'refunded' is reached by settling the refund (settle()), not by advance() — the overlay does not skip the money move.`,
        legal: RMA_STAGES[rma.stage].filter((s) => s !== "refunded"),
      };
    }
    const legal = RMA_STAGES[rma.stage];
    if (!legal.includes(to)) {
      return {
        ok: false,
        reason:
          `RMA '${rmaId}' cannot move from stage '${rma.stage}' to '${to}' — not a legal RMA stage transition ` +
          `(this is a session-layer overlay, not a commitment state). Legal next stages: ${legal.join(", ") || "(none)"}.`,
        legal: [...legal],
      };
    }
    rmas.set(rmaId, { ...rma, stage: to });
    return { ok: true, stage: to };
  }

  function settle(rmaId: string, actor: PartyID | string): GuardResult {
    const rma = rmas.get(rmaId);
    if (rma === undefined) {
      return {
        ok: false,
        violations: [
          { rule: "unknown-rma", message: `No RMA '${rmaId}' in this session.`, fix: "Open the RMA with open() before settling it." },
        ],
      };
    }
    // The overlay GATE: money only moves once goods are back and inspected. This is the
    // whole point of the stage machine — it sequences the operational workflow before
    // the (real) commitment refund.
    if (rma.stage !== "inspected") {
      return {
        ok: false,
        violations: [
          {
            rule: "rma-stage",
            message:
              `RMA '${rmaId}' is at stage '${rma.stage}', not 'inspected'; a return is refunded only after the goods ` +
              `are received and inspected. The RMA stages are a session-layer overlay over the order's committed state.`,
            fix: `Advance the RMA through received → inspected (advance()) before settling the refund.`,
          },
        ],
      };
    }

    // Refund each return line against its order LINE-ITEM CHILD, through the session —
    // the per-child cap, the per-tree cap (checkI6TreeConsistency + the I-1 cumulative
    // probe), and the real Fulfilled → Refunded transition are all the session's, not
    // reimplemented here. The first rejection (e.g. an over-return caught by the tree
    // cap) is returned as-is so the caller gets the actionable, self-correcting message.
    let last: GuardResult | null = null;
    for (const line of rma.lines) {
      const action: ProposedAction = {
        commitment: line.line,
        to: { type: "Refunded", amount: line.amount, at: nowStamp() },
        actor,
        ...(line.reason !== undefined ? { reason: line.reason } : {}),
        idempotencyKey: `rma:${rmaId}:line:${line.line}`,
      };
      const verdict = session.propose(action);
      if (!verdict.ok) return verdict;
      last = verdict;
    }
    // All lines settled: advance the overlay to its terminal `refunded` stage.
    rmas.set(rmaId, { ...rma, stage: "refunded" });
    return last ?? { ok: true, next: session.world };
  }

  return {
    open,
    advance,
    settle,
    rma(rmaId: string): Rma | null {
      return rmas.get(rmaId) ?? null;
    },
    refundedSoFar(commitmentId: string): Money | null {
      return session.refundedSoFar(commitmentId);
    },
    get world() {
      return session.world;
    },
  };
}

/** ISO timestamp for the refund transition `at` (kept local to avoid leaking `now`). */
function nowStamp(): string {
  return new Date().toISOString();
}
