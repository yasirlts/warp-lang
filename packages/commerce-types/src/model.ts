/**
 * The COMPOSED commerce model, and the engine entry point that runs one (rung 4a).
 *
 * The problem this solves. `step`/`run` (./engine) enforce the BASE layer only —
 * `guardAction`, i.e. the transition table and the six invariants. A profile is
 * enforced by `guardWithProfile`, negotiation bounds by `guardConcession`, a
 * regulatory pack by `checkSettlementPolicy`. Those are separate functions a
 * caller wires together by hand, so before this module there was no entry point
 * that ran a WHOLE authored system: you could author a profile and a policy and
 * still have the engine ignore both.
 *
 *   runModel(model, world, events) -> { world, effects, verdicts }
 *
 * `runModel` takes ONE {@link CommerceModel} — a lifecycle, an optional profile,
 * optional policies — and applies every layer that model declares to every event,
 * advancing the world only if ALL of them pass.
 *
 * WHAT THIS IS NOT. It adds no invariant, no state, no transition, and no schema
 * field. Every check it fires is one the model already had; this module only
 * decides WHICH existing checks apply to an event and in what order, then calls
 * them. Not one check is reimplemented here — each layer delegates to the shipped
 * function, and the base layer's verdict always comes from `guardAction`.
 *
 * Purity and determinism are the engine's, unchanged: no I/O, no mutation of any
 * input, never throws, and with a FIXED `opts.clock` the output is byte-for-byte
 * deterministic. `step`/`run` are untouched and behave exactly as before; a model
 * with no profile and no policies produces the same verdicts `step`/`run` would
 * (tested), so the composition is strictly ADDITIVE.
 */
import type { Clock } from "./transitions.js";
import type { CommerceProfile } from "./profiles.js";
import { guardWithProfile } from "./profiles.js";
import type { NegotiationBounds, ConcessionKind } from "./negotiation.js";
import { guardConcession } from "./negotiation.js";
import type { RegulatoryPolicyPack } from "./policy-packs.js";
import { checkSettlementPolicy } from "./policy-packs.js";
import type { InvariantId } from "./invariants.js";
import type { AuctionProcess } from "./auction.js";
import { checkAuctionResolution } from "./auction-integrity.js";
import type { MoneyBreakdown } from "./money.js";
import type { Money } from "./money.js";
import type { PartyID } from "./primitives.js";
import type { World } from "./guard.js";
import { step, type CommerceEvent, type EngineVerdict } from "./engine.js";
import type { Effect } from "./effects.js";

// ---------------------------------------------------------------------------
// The composed model — plain, serializable data
// ---------------------------------------------------------------------------

/**
 * One authored policy, as DATA. Every field is a rule structure the model already
 * defines, and each is consumed by the function that already enforced it:
 *
 *   `bounds`  → `guardConcession`        (a negotiation floor; I-1)
 *   `profile` → `guardWithProfile`       (a narrowed profile)
 *   `pack`    → `checkSettlementPolicy`  (permitted tax rates per jurisdiction)
 *   `asserts` → selects from `auditCommerce` output
 *
 * This is deliberately the shape `@warp-lang/commerce-lang` already compiles a
 * `policy` declaration to, so an authored `.warp` policy drops straight in. It
 * holds no behaviour.
 */
export interface CommercePolicy {
  /** Stable id, used in verdict messages so a block names the policy that caused it. */
  id: string;
  label?: string;
  description?: string;
  /** A negotiation floor. Enforced by `guardConcession` on a concession event. */
  bounds?: NegotiationBounds;
  /** A narrowed profile. Enforced by `guardWithProfile` on every action. */
  profile?: CommerceProfile;
  /** The profile id this policy narrowed, when it was derived from one. */
  appliesTo?: string;
  /** Permitted tax rates. Enforced by `checkSettlementPolicy` on a settlement event. */
  pack?: RegulatoryPolicyPack;
  /**
   * The invariants this policy declares it cares about — carried as DATA, for
   * provenance and round-tripping with an authored `.warp` policy.
   *
   * It is NOT a gate, and deliberately so. `guardAction` already audits ALL SIX
   * invariants over the whole resulting world on every action, so an asserted
   * invariant can never be the layer that blocks: if `auditCommerce` finds
   * anything, the base guard has already refused. Asserting an invariant cannot
   * strengthen that, and — the half that matters — omitting one cannot weaken it.
   * A layer here that appeared to enforce would be enforcing nothing.
   */
  asserts?: readonly InvariantId[];
}

/**
 * A complete authored commerce system, as plain serializable data — the "whole
 * model" object the engine runs. Every field is optional except nothing: a model
 * with no profile and no policies is exactly the base engine.
 *
 * `transitions` is carried for provenance and for callers that verify a lifecycle
 * separately (`verifyLifecycle`); it is NOT consulted when deciding an event.
 * The transition table that governs a move is the MODEL'S OWN, inside
 * `guardAction` — a caller cannot widen the legal moves by authoring a table, and
 * this field deliberately gives them no way to try.
 */
export interface CommerceModel {
  /** Stable id for the authored system. */
  id?: string;
  label?: string;
  description?: string;
  /**
   * The authored lifecycle table, for provenance and separate verification.
   * NOT used to decide events — see the note above.
   */
  transitions?: Readonly<Record<string, readonly string[]>>;
  /** A profile applied to every action in the run. */
  profile?: CommerceProfile;
  /** Policies applied to every event in the run. */
  policies?: readonly CommercePolicy[];
  /**
   * An auction this system coordinates. When present, every event's resulting
   * world is checked for RESOLUTION SOUNDNESS — the winner was a bid the auction
   * collected, only one bid is awarded, losing bids are released, and the
   * clearing price is in the winner's currency and no higher than their offer.
   *
   * These checks are not re-expressions of the six invariants: an unsound
   * resolution is invariant-clean (a dangling loser and a double award both
   * return zero violations from `auditCommerce` — pinned in the tests). They are
   * a data-driven check over an auxiliary record, the same category as a profile
   * or a policy pack. They do NOT judge whether a mechanism produced a good
   * price; see {@link checkAuctionResolution}.
   */
  auction?: AuctionProcess;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * A negotiation move, priced. Distinct from a plain action because a concession
 * carries a PRICE, which a `ProposedAction`'s target state does not. Routed to
 * `guardConcession` with the model's bounds.
 */
export interface ConcessionEvent {
  type: "concession";
  /** The commitment being negotiated. */
  commitment: string;
  /** offer → Proposed, counter → Modified, accept → Accepted (the existing mapping). */
  kind: ConcessionKind;
  /** The price this step puts on the table. */
  price: Money;
  /** Who makes the move. */
  by: PartyID | string;
  reason?: string;
}

/**
 * A settlement presented for checking against a policy's regulatory pack. The
 * committed total is supplied by the caller rather than re-derived here, so this
 * module computes nothing about money.
 */
export interface SettlementEvent {
  type: "settlement";
  /** The commitment this settlement settles (named in the verdict). */
  commitment: string;
  settlement: MoneyBreakdown;
  committedTotal: Money;
}

/** Every event `runModel` accepts. A plain `CommerceEvent` still means exactly what it did. */
export type ModelEvent = CommerceEvent | ConcessionEvent | SettlementEvent;

/** Which layer decided a block — so a caller can tell "illegal move" from "your policy forbids it". */
export type ModelLayer = "base" | "profile" | "policy" | "auction";

/** The engine's decision for one event under a composed model. */
export interface ModelVerdict extends EngineVerdict {
  /** Present on a block: the layer that refused. Absent on `ok`. */
  layer?: ModelLayer;
  /** Present on a block from a policy layer: the id of the policy that refused. */
  policy?: string;
}

export interface ModelStepResult {
  /** the next world on `ok`; the SAME (unchanged) input world on a block. */
  world: World;
  /** host effect descriptors on `ok`; empty `[]` on a block. */
  effects: Effect[];
  verdict: ModelVerdict;
}

export interface ModelRunResult {
  world: World;
  effects: Effect[];
  verdicts: ModelVerdict[];
}

export interface ModelOptions {
  /** Supply a FIXED clock for byte-for-byte determinism, exactly as `step` does. */
  clock?: Clock;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every profile this model applies: the model's own, then each policy's narrowed one. */
function profilesOf(model: CommerceModel): { profile: CommerceProfile; policy?: string }[] {
  const out: { profile: CommerceProfile; policy?: string }[] = [];
  if (model.profile) out.push({ profile: model.profile });
  for (const p of model.policies ?? []) {
    if (p.profile) out.push({ profile: p.profile, policy: p.id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// stepModel — one event, every layer the model declares
// ---------------------------------------------------------------------------

/**
 * Apply one event under a composed model. The layers, in order:
 *
 *  1. PROFILE — for each profile the model declares, `guardWithProfile` decides.
 *     Only its `profile-*` rules are honoured here; anything else it reports is
 *     left to the base layer, whose verdict is authoritative and clocked. (A
 *     profile can only ever narrow, so this ordering cannot approve something the
 *     base layer would refuse.)
 *  2. BASE — `step` (i.e. `guardAction`) decides legality and produces the next
 *     world and effects. This is the only layer that advances anything.
 *  3. AUCTION — when the model carries an auction, the resulting world is checked
 *     for resolution soundness, and the event is refused if it INTRODUCED an
 *     unsoundness (one not already present). These rules catch what the
 *     invariants provably do not: an unsound resolution is invariant-clean.
 *
 * There is deliberately no assertion layer: the base guard already audits
 * all six invariants over the whole resulting world, so a policy's `asserts` list
 * is carried as declared intent and cannot gate anything. See
 * {@link CommercePolicy.asserts}.
 *
 * A concession event is decided by `guardConcession` against the model's bounds
 * before the base layer sees the equivalent move; a settlement event is decided by
 * `checkSettlementPolicy` and advances nothing.
 *
 * Pure and total: it mutates no input and never throws.
 */
export function stepModel(
  model: CommerceModel,
  world: World,
  event: ModelEvent,
  opts?: ModelOptions,
): ModelStepResult {
  const blocked = (verdict: ModelVerdict): ModelStepResult => ({ world, effects: [], verdict });

  try {
    // --- settlement: a policy-pack check. Decides, advances nothing. ---------
    if (event.type === "settlement") {
      const packs = (model.policies ?? []).filter((p) => p.pack);
      if (packs.length === 0) {
        return blocked({
          ok: false,
          layer: "policy",
          violations: [
            {
              rule: "policy-pack-missing",
              message:
                `A settlement was presented for commitment '${event.commitment}', but this model ` +
                `declares no policy with a regulatory pack to check it against.`,
              fix: `Add a policy carrying a 'pack' (RegulatoryPolicyPack), or do not send settlement events.`,
            },
          ],
        });
      }
      for (const p of packs) {
        const verdict = checkSettlementPolicy(event.settlement, event.committedTotal, p.pack!);
        if (verdict.ok === false) {
          return blocked({
            ok: false,
            layer: "policy",
            policy: p.id,
            violations: verdict.violations.map((v) => ({
              rule: v.rule,
              message: v.message,
              fix: v.fix,
            })),
          });
        }
      }
      // Every pack accepted it. Nothing to advance — a settlement check is a check.
      return { world, effects: [], verdict: { ok: true } };
    }

    // --- concession: the negotiation floor, then the equivalent base move ----
    if (event.type === "concession") {
      const withBounds = (model.policies ?? []).filter((p) => p.bounds);
      for (const p of withBounds) {
        const result = guardConcession(world, event.commitment, p.bounds!).step({
          kind: event.kind,
          price: event.price,
          by: event.by,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        });
        if (result.ok === false) {
          return blocked({
            ok: false,
            layer: "policy",
            policy: p.id,
            violations: result.violations,
            ...(result.alternatives !== undefined ? { alternatives: result.alternatives } : {}),
          });
        }
      }
      // Within every declared floor. Advance through the BASE engine so the world,
      // effects and timestamps come from the one clocked path, exactly as an
      // ordinary action would — `guardConcession`'s own world is not used.
      const to =
        event.kind === "offer"
          ? ({ type: "Proposed" } as const)
          : event.kind === "counter"
            ? ({
                type: "Modified",
                modified_by: event.by as PartyID,
                reason: event.reason ?? `counter to ${event.price.amount} ${event.price.currency}`,
              } as const)
            : ({ type: "Accepted" } as const);
      return stepModel(
        model,
        world,
        {
          type: "action",
          action: {
            commitment: event.commitment as CommerceEvent["action"]["commitment"],
            to,
            actor: event.by as PartyID,
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
          },
        },
        opts,
      );
    }

    // --- action: profile layer, then base, then assertions -------------------
    const action = event.action;

    for (const { profile, policy } of profilesOf(model)) {
      const verdict = guardWithProfile(profile, world, action);
      if (verdict.ok === false) {
        // Honour ONLY the profile's own data rules here. Anything else this call
        // reports is the base layer's to decide, on the clocked path below.
        const profileRules = verdict.violations.filter((v) => v.rule.startsWith("profile-"));
        if (profileRules.length > 0) {
          return blocked({
            ok: false,
            layer: "profile",
            ...(policy !== undefined ? { policy } : {}),
            violations: profileRules,
            ...(verdict.alternatives !== undefined ? { alternatives: verdict.alternatives } : {}),
          });
        }
      }
    }

    // BASE — `guardAction`, via the unmodified `step`. This is the only layer that
    // advances anything, and it already audits all six invariants over the whole
    // resulting world (see `CommercePolicy.asserts` for why no assertion layer
    // follows it: there is nothing left for one to catch).
    const base = step(world, event, opts);
    if (!base.verdict.ok) {
      return { world: base.world, effects: base.effects, verdict: { ...base.verdict, layer: "base" } };
    }

    // AUCTION — resolution soundness over the RESULTING world. Checked after the
    // base advance because a resolution is a property of the world an event
    // produces, not of the event in isolation. An auction nobody has won yet is
    // not unsound, so this is silent until a bid is awarded.
    if (model.auction !== undefined) {
      const introduced = checkAuctionResolution(model.auction, base.world);
      if (introduced.length > 0) {
        // Only refuse what THIS event caused. A resolution already unsound before
        // the event is not this event's fault, and blaming it would make every
        // subsequent event unfixable.
        const already = new Set(
          checkAuctionResolution(model.auction, world).map((v) => `${v.rule}|${v.message}`),
        );
        const caused = introduced.filter((v) => !already.has(`${v.rule}|${v.message}`));
        if (caused.length > 0) {
          return blocked({ ok: false, layer: "auction", violations: caused });
        }
      }
    }

    return { world: base.world, effects: base.effects, verdict: base.verdict };
  } catch (err) {
    // Totality, exactly as the base engine: never throw — surface as a block.
    const message = err instanceof Error ? err.message : String(err);
    return blocked({
      ok: false,
      layer: "base",
      violations: [
        {
          rule: "engine-error",
          message: `the engine could not process this event: ${message}`,
          fix: `check the event is well-formed (a valid commitment id, target state, actor, and — for a concession — a price in the negotiation's currency).`,
        },
      ],
    });
  }
}

/**
 * Fold {@link stepModel} over a sequence of events — the engine running a whole
 * authored system. Deterministic with a fixed clock, exactly like `run`.
 */
export function runModel(
  model: CommerceModel,
  world: World,
  events: readonly ModelEvent[],
  opts?: ModelOptions,
): ModelRunResult {
  let w = world;
  const effects: Effect[] = [];
  const verdicts: ModelVerdict[] = [];
  for (const event of events) {
    const r = stepModel(model, w, event, opts);
    w = r.world;
    for (const e of r.effects) effects.push(e);
    verdicts.push(r.verdict);
  }
  return { world: w, effects, verdicts };
}
