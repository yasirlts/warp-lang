// Multi-object coherence: the session's cumulative checking spans a TREE of related
// commitments — a parent order and its child line-item commitments. Refunds spread
// across DIFFERENT children (each individually valid, each child reconciling to the
// parent via I-6) cannot cumulatively exceed the PARENT's committed amount.
//
//   npm install @warp-lang/commerce-types
//   node multi-object.mjs
//
// The unit is a parent + its children tree. This composes the existing
// checkI6TreeConsistency (structure) + the I-1 cumulative rule (lifted to the parent).
import {
  createSession, newCommitment, applyCommitmentPath, partyId, valueId, checkI6TreeConsistency,
} from "@warp-lang/commerce-types";

const buyer = partyId("buyer");
const seller = partyId("seller");
const money = (amount) => ({ id: valueId(), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } });

// A 200 MAD parent order with two line-item children (100 + 100 = 200), all shipped.
const mk = (id, amount, extra) => applyCommitmentPath({ ...newCommitment(buyer, seller, { offered: [], requested: [money(amount)] }), id, ...extra }, { type: "Fulfilled" }, seller);
const parent = mk("order-1", 200, { children: ["line-A", "line-B"] });
const lineA = mk("line-A", 100, { parent: "order-1" });
const lineB = mk("line-B", 100, { parent: "order-1" });

console.log("I-6 static reconciliation (children 100+100 == parent 200):", checkI6TreeConsistency(parent, [lineA, lineB]).length === 0);

const session = createSession({ commitments: [parent, lineA, lineB], fulfillments: [], parties: [] });
const refund = (commitment, amount, key) => ({ commitment, to: { type: "Refunded", amount: { amount, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor: "agent", idempotencyKey: key });
const treeTotal = () => ["order-1", "line-A", "line-B"].reduce((sum, id) => sum + (session.refundedSoFar(id)?.amount ?? 0), 0);

// Two line-item refunds, each ≤ its own child's committed (100). Individually valid.
console.log(`\nrefund line-A 80 → ${session.propose(refund("line-A", 80, "a")).ok ? "accepted" : "rejected"} (tree refunded: ${treeTotal()} MAD)`);
console.log(`refund line-B 80 → ${session.propose(refund("line-B", 80, "b")).ok ? "accepted" : "rejected"} (tree refunded: ${treeTotal()} MAD)`);

// A third refund — on the PARENT, 80 ≤ 200 on its own — but the TREE total would
// reach 240 > 200. Caught at this step, with the remaining-refundable across the tree.
const over = session.propose(refund("order-1", 80, "p"));
if (over.ok === false) {
  console.log(`\nrefund order-1 80 → BLOCKED [${over.violations[0].rule}]`);
  console.log(`  ${over.violations[0].message}`);
  console.log(`  guidance: ${over.alternatives[0].bounded}`);
}

// Corrected to the remaining 40 across the tree → completes.
const fixed = session.propose(refund("order-1", 40, "p2"));
console.log(`\ncorrected refund order-1 40 → ${fixed.ok ? "accepted" : "rejected"}. tree refunded: ${treeTotal()} MAD (== parent committed 200)`);

// A fully-valid tree: refund each child within the parent (100 + 100 = 200).
const p2 = mk("order-2", 200, { children: ["line-C", "line-D"] });
const lc = mk("line-C", 100, { parent: "order-2" });
const ld = mk("line-D", 100, { parent: "order-2" });
const s2 = createSession({ commitments: [p2, lc, ld], fulfillments: [], parties: [] });
const c = s2.propose(refund("line-C", 100, "c"));
const d = s2.propose(refund("line-D", 100, "d"));
console.log(`\nvalid tree: refund line-C 100 → ${c.ok}, line-D 100 → ${d.ok} (tree total 200 == parent 200, within the parent)`);
