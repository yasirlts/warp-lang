/**
 * Host-agnostic effect DESCRIPTORS — Boundary-A: effects-as-data.
 *
 * The per-platform emitters in {@link ./interop} ({@link toStripeAction},
 * {@link toShopifyAction}, …) translate a VALIDATED Warp action into a payload
 * shaped for ONE specific platform's API. This module adds the generic,
 * host-agnostic sibling: {@link toEffect} describes WHAT a host would do for a
 * validated action as a neutral `{ kind, target, payload }` descriptor, leaving
 * the host to decide HOW (which platform, which API, which credentials).
 *
 * THE LINE THIS MODULE DOES NOT CROSS:
 *
 *   Warp DESCRIBES the effect; the host PERFORMS it. {@link toEffect} returns a
 *   plain data object only. It makes NO network calls, holds NO credentials,
 *   reads NO environment, and performs NO side effect — exactly like the
 *   platform emitters. Carrying out the described effect is the host's job.
 *
 * It COMPOSES the same coverage/validation shape the platform emitters use
 * (Refunded → refund, Cancelled → cancel; anything else is an honest non-ok
 * result). It does not duplicate or fork any guard/invariant logic — validating
 * the action is still the caller's responsibility (guardAction / a session),
 * just as it is for the existing emitters.
 *
 * TypeScript first; other-language ports are roadmap.
 */

import type { EmitResult } from "./interop.js";
import type { ProposedAction } from "./guard.js";
import type { Money } from "./money.js";

/**
 * A host-agnostic effect descriptor: a neutral statement of WHAT should happen,
 * with no platform binding. The host maps `kind` + `target` onto its own API.
 *
 *  - `refund` carries the {@link Money} to return on the target commitment.
 *  - `cancel` carries no payload beyond the target.
 *
 * This mirrors the coverage of the platform emitters (Refunded, Cancelled). It
 * is a description, not an instruction to a specific system: the host chooses
 * the platform and the call.
 */
export type Effect =
  | { kind: "refund"; target: string; payload: { amount: Money } }
  | { kind: "cancel"; target: string; payload: Record<string, never> };

/**
 * Describe the host-agnostic effect of a VALIDATED action, as a data descriptor.
 *
 * The caller must have already validated the action (guardAction / a session);
 * this only translates a validated action into a neutral descriptor — it does
 * NOT re-run, duplicate, or fork the invariant checks. Coverage matches the
 * platform emitters: Refunded → `refund`, Cancelled → `cancel`. Any other action
 * type has no host-agnostic effect in this layer and returns an honest non-ok
 * {@link EmitResult} (it never throws).
 *
 * No I/O of any kind is performed. Warp describes the effect; the host performs
 * it (Boundary-A: effects-as-data).
 *
 * The `platform` field of {@link EmitResult} is reported as `"host"` to signal
 * that the descriptor is host-agnostic — it is not bound to any one platform.
 */
export function toEffect(action: ProposedAction): EmitResult<Effect> {
  if (action.to.type === "Refunded") {
    return {
      ok: true,
      platform: "host",
      descriptor: { kind: "refund", target: action.commitment, payload: { amount: action.to.amount } },
    };
  }
  if (action.to.type === "Cancelled") {
    return {
      ok: true,
      platform: "host",
      descriptor: { kind: "cancel", target: action.commitment, payload: {} },
    };
  }
  return {
    ok: false,
    platform: "host",
    reason:
      `A '${action.to.type}' action has no host-agnostic effect in this layer ` +
      `(covered: Refunded → refund, Cancelled → cancel). Handle it in the host, or extend the descriptor set.`,
  };
}

/**
 * Describe the host-agnostic effects of several VALIDATED actions, preserving
 * order and one-to-one correspondence with the input. Each entry is an
 * independent {@link EmitResult}: a non-representable action yields a non-ok
 * result in its slot rather than failing or dropping the whole batch. Composes
 * {@link toEffect}; performs no I/O.
 */
export function toEffects(actions: ProposedAction[]): EmitResult<Effect>[] {
  return actions.map(toEffect);
}
