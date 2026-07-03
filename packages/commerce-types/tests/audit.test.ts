/**
 * Platform Auditor — Tier 1. These tests pin its contract: a sound model audits
 * sound with no false finding; a broken model is caught with the exact illegal
 * transition, its invariant, and the counterexample path; unmapped states are
 * reported (never silently dropped); and the report carries the honest scope.
 */
import { describe, it, expect } from "vitest";
import {
  auditPlatformModel,
  formatAuditReport,
  shopifyProfile,
  wooCommerceProfile,
  BUILT_IN_PROFILES,
  type PlatformModel,
} from "../src/index.js";

describe("auditPlatformModel — sound built-in profiles", () => {
  it("Shopify's model is sound: all states mapped, no illegal transition", () => {
    const r = auditPlatformModel(shopifyProfile);
    expect(r.sound).toBe(true);
    expect(r.illegalTransitions).toEqual([]);
    expect(r.unmappedStates).toEqual([]);
    expect(r.transitionsChecked).toBe(shopifyProfile.transitions.length);
    expect(r.reachabilityVerdict).toBe("fixpoint-sound");
  });

  it("WooCommerce's model is sound", () => {
    const r = auditPlatformModel(wooCommerceProfile);
    expect(r.sound).toBe(true);
    expect(r.illegalTransitions).toEqual([]);
    expect(BUILT_IN_PROFILES.woocommerce).toBe(wooCommerceProfile);
  });
});

describe("auditPlatformModel — catches a broken model with the path", () => {
  const broken: PlatformModel = {
    ...shopifyProfile,
    platformName: "Broken",
    transitions: [...shopifyProfile.transitions, { from: "fulfilled", to: "paid" }], // revert-after-ship
  };

  it("finds the illegal transition, labels it I-2, maps it, and explains", () => {
    const r = auditPlatformModel(broken);
    expect(r.sound).toBe(false);
    expect(r.illegalTransitions).toHaveLength(1);
    const f = r.illegalTransitions[0]!;
    expect(f).toMatchObject({ from: "fulfilled", to: "paid", warpFrom: "Fulfilled", warpTo: "Accepted", rule: "I-2" });
    expect(f.why).toContain("Invariant 2");
    expect(f.why).toContain("Disputed"); // names the legal moves from Fulfilled
  });

  it("returns a reachable counterexample path ending in the forbidden move", () => {
    const r = auditPlatformModel(broken);
    expect(r.reachabilityVerdict).toBe("violation-found");
    expect(r.counterexamples.length).toBeGreaterThan(0);
    const c = r.counterexamples[0]!;
    expect(c.path[c.path.length - 1]).toBe("Accepted");
    expect(c.path).toContain("Fulfilled");
  });
});

describe("auditPlatformModel — unmapped states are reported, never faked", () => {
  const withUnmapped: PlatformModel = {
    platformName: "Custom",
    states: ["new", "paid", "on_hold", "done"],
    stateMapping: { new: "Proposed", paid: "Accepted", done: "Fulfilled" }, // 'on_hold' unmapped
    transitions: [
      { from: "new", to: "paid" },
      { from: "paid", to: "on_hold" }, // touches an unmapped state → unchecked
      { from: "paid", to: "done" }, // Accepted → Fulfilled is illegal (no PartiallyFulfilled step)
    ],
    start: "new",
  };

  it("reports the unmapped state and the transition it makes uncheckable", () => {
    const r = auditPlatformModel(withUnmapped);
    expect(r.unmappedStates).toEqual(["on_hold"]);
    expect(r.uncheckedTransitions).toEqual([{ from: "paid", to: "on_hold" }]);
    expect(r.transitionsChecked).toBe(2); // only the two fully-mapped edges
  });

  it("still checks the mapped transitions (catches Accepted→Fulfilled as illegal)", () => {
    const r = auditPlatformModel(withUnmapped);
    expect(r.sound).toBe(false);
    expect(r.illegalTransitions.some((f) => f.warpFrom === "Accepted" && f.warpTo === "Fulfilled")).toBe(true);
  });
});

describe("formatAuditReport — human report with honest scope", () => {
  it("states the scope and the verdict", () => {
    const sound = formatAuditReport(auditPlatformModel(shopifyProfile));
    expect(sound).toContain("Tier 1 (state model)");
    expect(sound).toContain("not live data, not the whole platform");
    expect(sound).toContain("Verdict: SOUND");

    const broken = formatAuditReport(
      auditPlatformModel({ ...shopifyProfile, transitions: [...shopifyProfile.transitions, { from: "refunded", to: "paid" }] }),
    );
    expect(broken).toContain("Verdict: UNSOUND");
    expect(broken).toContain("counterexample path");
  });
});
