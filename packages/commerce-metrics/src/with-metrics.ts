/**
 * withMetrics — wrap a guard function so its blocks are tallied, without touching
 * the guard.
 *
 * The wrapper has the SAME signature and returns the EXACT verdict of the guard
 * it wraps (by default {@link guardAction}). On a block it records the cited
 * rule(s) and a scope into a {@link MetricsCollector}; on an allow it bumps the
 * allowed count. It composes the published guard — it never inspects or alters
 * how the verdict is reached, only observes the verdict that comes out.
 */
import { guardAction } from "@warp-lang/commerce-types";
import type { GuardResult, ProposedAction, World } from "@warp-lang/commerce-types";
import { MetricsCollector } from "./collector.js";

/** The shape of guardAction — the function withMetrics wraps. */
export type GuardFn = (world: World, action: ProposedAction) => GuardResult;

/** Options for {@link withMetrics}. */
export interface WithMetricsOptions {
  /**
   * Derive the scope label recorded for an action. Default: the proposed target
   * state type (e.g. "Refunded", "Cancelled") — the kind of move being guarded.
   */
  scopeOf?: (world: World, action: ProposedAction) => string;
}

/** Default scope: the target state type of the proposed action. */
function defaultScope(_world: World, action: ProposedAction): string {
  return action.to?.type ?? "unknown";
}

/**
 * Wrap a guard function with metrics. Returns a function with the identical
 * signature and verdict; the supplied collector accumulates the tally.
 *
 * ```ts
 * const collector = new MetricsCollector();
 * const guard = withMetrics(guardAction, collector);
 * const verdict = guard(world, action); // identical to guardAction(world, action)
 * collector.snapshot(); // { totalBlocks, byRule, byScope, ... }
 * ```
 *
 * @param guard the guard to wrap; defaults to the published {@link guardAction}.
 * @param collector the tally to record into; defaults to a fresh collector.
 */
export function withMetrics(
  guard: GuardFn = guardAction,
  collector: MetricsCollector = new MetricsCollector(),
  options: WithMetricsOptions = {},
): GuardFn & { collector: MetricsCollector } {
  const scopeOf = options.scopeOf ?? defaultScope;

  const wrapped: GuardFn = (world, action) => {
    const verdict = guard(world, action);
    if (verdict.ok) {
      collector.recordAllowed();
    } else {
      // Record every rule the verdict cited — the rule ids are the guard's own
      // (I-1..I-6 invariants and guard rules); the wrapper does not invent them.
      const rules = verdict.violations.map((v) => v.rule);
      collector.recordBlock({ rules, scope: scopeOf(world, action) });
    }
    // Return the guard's verdict unchanged.
    return verdict;
  };

  return Object.assign(wrapped, { collector });
}
