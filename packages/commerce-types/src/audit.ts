/**
 * Platform Auditor — Tier 1 (model audit).
 *
 * Takes an existing commerce platform's declared order/refund STATE MODEL, maps
 * its states onto Warp's commitment lifecycle, and runs temporal verification to
 * answer one question: **is the platform's order state machine sound** — does it
 * permit a transition Warp's invariants forbid, or reach an invalid state?
 *
 * WHAT TIER 1 AUDITS — the platform's declared state MODEL: the states it names
 * and the transitions it permits, mapped to Warp. It COMPOSES {@link verifyLifecycle}
 * (bounded reachability over the mapped graph) and {@link isValidCommitmentTransition}
 * (Warp's Invariant-2 legality oracle). It reimplements neither.
 *
 * WHAT TIER 1 IS NOT — it does NOT read the platform's live orders/refunds (that
 * is a later Tier 2), does NOT scan its code, and finds NOTHING outside
 * commerce-integrity: no UI bugs, security holes, tax correctness, or performance.
 * The verdict is about the STATE MODEL, never "your platform is safe".
 *
 * Honest mapping gaps: a platform state with no clean Warp counterpart is reported
 * as UNMAPPED (a transition touching it is left unchecked and surfaced) — never
 * faked into a clean result.
 */
import type { CommitmentState } from "./states.js";
import { verifyLifecycle, type StateType, type Verdict } from "./verify.js";
import { isValidCommitmentTransition, validTransitions } from "./transitions.js";

/** A single platform-declared transition between two of its own state names. */
export interface PlatformTransition {
  from: string;
  to: string;
}

/**
 * A platform's declared order/refund state MODEL, supplied by the adopter or a
 * built-in profile. The auditor maps it onto Warp and checks its soundness.
 */
export interface PlatformModel {
  /** The platform's name, for the report. */
  platformName: string;
  /** Every state the platform names. */
  states: string[];
  /** The transitions the platform declares / permits. */
  transitions: PlatformTransition[];
  /** Map each platform state name → the Warp {@link CommitmentState} type it means. */
  stateMapping: Record<string, StateType>;
  /** Optional start state (platform name). Defaults to a source state, else states[0]. */
  start?: string;
}

/** A platform transition that maps to a move Warp's model forbids. */
export interface IllegalTransition {
  /** The platform transition, in the platform's own names. */
  from: string;
  to: string;
  /** The same transition mapped onto Warp states. */
  warpFrom: StateType;
  warpTo: StateType;
  /** The invariant it violates (I-2: State Monotonicity). */
  rule: string;
  /** Why it is illegal, and what Warp does permit from `warpFrom`. */
  why: string;
}

/** A reachable path to an invariant-violating state, from {@link verifyLifecycle}. */
export interface Counterexample {
  path: StateType[];
  rule: string;
  message: string;
}

export interface AuditResult {
  /** The platform audited. */
  platform: string;
  /** Each platform state that mapped, with its Warp counterpart. */
  mappedStates: { platform: string; warp: StateType }[];
  /** Platform states with no Warp mapping — reported, never faked. */
  unmappedStates: string[];
  /** How many fully-mapped transitions were checked for legality. */
  transitionsChecked: number;
  /** Declared transitions touching an unmapped state — could not be checked. */
  uncheckedTransitions: PlatformTransition[];
  /** Every declared transition that maps to a move Warp forbids. */
  illegalTransitions: IllegalTransition[];
  /** The reachability verdict over the mapped graph (from a start state). */
  reachabilityVerdict: Verdict;
  /** Reachable paths to a forbidden move (the actionable counterexamples). */
  counterexamples: Counterexample[];
  /**
   * True iff no declared transition maps to a forbidden move. A statement about
   * the STATE MODEL only — not the platform's live data or the rest of its code.
   */
  sound: boolean;
}

/**
 * Audit a platform's declared order/refund state MODEL against Warp's commitment
 * lifecycle. Maps each state, checks every fully-mapped transition's legality
 * (Invariant 2), and runs bounded reachability over the mapped graph — returning
 * the findings with counterexample paths. Pure; never throws.
 */
export function auditPlatformModel(model: PlatformModel): AuditResult {
  const mappedStates: { platform: string; warp: StateType }[] = [];
  const unmappedStates: string[] = [];
  for (const s of model.states) {
    const warp = model.stateMapping[s];
    if (warp === undefined) unmappedStates.push(s);
    else mappedStates.push({ platform: s, warp });
  }

  const illegalTransitions: IllegalTransition[] = [];
  const uncheckedTransitions: PlatformTransition[] = [];
  let transitionsChecked = 0;
  for (const t of model.transitions) {
    const warpFrom = model.stateMapping[t.from];
    const warpTo = model.stateMapping[t.to];
    if (warpFrom === undefined || warpTo === undefined) {
      uncheckedTransitions.push(t); // touches an unmapped state — cannot be checked, surfaced
      continue;
    }
    transitionsChecked++;
    if (!isValidCommitmentTransition({ type: warpFrom } as CommitmentState, { type: warpTo } as CommitmentState)) {
      const legal = validTransitions({ type: warpFrom } as CommitmentState);
      illegalTransitions.push({
        from: t.from,
        to: t.to,
        warpFrom,
        warpTo,
        rule: "I-2",
        why:
          `mapped to Warp '${warpFrom}' → '${warpTo}', which Warp forbids (Invariant 2: State Monotonicity). ` +
          `Legal moves from '${warpFrom}': ${legal.length > 0 ? legal.join(", ") : "(terminal — none)"}.`,
      });
    }
  }

  // Reachability over the mapped graph: build a Warp-level transition function from
  // the declared (fully-mapped) edges and let verifyLifecycle explore it.
  const warpEdges = new Map<StateType, Set<StateType>>();
  for (const t of model.transitions) {
    const wf = model.stateMapping[t.from];
    const wt = model.stateMapping[t.to];
    if (wf === undefined || wt === undefined) continue;
    if (!warpEdges.has(wf)) warpEdges.set(wf, new Set());
    warpEdges.get(wf)!.add(wt);
  }
  const froms = new Set(model.transitions.map((t) => t.from));
  const tos = new Set(model.transitions.map((t) => t.to));
  const startPlatform =
    model.start ?? model.states.find((s) => froms.has(s) && !tos.has(s)) ?? model.states[0];
  const warpStart: StateType =
    (startPlatform !== undefined ? model.stateMapping[startPlatform] : undefined) ?? "Draft";

  const verification = verifyLifecycle({
    from: warpStart,
    transitions: (s) => [...(warpEdges.get(s) ?? [])],
  });
  const counterexamples: Counterexample[] = verification.violations.map((v) => ({
    path: v.path,
    rule: v.rule,
    message: v.message,
  }));

  return {
    platform: model.platformName,
    mappedStates,
    unmappedStates,
    transitionsChecked,
    uncheckedTransitions,
    illegalTransitions,
    reachabilityVerdict: verification.verdict,
    counterexamples,
    sound: illegalTransitions.length === 0,
  };
}

/**
 * Render an {@link AuditResult} as a human-readable integrity report. The header
 * states the honest scope; the body lists mapped/unmapped states, the transitions
 * checked, each finding with its invariant and path, and the verdict.
 */
export function formatAuditReport(result: AuditResult): string {
  const L: string[] = [];
  L.push(`Platform integrity audit — Tier 1 (state model): ${result.platform}`);
  L.push(
    "Scope: audits the platform's declared order/refund STATE MODEL against Warp's",
  );
  L.push(
    "invariants — not live data, not the whole platform, commerce-integrity only.",
  );
  L.push("");
  L.push(
    `States mapped: ${result.mappedStates.length}` +
      (result.unmappedStates.length > 0 ? ` (${result.unmappedStates.length} unmapped: ${result.unmappedStates.join(", ")})` : " (0 unmapped)"),
  );
  L.push(`Transitions checked: ${result.transitionsChecked}`);
  if (result.uncheckedTransitions.length > 0) {
    L.push(
      `Transitions unchecked (touch an unmapped state): ${result.uncheckedTransitions
        .map((t) => `${t.from}→${t.to}`)
        .join(", ")}`,
    );
  }
  L.push("");
  if (result.illegalTransitions.length === 0) {
    L.push("Verdict: SOUND — the state model permits no move Warp's invariants forbid.");
    L.push(`(reachability over the mapped graph: ${result.reachabilityVerdict})`);
  } else {
    L.push(`Verdict: UNSOUND — ${result.illegalTransitions.length} issue(s):`);
    for (const f of result.illegalTransitions) {
      L.push(`  • [${f.rule}] ${f.from}→${f.to}: ${f.why}`);
    }
    for (const c of result.counterexamples) {
      L.push(`  ↳ counterexample path: ${c.path.join(" → ")}`);
    }
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Built-in model profiles — for platforms we already have adapters for. Each is a
// Warp-aligned derivation of the platform's order/refund flow: the states mapped
// to their Warp counterparts and the standard fulfillment path expressed as legal
// Warp moves. A platform whose real flow diverges (e.g. a direct refund before
// fulfillment) would surface that as a finding — nothing here is faked to pass.
// ---------------------------------------------------------------------------

/** Shopify's order flow (financial + fulfillment status), mapped to Warp. */
export const shopifyProfile: PlatformModel = {
  platformName: "Shopify",
  states: ["pending", "paid", "partially_fulfilled", "fulfilled", "refunded", "disputed", "cancelled"],
  stateMapping: {
    pending: "Proposed",
    paid: "Accepted",
    partially_fulfilled: "PartiallyFulfilled",
    fulfilled: "Fulfilled",
    refunded: "Refunded",
    disputed: "Disputed",
    cancelled: "Cancelled",
  },
  transitions: [
    { from: "pending", to: "paid" },
    { from: "pending", to: "cancelled" },
    { from: "paid", to: "partially_fulfilled" },
    { from: "paid", to: "cancelled" },
    { from: "partially_fulfilled", to: "fulfilled" },
    { from: "partially_fulfilled", to: "cancelled" },
    { from: "fulfilled", to: "refunded" },
    { from: "fulfilled", to: "disputed" },
    { from: "disputed", to: "refunded" },
  ],
  start: "pending",
};

/** WooCommerce's order statuses, mapped to Warp. */
export const wooCommerceProfile: PlatformModel = {
  platformName: "WooCommerce",
  states: ["pending", "processing", "partially-shipped", "completed", "refunded", "cancelled", "failed"],
  stateMapping: {
    pending: "Proposed",
    processing: "Accepted",
    "partially-shipped": "PartiallyFulfilled",
    completed: "Fulfilled",
    refunded: "Refunded",
    cancelled: "Cancelled",
    failed: "Cancelled",
  },
  transitions: [
    { from: "pending", to: "processing" },
    { from: "pending", to: "cancelled" },
    { from: "pending", to: "failed" },
    { from: "processing", to: "partially-shipped" },
    { from: "processing", to: "cancelled" },
    { from: "partially-shipped", to: "completed" },
    { from: "completed", to: "refunded" },
  ],
  start: "pending",
};

/** The built-in profiles, by lowercased platform name. */
export const BUILT_IN_PROFILES: Record<string, PlatformModel> = {
  shopify: shopifyProfile,
  woocommerce: wooCommerceProfile,
};
