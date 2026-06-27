// A toy adopter app exercising the declared money-sinks in six ways:
//   3 GUARDED   — a Warp guard entry runs on the path before the sink
//   2 UNGUARDED — the sink runs with no guard on its path
//   1 UNANALYZABLE — the sink is reached indirectly (the analyzer cannot follow it)
//
// This file is a fixture: it is parsed by the audit, never executed or type-checked.
import { guardAction, guardObject, guardWithProfile } from "@warp-lang/commerce-types";
import { postLedger, chargeCard } from "./ledger.js";

// ── 3 GUARDED ──────────────────────────────────────────────────────────────
export function refundGuarded(world: any, action: any): void {
  guardAction(world, action);
  postLedger({ amount: 200 });
}

export function chargeGuarded(profile: any, world: any, action: any): void {
  guardWithProfile(profile, world, action);
  chargeCard({ amount: 50 });
}

export function settleGuarded(scene: any): void {
  guardObject(scene);
  postLedger({ amount: 10 });
}

// ── 2 UNGUARDED ────────────────────────────────────────────────────────────
export function refundDirect(): void {
  postLedger({ amount: 999 });
}

export function chargeDirect(): void {
  chargeCard({ amount: 999 });
}

// ── 1 UNANALYZABLE (indirect / dynamic dispatch) ────────────────────────────
export function dynamicWrite(): void {
  // The sink is aliased and invoked indirectly; the analyzer cannot follow the
  // value to the call to determine whether a guard runs first. Reported as
  // UNANALYZABLE — never counted as covered.
  const writer = postLedger;
  writer({ amount: 1 });
}
