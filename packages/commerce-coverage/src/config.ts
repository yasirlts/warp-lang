/**
 * Coverage-audit configuration — the honest foundation.
 *
 * Warp cannot magically know which calls in YOUR code mutate commerce state. You
 * declare them. The audit then reports coverage *of what you declared* — never a
 * claim to have found every money write. A sink you do not declare is not
 * measured (and is not silently counted as covered).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";

/**
 * A money-sink pattern: a call the adopter considers a money-state mutation
 * (an ORM write, a payment-SDK call, a ledger post, a balance update).
 * Matched by the called function/method NAME, optionally narrowed to an import
 * `module`. This is a STRUCTURAL match on call sites, not semantic proof a write
 * occurs.
 */
export interface SinkPattern {
  /** Function or method name at the call site (e.g. "postLedger", "save"). */
  name: string;
  /** Optional: only match when `name` is imported from this module specifier. */
  module?: string;
  /** Optional human label shown in the report. */
  description?: string;
}

/** A Warp guard-surface entry whose presence on the path marks a sink "covered". */
export interface GuardPattern {
  name: string;
  module?: string;
}

export interface CoverageConfig {
  /** Files/dirs to scan, relative to the config file (or absolute). */
  projectRoots: string[];
  /** The adopter's declared money-state operations. Coverage is reported against THESE. */
  moneySinks: SinkPattern[];
  /** Warp guard surface; defaults to the known commerce-types entries (overridable). */
  guardEntries?: GuardPattern[];
  /**
   * Optional escape hatch: `file:line` sites (or bare file paths) the adopter has
   * reviewed and intentionally excludes from detection. Suppressed matches are
   * reported TRANSPARENTLY in their own section with a count — they are removed
   * from the measured set, not hidden, so the headline number cannot be quietly
   * gamed. Use sparingly.
   */
  allowList?: string[];
  /** File extensions to scan. Default: ts, tsx, mts, cts, js, jsx, mjs, cjs. */
  extensions?: string[];
  /** Directory names to skip. Default: node_modules, dist, build, .git, coverage. */
  exclude?: string[];
}

/**
 * The default Warp guard surface — mirrors the named guard entries exported by
 * `@warp-lang/commerce-types`. A `createSession`-based guard is detected via the
 * `createSession` call that establishes the guarded session (its `.propose()`
 * performs the actual check). Override `guardEntries` in config to extend this.
 */
export const DEFAULT_GUARD_ENTRIES: GuardPattern[] = [
  { name: "guardAction", module: "@warp-lang/commerce-types" },
  { name: "guardObject", module: "@warp-lang/commerce-types" },
  { name: "guardWithProfile", module: "@warp-lang/commerce-types" },
  { name: "guardConcession", module: "@warp-lang/commerce-types" },
  { name: "createSession", module: "@warp-lang/commerce-types" },
  { name: "createMultiAgentSession", module: "@warp-lang/commerce-types" },
  { name: "toEffect", module: "@warp-lang/commerce-types" },
];

export const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
export const DEFAULT_EXCLUDE = ["node_modules", "dist", "build", ".git", "coverage"];

export interface LoadedConfig {
  /** The config with defaults applied. */
  config: Required<Omit<CoverageConfig, "allowList">> & Pick<CoverageConfig, "allowList">;
  /** Absolute roots resolved against the config file's directory. */
  absoluteRoots: string[];
  /** Directory the config was loaded from (base for relative roots). */
  baseDir: string;
}

function fail(msg: string): never {
  throw new Error(`Invalid coverage config: ${msg}`);
}

/** Parse + validate a raw config object, applying defaults. `baseDir` resolves relative roots. */
export function normalizeConfig(raw: unknown, baseDir: string): LoadedConfig {
  if (typeof raw !== "object" || raw === null) fail("expected a JSON object");
  const c = raw as Record<string, unknown>;

  if (!Array.isArray(c.projectRoots) || c.projectRoots.length === 0) {
    fail("`projectRoots` must be a non-empty array of paths");
  }
  if (!Array.isArray(c.moneySinks) || c.moneySinks.length === 0) {
    fail("`moneySinks` must be a non-empty array — you must declare your money-state operations");
  }
  const moneySinks: SinkPattern[] = c.moneySinks.map((s, i) => {
    if (typeof s !== "object" || s === null || typeof (s as any).name !== "string") {
      fail(`moneySinks[${i}] must be an object with a string \`name\``);
    }
    const sp = s as any;
    return { name: sp.name, module: sp.module, description: sp.description };
  });

  const guardEntries: GuardPattern[] =
    c.guardEntries === undefined
      ? DEFAULT_GUARD_ENTRIES
      : (Array.isArray(c.guardEntries) ? c.guardEntries : fail("`guardEntries` must be an array")).map(
          (g, i) => {
            if (typeof g !== "object" || g === null || typeof (g as any).name !== "string") {
              fail(`guardEntries[${i}] must be an object with a string \`name\``);
            }
            return { name: (g as any).name, module: (g as any).module };
          },
        );

  const config = {
    projectRoots: c.projectRoots as string[],
    moneySinks,
    guardEntries,
    allowList: Array.isArray(c.allowList) ? (c.allowList as string[]) : undefined,
    extensions: Array.isArray(c.extensions) ? (c.extensions as string[]) : DEFAULT_EXTENSIONS,
    exclude: Array.isArray(c.exclude) ? (c.exclude as string[]) : DEFAULT_EXCLUDE,
  };

  const absoluteRoots = config.projectRoots.map((r) => (isAbsolute(r) ? r : resolve(baseDir, r)));
  return { config, absoluteRoots, baseDir };
}

/** Load + normalize a config file from disk. */
export function loadConfig(configPath: string): LoadedConfig {
  const abs = resolve(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`Could not read config at ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return normalizeConfig(raw, dirname(abs));
}
