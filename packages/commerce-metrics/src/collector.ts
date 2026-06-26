/**
 * In-memory metrics collector for guard blocks.
 *
 * It records one observation per blocked action: which rule(s) the guard cited
 * and the scope the action targeted. It is a plain tally — no I/O, no network,
 * no clock — so it is trivially testable and side-effect-free beyond its own
 * counters. It observes verdicts; it does not produce them.
 */

/** One blocked action to record: the rules the guard cited and the action's scope. */
export interface BlockObservation {
  /** The rule ids the guard returned, e.g. ["I-1"] or ["I-2"]. May be several. */
  rules: string[];
  /** The scope this action targeted (e.g. the proposed target state type). */
  scope: string;
}

/** A read-only snapshot of the tally so far. */
export interface MetricsSnapshot {
  /** Total number of blocked actions observed. */
  totalBlocks: number;
  /** Total number of valid (ok) actions observed. */
  totalAllowed: number;
  /**
   * Count of citations per rule id. A single block citing two rules increments
   * both — so the sum of these can exceed `totalBlocks`.
   */
  byRule: Record<string, number>;
  /** Count of blocked actions per scope. One block increments exactly one scope. */
  byScope: Record<string, number>;
}

/**
 * Accumulates guard outcomes in memory. Reference implementation: a process-local
 * tally with a snapshot reader. It is not a time series, exporter, or persistent
 * store — a caller that needs those can read `snapshot()` and forward it.
 */
export class MetricsCollector {
  #totalBlocks = 0;
  #totalAllowed = 0;
  readonly #byRule = new Map<string, number>();
  readonly #byScope = new Map<string, number>();

  /** Record that an action was allowed (the guard returned ok). */
  recordAllowed(): void {
    this.#totalAllowed += 1;
  }

  /** Record a blocked action: increment every cited rule and the action's scope. */
  recordBlock(observation: BlockObservation): void {
    this.#totalBlocks += 1;
    for (const rule of observation.rules) {
      this.#byRule.set(rule, (this.#byRule.get(rule) ?? 0) + 1);
    }
    this.#byScope.set(observation.scope, (this.#byScope.get(observation.scope) ?? 0) + 1);
  }

  /** A point-in-time copy of the tally. Mutating the returned object is harmless. */
  snapshot(): MetricsSnapshot {
    return {
      totalBlocks: this.#totalBlocks,
      totalAllowed: this.#totalAllowed,
      byRule: Object.fromEntries(this.#byRule),
      byScope: Object.fromEntries(this.#byScope),
    };
  }

  /** Reset all counters to zero. */
  reset(): void {
    this.#totalBlocks = 0;
    this.#totalAllowed = 0;
    this.#byRule.clear();
    this.#byScope.clear();
  }
}
