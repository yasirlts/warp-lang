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
import type { Commitment, Value } from "./primitives.js";
import { sumMoney } from "./invariants.js";

/** One thing a host must deliver to fulfill a commitment, described host-agnostically. */
export interface FulfillItem {
  /** What to deliver — a SKU, a digital identifier, a service name, etc. */
  description: string;
  /** How many. */
  quantity: number;
}

/**
 * A host-agnostic effect descriptor: a neutral statement of WHAT should happen,
 * with enough in the payload for a host to actually perform it. The host maps
 * `kind` + `target` + `payload` onto its own API.
 *
 *  - `refund`  the {@link Money} to return on the target commitment.
 *  - `cancel`  who cancelled, why, and when — so the host can void downstream.
 *  - `fulfill` the items the host must deliver (from the commitment's offered values).
 *  - `settle`  the agreed amount the host captures / settles.
 *  - `notify`  who opened the dispute, why, and when — so the host can escalate.
 *
 * It is a description, not an instruction to a specific system: the host chooses
 * the platform and the call. Transitions with no host effect emit nothing.
 */
export type Effect =
  | { kind: "refund"; target: string; payload: { amount: Money } }
  | { kind: "cancel"; target: string; payload: { reason: string; by: string; at: string } }
  | { kind: "fulfill"; target: string; payload: { items: FulfillItem[] } }
  | { kind: "settle"; target: string; payload: { amount: Money } }
  | { kind: "notify"; target: string; payload: { reason: string; by: string; openedAt: string } };

/** Describe one offered value host-agnostically (what the host delivers). */
function describeValue(v: Value): FulfillItem {
  const f = v.form;
  let description: string;
  switch (f.kind) {
    case "PhysicalGood":
      description = `PhysicalGood ${f.sku}`;
      break;
    case "DigitalGood":
      description = `DigitalGood ${f.identifier}`;
      break;
    case "Service":
      description = `Service ${f.identifier}`;
      break;
    case "Money":
      description = `${f.money.amount} ${f.money.currency}`;
      break;
    default:
      description = f.kind;
  }
  return { description, quantity: v.quantity };
}

/**
 * Describe the host-agnostic effect of a VALIDATED action, as a data descriptor.
 *
 * The caller must have already validated the action (guardAction / a session);
 * this only translates a validated action into a neutral descriptor — it does
 * NOT re-run, duplicate, or fork the invariant checks. It maps the model
 * transitions that imply a host effect:
 *
 *   - `Refunded`  → `refund`  (return the carried {@link Money} on the target)
 *   - `Cancelled` → `cancel`  (carries who/why/when)
 *   - `Fulfilled` → `fulfill` (the host delivers the commitment's offered items)
 *   - `Accepted`  → `settle`  (the host captures the committed amount)
 *   - `Disputed`  → `notify`  (the host escalates; carries who/why/when)
 *
 * `fulfill` and `settle` need the {@link Commitment} to be host-actionable (the
 * items to deliver, the amount to capture). Pass it — the engine always does. A
 * `fulfill`/`settle` requested without the commitment, or a `settle` on a
 * commitment with no committed money, returns an honest non-ok {@link EmitResult}
 * rather than an empty, un-actionable descriptor. Transitions that imply NO host
 * effect (e.g. Proposed, Modified, Active) likewise return a non-ok result. It
 * never throws.
 *
 * No I/O of any kind is performed. Warp describes the effect; the host performs
 * it (Boundary-A: effects-as-data). The `platform` field is `"host"` to signal
 * the descriptor is host-agnostic — not bound to any one platform.
 */
export function toEffect(action: ProposedAction, commitment?: Commitment): EmitResult<Effect> {
  const target = action.commitment;
  const ok = (descriptor: Effect): EmitResult<Effect> => ({ ok: true, platform: "host", descriptor });
  const notOk = (reason: string): EmitResult<Effect> => ({ ok: false, platform: "host", reason });
  switch (action.to.type) {
    case "Refunded":
      return ok({ kind: "refund", target, payload: { amount: action.to.amount } });
    case "Cancelled":
      return ok({ kind: "cancel", target, payload: { reason: action.to.reason, by: action.to.by, at: action.to.at } });
    case "Disputed":
      return ok({
        kind: "notify",
        target,
        payload: { reason: action.to.reason, by: action.to.by, openedAt: action.to.opened_at },
      });
    case "Fulfilled":
      if (commitment === undefined) {
        return notOk("a 'fulfill' effect needs the commitment to list the items to deliver — pass it (the engine does).");
      }
      return ok({ kind: "fulfill", target, payload: { items: commitment.subject.offered.map(describeValue) } });
    case "Accepted": {
      if (commitment === undefined) {
        return notOk("a 'settle' effect needs the commitment to read the amount to capture — pass it (the engine does).");
      }
      const total = sumMoney(commitment.subject.requested).total;
      if (total === null) {
        return notOk("a 'settle' effect needs committed money on the commitment; none found in its requested values.");
      }
      return ok({ kind: "settle", target, payload: { amount: total } });
    }
    default:
      return notOk(
        `A '${action.to.type}' transition has no host-agnostic effect in this layer ` +
          `(covered: Refunded, Cancelled, Fulfilled, Accepted, Disputed). The engine emits no effect for it.`,
      );
  }
}

/**
 * Describe the host-agnostic effects of several VALIDATED actions, preserving
 * order and one-to-one correspondence with the input. Each entry is an
 * independent {@link EmitResult}: a non-representable action yields a non-ok
 * result in its slot rather than failing or dropping the whole batch. Composes
 * {@link toEffect}; performs no I/O. Optional per-action commitments (aligned by
 * index) make `fulfill`/`settle` host-actionable; omit them and those kinds yield
 * an honest non-ok result in their slot.
 */
export function toEffects(actions: ProposedAction[], commitments?: (Commitment | undefined)[]): EmitResult<Effect>[] {
  return actions.map((action, i) => toEffect(action, commitments?.[i]));
}
