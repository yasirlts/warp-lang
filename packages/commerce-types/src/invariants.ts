/**
 * Runtime checkers for the six invariants of the Warp Commerce Model. Each
 * returns a list of violations (empty = clean) rather than a boolean, so the
 * caller — a developer, a CI step, or an AI coding agent — gets actionable
 * detail per violation.
 */

import type { Money, MoneyBreakdown } from "./money.js";
import { CurrencyMismatchError, moneyEquals, validateMoneyBreakdown } from "./money.js";
import type { Commitment, Fulfillment, Party, PartyCapacity, PartyID, Value } from "./primitives.js";
import { isValidCommitmentTransition } from "./transitions.js";

export type InvariantId = "I-1" | "I-2" | "I-3" | "I-4" | "I-5" | "I-6";

export interface InvariantViolation {
  invariant: InvariantId;
  name: string;
  description: string;
  location?: string;
  fix: string;
}

// --- helpers ---------------------------------------------------------------

function moneyOf(value: Value): Money | null {
  return value.form.kind === "Money" ? value.form.money : null;
}

/** Sum the Money values in a list; flags if more than one currency appears. */
function sumMoney(values: Value[]): { total: Money | null; mixed: boolean; currencies: string[] } {
  const currencies = new Set<string>();
  let amount = 0;
  for (const v of values) {
    const m = moneyOf(v);
    if (m) {
      currencies.add(m.currency);
      amount += m.amount;
    }
  }
  const list = [...currencies];
  if (list.length === 0) return { total: null, mixed: false, currencies: list };
  const first = list[0] as string;
  return { total: { amount, currency: first }, mixed: list.length > 1, currencies: list };
}

const ACCEPTED_OR_LATER = new Set([
  "Accepted",
  "Active",
  "Modified",
  "PartiallyFulfilled",
  "Fulfilled",
  "Disputed",
  "Refunded",
]);

function reachedAccepted(c: Commitment): boolean {
  if (ACCEPTED_OR_LATER.has(c.state.type)) return true;
  return c.history.some((h) => h.to.type === "Accepted");
}

function acceptedAt(c: Commitment): string | null {
  const entry = c.history.find((h) => h.to.type === "Accepted");
  return entry ? entry.at : null;
}

// --- I-1: Value Conservation ----------------------------------------------

export function checkI1ValueConservation(commitments: Commitment[]): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  for (const c of commitments) {
    const all = [...c.subject.offered, ...c.subject.requested];
    const { mixed, currencies } = sumMoney(all);
    if (mixed) {
      out.push({
        invariant: "I-1",
        name: "Value Conservation",
        description: `Commitment ${c.id} mixes currencies (${currencies.join(", ")}) in its subject without explicit conversion.`,
        fix: "Convert all monetary values to one currency with convert(), or record an explicit CurrencyConversion in the terms.",
      });
    }
  }
  return out;
}

/**
 * I-1, fourth clause (v0.3) — loyalty point creation.
 *
 * Loyalty points and merchant-issued currency are the only ValueForm where
 * value *creation* (not transfer) is the primary operation: the issuer mints
 * points as a liability — a promise to honor them in future transactions.
 * Conservation therefore applies to the issuer's total outstanding liability
 * pool, not to any single transaction. A merchant must not issue more points
 * than the business can sustain as redeemable value.
 *
 * `sustainable` is true when the redemption value of all outstanding points
 * does not exceed the issuer's capacity to honor them.
 */
export interface LoyaltyLiabilityCheck {
  issuer: PartyID;
  total_points_outstanding: number;
  points_per_currency_unit: number;
  redemption_rate: Money; // value of a single point when redeemed
  sustainable: boolean; // outstanding * rate <= issuer capacity
}

export function checkLoyaltyLiability(
  issuer: PartyID,
  outstanding_points: number,
  redemption_value_per_point: Money,
  issuer_revenue_capacity: Money,
): LoyaltyLiabilityCheck {
  // Liability and capacity must be denominated in the same currency to compare.
  if (redemption_value_per_point.currency !== issuer_revenue_capacity.currency) {
    throw new CurrencyMismatchError(
      redemption_value_per_point.currency,
      issuer_revenue_capacity.currency,
    );
  }
  const totalLiability = outstanding_points * redemption_value_per_point.amount;
  return {
    issuer,
    total_points_outstanding: outstanding_points,
    points_per_currency_unit:
      redemption_value_per_point.amount === 0 ? 0 : 1 / redemption_value_per_point.amount,
    redemption_rate: redemption_value_per_point,
    sustainable: totalLiability <= issuer_revenue_capacity.amount,
  };
}

/**
 * I-1, MoneyBreakdown extension — the canonical `money_breakdown_sum` rule
 * (schema/behavior/invariants.json, invariant I-1). A MoneyBreakdown is clean
 * when every component shares the total's currency and the component amounts
 * sum to the total within the currency's minor-unit tolerance (a Discount
 * component carries a negative amount and subtracts). This is the
 * violations-returning checker form of `validateMoneyBreakdown` (money.ts),
 * consistent with the other `checkI*` functions; both enforce the identical
 * rule the Python binding enforces via `validate_money_breakdown`.
 */
export function checkI1MoneyBreakdownSum(breakdown: MoneyBreakdown): InvariantViolation[] {
  try {
    validateMoneyBreakdown(breakdown);
    return [];
  } catch (e) {
    return [
      {
        invariant: "I-1",
        name: "Value Conservation",
        description: `MoneyBreakdown violates money_breakdown_sum: ${(e as Error).message}`,
        fix: "Express every component in the total's currency (convert() first), and ensure the components — Discounts negative — sum to the total.",
      },
    ];
  }
}

// --- I-2: State Monotonicity ----------------------------------------------

export function checkI2StateMonotonicity(commitment: Commitment): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  for (const h of commitment.history) {
    if (!isValidCommitmentTransition(h.from, h.to)) {
      out.push({
        invariant: "I-2",
        name: "State Monotonicity",
        description: `Commitment ${commitment.id} recorded an invalid transition ${h.from.type} → ${h.to.type}.`,
        fix: "Only the model's valid transitions are allowed; a reversal must be a new Commitment with parties exchanged.",
      });
    }
  }
  // Timestamps must never move backward.
  for (let i = 1; i < commitment.history.length; i++) {
    const prev = commitment.history[i - 1];
    const cur = commitment.history[i];
    if (prev && cur && Date.parse(cur.at) < Date.parse(prev.at)) {
      out.push({
        invariant: "I-2",
        name: "State Monotonicity",
        description: `Commitment ${commitment.id} has a transition dated before the previous one (${cur.at} < ${prev.at}).`,
        fix: "History is append-only and time moves forward; record a correcting entry instead of backdating.",
      });
    }
  }
  return out;
}

// --- I-3: Capacity Verification -------------------------------------------

export function checkI3CapacityVerification(
  commitment: Commitment,
  capacity: PartyCapacity,
): InvariantViolation[] {
  if (reachedAccepted(commitment) && !capacity.can_buy) {
    return [
      {
        invariant: "I-3",
        name: "Capacity Verification",
        description: `Commitment ${commitment.id} reached Accepted but the initiator's capacity does not permit buying (can_buy=false).`,
        fix: "Verify party capacity (can_buy) before transitioning to Accepted.",
      },
    ];
  }
  return [];
}

// --- I-4: Temporal Integrity ----------------------------------------------

export function checkI4TemporalIntegrity(
  commitment: Commitment,
  fulfillments: Fulfillment[],
): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const mine = fulfillments.filter((f) => f.commitment === commitment.id);
  const accepted = acceptedAt(commitment);
  for (const f of mine) {
    const started = f.started_at;
    const executed = f.state.type === "InProgress" || f.state.type === "Completed";
    if (executed && accepted === null) {
      out.push({
        invariant: "I-4",
        name: "Temporal Integrity",
        description: `Fulfillment ${f.id} is executing but its Commitment ${commitment.id} never reached Accepted.`,
        fix: "Commitments form before Fulfillments execute — accept the commitment first.",
      });
    } else if (started && accepted && Date.parse(started) < Date.parse(accepted)) {
      out.push({
        invariant: "I-4",
        name: "Temporal Integrity",
        description: `Fulfillment ${f.id} started (${started}) before its Commitment was Accepted (${accepted}).`,
        fix: "Move the fulfillment after the commitment's Accepted transition.",
      });
    }
  }
  return out;
}

// --- I-5: Identity Permanence ---------------------------------------------

export function checkI5IdentityPermanence(ids: string[]): InvariantViolation[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes].map((id) => ({
    invariant: "I-5" as const,
    name: "Identity Permanence",
    description: `Identifier '${id}' appears more than once.`,
    fix: "IDs are globally unique and never reused; generate a fresh id.",
  }));
}

// --- I-6: Commitment Tree Consistency -------------------------------------

export function checkI6TreeConsistency(
  parent: Commitment,
  children: Commitment[],
): InvariantViolation[] {
  const parentSum = sumMoney(parent.subject.requested);
  if (parentSum.total === null) return [];
  let childAmount = 0;
  const currencies = new Set<string>([parentSum.total.currency]);
  for (const child of children) {
    const s = sumMoney(child.subject.requested);
    if (s.total) {
      currencies.add(s.total.currency);
      childAmount += s.total.amount;
    }
  }
  const out: InvariantViolation[] = [];
  if (currencies.size > 1) {
    out.push({
      invariant: "I-6",
      name: "Commitment Tree Consistency",
      description: `Parent ${parent.id} and its children use mixed currencies (${[...currencies].join(", ")}); convert to a base currency before summing.`,
      fix: "Express parent and children in one base currency (via explicit conversion) before comparing.",
    });
    return out;
  }
  // Compare with a minor-unit tolerance, NOT exact float equality: children of
  // 0.1 + 0.2 MAD must reconcile against a parent of 0.3 MAD even though
  // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754. `moneyEpsilon` is half the
  // currency's smallest minor unit (0.005 for 2-decimal currencies), so only a
  // real discrepancy (≥ half a cent) is flagged. For exact splits that never
  // drift in the first place, build children with `allocate()` (money.ts).
  if (!moneyEquals(childAmount, parentSum.total.amount, parentSum.total.currency)) {
    out.push({
      invariant: "I-6",
      name: "Commitment Tree Consistency",
      description: `Children of ${parent.id} sum to ${childAmount} ${parentSum.total.currency} but the parent requests ${parentSum.total.amount} ${parentSum.total.currency}.`,
      fix: "Child commitment values must sum to the parent; recalculate after any substitution or cancellation (use allocate() for exact splits).",
    });
  }
  return out;
}

// --- audit -----------------------------------------------------------------

/**
 * Run every applicable invariant check across a set of commerce objects and
 * return all violations. Pairs each commitment with its initiator's capacity
 * (I-3), its fulfillments (I-4), and — when it has children present in the set
 * — its children (I-6).
 */
export function auditCommerce(
  commitments: Commitment[],
  fulfillments: Fulfillment[],
  parties: Party[],
): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const capacityByParty = new Map<string, PartyCapacity>(parties.map((p) => [p.id, p.capacity]));
  const commitmentById = new Map<string, Commitment>(commitments.map((c) => [c.id, c]));

  out.push(...checkI1ValueConservation(commitments));

  for (const c of commitments) {
    out.push(...checkI2StateMonotonicity(c));
    const cap = capacityByParty.get(c.parties.initiator);
    if (cap) out.push(...checkI3CapacityVerification(c, cap));
    out.push(...checkI4TemporalIntegrity(c, fulfillments));
    if (c.children.length > 0) {
      const kids = c.children
        .map((id) => commitmentById.get(id))
        .filter((x): x is Commitment => x !== undefined);
      if (kids.length > 0) out.push(...checkI6TreeConsistency(c, kids));
    }
  }

  const allIds: string[] = [
    ...commitments.map((c) => c.id as string),
    ...fulfillments.map((f) => f.id as string),
    ...parties.map((p) => p.id as string),
  ];
  out.push(...checkI5IdentityPermanence(allIds));

  return out;
}
