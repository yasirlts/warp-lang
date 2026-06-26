/**
 * The adapter manifest FORMAT.
 *
 * This is the registry package's OWN descriptive type for a community commerce
 * adapter. It is deliberately NOT the frozen Warp Commerce Model schema (the six
 * invariants, the transition graph, the structural shapes) — those live in
 * `schema/` and are never touched here. A manifest does not describe commerce
 * objects; it describes an ADAPTER: a piece of code that maps some external
 * platform onto the Warp model, what it can map, and how far it has been checked.
 *
 * A manifest carries no executable code and references no adapter implementation
 * directly. It is data: enough to list an adapter in an index and to reason about
 * what it claims to do, without loading or running it.
 */

/**
 * The well-known platforms the canonical `@warp-lang/commerce-types` ships
 * mappings for. A manifest may name one of these or any other string — community
 * adapters target platforms beyond this set, so `platform` is an open string and
 * this list is only the known-good vocabulary.
 */
export const KNOWN_PLATFORMS = [
  "shopify",
  "woocommerce",
  "stripe",
  "paypal",
  "amazon",
] as const;

export type KnownPlatform = (typeof KNOWN_PLATFORMS)[number];

/**
 * Which direction(s) an adapter maps.
 *  - "inbound"  : external platform object -> Warp model (e.g. fromShopifyOrder)
 *  - "outbound" : Warp model -> external platform object (e.g. toShopifyOrderStatus)
 * An adapter declares the directions it actually implements. An adapter with no
 * declared direction maps nothing and is rejected by the validator.
 */
export type CapabilityDirection = "inbound" | "outbound";

/**
 * One mapping an adapter provides, in a single direction. `entity` names the
 * Warp-model concept involved (e.g. "Commitment", "Party", "Value"); `via` names
 * the exported function that performs the mapping, so a reader can find it in the
 * adapter's source. `via` is documentary only — the registry never calls it.
 */
export interface AdapterCapability {
  direction: CapabilityDirection;
  /** The Warp-model concept this mapping produces (inbound) or consumes (outbound). */
  entity: string;
  /** The exported function name that performs the mapping. Documentary, not invoked. */
  via: string;
}

/**
 * How far an adapter has been checked against the canonical conformance harness.
 *  - "unverified" : no conformance evidence has been recorded.
 *  - "self-reported" : the author ran the harness and reports passing, but the
 *                      result has not been independently reproduced here.
 *  - "verified"   : reproduced against the canonical conformance fixtures.
 * This is a claim about process, not a guarantee about the adapter's code. The
 * registry records the status; it does not itself run conformance.
 */
export type ConformanceStatus = "unverified" | "self-reported" | "verified";

export const CONFORMANCE_STATUSES: readonly ConformanceStatus[] = [
  "unverified",
  "self-reported",
  "verified",
];

/**
 * A community adapter, described.
 *
 * `name` is the unique key within an index. `platform` is the external system the
 * adapter targets. `capabilities` is the non-empty list of mappings it provides.
 * `conformance` records how far it has been checked. The optional fields are
 * documentation a reader of the index would want; none of them are executable.
 */
export interface AdapterManifest {
  /** Unique adapter name within an index. Lowercase letters, digits, hyphen. */
  name: string;
  /** Human-readable summary of what the adapter maps. */
  description?: string;
  /** The external platform this adapter targets (open string; see KNOWN_PLATFORMS). */
  platform: string;
  /** Non-empty list of the mappings this adapter provides. */
  capabilities: AdapterCapability[];
  /** How far this adapter has been checked against the canonical conformance harness. */
  conformance: ConformanceStatus;
  /** Optional semver of the adapter itself. */
  version?: string;
  /** Optional URL to the adapter's source or docs. */
  homepage?: string;
}

/** True if `value` is one of the known conformance statuses. */
export function isConformanceStatus(value: unknown): value is ConformanceStatus {
  return typeof value === "string" && (CONFORMANCE_STATUSES as readonly string[]).includes(value);
}

/** True if `value` is a recognized capability direction. */
export function isCapabilityDirection(value: unknown): value is CapabilityDirection {
  return value === "inbound" || value === "outbound";
}
