/**
 * Platform Auditor — Tier 1, runnable. It maps an existing platform's declared
 * order/refund STATE MODEL onto Warp and checks its soundness. It must do BOTH
 * honestly:
 *
 *   (a) a SOUND model (the built-in Shopify-derived profile) → reports SOUND.
 *   (b) a BROKEN model (a platform that lets a shipped order revert to unfulfilled)
 *       → reports UNSOUND, naming the illegal transition, its invariant, and the
 *       counterexample path.
 *
 * (b) is essential — a tool that only ever says "sound" is untrustworthy.
 *
 * Scope: this audits the state MODEL, not live orders and not the whole platform;
 * commerce-integrity only.
 *
 *   node examples/audit-platform.mjs
 */
import { auditPlatformModel, formatAuditReport, shopifyProfile } from "@warp-lang/commerce-types";

console.log("(a) A sound platform model — Shopify's order flow, mapped to Warp:\n");
console.log(formatAuditReport(auditPlatformModel(shopifyProfile)));

// (b) A broken model: a bug lets a FULFILLED (shipped) order revert to PAID
//     (unfulfilled). In Warp that is Fulfilled → Accepted, which Invariant 2 forbids.
const brokenShopify = {
  ...shopifyProfile,
  platformName: "Shopify (with a revert-after-ship bug)",
  transitions: [...shopifyProfile.transitions, { from: "fulfilled", to: "paid" }],
};

console.log("\n\n(b) A broken platform model — a shipped order can revert to unfulfilled:\n");
const broken = auditPlatformModel(brokenShopify);
console.log(formatAuditReport(broken));

console.log(
  "\nThe auditor mapped each platform state to Warp, checked every transition against",
);
console.log(
  "Warp's invariants, and caught the broken model's forbidden move with its path — it",
);
console.log("reports on the state MODEL, not live data or the rest of the platform.");
