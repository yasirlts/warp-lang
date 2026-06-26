/**
 * Split fulfillment — bound the CUMULATIVE fractional allocation of a parent
 * commitment across its line-item children, over a SEQUENCE of allocation steps.
 *
 * THE GAP THIS CLOSES (relative to the F6 tree + the refund session):
 *   - {@link checkI6TreeConsistency} (F6) reconciles a STATIC snapshot: given a
 *     parent and the children present right now, it checks that the children's
 *     `requested` amounts sum to the parent (within the currency's minor-unit
 *     tolerance). It answers "does this completed split add up?".
 *   - {@link createSession} lifts the point-in-time I-1 over-refund rule into a
 *     CUMULATIVE rule, but only for REFUNDS (the unwinding direction). Its
 *     per-tree ledger caps the sum of refunds across a tree against the parent.
 *   - Neither bounds the FORWARD direction across STEPS: allocating a parent's
 *     committed value to children one shipment/line at a time, where each
 *     allocation is individually under the parent yet the running sum tips over
 *     the parent commitment only on a later step. A naive loop over the static
 *     I-6 check catches none of these until every child already exists in one
 *     snapshot — and an over-allocation that is split across separately-added
 *     children is exactly the case the static snapshot is reconstructed after
 *     the fact, not guarded as it accumulates.
 *
 * This module is the cross-step accumulator for that forward direction. It is a
 * COMPOSITION over the proven primitives — it does NOT fork invariant or
 * transition logic:
 *   - the over-allocation bound is the SAME I-1 value-conservation rule the
 *     refund path uses, probed via {@link checkI1ValueConservation} with the
 *     running allocation total treated as a `Refunded` amount against the parent
 *     (the canonical "a draw against a commitment cannot exceed what was
 *     committed" oracle, applied to a sum — not a second copy of it);
 *   - when an allocation completes the split (cumulative == parent committed),
 *     the resulting children are reconciled with the unmodified
 *     {@link checkI6TreeConsistency}, so the structural F6 check is what confirms
 *     the finished tree, not new structural logic here;
 *   - {@link allocate} (money.ts) is the recommended way to compute the per-child
 *     fractional shares so they sum EXACTLY to the parent (largest-remainder
 *     method), the same splitter the I-6 docs already point at.
 *
 * SCOPE (honest): this validates that a sequence of fractional allocations
 * conserves the parent's committed value (no over-allocation) and that a
 * completed split reconciles under I-6. It is a SESSION-LAYER accumulator —
 * per-instance and in-memory, like the refund session's ledger and the RMA
 * overlay; durable, cross-process allocation tracking would need a persistent
 * store and is not provided here. It tracks the MONETARY value of each child's
 * `requested` subject (single currency); a child whose subject carries no Money,
 * or a mixed-currency subject (already an I-1 point-in-time violation), is not
 * something this accumulator can bound and is reported as such. It does not
 * create commitments, drive state transitions, or decide WHICH child gets which
 * share — the caller supplies the children (e.g. built with `allocate`); Warp
 * checks they do not collectively draw more than the parent committed.
 *
 * TypeScript first. Ports to Python / Rust / Go are roadmap.
 */

import { checkI1ValueConservation, checkI6TreeConsistency, type InvariantViolation } from "./invariants.js";
import { add } from "./money.js";
import type { Money } from "./money.js";
import type { Commitment } from "./primitives.js";

/** The total allocated to a parent's children so far, with how many children composed it. */
interface AllocationTally {
  total: Money;
  count: number;
}

/** One child allocation proposed against a parent: the child commitment to add. */
export interface AllocationStep {
  /** The line-item CHILD commitment receiving this fractional share of the parent. */
  child: Commitment;
}

/** The verdict of proposing one allocation step. */
export type AllocationResult =
  | {
      ok: true;
      /** The child's allocated amount (the Money in its `requested` subject). */
      allocated: Money;
      /** The cumulative amount allocated across the tree after this step. */
      cumulative: Money;
      /** The amount of the parent commitment still unallocated after this step. */
      remaining: Money;
      /** True once the cumulative allocation reconciles to the parent (split complete). */
      complete: boolean;
    }
  | {
      ok: false;
      violations: Array<{ rule: InvariantViolation["invariant"] | string; message: string; fix: string }>;
    };

/**
 * A stateful accumulator that bounds the cumulative fractional fulfillment of one
 * parent commitment across the children allocated to it, step by step.
 */
export interface SplitFulfillment {
  /**
   * Propose allocating one more child a fractional share of the parent. Accepted
   * only if the running allocation total stays within the parent's committed
   * amount (the I-1 conservation bound); the accepted child is recorded so the
   * NEXT step is checked against the updated running total. On rejection nothing
   * is recorded.
   */
  allocate(step: AllocationStep): AllocationResult;
  /** The amount allocated to children so far, in the parent's currency. */
  allocatedSoFar(): Money;
  /** The parent commitment's committed total (single currency), or null if it carries none. */
  readonly committed: Money | null;
  /** The children accepted so far (in allocation order). */
  readonly children: ReadonlyArray<Commitment>;
}

/** Sum the Money in a commitment's `requested` subject (single currency); null if none/mixed. */
function requestedTotal(c: Commitment): Money | null {
  const monies: Money[] = [];
  for (const v of c.subject.requested) {
    if (v.form.kind === "Money") monies.push(v.form.money);
  }
  if (monies.length === 0) return null;
  const currency = monies[0]?.currency;
  if (currency === undefined) return null;
  // A mixed-currency subject is a point-in-time I-1 violation already; not ours to bound.
  if (monies.some((m) => m.currency !== currency)) return null;
  return monies.reduce((acc, m) => add(acc, m));
}

/**
 * Is a cumulative allocation of `total` over the parent's committed amount? Derived
 * from the canonical I-1 by probing {@link checkI1ValueConservation} with the parent
 * in `Refunded(total)` state — the SAME "a draw against a commitment cannot exceed
 * what was committed" oracle the refund path uses, applied to the allocation sum.
 * This is the point-in-time conservation rule lifted to a running total, NOT a
 * second copy of it.
 */
function isOverAllocation(parent: Commitment, total: number, currency: Money["currency"]): boolean {
  const probe: Commitment = {
    ...parent,
    state: { type: "Refunded", amount: { amount: total, currency }, at: parent.created_at },
    history: [],
  };
  return checkI1ValueConservation([probe]).some(
    (v) => v.invariant === "I-1" && v.description.includes("cannot exceed what was captured"),
  );
}

/**
 * Open a split-fulfillment accumulator for `parent`. The parent is the commitment
 * whose committed value is being fractionally allocated across child line items
 * (the F6 tree's parent). Children are supplied one at a time via {@link SplitFulfillment.allocate}.
 */
export function createSplitFulfillment(parent: Commitment): SplitFulfillment {
  const committed = requestedTotal(parent);
  const accepted: Commitment[] = [];
  let tally: AllocationTally | null = null;

  function currentTotal(): Money {
    if (tally) return tally.total;
    return committed ? { amount: 0, currency: committed.currency } : { amount: 0, currency: "" as Money["currency"] };
  }

  function allocate(step: AllocationStep): AllocationResult {
    const childAmount = requestedTotal(step.child);

    if (committed === null) {
      return {
        ok: false,
        violations: [
          {
            rule: "I-1",
            message:
              `Parent ${parent.id} carries no single-currency monetary commitment in its requested subject, ` +
              `so a fractional value allocation cannot be bounded against it.`,
            fix: "Give the parent a single-currency Money requested subject (convert() any mixed currencies first), then allocate against it.",
          },
        ],
      };
    }
    if (childAmount === null) {
      return {
        ok: false,
        violations: [
          {
            rule: "I-1",
            message:
              `Child ${step.child.id} carries no single-currency monetary value in its requested subject, ` +
              `so its share of the parent cannot be measured.`,
            fix: "Give each child a single-currency Money requested subject (use allocate() to split the parent into exact shares).",
          },
        ],
      };
    }
    if (childAmount.currency !== committed.currency) {
      return {
        ok: false,
        violations: [
          {
            rule: "I-1",
            message:
              `Child ${step.child.id} is in ${childAmount.currency} but the parent committed ${committed.currency}; ` +
              `an allocation must be in the parent's currency to conserve value (no implicit FX).`,
            fix: `Express the child's share in ${committed.currency} (convert() with an explicit rate), or record the conversion in the terms.`,
          },
        ],
      };
    }

    const priorAmt = tally ? tally.total.amount : 0;
    const priorCount = tally ? tally.count : 0;
    const cumulativeAmt = priorAmt + childAmount.amount;

    // The bound: the running allocation total cannot exceed the parent's committed
    // amount. Same canonical I-1 oracle as the refund path, lifted to the sum.
    if (isOverAllocation(parent, cumulativeAmt, committed.currency)) {
      const remaining = Math.max(0, committed.amount - priorAmt);
      return {
        ok: false,
        violations: [
          {
            rule: "I-1",
            message:
              `Allocating ${childAmount.amount} ${committed.currency} to ${step.child.id} would bring the cumulative ` +
              `fulfillment allocation across ${priorCount + 1} child(ren) to ${cumulativeAmt} ${committed.currency}, but ` +
              `parent ${parent.id} committed only ${committed.amount} ${committed.currency} — the split over-allocates ` +
              `the parent (each child alone is within it; the running sum is not).`,
            fix:
              `Allocate at most the remaining ${remaining} ${committed.currency} ` +
              `(committed ${committed.amount} − already allocated ${priorAmt}); use allocate() to split the parent into exact shares.`,
          },
        ],
      };
    }

    // Accepted. Record it so the next step is checked against the updated running total.
    accepted.push(step.child);
    tally = { total: { amount: cumulativeAmt, currency: committed.currency }, count: priorCount + 1 };

    const remaining = { amount: Math.max(0, committed.amount - cumulativeAmt), currency: committed.currency };
    const complete = remaining.amount === 0;

    // When the split is complete, confirm the finished tree with the UNMODIFIED
    // structural F6 check — the children must reconcile to the parent. If they do
    // not (a discrepancy beyond the running-sum check, e.g. a currency edge), surface
    // the I-6 violation rather than silently reporting completion.
    if (complete) {
      const i6 = checkI6TreeConsistency(parent, accepted);
      if (i6.length > 0) {
        return {
          ok: false,
          violations: i6.map((v) => ({ rule: v.invariant, message: v.description, fix: v.fix })),
        };
      }
    }

    return {
      ok: true,
      allocated: childAmount,
      cumulative: { amount: cumulativeAmt, currency: committed.currency },
      remaining,
      complete,
    };
  }

  return {
    allocate,
    allocatedSoFar(): Money {
      return currentTotal();
    },
    committed,
    get children() {
      return accepted;
    },
  };
}
