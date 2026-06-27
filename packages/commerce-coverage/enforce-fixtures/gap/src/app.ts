// Gap state: a new unguarded declared sink. `enforce` must fail and name it.
import { guardAction } from "@warp-lang/commerce-types";
import { postLedger, chargeCard } from "./ledger.js";

export function refund(world: any, action: any): void {
  guardAction(world, action);
  postLedger({ amount: 10 });
}

export function chargeUnguarded(): void {
  chargeCard({ amount: 99 });
}
