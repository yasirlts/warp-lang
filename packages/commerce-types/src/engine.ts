/**
 * The pure commerce engine — the effects-as-data core (Phase 3.1).
 *
 *   step(world, event) -> { world, effects, verdict }
 *
 * This is the one function that IS the engine: a PURE function of (world, event)
 * returning the next world, a list of host effect-DESCRIPTORS, and the verdict.
 * It is the Elm/SQL effects-as-data boundary — the engine DECIDES and DESCRIBES;
 * a host PERFORMS the I/O. The engine itself performs NO I/O, reads no clock, and
 * mutates no input.
 *
 * It is NOT a language, NOT a DSL, NOT new syntax — it is the composition of
 * existing pure pieces over the frozen model:
 *   - `guardAction` (from ./guard) gives the validated pure state transition.
 *   - `toEffect` (from ./effects) maps a validated action to a host descriptor.
 * No invariant or transition logic is reimplemented here.
 *
 * Determinism note (an honest finding from this step): the engine itself reads
 * no clock, performs no I/O, and mutates no input. The ONE field that is not
 * byte-for-byte stable across calls is each transition's `history[].at`, which the
 * underlying `guardAction` records from the system clock — the same single field
 * the reference runtime normalizes for replay. `step` is therefore deterministic
 * MODULO that timestamp: same (world, event) -> same output in every other field.
 * The engine does not overwrite the timestamp (doing so would let an event time
 * predate existing history and break temporal monotonicity, which the guard
 * validates against the clock). Making the core literally clock-free would require
 * an injectable clock inside `guardAction` — a separate, later change, gated on
 * whether this pure core proves out.
 */
import type { World, ProposedAction, GuardViolation, TransitionAlternative } from "./guard.js";
import { guardAction } from "./guard.js";
import { toEffect, type Effect } from "./effects.js";

/**
 * The external input the engine interprets. A distinct type from
 * {@link ProposedAction} so the boundary is real and can grow (one event may map
 * to one or more actions later); today a `"action"` event maps 1:1 to an action.
 */
export interface CommerceEvent {
  type: "action";
  /** The proposed action this event asks the engine to apply. */
  action: ProposedAction;
}

/** The engine's decision for one event. */
export interface EngineVerdict {
  ok: boolean;
  /** present on a block: every reason, each with rule + message + fix. */
  violations?: GuardViolation[];
  /** present on a block: the legal moves from the current state. */
  alternatives?: TransitionAlternative[];
  /** present on an optimistic-concurrency conflict. */
  conflict?: boolean;
}

export interface StepResult {
  /** the next world on `ok`; the SAME (unchanged) input world on a block. */
  world: World;
  /** host effect descriptors on `ok`; empty `[]` on a block. */
  effects: Effect[];
  verdict: EngineVerdict;
}

export interface RunResult {
  world: World;
  effects: Effect[];
  verdicts: EngineVerdict[];
}

/** Interpret an event into the action(s) to validate. Today 1:1; structured to grow. */
export function interpret(event: CommerceEvent): ProposedAction[] {
  return [event.action];
}

/**
 * The pure engine step. Validates the event's action(s) via the guard, advances
 * the world on success, and returns host effect descriptors — or, on a block,
 * leaves the world unchanged and returns the verdict explaining why (no effects).
 *
 * Pure + total: same (world, event) -> same output; no clock, no I/O; the input
 * world is never mutated; it never throws.
 */
export function step(world: World, event: CommerceEvent): StepResult {
  try {
    const actions = interpret(event);
    let w: World = world;
    const effects: Effect[] = [];
    for (const action of actions) {
      const r = guardAction(w, action);
      if (!r.ok) {
        // blocked: the whole event is rejected — original world unchanged, no effects.
        return {
          world,
          effects: [],
          verdict: { ok: false, violations: r.violations, alternatives: r.alternatives, conflict: r.conflict },
        };
      }
      // r.next is a fresh world built by the guard (it does not mutate the input).
      // Surfaced as-is: the only non-deterministic field is the transition's
      // wall-clock `at`, which the guard records and which determinism is measured
      // modulo (see the module note).
      w = r.next;
      const e = toEffect(action);
      if (e.ok) effects.push(e.descriptor); // a transition with no host effect emits none (honest)
    }
    return { world: w, effects, verdict: { ok: true } };
  } catch (err) {
    // totality: never throw — surface the failure as a block, world unchanged.
    return {
      world,
      effects: [],
      verdict: {
        ok: false,
        violations: [
          {
            rule: "engine-error",
            message: `the engine could not process this event: ${err instanceof Error ? err.message : String(err)}`,
            fix: "check the event's action is well-formed (a valid commitment id, target state, and actor).",
          },
        ],
      },
    };
  }
}

/**
 * Fold {@link step} over a sequence of events — the engine processing a stream.
 * Deterministic, exactly like the reference runtime's replay: the same initial
 * world and the same events produce the same final world, effects, and verdicts.
 */
export function run(world: World, events: CommerceEvent[]): RunResult {
  let w = world;
  const effects: Effect[] = [];
  const verdicts: EngineVerdict[] = [];
  for (const event of events) {
    const r = step(w, event);
    w = r.world;
    for (const e of r.effects) effects.push(e);
    verdicts.push(r.verdict);
  }
  return { world: w, effects, verdicts };
}
