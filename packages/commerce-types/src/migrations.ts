/**
 * Declarative data migrations — transform in-flight commerce world data from one
 * model shape to another, then RE-VALIDATE the result with the existing audit.
 *
 * The problem: a stored commerce world (commitments / fulfillments / parties) was
 * written under an older shape of the data — a field was later renamed, a now-
 * required field was once optional, a default was introduced. To keep using it
 * with the current types you have to bring the data forward to the current shape.
 *
 * The mechanism here is a pure DATA transform plus a re-audit. It is NOT a schema
 * change and it does not touch `schema/`: a migration is a function over plain
 * world data, and its output is checked by the SAME {@link guardObject} the rest
 * of the toolkit uses (which composes {@link auditCommerce}: the six invariants).
 * A migration whose output would violate an invariant is rejected — the migrated
 * world is held to exactly the same correctness bar as any other world.
 *
 * This is a COMPOSITION over the proven primitives — it does not fork invariant or
 * transition logic:
 *   - the caller's `transform` reshapes data (rename / default / restructure);
 *   - {@link guardObject} → {@link auditCommerce} validates the result.
 *
 * ── A NOTE ON SCHEMA VERSIONS (honest scope) ────────────────────────────────
 * There is currently exactly ONE published schema version: {@link SCHEMA_VERSION}
 * ("1.0.0", from `schema/VERSION`). So this module ships the MECHANISM, not a real
 * cross-version upgrade: the bundled example transforms an ILLUSTRATIVE old-shaped
 * record (a commitment that predates the always-present `children: []` /
 * `history: []` fields) into the current shape, then re-audits it. When a second
 * real schema version is eventually published, a real migration is written the
 * same way — `defineMigration({ from, to, transform })` — with no change to this
 * layer. This module does not invent a second schema version and does not edit the
 * schema.
 *
 * The `from`/`to` version strings are caller-supplied LABELS used only to order
 * and select the transform chain; this layer does not read or enforce `schema/`
 * version semantics, so a migration may use any version labels the caller adopts
 * (e.g. "1.0.0" → "1.1.0", or a date, or a sequence number). The single source of
 * truth for the live published schema remains `schema/VERSION` / {@link SCHEMA_VERSION}.
 *
 * Scope (honest): this validates the SHAPE and INVARIANTS of the migrated output.
 * It does not prove the transform preserves business meaning beyond what the six
 * invariants express, it does not run inside a transaction or persist anything,
 * and it does not auto-discover migrations — the caller supplies the ordered set.
 * TypeScript first; ports roadmap.
 */

import { guardObject, type GuardViolation, type World } from "./guard.js";

/**
 * A declarative migration: bring world data from the `from` shape to the `to`
 * shape via a pure `transform`. The `transform` receives the whole world and
 * returns the whole world in the new shape — it may rename fields, fill defaults,
 * or restructure records, but it should NOT mutate its input (return new data).
 */
export interface Migration {
  /** The version label this migration upgrades FROM. */
  from: string;
  /** The version label this migration upgrades TO. */
  to: string;
  /** Pure data transform: old-shaped world in, new-shaped world out. */
  transform: (world: World) => World;
}

/**
 * Declare a migration. A thin, total constructor — it validates the descriptor
 * (non-empty distinct version labels, a callable transform) so a malformed
 * migration is caught at definition time rather than mid-chain.
 *
 * ```ts
 * const m = defineMigration({
 *   from: "1.0.0",
 *   to: "1.1.0",
 *   transform: (world) => ({
 *     ...world,
 *     commitments: world.commitments.map((c) => ({ children: [], history: [], ...c })),
 *   }),
 * });
 * ```
 */
export function defineMigration(spec: Migration): Migration {
  if (typeof spec.from !== "string" || spec.from.length === 0) {
    throw new TypeError("defineMigration: `from` must be a non-empty version label");
  }
  if (typeof spec.to !== "string" || spec.to.length === 0) {
    throw new TypeError("defineMigration: `to` must be a non-empty version label");
  }
  if (spec.from === spec.to) {
    throw new TypeError(`defineMigration: \`from\` and \`to\` must differ (both "${spec.from}")`);
  }
  if (typeof spec.transform !== "function") {
    throw new TypeError("defineMigration: `transform` must be a function");
  }
  return { from: spec.from, to: spec.to, transform: spec.transform };
}

/** Options for {@link migrate}. */
export interface MigrateOptions {
  /**
   * The version the world is currently at. When given, the chain is selected and
   * ordered starting from this version (following `from` → `to` links). When
   * omitted, the migrations are applied in the order provided.
   */
  from?: string;
  /**
   * The target version to migrate to. When given (with `from`), only the segment
   * of the chain reaching this version is applied. When omitted, the full
   * resolved chain is applied.
   */
  to?: string;
}

/** The result of a {@link migrate} run. */
export type MigrationResult =
  | {
      ok: true;
      /** The migrated, re-audited world. */
      world: World;
      /** The ordered version hops applied, e.g. ["1.0.0", "1.1.0"]. */
      applied: string[];
    }
  | {
      ok: false;
      /**
       * Why the migration was rejected. Either a chain-resolution problem
       * (`stage: "chain"`) or an invariant violation in a transform's output
       * (`stage: "audit"`, with the version hop that produced it).
       */
      stage: "chain" | "audit";
      /** The version hop being applied when it failed (audit stage). */
      at?: string;
      /** Human/agent-readable reasons. For an audit failure these are the invariant violations. */
      violations: GuardViolation[];
    };

/**
 * Order the supplied migrations into a single chain. If `from` is given, the chain
 * is followed from that version; otherwise the provided order is used as-is, and
 * we sanity-check that consecutive hops link up (`to` of one == `from` of next).
 */
function resolveChain(
  migrations: Migration[],
  opts: MigrateOptions,
): { ok: true; chain: Migration[] } | { ok: false; reason: string } {
  if (migrations.length === 0) return { ok: true, chain: [] };

  if (opts.from === undefined) {
    // Use as-provided; verify it is a connected chain.
    for (let i = 1; i < migrations.length; i++) {
      const prev = migrations[i - 1]!;
      const next = migrations[i]!;
      if (prev.to !== next.from) {
        return {
          ok: false,
          reason: `migrations are not a connected chain: step ${i - 1} ends at "${prev.to}" but step ${i} starts at "${next.from}". Pass \`from\` to have the chain resolved, or order them so each \`to\` matches the next \`from\`.`,
        };
      }
    }
    return { ok: true, chain: migrations };
  }

  // Resolve by following from → to links starting at opts.from.
  const byFrom = new Map<string, Migration>();
  for (const m of migrations) {
    if (byFrom.has(m.from)) {
      return { ok: false, reason: `ambiguous migration chain: two migrations start at "${m.from}"` };
    }
    byFrom.set(m.from, m);
  }

  const chain: Migration[] = [];
  const seen = new Set<string>();
  let cursor = opts.from;
  while (cursor !== opts.to) {
    const next = byFrom.get(cursor);
    if (next === undefined) {
      if (opts.to === undefined) break; // reached the end of the chain; no explicit target
      return { ok: false, reason: `no migration found from version "${cursor}" toward "${opts.to}"` };
    }
    if (seen.has(cursor)) {
      return { ok: false, reason: `migration chain has a cycle at version "${cursor}"` };
    }
    seen.add(cursor);
    chain.push(next);
    cursor = next.to;
  }
  return { ok: true, chain };
}

/**
 * Apply an ordered chain of migrations to a world, RE-AUDITING after each hop.
 *
 * Each migration's `transform` is applied in turn; after every hop the resulting
 * world is run through {@link guardObject} (→ {@link auditCommerce}). If any hop's
 * output violates an invariant, the migration STOPS and is rejected with the
 * offending hop and the violations — the partially-migrated world is not returned,
 * so a bad migration cannot hand back an invalid world.
 *
 * ```ts
 * const result = migrate(oldWorld, [m], { from: "1.0.0", to: "1.1.0" });
 * if (result.ok) useWorld(result.world);
 * else result.violations; // [{ rule, message, fix }]
 * ```
 */
export function migrate(
  world: World,
  migrations: Migration[],
  opts: MigrateOptions = {},
): MigrationResult {
  const resolved = resolveChain(migrations, opts);
  if (!resolved.ok) {
    return {
      ok: false,
      stage: "chain",
      violations: [
        {
          rule: "migration/chain",
          message: resolved.reason,
          fix: "Provide a connected, unambiguous ordered set of migrations (and `from`/`to` when selecting a sub-range).",
        },
      ],
    };
  }

  let current: World = world;
  const applied: string[] = [];
  for (const m of resolved.chain) {
    const transformed = m.transform(current);
    const verdict = guardObject(
      transformed.commitments,
      transformed.fulfillments,
      transformed.parties,
    );
    if (!verdict.ok) {
      return { ok: false, stage: "audit", at: `${m.from}→${m.to}`, violations: verdict.violations };
    }
    current = verdict.next;
    applied.push(m.from);
    if (applied[applied.length - 1] !== m.to) applied.push(m.to);
  }

  // Dedup consecutive version labels for a clean `applied` path (from, to, to, …).
  const path: string[] = [];
  for (const v of applied) if (path[path.length - 1] !== v) path.push(v);

  return { ok: true, world: current, applied: path };
}
