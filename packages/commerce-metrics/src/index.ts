/**
 * @warp-lang/commerce-metrics
 *
 * Observability for Warp's commerce-integrity guardrail. Wrap the published
 * guardAction with {@link withMetrics} and the blocks it returns are tallied by
 * rule (I-1..I-6 and the guard's own rules) and by scope, into an in-memory
 * {@link MetricsCollector}. The wrapper composes the guard and returns its verdict
 * verbatim; no invariant, transition, or guard logic is changed here.
 */
export { MetricsCollector } from "./collector.js";
export type { BlockObservation, MetricsSnapshot } from "./collector.js";
export { withMetrics } from "./with-metrics.js";
export type { GuardFn, WithMetricsOptions } from "./with-metrics.js";
