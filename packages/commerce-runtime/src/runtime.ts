/**
 * The reference runtime — feed it proposed commerce actions, it runs each one
 * through a single {@link createSession} and records every verdict in an
 * append-only {@link AuditStore}.
 *
 * WHAT IT IS: a runnable, self-host reference for durable execution of the Warp
 * commerce model. It accepts a list (or any iterable) of events — each event is a
 * proposed commerce action — runs each through the session's `propose` (which
 * composes guardAction + the cross-step cumulative checks), and appends an audit
 * entry per action: the action, the verdict, and the resulting state version.
 * The accumulated world after the last action is the runtime's final state.
 *
 * WHAT IT IS NOT (honest scope):
 *   - NOT a hosted SaaS. It is a library you run yourself, in your process.
 *   - NOT a payment executor. It validates and logs; it authorizes, settles, and
 *     moves no money. Carrying out an accepted action is the host's job — and the
 *     effect to carry out is a Boundary-A DESCRIPTOR (see {@link describeEffects}),
 *     plain data, no network call, no credentials.
 *   - NOT a distributed/HA execution engine. The "durable" property here is the
 *     append-only log + replay: the log can survive the process (file store) and
 *     re-running it reproduces the same final state (see {@link replayLog}). It is
 *     not a clustered scheduler, not crash-atomic, and makes no liveness or
 *     exactly-once delivery guarantees.
 *
 * DETERMINISM / REPLAY: the runtime adds no nondeterminism of its own — it does
 * not read the clock, the network, or random state to DECIDE a verdict. The only
 * wall-clock read is the `at` stamp on the audit entry (metadata, not input to
 * the verdict). So replaying the recorded actions through a fresh runtime over the
 * same initial world reproduces the same verdicts and the same model state. One
 * field is not reproducible and is not claimed to be: the frozen model stamps each
 * transition's history record with a wall-clock instant at apply time, so a later
 * replay's history stamps differ. {@link worldsEqual} compares state up to those
 * model-sampled stamps; {@link replayLog} documents the boundary precisely.
 */

import {
  commitmentVersion,
  createSession,
  type Commitment,
  type GuardResult,
  type ProposedAction,
  type Session,
  type World,
} from "@warp-lang/commerce-types";
import { InMemoryAuditStore, type AuditEntry, type AuditStore, type StateVersion } from "./audit-log.js";

/** Options for {@link CommerceRuntime}. */
export interface RuntimeOptions {
  /**
   * Where to record the audit log. Defaults to a fresh {@link InMemoryAuditStore}.
   * Pass a FileAuditStore to persist the log across the process.
   */
  store?: AuditStore;
  /**
   * Clock for the audit entry's `at` metadata stamp ONLY. It does not affect any
   * verdict (the verdict is a pure function of the world + action). Defaults to
   * `() => new Date().toISOString()`. A fixed clock makes entry stamps
   * deterministic for tests.
   */
  now?: () => string;
}

/** The outcome of processing one action: the entry that was logged, plus whether it advanced the world. */
export interface ProcessResult {
  /** The audit entry appended for this action. */
  entry: AuditEntry;
  /** True when the action was accepted and advanced the world (false when blocked, a replay, or a conflict). */
  advanced: boolean;
}

/** Look up a commitment's current version in `world`, or null if it is absent. */
function versionInWorld(world: World, commitmentId: string): string | null {
  const c: Commitment | undefined = world.commitments.find((x) => (x.id as string) === commitmentId);
  return c === undefined ? null : commitmentVersion(c);
}

/**
 * A reference durable-execution runtime over the Warp commerce model.
 *
 * ```ts
 * const rt = new CommerceRuntime(initialWorld);
 * rt.process(action);            // run one action, log its verdict
 * rt.run([a1, a2, a3]);          // run a batch
 * rt.world;                      // the accumulated final state
 * rt.store.entries();            // the append-only audit log
 * ```
 */
export class CommerceRuntime {
  /** The append-only audit log this runtime writes to. */
  readonly store: AuditStore;
  private readonly session: Session;
  private readonly now: () => string;
  private seq = 0;

  constructor(initialWorld: World, options: RuntimeOptions = {}) {
    this.session = createSession(initialWorld);
    this.store = options.store ?? new InMemoryAuditStore();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** The accumulated world after every accepted action so far. */
  get world(): World {
    return this.session.world;
  }

  /**
   * Process one proposed action: run it through the session, append an audit
   * entry (the action, the verdict, the resulting state version), and return the
   * entry plus whether the world advanced. A blocked or conflicting action is
   * still logged — it just does not advance the world (the session leaves the
   * world unchanged on a non-ok verdict).
   */
  process(action: ProposedAction): ProcessResult {
    const verdict: GuardResult = this.session.propose(action);
    this.seq += 1;
    const version: StateVersion = {
      seq: this.seq,
      commitment: action.commitment,
      commitmentVersion: versionInWorld(this.session.world, action.commitment),
    };
    const entry: AuditEntry = {
      at: this.now(),
      action,
      verdict,
      version,
    };
    this.store.append(entry);
    // "advanced" means the world moved forward: accepted and not a replay no-op.
    const advanced = verdict.ok === true && verdict.replay !== true;
    return { entry, advanced };
  }

  /** Process a list (or any iterable) of actions in order, returning one result per action. */
  run(actions: Iterable<ProposedAction>): ProcessResult[] {
    const results: ProcessResult[] = [];
    for (const action of actions) {
      results.push(this.process(action));
    }
    return results;
  }
}
