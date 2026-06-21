/**
 * Session-level coherence — validate a SEQUENCE of agent actions against the
 * accumulated history, catching violations that only emerge across steps.
 *
 * {@link guardAction} validates one action against the current world. Some
 * violations are only visible across a sequence — most importantly a CUMULATIVE
 * over-refund: three partial refunds of 80 against a 200 order each individually
 * pass (80 ≤ 200), but they sum to 240 > 200. The point-in-time I-1 check looks
 * at a commitment's *current* Refunded state, so a naive guardAction-in-a-loop
 * catches none of these. A session accumulates and checks the pattern.
 *
 * This is a COMPOSITION over the proven primitives — it does not fork invariant
 * logic:
 *   - {@link guardAction} for per-action validation (transition table = I-2,
 *     point-in-time audit) and for planning-oracle alternatives on rejection;
 *   - {@link checkI1ValueConservation} for the cumulative amount check — the
 *     session probes the SAME canonical I-1 function with the running refund
 *     total, so the cumulative rule is the point-in-time rule, applied to a sum.
 *
 * Scope (honest): the headline cross-step property is cumulative refund
 * conservation. Ordering that lives on a single commitment (a refund before the
 * order was ever captured/fulfilled) is caught because reaching Refunded from a
 * pre-fulfilment state is not a legal transition — guardAction rejects it with
 * the legal alternatives. Cross-object ordering is covered only to the extent
 * the per-action audit (I-4 temporal integrity) already expresses it; properties
 * the data model cannot express are documented as known limits, not faked.
 *
 * A NOTE ON PARTIAL REFUNDS: the schema models a refund as a single terminal
 * `Refunded` state carrying one amount — there is no partial-refund state. So a
 * session tracks partial refunds in its own ledger (a TS-layer accumulation, not
 * a schema change) and keeps the order in `Fulfilled` until it is fully refunded,
 * at which point it transitions to `Refunded`. The cumulative cap is enforced by
 * the session against the order's committed amount.
 *
 * TypeScript first. Ports to Python / Rust / Go are roadmap.
 */

import { guardAction, type GuardResult, type ProposedAction, type World } from "./guard.js";
import { checkI1ValueConservation } from "./invariants.js";
import { add, moneyEquals } from "./money.js";
import type { Money } from "./money.js";
import type { Commitment } from "./primitives.js";
import { isValidCommitmentTransition } from "./transitions.js";

/** The total refunded so far for one commitment, with how many refunds composed it. */
interface RefundTally {
  total: Money;
  count: number;
}

/** A stateful sequence validator over an accumulating world. */
export interface Session {
  /**
   * Validate a proposed action against the ACCUMULATED world (and the session's
   * cross-step ledger), apply it on success, and return the same discriminated
   * verdict as {@link guardAction}. On rejection the world is not advanced.
   */
  propose(action: ProposedAction): GuardResult;
  /** The current accumulated world (read-only view; updated only on accepted actions). */
  readonly world: World;
  /** The amount refunded so far for a commitment across this session, or null if none. */
  refundedSoFar(commitmentId: string): Money | null;
}

/** Sum the Money in a commitment's `requested` subject (single currency). */
function committedTotal(c: Commitment): Money | null {
  const monies: Money[] = [];
  for (const v of c.subject.requested) {
    if (v.form.kind === "Money") monies.push(v.form.money);
  }
  if (monies.length === 0) return null;
  const currency = monies[0]?.currency;
  if (currency === undefined) return null;
  // A mixed-currency subject is a point-in-time I-1 violation already; not ours.
  if (monies.some((m) => m.currency !== currency)) return null;
  return monies.reduce((acc, m) => add(acc, m));
}

/**
 * Is a cumulative refund of `total` over the committed amount? Derived from the
 * canonical I-1 by probing {@link checkI1ValueConservation} with a commitment in
 * `Refunded(total)` state — so this is the point-in-time rule applied to the sum,
 * not a second copy of it.
 */
function isCumulativeOverRefund(order: Commitment, total: number, currency: Money["currency"]): boolean {
  const probe: Commitment = {
    ...order,
    state: { type: "Refunded", amount: { amount: total, currency }, at: order.created_at },
    history: [],
  };
  return checkI1ValueConservation([probe]).some(
    (v) => v.invariant === "I-1" && v.description.includes("cannot exceed what was captured"),
  );
}

export function createSession(initialWorld: World): Session {
  let world = initialWorld;
  const ledger = new Map<string, RefundTally>();

  function propose(action: ProposedAction): GuardResult {
    // Refund actions get the cross-step cumulative check; everything else is a
    // straight compose over guardAction.
    if (action.to.type === "Refunded") {
      const order = world.commitments.find((c) => (c.id as string) === action.commitment);
      // If the order can't legally reach Refunded from its current state (e.g. a
      // refund proposed before the order was ever fulfilled, or after it is fully
      // refunded), let guardAction produce the I-2 rejection WITH alternatives.
      if (order === undefined || !isValidCommitmentTransition(order.state, action.to)) {
        return guardAction(world, action);
      }

      const committed = committedTotal(order);
      const proposed = action.to.amount;
      if (committed !== null && proposed.currency === committed.currency) {
        const prior = ledger.get(action.commitment);
        const priorAmt = prior ? prior.total.amount : 0;
        const priorCount = prior ? prior.count : 0;
        const cumulative = priorAmt + proposed.amount;

        if (isCumulativeOverRefund(order, cumulative, committed.currency)) {
          const remaining = Math.max(0, committed.amount - priorAmt);
          return {
            ok: false,
            violations: [
              {
                rule: "I-1",
                message:
                  `Cumulative refunds on ${order.id} would reach ${cumulative} ${committed.currency} across ` +
                  `${priorCount + 1} refund(s), but only ${committed.amount} ${committed.currency} was committed — ` +
                  `value is not conserved across the session (the point-in-time check sees each refund alone).`,
                fix:
                  `Refund at most the remaining ${remaining} ${committed.currency} ` +
                  `(committed ${committed.amount} − already refunded ${priorAmt}).`,
              },
            ],
            alternatives: [
              {
                to: "Refunded",
                label: "refund the commitment",
                bounded: `cumulative refunds must stay within the committed ${committed.amount} ${committed.currency}; ${remaining} ${committed.currency} remains refundable`,
              },
            ],
          };
        }

        // Accepted refund. Record it in the ledger. Keep the order in Fulfilled
        // for a PARTIAL refund (the schema has no partial-refund state); transition
        // it to Refunded only once the refunds reach the committed total.
        const newTotal = prior ? add(prior.total, proposed) : proposed;
        const fullyRefunded = moneyEquals(cumulative, committed.amount, committed.currency);
        if (fullyRefunded) {
          // A real Fulfilled → Refunded transition for the final, full refund.
          const verdict = guardAction(world, action);
          if (!verdict.ok) return verdict;
          world = verdict.next;
          ledger.set(action.commitment, { total: newTotal, count: priorCount + 1 });
          return verdict;
        }
        ledger.set(action.commitment, { total: newTotal, count: priorCount + 1 });
        return { ok: true, next: world };
      }
    }

    // Non-refund action: pure compose over guardAction.
    const verdict = guardAction(world, action);
    if (verdict.ok) world = verdict.next;
    return verdict;
  }

  return {
    propose,
    get world() {
      return world;
    },
    refundedSoFar(commitmentId: string): Money | null {
      const tally = ledger.get(commitmentId);
      return tally ? tally.total : null;
    },
  };
}
