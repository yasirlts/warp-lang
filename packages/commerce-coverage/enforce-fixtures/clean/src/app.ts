// Clean state: every analyzable declared sink is guarded. One sink is reached
// indirectly (unanalyzable) to exercise onUnanalyzable warn|block.
import { guardAction, guardWithProfile } from "@warp-lang/commerce-types";
import { postLedger, chargeCard } from "./ledger.js";

export function refund(world: any, action: any): void {
  guardAction(world, action);
  postLedger({ amount: 10 });
}

export function charge(profile: any, world: any, action: any): void {
  guardWithProfile(profile, world, action);
  chargeCard({ amount: 20 });
}

export function dynamic(): void {
  const writer = postLedger; // indirect -> UNANALYZABLE
  writer({ amount: 1 });
}
