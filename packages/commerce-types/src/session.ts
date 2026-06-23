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
 * IDEMPOTENCY & REPLAY-SAFETY: agents retry and networks duplicate, so the SAME
 * action applied twice must not double-apply (a retried refund must not refund
 * twice). The session records the identity of each ACCEPTED action — a
 * caller-supplied `idempotencyKey`, or a derived fingerprint (commitment + target
 * type + amount + actor) when none is given — and treats a repeat as a replay: it
 * does not re-apply, does not advance the world, and returns
 * `{ ok: true, next, replay: true }` so the caller learns "already done", not
 * "applied again". Distinct operations therefore need distinct keys (two
 * structurally-identical refunds with no key are deduped by fingerprint). This is
 * also why a session, not a single `guardAction`, is the home for replay safety:
 * it is the layer that accumulates an applied-action record. Scope is
 * **per-session and in-memory only** — durable, cross-session idempotency would
 * need a persistent store and is not provided here (a documented limit, not a
 * guarantee the session can make).
 *
 * OPTIMISTIC CONCURRENCY: when two actors act on the same commitment, an action
 * may be individually valid yet planned against a STALE version (the other actor
 * advanced the commitment first). A caller passes the version they planned against
 * (`expectedVersion`, from {@link commitmentVersion}, derived from the commitment's
 * append-only history + state — not a schema field); if it no longer matches, the
 * action is rejected as a CONFLICT (`{ ok: false, conflict: true, expected, actual }`)
 * so the caller re-reads and re-plans. A conflict is distinct from an invariant
 * violation (unsafe) and from a replay (a retry, which dedups). This is OPTIMISTIC
 * concurrency over the caller's view — NOT a lock, consensus, or distributed
 * transaction manager; Warp does not serialize concurrent writers.
 *
 * TypeScript first. Ports to Python / Rust / Go are roadmap.
 */

import { checkVersion, guardAction, type GuardResult, type ProposedAction, type World } from "./guard.js";
import { checkI1ValueConservation, checkI6TreeConsistency } from "./invariants.js";
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

/**
 * The identity of an action for replay detection. Two actions are "the same" iff
 * this key is equal. An explicit `idempotencyKey` is used when supplied (the
 * unambiguous, standard approach); otherwise a fingerprint is derived from the
 * fields that define the operation — commitment, target type, amount (for a
 * Refunded move), and actor. Two genuinely-distinct but structurally-identical
 * actions therefore need distinct keys to be applied separately.
 */
function actionKey(action: ProposedAction): string {
  if (action.idempotencyKey !== undefined) return `key:${action.idempotencyKey}`;
  const parts = [action.commitment, action.to.type, String(action.actor)];
  if (action.to.type === "Refunded") {
    parts.push(String(action.to.amount.amount), action.to.amount.currency);
  }
  return `fp:${parts.join("|")}`;
}

/**
 * The root of `commitment`'s tree in `world` — walk `parent` pointers up while the
 * parent is present in the world. A commitment with no parent (or whose parent is
 * not in the world) is its own root. The append-only `parent` / `children` fields
 * already exist on the model, so this is a pure structural read — no schema change.
 */
function treeRootOf(world: World, commitment: Commitment): Commitment {
  const byId = new Map(world.commitments.map((c) => [c.id as string, c]));
  let current = commitment;
  const seen = new Set<string>();
  while (current.parent !== undefined) {
    const parent = byId.get(current.parent as string);
    if (parent === undefined || seen.has(current.id as string)) break;
    seen.add(current.id as string);
    current = parent;
  }
  return current;
}

/** A commitment is "in a tree" if it has a parent (is a child) or has children. */
function isInTree(commitment: Commitment, root: Commitment): boolean {
  return (root.id as string) !== (commitment.id as string) || commitment.children.length > 0;
}

export function createSession(initialWorld: World): Session {
  let world = initialWorld;
  const ledger = new Map<string, RefundTally>();
  // Per-TREE cumulative refund ledger, keyed by the tree ROOT id. The per-commitment
  // `ledger` above caps each commitment against its own committed amount; this caps
  // the SUM of refunds across a parent + its children against the parent's committed
  // amount (full multi-object coherence). Standalone commitments are never tree
  // members, so this leaves single-commitment behaviour byte-for-byte unchanged.
  const treeLedger = new Map<string, RefundTally>();
  // Idempotency / replay-safety: keys of actions ALREADY APPLIED in this session.
  // Scope is per-session and in-memory — durable, cross-session idempotency would
  // need a persistent store and is not provided here (see the module docs).
  const applied = new Set<string>();

  function propose(action: ProposedAction): GuardResult {
    // Replay detection: if this exact action was already applied in this session,
    // it is a no-op — do NOT apply it again, do NOT advance the world. Report the
    // current (unchanged) world flagged `replay: true` so the caller learns
    // "already done", never "applied twice". Only ACCEPTED actions are recorded,
    // so re-proposing a previously-rejected action is re-evaluated normally.
    const key = actionKey(action);
    if (applied.has(key)) {
      return { ok: true, next: world, replay: true };
    }

    // Optimistic-concurrency conflict (distinct from a replay): if this action was
    // planned against a version the commitment has since moved past (a concurrent
    // actor advanced it in this accumulated world), reject as a CONFLICT so the
    // caller re-reads. Checked here too because the partial-refund path below does
    // not route through guardAction. A replay (handled above) is NOT a conflict.
    const conflictTarget = world.commitments.find((c) => (c.id as string) === action.commitment);
    if (conflictTarget !== undefined) {
      const conflict = checkVersion(conflictTarget, action.expectedVersion);
      if (conflict) return conflict;
    }

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

        // Multi-object coherence: if this commitment is part of a tree (a parent
        // with children, or a child), cap the SUM of refunds across the whole tree
        // against the PARENT's committed amount — so refunds spread over different
        // children (each individually valid, each child reconciling via I-6) cannot
        // cumulatively exceed the parent. Composes the existing checkI6TreeConsistency
        // (structure) + the same I-1 cumulative probe (lifted to the parent).
        const root = treeRootOf(world, order);
        const treeMember = isInTree(order, root);
        if (treeMember) {
          const children = world.commitments.filter((c) => c.parent === root.id);
          const i6 = checkI6TreeConsistency(root, children);
          if (i6.length > 0) {
            return { ok: false, violations: i6.map((v) => ({ rule: v.invariant, message: v.description, fix: v.fix })) };
          }
          const treeCommitted = committedTotal(root);
          if (treeCommitted !== null && proposed.currency === treeCommitted.currency) {
            const treePrior = treeLedger.get(root.id as string);
            const treePriorAmt = treePrior ? treePrior.total.amount : 0;
            const treeCount = treePrior ? treePrior.count : 0;
            const treeCumulative = treePriorAmt + proposed.amount;
            if (isCumulativeOverRefund(root, treeCumulative, treeCommitted.currency)) {
              const remaining = Math.max(0, treeCommitted.amount - treePriorAmt);
              return {
                ok: false,
                violations: [
                  {
                    rule: "I-1",
                    message:
                      `Cumulative refunds across the commitment tree rooted at ${root.id} would reach ` +
                      `${treeCumulative} ${treeCommitted.currency} across ${treeCount + 1} refund(s) on the ` +
                      `parent and its children, but the parent committed only ${treeCommitted.amount} ` +
                      `${treeCommitted.currency} — value is not conserved across the tree.`,
                    fix:
                      `Refund at most the remaining ${remaining} ${treeCommitted.currency} across the tree ` +
                      `(parent committed ${treeCommitted.amount} − already refunded across the tree ${treePriorAmt}).`,
                  },
                ],
                alternatives: [
                  {
                    to: "Refunded",
                    label: "refund the commitment",
                    bounded: `cumulative refunds across the tree must stay within the parent's committed ${treeCommitted.amount} ${treeCommitted.currency}; ${remaining} ${treeCommitted.currency} remains refundable`,
                  },
                ],
              };
            }
          }
        }

        // Accepted refund. Record it in the ledger. Keep the order in Fulfilled
        // for a PARTIAL refund (the schema has no partial-refund state); transition
        // it to Refunded only once the refunds reach the committed total.
        const newTotal = prior ? add(prior.total, proposed) : proposed;
        const recordTree = () => {
          if (!treeMember) return;
          const tp = treeLedger.get(root.id as string);
          treeLedger.set(root.id as string, {
            total: tp ? add(tp.total, proposed) : proposed,
            count: (tp ? tp.count : 0) + 1,
          });
        };
        const fullyRefunded = moneyEquals(cumulative, committed.amount, committed.currency);
        if (fullyRefunded) {
          // A real Fulfilled → Refunded transition for the final, full refund.
          const verdict = guardAction(world, action);
          if (!verdict.ok) return verdict;
          world = verdict.next;
          ledger.set(action.commitment, { total: newTotal, count: priorCount + 1 });
          recordTree();
          applied.add(key);
          return verdict;
        }
        ledger.set(action.commitment, { total: newTotal, count: priorCount + 1 });
        recordTree();
        applied.add(key);
        return { ok: true, next: world };
      }
    }

    // Non-refund action: pure compose over guardAction.
    const verdict = guardAction(world, action);
    if (verdict.ok) {
      world = verdict.next;
      applied.add(key);
    }
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
