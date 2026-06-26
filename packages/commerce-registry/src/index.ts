/**
 * @warp-lang/commerce-registry
 *
 * A mechanism for describing and indexing community commerce adapters:
 *   - a manifest FORMAT (manifest.ts) — the package's own descriptive type for an
 *     adapter; deliberately separate from the frozen Warp Commerce Model schema.
 *   - a VALIDATOR (validate.ts) — checks a candidate against the format.
 *   - a local INDEX (index-store.ts) — an in-memory collection of registered
 *     manifests with list/filter/lookup.
 *
 * It is a format plus tooling, not a hosted registry service: it persists nothing,
 * fetches nothing, and runs no adapter.
 */

export {
  KNOWN_PLATFORMS,
  CONFORMANCE_STATUSES,
  isConformanceStatus,
  isCapabilityDirection,
} from "./manifest.js";
export type {
  AdapterManifest,
  AdapterCapability,
  CapabilityDirection,
  ConformanceStatus,
  KnownPlatform,
} from "./manifest.js";

export { validateManifest, assertValidManifest, formatIssues } from "./validate.js";
export type { ValidationResult, ValidationIssue } from "./validate.js";

export { AdapterRegistry } from "./index-store.js";

export {
  KNOWN_ADAPTER_MANIFESTS,
  SHOPIFY_MANIFEST,
  STRIPE_MANIFEST,
  PAYPAL_MANIFEST,
  AMAZON_MANIFEST,
} from "./known-adapters.js";
