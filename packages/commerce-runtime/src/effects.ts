/**
 * Boundary-A effect descriptors for the runtime's ACCEPTED actions.
 *
 * The runtime validates and logs; it performs no side effect. When a host wants
 * to actually carry out the accepted actions (issue the refund, cancel the order),
 * it asks for the effect DESCRIPTORS — plain `{ kind, target, payload }` data
 * (Boundary-A: effects-as-data). The host maps each descriptor onto its own API;
 * this module makes no network call, holds no credentials, and reads no
 * environment.
 *
 * This is a pure read over the audit log + a literal translation of an action's
 * target state into a neutral descriptor. It is NOT guard or invariant logic: the
 * action was already validated and its verdict recorded in the log; this only
 * restates an accepted action as data the host can act on. Coverage mirrors the
 * model's money-moving terminal states (Refunded → refund, Cancelled → cancel);
 * any other accepted action has no host-agnostic effect in this layer and is
 * surfaced honestly as a non-representable descriptor rather than dropped.
 *
 * NOTE ON SCOPE: this descriptor is intentionally minimal and lives in the
 * runtime so the package depends only on the PUBLISHED commerce-types surface. A
 * richer, platform-aware emitter set already exists in commerce-types' interop
 * layer; a host that wants per-platform payloads (Stripe, Shopify, …) should use
 * those directly on the accepted actions.
 */

import type { Money, ProposedAction } from "@warp-lang/commerce-types";
import type { AuditEntry, AuditStore } from "./audit-log.js";

/**
 * A host-agnostic effect descriptor: WHAT should happen, with no platform binding.
 *  - `refund` carries the {@link Money} to return on the target commitment.
 *  - `cancel` carries no payload beyond the target.
 */
export type Effect =
  | { kind: "refund"; target: string; payload: { amount: Money } }
  | { kind: "cancel"; target: string; payload: Record<string, never> };

/** The outcome of describing one action as a Boundary-A descriptor. */
export type EffectResult =
  | { ok: true; effect: Effect }
  | { ok: false; reason: string };

/** Was this entry an accepted, world-advancing action (not blocked, not a replay)? */
function wasApplied(entry: AuditEntry): boolean {
  return entry.verdict.ok === true && entry.verdict.replay !== true;
}

/** Translate one accepted action into its Boundary-A descriptor (data only, no I/O). */
function effectOf(action: ProposedAction): EffectResult {
  if (action.to.type === "Refunded") {
    return { ok: true, effect: { kind: "refund", target: action.commitment, payload: { amount: action.to.amount } } };
  }
  if (action.to.type === "Cancelled") {
    return { ok: true, effect: { kind: "cancel", target: action.commitment, payload: {} } };
  }
  return {
    ok: false,
    reason:
      `A '${action.to.type}' action has no host-agnostic effect in this layer ` +
      `(covered: Refunded -> refund, Cancelled -> cancel). Handle it in the host, ` +
      `or use the commerce-types interop emitters for a platform-specific payload.`,
  };
}

/**
 * Derive Boundary-A effect descriptors for every ACCEPTED action in the log, in
 * order. The host performs them; Warp only describes them. Blocked, replayed, and
 * conflicting entries contribute no effect.
 */
export function describeEffects(source: AuditStore | AuditEntry[]): EffectResult[] {
  const entries = Array.isArray(source) ? source : source.entries();
  return entries.filter(wasApplied).map((e) => effectOf(e.action));
}
