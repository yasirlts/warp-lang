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
 * Determinism: the engine performs no I/O and mutates no input. The one field the
 * model samples is each transition's `history[].at`; it now comes from an OPTIONAL
 * injectable clock threaded into `guardAction` (Phase 3.1b). With a FIXED clock,
 * `step`/`run` are byte-for-byte deterministic: same (world, event, clock) -> the
 * same output, every field. With no clock supplied the default is the real wall
 * clock (backward-compatible). The clock is injectable for determinism, but it is
 * NOT exempt from Invariant 4: an injected time earlier than the previous
 * transition is still rejected — the clock is injectable; temporal integrity is
 * not. (This resolves the "deterministic modulo the timestamp" caveat from the
 * first Phase-3.1 cut.)
 */
import type { World, ProposedAction, GuardViolation, TransitionAlternative } from "./guard.js";
import { guardAction } from "./guard.js";
import { toEffect, type Effect } from "./effects.js";
import type { Clock } from "./transitions.js";

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

/**
 * Engine options. Supply a FIXED `clock` to make `step`/`run` byte-for-byte
 * deterministic (replay, simulation, tests); omit it for the real wall clock.
 * The injected time is still governed by Invariant 4 — an earlier-than-previous
 * time is rejected, exactly as a wall-clock time would be. Mirrors the
 * `{ now }` clock the reference runtime already accepts, threaded into the guard.
 */
export interface EngineOptions {
  clock?: Clock;
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
 * Pure + total: same (world, event, clock) -> same output; the input world is
 * never mutated; it never throws. With a FIXED `opts.clock` the output is
 * byte-for-byte deterministic; with no clock it uses the real wall clock.
 */
export function step(world: World, event: CommerceEvent, opts?: EngineOptions): StepResult {
  try {
    const actions = interpret(event);
    let w: World = world;
    const effects: Effect[] = [];
    for (const action of actions) {
      const r = guardAction(w, action, opts?.clock);
      if (!r.ok) {
        // blocked: the whole event is rejected — original world unchanged, no effects.
        return {
          world,
          effects: [],
          verdict: { ok: false, violations: r.violations, alternatives: r.alternatives, conflict: r.conflict },
        };
      }
      // r.next is a fresh world built by the guard (it does not mutate the input).
      // The transition's `at` comes from opts.clock (the wall clock by default);
      // with a fixed clock the result is byte-for-byte deterministic.
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
 * world, events, and (fixed) clock produce byte-for-byte the same final world,
 * effects, and verdicts.
 */
export function run(world: World, events: CommerceEvent[], opts?: EngineOptions): RunResult {
  let w = world;
  const effects: Effect[] = [];
  const verdicts: EngineVerdict[] = [];
  for (const event of events) {
    const r = step(w, event, opts);
    w = r.world;
    for (const e of r.effects) effects.push(e);
    verdicts.push(r.verdict);
  }
  return { world: w, effects, verdicts };
}
