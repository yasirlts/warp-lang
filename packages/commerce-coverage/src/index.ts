/**
 * @warp-lang/commerce-coverage — measure Warp guard coverage over an adopter's
 * declared money-sinks. Library surface; see ./cli for the `warp-coverage` binary.
 *
 * Honest by construction: coverage is reported over DECLARED sinks; "covered" is a
 * structural signal (a guard runs on the path), not a correctness proof; sinks
 * that cannot be statically analyzed are reported separately and never counted as
 * covered.
 */
export type { CoverageConfig, SinkPattern, GuardPattern, AllowEntry, LoadedConfig } from "./config.js";
export {
  loadConfig,
  normalizeConfig,
  DEFAULT_GUARD_ENTRIES,
  DEFAULT_EXTENSIONS,
  DEFAULT_EXCLUDE,
  DEFAULT_FAIL_UNDER,
  DEFAULT_ON_UNANALYZABLE,
} from "./config.js";
export type { AuditResult, Finding, Classification } from "./audit.js";
export { runAudit } from "./audit.js";
export type { CoverageReport, CoverageSummary } from "./report.js";
export { buildReport, formatHuman, DISCLAIMER } from "./report.js";
export type { EnforcementOptions, EnforcementResult } from "./enforce.js";
export { evaluateEnforcement, formatEnforcement, SCOPE_NOTE } from "./enforce.js";
