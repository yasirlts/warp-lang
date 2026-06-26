/**
 * Demo: run several commerce actions through a metrics-wrapped guard, then print
 * the tally by rule and by scope.
 *
 *   node examples/metrics.mjs
 *
 * The wrapper is withMetrics(guardAction, collector): each call returns the EXACT
 * verdict the published guardAction would, and the collector counts the blocks by
 * rule (I-1..I-6) and by scope (the target state type). Some actions here are
 * valid (within-amount refund), some are blocked (an I-1 over-refund and an I-2
 * illegal backward move). At the end we read collector.snapshot().
 *
 * This counts verdicts; it does not change how any verdict is reached.
 */
import { newCommitment, applyCommitmentPath, partyId } from "@warp-lang/commerce-types";
import { withMetrics, MetricsCollector } from "../dist/index.js";

function fulfilledOrder(amount = 200, currency = "MAD") {
  const buyer = partyId("buyer_1");
  const seller = partyId("seller_1");
  const order = newCommitment(buyer, seller, {
    offered: [],
    requested: [
      {
        id: "value:order-total",
        form: { kind: "Money", money: { amount, currency } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  const shipped = applyCommitmentPath(order, { type: "Fulfilled" }, seller);
  return { shipped, seller, world: { commitments: [shipped], fulfillments: [], parties: [] } };
}

const refundTo = (amount, currency = "MAD") => ({
  type: "Refunded",
  amount: { amount, currency },
  at: "2026-02-01T00:00:00.000Z",
});

const collector = new MetricsCollector();
const guard = withMetrics(undefined, collector); // defaults to the published guardAction

function run(label, world, action) {
  const verdict = guard(world, action);
  if (verdict.ok) {
    console.log(`${label.padEnd(34)} -> ok`);
  } else {
    const rules = verdict.violations.map((v) => v.rule).join(", ");
    console.log(`${label.padEnd(34)} -> BLOCKED [${rules}]`);
  }
}

// 1. Valid: refund within the committed amount. (allowed)
{
  const { shipped, seller, world } = fulfilledOrder(200);
  run("refund 200 MAD (valid)", world, {
    commitment: shipped.id,
    to: refundTo(200),
    actor: seller,
  });
}

// 2. Valid again, a second within-amount refund on a fresh order. (allowed)
{
  const { shipped, seller, world } = fulfilledOrder(150);
  run("refund 150 MAD (valid)", world, {
    commitment: shipped.id,
    to: refundTo(150),
    actor: seller,
  });
}

// 3. Blocked I-1: over-refund 500 MAD against a 200 MAD order.
{
  const { shipped, seller, world } = fulfilledOrder(200);
  run("over-refund 500 MAD (I-1)", world, {
    commitment: shipped.id,
    to: refundTo(500),
    actor: seller,
  });
}

// 4. Blocked I-1 again: over-refund 300 MAD against a 200 MAD order.
{
  const { shipped, seller, world } = fulfilledOrder(200);
  run("over-refund 300 MAD (I-1)", world, {
    commitment: shipped.id,
    to: refundTo(300),
    actor: seller,
  });
}

// 5. Blocked I-2: illegal backward move (Fulfilled -> Draft).
{
  const { shipped, seller, world } = fulfilledOrder(200);
  run("illegal move Fulfilled->Draft (I-2)", world, {
    commitment: shipped.id,
    to: { type: "Draft" },
    actor: seller,
  });
}

console.log();
const snap = collector.snapshot();
console.log("metrics tally");
console.log("  totalAllowed:", snap.totalAllowed);
console.log("  totalBlocks: ", snap.totalBlocks);
console.log("  byRule:      ", JSON.stringify(snap.byRule));
console.log("  byScope:     ", JSON.stringify(snap.byScope));
