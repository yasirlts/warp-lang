/**
 * Cumulative windowing — cap aggregate refund behavior over a CONFIGURABLE
 * window, generalizing the session's session-lifetime cumulative ledger.
 *
 * {@link createSession} accumulates refunds for the WHOLE life of the session and
 * caps their sum against the commitment's committed total. That catches the
 * classic cross-step over-refund (three 80s against a 200 order sum to 240). But
 * some risk is shaped as a BURST inside a moving window, not a lifetime total: a
 * policy like "no more than 150 MAD refunded across the last 3 refund events" or
 * "no more than 150 MAD refunded in any 60-second window" is satisfied by every
 * individual refund AND by the lifetime sum (which may legitimately reach the full
 * committed amount over weeks), yet violated by a cluster. The point-in-time check
 * cannot see the cluster; the lifetime ledger sees the total but not the window.
 *
 * A windowed session layers that narrower, caller-configured cap on top of the
 * session — without forking either the transition table or the invariant logic:
 *   - the underlying {@link createSession} still runs FIRST for every action, so
 *     the transition table (I-2), the point-in-time audit, idempotency/replay
 *     detection, optimistic-concurrency conflicts, and the lifetime cumulative
 *     over-refund cap (the canonical I-1 probe) all still decide safety. A window
 *     can only NARROW what the session already allows; it never widens it.
 *   - the windowed cap reuses {@link checkI1ValueConservation} through the same
 *     Refunded-state probe the session itself uses — the windowed sum is the
 *     point-in-time I-1 rule applied to an in-window running total, not a second
 *     copy of the rule.
 *
 * THE WINDOW IS CALLER CONFIG, NOT SCHEMA. Whether the window is the last N refund
 * events or a time span, and what the per-window cap is, are passed in by the
 * caller. Nothing here is a schema field; the model schema stays frozen. Events
 * that fall outside the window AGE OUT of the running total, so a window that has
 * scrolled past a burst resets and again has full headroom.
 *
 * SCOPE, STATED PLAINLY. This is a PER-SESSION, IN-MEMORY reference window over a
 * single session's accepted refunds. It is NOT a distributed or persistent
 * aggregate store, NOT a rate limiter shared across processes, and NOT durable
 * across restarts — those need a persistent store and are out of scope. Time
 * windows use a caller-supplied timestamp per action (or `Date.now()` when
 * omitted); they do not depend on a real clock being monotonic across machines.
 *
 * TypeScript first. Ports to Python / Rust / Go are roadmap.
 */

import type { GuardResult, ProposedAction, World } from "./guard.js";
import { checkI1ValueConservation } from "./invariants.js";
import type { Money } from "./money.js";
import { valueId, type Commitment } from "./primitives.js";
import { createSession, type Session } from "./session.js";

/**
 * How the window is bounded. Both forms are CALLER config, not schema.
 *
 *  - `count`: the window is the last `lastN` ACCEPTED refund events (per
 *    commitment). The N+1-th refund ages the oldest out of the running total.
 *  - `time`: the window is all accepted refunds whose timestamp is within
 *    `withinMs` milliseconds of the action under consideration. Older refunds age
 *    out of the running total.
 */
export type WindowSpec =
  | { readonly kind: "count"; readonly lastN: number }
  | { readonly kind: "time"; readonly withinMs: number };

/**
 * A windowed cumulative cap: the running sum of refunds WITHIN the window must not
 * exceed `cap`. The cap is a caller policy — typically smaller than the committed
 * total (that lifetime ceiling is still enforced by the underlying session); the
 * window catches a burst that stays under the lifetime ceiling.
 */
export interface WindowConfig {
  /** How the window is bounded (count of events, or a time span). */
  readonly window: WindowSpec;
  /** The maximum cumulative refund permitted WITHIN the window, in one currency. */
  readonly cap: Money;
}

/** One accepted refund recorded for windowing: when it happened and how much. */
interface WindowedRefund {
  /** Monotonic per-session sequence number — the ordering for a count window. */
  readonly seq: number;
  /** Caller-supplied (or defaulted) timestamp in epoch ms — the axis for a time window. */
  readonly at: number;
  /** The refund amount (single currency, matching the cap). */
  readonly amount: Money;
}

/** Read-only view of a commitment's windowed refund state at a moment in time. */
export interface WindowState {
  /** Sum of refunds currently inside the window (zero Money in the cap currency if none). */
  readonly inWindow: Money;
  /** Headroom left under the cap (cap − inWindow, floored at zero). */
  readonly remaining: Money;
  /** How many refund events are currently inside the window. */
  readonly count: number;
}

/**
 * A session whose refunds are additionally bounded by a moving window cap. Every
 * method delegates the per-action and lifetime checks to an inner
 * {@link createSession}; the window adds one more, narrower constraint on refunds.
 */
export interface WindowedSession {
  /**
   * Validate and (on success) apply a proposed action. The windowed refund cap is
   * checked FIRST for a refund; if the in-window total plus this refund would
   * exceed the cap, the action is rejected and the inner session is never touched
   * (so the world and the lifetime ledger are unchanged). Otherwise the action is
   * delegated to the inner session, which still applies every existing check; the
   * refund is recorded in the window only when the inner session accepts it.
   *
   * `occurredAt` is the timestamp (epoch ms) for time-windowing; it defaults to
   * `Date.now()`. It is ignored for a count window.
   */
  propose(action: ProposedAction, occurredAt?: number): GuardResult;
  /** The current accumulated world (read-only; updated only on accepted actions). */
  readonly world: World;
  /** The amount refunded so far (session lifetime) for a commitment, or null. */
  refundedSoFar(commitmentId: string): Money | null;
  /**
   * The windowed refund state for a commitment as of `asOf` (epoch ms, default
   * `Date.now()`; ignored for a count window). Lets a caller read how much
   * headroom remains before proposing — the planning-oracle view for windows.
   */
  windowState(commitmentId: string, asOf?: number): WindowState;
}

/**
 * Is a cumulative refund of `total` over `cap`? Derived from the canonical I-1 by
 * probing {@link checkI1ValueConservation} with a synthetic commitment whose
 * committed (`requested`) amount is the CAP and whose state is `Refunded(total)` —
 * so "over the window cap" is literally the point-in-time over-refund rule, with
 * the cap standing in for the committed total. The window does not re-derive the
 * conservation check; it reuses it with a different reference amount.
 */
function exceedsCap(reference: Commitment, total: number, cap: Money): boolean {
  const probe: Commitment = {
    ...reference,
    subject: {
      ...reference.subject,
      offered: [],
      requested: [
        {
          id: reference.subject.requested[0]?.id ?? valueId(),
          form: { kind: "Money", money: cap },
          quantity: 1,
          state: { type: "Available" },
        },
      ],
    },
    state: { type: "Refunded", amount: { amount: total, currency: cap.currency }, at: reference.created_at },
    history: [],
  };
  return checkI1ValueConservation([probe]).some(
    (v) => v.invariant === "I-1" && v.description.includes("cannot exceed what was captured"),
  );
}

/**
 * Create a windowed session over `initialWorld` with the given window `config`.
 * The window applies only to `Refunded` actions; every other action passes
 * straight through to the inner session unchanged.
 */
export function createWindowedSession(initialWorld: World, config: WindowConfig): WindowedSession {
  const session: Session = createSession(initialWorld);
  // Per-commitment record of accepted refunds, for windowing. Only refunds the
  // inner session ACCEPTED are recorded — a rejected refund never enters a window.
  const refunds = new Map<string, WindowedRefund[]>();
  // Action keys already admitted to a window, so a replay is not re-checked against
  // the cap or double-counted. Mirrors the caller-supplied idempotency key; when no
  // key is given a structural fingerprint is used (commitment + amount + actor) so
  // a retried identical refund is recognized. Replay SEMANTICS are the session's —
  // this set only gates whether the window cap runs.
  const admitted = new Set<string>();
  let seq = 0;

  /** The replay-identity of an action, matching the session's idempotency idiom. */
  function actionKey(action: ProposedAction): string {
    if (action.idempotencyKey !== undefined) return `key:${action.idempotencyKey}`;
    const parts = [action.commitment, action.to.type, String(action.actor)];
    if (action.to.type === "Refunded") parts.push(String(action.to.amount.amount), action.to.amount.currency);
    return `fp:${parts.join("|")}`;
  }

  /**
   * The accepted refunds for `commitmentId` currently inside the window as of
   * `asOf`. For a count window this is the last N events; for a time window it is
   * every event within `withinMs` of `asOf`. `keep` lets the propose path ask for
   * the last N-1 (the set the new event will join, the oldest evicted).
   */
  function currentWindow(commitmentId: string, asOf: number, keep?: number): WindowedRefund[] {
    const all = refunds.get(commitmentId) ?? [];
    if (config.window.kind === "count") {
      const n = keep ?? config.window.lastN;
      if (n <= 0) return [];
      return all.slice(-n);
    }
    const cutoff = asOf - config.window.withinMs;
    return all.filter((r) => r.at >= cutoff);
  }

  function sumOf(entries: WindowedRefund[]): number {
    return entries.reduce((s, r) => s + r.amount.amount, 0);
  }

  function windowState(commitmentId: string, asOf: number = Date.now()): WindowState {
    const entries = currentWindow(commitmentId, asOf);
    const inWindowAmt = sumOf(entries);
    const remaining = Math.max(0, config.cap.amount - inWindowAmt);
    return {
      inWindow: { amount: inWindowAmt, currency: config.cap.currency },
      remaining: { amount: remaining, currency: config.cap.currency },
      count: entries.length,
    };
  }

  function propose(action: ProposedAction, occurredAt: number = Date.now()): GuardResult {
    if (action.to.type !== "Refunded") {
      // Non-refund actions are not windowed — pure pass-through to the session.
      return session.propose(action);
    }

    const proposed = action.to.amount;
    // The window cap is single-currency; a refund in a different currency is not
    // something this window measures. Defer entirely to the session (which applies
    // its own currency-aware checks) rather than silently mixing currencies here.
    if (proposed.currency !== config.cap.currency) {
      return session.propose(action);
    }

    // A replay is not re-checked against the window cap and never double-counts —
    // hand it to the session, whose replay semantics are canonical (it returns the
    // unchanged world with `replay: true`).
    const key = actionKey(action);
    if (admitted.has(key)) {
      return session.propose(action);
    }

    const order = session.world.commitments.find((c) => (c.id as string) === action.commitment);
    if (order !== undefined) {
      // Windowed cap check FIRST. If the in-window sum plus this refund exceeds the
      // cap, reject before the inner session is touched — the world and lifetime
      // ledger stay unchanged. The prior set is the events that will still be in the
      // window once this one enters (for a count window, the last N-1, since the new
      // event evicts the oldest). Reuses the canonical I-1 probe with the cap as the
      // reference amount.
      const keep = config.window.kind === "count" ? config.window.lastN - 1 : undefined;
      const prior = currentWindow(action.commitment, occurredAt, keep);
      const windowedAmt = sumOf(prior);
      const cumulative = windowedAmt + proposed.amount;
      if (exceedsCap(order, cumulative, config.cap)) {
        const remaining = Math.max(0, config.cap.amount - windowedAmt);
        const inWindowCount = prior.length;
        const windowDesc =
          config.window.kind === "count"
            ? `the last ${config.window.lastN} refund event(s)`
            : `a ${config.window.withinMs}ms window`;
        return {
          ok: false,
          violations: [
            {
              rule: "I-1",
              message:
                `Windowed refunds on ${order.id} would reach ${cumulative} ${config.cap.currency} across ` +
                `${inWindowCount + 1} refund(s) within ${windowDesc}, but the window cap is ` +
                `${config.cap.amount} ${config.cap.currency} — this refund is a burst the lifetime and ` +
                `point-in-time checks do not see (each refund alone, and the lifetime total, may be valid).`,
              fix:
                `Refund at most the remaining ${remaining} ${config.cap.currency} in this window ` +
                `(cap ${config.cap.amount} − already refunded in-window ${windowedAmt}); ` +
                `or wait for earlier refunds to age out of the window.`,
            },
          ],
          alternatives: [
            {
              to: "Refunded",
              label: "refund the commitment",
              bounded: `windowed refunds must stay within the ${config.cap.amount} ${config.cap.currency} cap over ${windowDesc}; ${remaining} ${config.cap.currency} remains in-window`,
            },
          ],
        };
      }
    }

    // Within the window cap — delegate to the inner session for every existing
    // check (transition table, point-in-time audit, idempotency/replay, conflict,
    // and the lifetime cumulative over-refund cap). Record in the window only if
    // the session accepts AND it is not a replay (a replay must not double-count).
    const verdict = session.propose(action);
    if (verdict.ok && verdict.replay !== true && order !== undefined) {
      const list = refunds.get(action.commitment) ?? [];
      list.push({ seq: seq++, at: occurredAt, amount: proposed });
      refunds.set(action.commitment, list);
      admitted.add(key);
    }
    return verdict;
  }

  return {
    propose,
    get world() {
      return session.world;
    },
    refundedSoFar(commitmentId: string): Money | null {
      return session.refundedSoFar(commitmentId);
    },
    windowState(commitmentId: string, asOf?: number): WindowState {
      return windowState(commitmentId, asOf);
    },
  };
}
