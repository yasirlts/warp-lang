// Split fulfillment: bound the CUMULATIVE fractional allocation of a parent order
// across its line-item children, step by step. The F6 tree check reconciles a
// completed STATIC split (children sum to parent); the refund session caps the
// UNWINDING direction. This closes the FORWARD direction across steps — each child
// allocation is individually under the parent, yet the running sum must not tip over
// the parent's commitment. The bound is the canonical I-1 conservation rule lifted to
// the running total; a completed split is confirmed by the unmodified I-6 check.
//
//   npm install @warp-lang/commerce-types
//   node split-fulfillment.mjs
import {
  createSplitFulfillment, newCommitment, applyCommitmentPath,
  partyId, valueId, allocate, checkI6TreeConsistency,
} from "@warp-lang/commerce-types";

const buyer = partyId("buyer");
const seller = partyId("seller");
const money = (amount) => ({ id: valueId(), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } });
const mk = (id, amount, extra) => applyCommitmentPath({ ...newCommitment(buyer, seller, { offered: [], requested: [money(amount)] }), id, ...extra }, { type: "Fulfilled" }, seller);

// A 200 MAD parent order, fulfilled across three child shipments over time.
const parent = mk("order-1", 200, { children: ["ship-A", "ship-B", "ship-C"] });
console.log(`parent order-1 committed: ${parent.subject.requested[0].form.money.amount} MAD\n`);

const split = createSplitFulfillment(parent);
const alloc = (id, amount) => {
  const r = split.allocate({ child: mk(id, amount, { parent: "order-1" }) });
  if (r.ok) {
    console.log(`allocate ${id} ${amount} → accepted (cumulative ${r.cumulative.amount}, remaining ${r.remaining.amount}${r.complete ? ", SPLIT COMPLETE" : ""})`);
  } else {
    console.log(`allocate ${id} ${amount} → BLOCKED [${r.violations[0].rule}]`);
    console.log(`  ${r.violations[0].message}`);
    console.log(`  fix: ${r.violations[0].fix}`);
  }
  return r;
};

// Two partial shipments, each individually under the parent.
alloc("ship-A", 80);
alloc("ship-B", 70);

// A third shipment of 80 — valid alone (80 ≤ 200), but the running sum would reach
// 230 > 200. Caught as an I-1 over-allocation, with the remaining-allocatable.
alloc("ship-C", 80);

// Corrected to the remaining 50 → completes the split; the finished tree reconciles
// under the unmodified F6 structural check.
const done = alloc("ship-C", 50);
console.log(`\nfinished tree reconciles under I-6: ${checkI6TreeConsistency(parent, [...split.children]).length === 0}`);
console.log(`allocated so far: ${split.allocatedSoFar().amount} MAD (== parent committed 200)`);

// An exact fractional 3-way split using allocate() — shares conserve to the cent.
console.log("\n--- exact fractional split via allocate() ---");
const p2 = mk("order-2", 100, { children: ["frac-A", "frac-B", "frac-C"] });
const s2 = createSplitFulfillment(p2);
const shares = allocate({ amount: 100, currency: "MAD" }, [1, 1, 1]); // 33.34 + 33.33 + 33.33
shares.forEach((m, i) => {
  const r = s2.allocate({ child: mk(["frac-A", "frac-B", "frac-C"][i], m.amount, { parent: "order-2" }) });
  console.log(`allocate frac share ${m.amount} → ${r.ok ? `accepted (cumulative ${r.cumulative.amount}${r.complete ? ", COMPLETE" : ""})` : "rejected"}`);
});
console.log(`exact split conserves: allocated ${s2.allocatedSoFar().amount} MAD == parent 100`);
