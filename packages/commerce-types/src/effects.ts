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
 *  - `refund`  carries the {@link Money} to return on the target commitment.
 *  - `cancel`  carries no payload beyond the target.
 *  - `fulfill` the host delivers / ships; no payload beyond the target.
 *  - `settle`  the host captures / settles the agreed payment; target only.
 *  - `notify`  the host escalates / notifies; carries the dispute `reason`.
 *
 * It is a description, not an instruction to a specific system: the host chooses
 * the platform and the call. Transitions with no host effect emit nothing.
 */
export type Effect =
  | { kind: "refund"; target: string; payload: { amount: Money } }
  | { kind: "cancel"; target: string; payload: Record<string, never> }
  | { kind: "fulfill"; target: string; payload: Record<string, never> }
  | { kind: "settle"; target: string; payload: Record<string, never> }
  | { kind: "notify"; target: string; payload: { reason: string } };

/**
 * Describe the host-agnostic effect of a VALIDATED action, as a data descriptor.
 *
 * The caller must have already validated the action (guardAction / a session);
 * this only translates a validated action into a neutral descriptor — it does
 * NOT re-run, duplicate, or fork the invariant checks. It maps the model
 * transitions that imply a host effect:
 *
 *   - `Refunded`  → `refund`  (return the carried {@link Money} on the target)
 *   - `Cancelled` → `cancel`
 *   - `Fulfilled` → `fulfill` (the host delivers / ships)
 *   - `Accepted`  → `settle`  (the host captures / settles the agreed payment)
 *   - `Disputed`  → `notify`  (the host escalates / notifies; carries the reason)
 *
 * Transitions that imply NO host effect (e.g. Proposed, Modified, Active) return
 * an honest non-ok {@link EmitResult} — the engine emits no effect for them. It
 * never throws.
 *
 * No I/O of any kind is performed. Warp describes the effect; the host performs
 * it (Boundary-A: effects-as-data). The `platform` field is `"host"` to signal
 * the descriptor is host-agnostic — not bound to any one platform.
 */
export function toEffect(action: ProposedAction): EmitResult<Effect> {
  const target = action.commitment;
  const ok = (descriptor: Effect): EmitResult<Effect> => ({ ok: true, platform: "host", descriptor });
  switch (action.to.type) {
    case "Refunded":
      return ok({ kind: "refund", target, payload: { amount: action.to.amount } });
    case "Cancelled":
      return ok({ kind: "cancel", target, payload: {} });
    case "Fulfilled":
      return ok({ kind: "fulfill", target, payload: {} });
    case "Accepted":
      return ok({ kind: "settle", target, payload: {} });
    case "Disputed":
      return ok({ kind: "notify", target, payload: { reason: action.to.reason } });
    default:
      return {
        ok: false,
        platform: "host",
        reason:
          `A '${action.to.type}' transition has no host-agnostic effect in this layer ` +
          `(covered: Refunded, Cancelled, Fulfilled, Accepted, Disputed). The engine emits no effect for it.`,
      };
  }
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
