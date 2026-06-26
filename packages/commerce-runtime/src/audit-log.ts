/**
 * The append-only AUDIT LOG — the runtime's record of every action it processed.
 *
 * Each entry records WHAT was proposed (the action), the runtime's VERDICT for it
 * (the discriminated {@link GuardResult} from the session, verbatim), and the
 * resulting STATE VERSION — a monotonically increasing sequence number plus a
 * per-commitment version derived from {@link commitmentVersion}. The log is
 * append-only by contract: a store appends entries and reads them back in order;
 * nothing edits or deletes a past entry.
 *
 * Two stores implement the same {@link AuditStore} interface:
 *   - {@link InMemoryAuditStore} — an in-process array, the default;
 *   - {@link FileAuditStore} — a JSON-lines file, one entry per line, so the log
 *     survives the process and can be replayed later.
 *
 * The verdict is recorded for BOTH accepted and rejected actions, so the log is a
 * complete history of what the runtime was asked to do and how it answered — a
 * blocked action is logged, it just does not advance the world (see the runtime).
 *
 * SCOPE (honest): this is a reference, self-host log — an array or a local file.
 * It is not a distributed log, a database, or a write-ahead log with fsync/durability
 * guarantees; the file store writes JSON lines and leaves durability to the OS.
 */

import type { GuardResult, ProposedAction } from "@warp-lang/commerce-types";

/**
 * The version of the world AFTER an entry was processed. `seq` is a per-log
 * monotonically increasing counter (it advances for every appended entry,
 * accepted or not). `commitment` is the id the action targeted; `commitmentVersion`
 * is that commitment's version in the resulting world (unchanged when the action
 * was blocked or was a replay). Together they let a reader see both "how far the
 * log has progressed" and "where the targeted commitment landed".
 */
export interface StateVersion {
  /** Per-log monotonically increasing entry counter (starts at 1). */
  seq: number;
  /** The commitment id the action targeted. */
  commitment: string;
  /**
   * The targeted commitment's version in the resulting world (from
   * commitmentVersion), or null if the commitment is not present in that world.
   */
  commitmentVersion: string | null;
}

/** One append-only record: the action proposed, the verdict, and the resulting version. */
export interface AuditEntry {
  /** ISO timestamp the entry was appended (wall-clock; not part of model state). */
  at: string;
  /** The action the runtime was asked to process. */
  action: ProposedAction;
  /** The session's verdict for the action, recorded verbatim. */
  verdict: GuardResult;
  /** The resulting state version after processing (see {@link StateVersion}). */
  version: StateVersion;
}

/** An append-only sink + source for {@link AuditEntry} records. */
export interface AuditStore {
  /** Append one entry to the end of the log. */
  append(entry: AuditEntry): void;
  /** Read every entry, in append order (a copy — callers cannot mutate the log). */
  entries(): AuditEntry[];
  /** How many entries have been appended. */
  size(): number;
}

/** An in-process, append-only log backed by an array. The default store. */
export class InMemoryAuditStore implements AuditStore {
  private readonly log: AuditEntry[] = [];

  append(entry: AuditEntry): void {
    this.log.push(entry);
  }

  entries(): AuditEntry[] {
    // Return a shallow copy so a caller iterating the log cannot append to or
    // truncate it through the returned array.
    return this.log.slice();
  }

  size(): number {
    return this.log.length;
  }
}
