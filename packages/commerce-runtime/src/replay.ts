/**
 * REPLAY — reconstruct the final state by re-running the audit log.
 *
 * The durable-execution property this reference demonstrates: given the same
 * initial world and the actions recorded in the audit log, re-running them through
 * a fresh runtime reproduces the same verdicts and the same final world. The log
 * is the source of truth; the live world can be thrown away and rebuilt from it.
 *
 * {@link replayLog} reads the actions out of a store (or any entry list), feeds
 * them to a new {@link CommerceRuntime} over the supplied initial world, and
 * returns the rebuilt world plus the verdicts it produced. {@link worldsEqual}
 * is a structural equality over worlds for asserting that a replay matches the
 * original run.
 *
 * Replay is deterministic in the verdicts and the resulting model STATE: the
 * verdict is a function of the world and the action, the runtime samples no clock
 * or randomness to DECIDE it, and {@link worldsEqual} confirms the rebuilt world
 * matches the original.
 *
 * ONE HONEST CAVEAT, made explicit. The frozen commerce-model stamps each state
 * transition's history record with a wall-clock instant at the moment the
 * transition is applied (`history[].at`, sampled by the model, not supplied by the
 * caller). A live run and a later replay therefore apply the same transitions at
 * different real instants, so those audit stamps differ between the two runs. They
 * are the only field that does. {@link worldsEqual} compares the model state up to
 * those model-sampled history timestamps — it normalizes `history[].at` before
 * comparing, so it asserts "the same states, transitions, amounts, and parties"
 * without asserting "applied at the same wall-clock instant", which no replay can
 * reproduce while the model samples the clock. The recorded VERDICTS (and the
 * action inputs that drove them) are compared byte-for-byte; only this model-owned
 * stamp is normalized.
 */

import type { GuardResult, ProposedAction, World } from "@warp-lang/commerce-types";
import type { AuditEntry, AuditStore } from "./audit-log.js";
import { CommerceRuntime } from "./runtime.js";

/** The result of a replay: the rebuilt final world and the verdict per replayed action. */
export interface ReplayResult {
  /** The world rebuilt by re-running the recorded actions over the initial world. */
  world: World;
  /** The verdict produced for each replayed action, in order. */
  verdicts: GuardResult[];
  /** The runtime used for the replay (its `store` holds the rebuilt audit log). */
  runtime: CommerceRuntime;
}

/** Pull the ordered action list out of a store or a raw entry array. */
function actionsOf(source: AuditStore | AuditEntry[]): ProposedAction[] {
  const entries = Array.isArray(source) ? source : source.entries();
  return entries.map((e) => e.action);
}

/**
 * Re-run a recorded log over `initialWorld` and return the rebuilt final state.
 *
 * `source` is either an {@link AuditStore} (e.g. a FileAuditStore opened over a
 * persisted log) or a raw {@link AuditEntry} array. The replay runs every recorded
 * action — accepted, blocked, replayed, and conflicting alike — through a fresh
 * session, so a blocked action stays blocked and still does not advance the world,
 * exactly as in the original run.
 *
 * ```ts
 * const replay = replayLog(initialWorld, store);
 * worldsEqual(replay.world, live.world); // true — replay reproduces the state
 * ```
 */
export function replayLog(initialWorld: World, source: AuditStore | AuditEntry[]): ReplayResult {
  const actions = actionsOf(source);
  // A fixed clock: replay metadata stamps must not depend on wall-clock time.
  const runtime = new CommerceRuntime(initialWorld, { now: () => "1970-01-01T00:00:00.000Z" });
  const verdicts = runtime.run(actions).map((r) => r.entry.verdict);
  return { world: runtime.world, verdicts, runtime };
}

/**
 * Recursively normalize the model-sampled wall-clock stamp on transition history
 * records. Every entry in a `history` array carries an `at` set by the model when
 * the transition was applied (see the module docs); replacing it with a fixed
 * placeholder lets two runs that applied the SAME transitions at DIFFERENT real
 * instants compare equal on everything else. No other field is touched, and the
 * input is not mutated.
 */
function normalizeHistoryStamps(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeHistoryStamps);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === "history" && Array.isArray(v)) {
        // A transition record's `at` is the model-sampled stamp; normalize it,
        // keep from/to/actor/reason as-is (those are deterministic).
        out[key] = v.map((entry) => {
          const normalized = normalizeHistoryStamps(entry);
          if (normalized !== null && typeof normalized === "object" && "at" in normalized) {
            return { ...(normalized as Record<string, unknown>), at: "<transition-at>" };
          }
          return normalized;
        });
      } else {
        out[key] = normalizeHistoryStamps(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Structural equality over two worlds, for asserting a replay reproduces the
 * original state. Worlds are plain serializable data (commitments, fulfillments,
 * parties). The comparison normalizes the model-sampled transition history
 * stamps (`history[].at`) first — see the module docs for why those, and only
 * those, cannot be reproduced by a later replay — and then compares canonically
 * (sorted keys, so insertion order does not matter).
 */
export function worldsEqual(a: World, b: World): boolean {
  return canonicalJson(normalizeHistoryStamps(a)) === canonicalJson(normalizeHistoryStamps(b));
}

/** JSON with object keys sorted recursively, so key insertion order is irrelevant. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
