/**
 * @warp-lang/commerce-runtime
 *
 * A reference, self-host durable-execution runtime for the Warp commerce model.
 * Feed {@link CommerceRuntime} a list (or stream) of proposed commerce actions; it
 * runs each through a single createSession + guardAction, appends an entry to an
 * append-only {@link AuditStore} (the action, the verdict, the resulting state
 * version), and accumulates the final world. {@link replayLog} rebuilds the same
 * final state by re-running the log — the durable-execution property.
 *
 * It runs the model and logs verdicts. It is NOT a hosted SaaS and NOT a payment
 * executor: side-effects are Boundary-A descriptors ({@link describeEffects}),
 * plain data, no network calls. See the README for the full scope statement.
 */

export { CommerceRuntime } from "./runtime.js";
export type { RuntimeOptions, ProcessResult } from "./runtime.js";

export { InMemoryAuditStore } from "./audit-log.js";
export type { AuditEntry, AuditStore, StateVersion } from "./audit-log.js";

export { FileAuditStore } from "./file-store.js";

export { replayLog, worldsEqual } from "./replay.js";
export type { ReplayResult } from "./replay.js";

export { describeEffects } from "./effects.js";
export type { Effect, EffectResult } from "./effects.js";
