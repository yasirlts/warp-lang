/**
 * A file-backed {@link AuditStore} — the append-only log persisted as JSON lines.
 *
 * One {@link AuditEntry} per line (newline-delimited JSON). Appending writes one
 * line; reading parses every line back. Because each line is a complete entry,
 * the file IS the log: a later process can construct a {@link FileAuditStore} over
 * the same path and {@link replayLog} it to reproduce the final state — this is
 * the "survives the process" half of the durable-execution reference.
 *
 * SCOPE (honest): this is a self-host, local-file store for a reference runtime.
 * It uses ordinary synchronous file appends; it is not a write-ahead log with
 * fsync/group-commit durability, not crash-atomic, and not concurrent-writer
 * safe. Durability beyond the OS write is out of scope and not claimed.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AuditEntry, AuditStore } from "./audit-log.js";

export class FileAuditStore implements AuditStore {
  private readonly path: string;

  /**
   * Open (or create) a JSON-lines log at `path`. When `truncate` is true the file
   * is reset to empty on construction (a fresh run); otherwise existing lines are
   * kept so the log can be appended to or replayed.
   */
  constructor(path: string, options: { truncate?: boolean } = {}) {
    this.path = path;
    if (options.truncate === true) {
      writeFileSync(this.path, "");
    } else if (!existsSync(this.path)) {
      writeFileSync(this.path, "");
    }
  }

  append(entry: AuditEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }

  entries(): AuditEntry[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditEntry);
  }

  size(): number {
    return this.entries().length;
  }
}
