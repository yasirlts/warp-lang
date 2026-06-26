/**
 * Commerce profiles — named DATA subsets of the model, applied caller-side.
 *
 * A profile describes a *kind of commerce* (digital goods, physical goods, a
 * subscription) by naming, as plain data, which commitment states and which
 * value-form kinds are relevant to it. It is configuration, NOT a schema change
 * and NOT a new invariant: the model's 11 commitment states, its transition
 * table, and its six invariants stay exactly as the frozen schema defines them.
 *
 * WHAT A PROFILE IS:
 *   - `allowedStates`     the subset of CommitmentState types this kind of commerce
 *                         uses (e.g. a pure digital good never goes PartiallyFulfilled
 *                         on physical line items).
 *   - `allowedValueForms` the subset of ValueForm kinds this kind of commerce trades
 *                         in (e.g. a digital profile trades DigitalGood + Money, not
 *                         PhysicalGood).
 *   These are DATA. A merchant or integrator picks a profile to say "this account
 *   only ever does digital sales" and the profile becomes an extra, caller-side
 *   constraint on top of the model.
 *
 * WHAT A PROFILE IS NOT:
 *   - It is not a schema edit — it adds no states, no value forms, no fields.
 *   - It is not new invariant logic — it does not re-derive value conservation,
 *     the transition table, or any of the six invariants. {@link guardWithProfile}
 *     checks the profile's data constraint and then DELEGATES to the unmodified
 *     {@link guardAction}, which owns all transition + invariant checking.
 *
 * COMPOSITION (no reimplemented logic):
 *   {@link guardWithProfile} runs the profile's data check FIRST (is the target
 *   state in `allowedStates`? are the target commitment's value forms all in
 *   `allowedValueForms`?). If that data check fails it rejects with a profile-level
 *   reason. If it passes, it calls {@link guardAction} unchanged — so the frozen
 *   invariants and the transition table still decide whether the action is safe.
 *   A profile can only NARROW what is allowed; it can never widen it, because the
 *   delegated guardAction always runs.
 *
 * SCOPE (honest): a profile is a data layer composing the frozen invariants, not a
 * new rule. It expresses "this account does not do X kind of commerce" as a
 * caller-side filter; it does not change what the model considers valid. The
 * value-form check inspects the targeted commitment's subject; it does not police
 * the rest of the world (the delegated guardAction audits the resulting world).
 *
 * TypeScript first. Ports to Python / Rust / Go are roadmap.
 */

import { guardAction, type GuardResult, type ProposedAction, type World } from "./guard.js";
import type { Commitment, Value, ValueForm } from "./primitives.js";
import type { CommitmentStateType } from "./states.js";

/** The discriminant of a value form (PhysicalGood | DigitalGood | Service | Money | …). */
export type ValueFormKind = ValueForm["kind"];

/**
 * A named subset of the model for one kind of commerce. Pure DATA — no behaviour,
 * no schema fields, no invariant logic.
 */
export interface CommerceProfile {
  /** Stable id used as the registry key (e.g. "digital"). */
  id: string;
  /** Human-readable label. */
  label: string;
  /** One-line description of the kind of commerce this profile constrains to. */
  description: string;
  /**
   * The commitment state types this profile permits as a transition TARGET. A
   * subset of the model's 11 states — the profile narrows, it never adds.
   */
  allowedStates: readonly CommitmentStateType[];
  /**
   * The value-form kinds this profile permits in a commitment's subject. A subset
   * of the model's value forms — the profile narrows, it never adds.
   */
  allowedValueForms: readonly ValueFormKind[];
}

/** The value forms present in a commitment's subject (offered + requested). */
function subjectValueForms(c: Commitment): ValueFormKind[] {
  const all: Value[] = [...c.subject.offered, ...c.subject.requested];
  return all.map((v) => v.form.kind);
}

/**
 * Check a proposed action against a profile's DATA constraints, then DELEGATE to
 * the unmodified {@link guardAction}.
 *
 * Order of checks:
 *   1. Resolve the targeted commitment in `world` (mirrors guardAction's own
 *      unknown-commitment handling so the profile layer reports it consistently).
 *   2. PROFILE STATE: reject if the action's target state type is not in the
 *      profile's `allowedStates`.
 *   3. PROFILE VALUE FORM: reject if the targeted commitment's subject carries a
 *      value-form kind the profile does not allow.
 *   4. Otherwise call {@link guardAction} — the frozen transition table + six
 *      invariants decide safety. The profile only narrows; it can never approve an
 *      action that guardAction would reject.
 *
 * ```ts
 * const verdict = guardWithProfile(PROFILES.digital, world, action);
 * if (verdict.ok) {
 *   // verdict.next is the post-action world — safe under the model AND the profile
 * } else {
 *   verdict.violations; // [{ rule, message, fix }] — profile-level OR invariant-level
 * }
 * ```
 */
export function guardWithProfile(
  profile: CommerceProfile,
  world: World,
  action: ProposedAction,
): GuardResult {
  const target = world.commitments.find((c) => (c.id as string) === action.commitment);
  if (target === undefined) {
    // Defer to guardAction's own unknown-commitment reporting — single source of truth.
    return guardAction(world, action);
  }

  // 2. PROFILE STATE constraint (data check, before any model logic).
  if (!profile.allowedStates.includes(action.to.type)) {
    return {
      ok: false,
      violations: [
        {
          rule: "profile-state",
          message:
            `The '${profile.label}' profile does not permit moving a commitment to ` +
            `'${action.to.type}'. This account is configured for ${profile.description} ` +
            `(${describeStates(profile)}).`,
          fix:
            `Choose a target state allowed by this profile, or apply this action under a ` +
            `profile whose commerce kind includes '${action.to.type}'. The model itself ` +
            `still permits '${action.to.type}'; the profile is a caller-side restriction.`,
        },
      ],
    };
  }

  // 3. PROFILE VALUE-FORM constraint (data check on the targeted commitment).
  const present = subjectValueForms(target);
  const offending = present.filter((k) => !profile.allowedValueForms.includes(k));
  if (offending.length > 0) {
    const unique = [...new Set(offending)];
    return {
      ok: false,
      violations: [
        {
          rule: "profile-value-form",
          message:
            `Commitment '${action.commitment}' carries value form(s) ` +
            `[${unique.join(", ")}] that the '${profile.label}' profile does not trade in ` +
            `(${describeValueForms(profile)}).`,
          fix:
            `Apply this action under a profile whose commerce kind includes ` +
            `[${unique.join(", ")}], or model this commitment with value forms the ` +
            `profile allows. The model itself still permits these forms; the profile is ` +
            `a caller-side restriction.`,
        },
      ],
    };
  }

  // 4. Passed the profile's data layer → DELEGATE to the unmodified guardAction.
  //    The frozen transition table + six invariants decide safety.
  return guardAction(world, action);
}

/** A short "states: a, b, c" summary for a profile, used in messages. */
function describeStates(profile: CommerceProfile): string {
  return `permitted states: ${profile.allowedStates.join(", ")}`;
}

/** A short "value forms: a, b" summary for a profile, used in messages. */
function describeValueForms(profile: CommerceProfile): string {
  return `permitted value forms: ${profile.allowedValueForms.join(", ")}`;
}

// ───────────────────────────────────────────────────────────────────────────
// The built-in profile registry — DATA. Each entry is a subset of the frozen
// model. They share the lifecycle states every kind of commerce moves through
// (Draft → Proposed → Accepted → Active → Fulfilled, plus Cancelled / Disputed /
// Refunded) and differ in the value forms they trade and the states that apply.
// ───────────────────────────────────────────────────────────────────────────

/** States common to every kind of commerce — the spine all profiles include. */
const COMMON_STATES: readonly CommitmentStateType[] = [
  "Draft",
  "Proposed",
  "Accepted",
  "Modified",
  "Active",
  "Fulfilled",
  "Cancelled",
  "Disputed",
  "Refunded",
];

/**
 * Digital goods — software, licences, downloads, streams, API access. Paid for in
 * Money. There is no physical, partial line-item fulfilment: a digital good is
 * granted or it is not, so `PartiallyFulfilled` (a physical, multi-line state) and
 * the open-ended `Tendered` offer are excluded.
 */
export const digitalProfile: CommerceProfile = {
  id: "digital",
  label: "Digital goods",
  description: "digital goods (software, licences, downloads) paid in money",
  allowedStates: COMMON_STATES,
  allowedValueForms: ["DigitalGood", "Money"],
};

/**
 * Physical goods — shippable items paid for in Money. Includes
 * `PartiallyFulfilled` because a physical order can ship some line items before
 * others, and `Tendered` for offer-style listings.
 */
export const physicalProfile: CommerceProfile = {
  id: "physical",
  label: "Physical goods",
  description: "physical, shippable goods paid in money",
  allowedStates: [...COMMON_STATES, "PartiallyFulfilled", "Tendered"],
  allowedValueForms: ["PhysicalGood", "Money"],
};

/**
 * Subscriptions — recurring access to a service or digital good, paid in Money. A
 * subscription is continuous, so the `Active` and `Modified` states matter; like a
 * digital good it has no physical multi-line `PartiallyFulfilled` step.
 */
export const subscriptionProfile: CommerceProfile = {
  id: "subscription",
  label: "Subscription",
  description: "recurring subscription access (service or digital) paid in money",
  allowedStates: COMMON_STATES,
  allowedValueForms: ["Service", "DigitalGood", "Money"],
};

/** The built-in profiles, keyed by id. */
export const PROFILES: Record<string, CommerceProfile> = {
  digital: digitalProfile,
  physical: physicalProfile,
  subscription: subscriptionProfile,
};
