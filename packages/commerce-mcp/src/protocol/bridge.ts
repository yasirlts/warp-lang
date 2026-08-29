/**
 * The bridge itself: a protocol-shaped action in, Warp's integrity verdict out.
 *
 * It is two steps, in this order, and nothing else:
 *
 *   1. MAP    — `mapProtocolAction` translates the protocol payload into a Warp
 *               `ProposedAction` (pure mapping; see adapters.ts).
 *   2. GUARD  — the UNMODIFIED, published `guardAction` decides. Its result is
 *               returned VERBATIM, byte for byte, as `verdict`.
 *
 * The second step is the whole point of the honesty claim: this module adds NO
 * integrity semantics. Whatever `guard_action` would have said about the mapped
 * action is exactly what this returns — the bridge only spares the caller from
 * writing the mapping by hand. `test/protocol.test.ts` asserts that equivalence
 * against the plain `guard_action` tool, so the claim is checked, not asserted.
 *
 * THREE OUTCOMES, AND THE MIDDLE ONE MATTERS MOST:
 *
 *   - mapped, verdict.ok true   — the commerce move is structurally coherent.
 *   - mapped, verdict.ok false  — Warp blocked it, with the invariant, the reason,
 *                                 the fix, and the legal alternatives.
 *   - NOT MAPPED                — `verdict` is `null`. Warp expressed NO opinion.
 *                                 The action is neither approved nor rejected; it
 *                                 was never checked. A caller that treats this as
 *                                 a pass has defeated the point of asking.
 *
 * WHAT A PASSING VERDICT DOES AND DOES NOT MEAN. `ok: true` means the action is
 * coherent commerce under Warp's six invariants: value is conserved, the state
 * move is legal, the amounts reconcile. It does NOT mean the payment is
 * authorized, the buyer consented, the mandate is valid, the checkout may
 * proceed, or the transaction is not fraud. Those are other layers' questions and
 * Warp does not answer them.
 */
import { guardAction, type GuardResult, type ProposedAction, type World } from "@warp-lang/commerce-types";
import { mapProtocolAction, type MappingNote } from "./adapters.js";
import type { AcpAction, Ap2Action, ProtocolAction, ProtocolId, UcpAction } from "./shapes.js";

/** The one-line scope statement returned with every verdict, so it travels with the answer. */
export const SCOPE_NOTE =
  "Warp checked structural commerce integrity only (value conservation, legal state " +
  "moves, reconciliation). It did not authorize payment, verify identity or consent, " +
  "run checkout, settle funds, or assess fraud — those remain with the protocols and " +
  "systems that own them.";

/** The result of putting a protocol-shaped action through the bridge. */
export interface ProtocolGuardResult {
  /** Which protocol's shape was supplied. */
  protocol: ProtocolId;
  /** Whether the action mapped onto a Warp commitment move at all. */
  mapped: boolean;
  /**
   * Warp's verdict — the unmodified `guardAction` result — or `null` when the
   * action did not map. `null` is NOT a pass: Warp evaluated nothing.
   */
  verdict: GuardResult | null;
  /** The Warp action that was checked. Present only when `mapped` is true. */
  action?: ProposedAction;
  /** Why the action has no sound Warp counterpart. Present only when `mapped` is false. */
  gap?: { reason: string; owner: string };
  /** What the adapter read and translated, and what it deliberately did not interpret. */
  notes: { mapped: MappingNote[]; outOfScope: MappingNote[] };
  /** The standing scope statement — what a verdict here does and does not cover. */
  scope: string;
}

/**
 * Map a protocol-shaped action and run it through the unmodified Warp guard.
 *
 * Pure and total: no I/O, no clock of its own, no mutation of `world`; an
 * unmappable action returns a gap rather than throwing.
 */
export function guardProtocolAction(world: World, input: ProtocolAction): ProtocolGuardResult {
  const mapping = mapProtocolAction(input);

  if (!mapping.ok) {
    return {
      protocol: mapping.protocol,
      mapped: false,
      verdict: null,
      gap: { reason: mapping.reason, owner: mapping.owner },
      notes: { mapped: [], outOfScope: mapping.outOfScope },
      scope: SCOPE_NOTE,
    };
  }

  // The unmodified, published guard decides. Returned verbatim.
  const verdict = guardAction(world, mapping.action);

  return {
    protocol: mapping.protocol,
    mapped: true,
    verdict,
    action: mapping.action,
    notes: { mapped: mapping.mapped, outOfScope: mapping.outOfScope },
    scope: SCOPE_NOTE,
  };
}

/**
 * Assemble the tagged {@link ProtocolAction} union from a protocol id and a
 * validated payload. The MCP tool validates `protocol` and the payload
 * separately (a discriminated tool input would force one giant union in the
 * tool's JSON-Schema), so this re-pairs them in a type-safe way.
 */
export function taggedAction(protocol: ProtocolId, action: unknown): ProtocolAction {
  switch (protocol) {
    case "acp":
      return { protocol: "acp", action: action as AcpAction };
    case "ucp":
      return { protocol: "ucp", action: action as UcpAction };
    case "ap2":
      return { protocol: "ap2", action: action as Ap2Action };
  }
}
