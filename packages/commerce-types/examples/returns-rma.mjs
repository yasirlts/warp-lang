// Returns / RMA lifecycle as a SESSION-LAYER profile — no schema change.
//
//   npm install @warp-lang/commerce-types
//   node returns-rma.mjs
//
// A return refunds the order's LINE-ITEM children (which the model already carries via
// the F6 parent/children tree). The order itself is never moved backward. The RMA stages
// (requested → authorized → in_transit → received → inspected → refunded) are a
// session-layer OVERLAY that gates the money move; they are NOT commitment states. The
// committed states stay the frozen set. Partial returns and over-return safety are the
// existing per-tree refund cap (checkI6TreeConsistency + the I-1 cumulative probe).
import {
  createReturnsSession, newCommitment, applyCommitmentPath, partyId, valueId, checkI6TreeConsistency,
} from "@warp-lang/commerce-types";

const buyer = partyId("buyer");
const seller = partyId("seller");
const money = (amount) => ({ id: valueId(), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } });

// A 200 MAD order with two fulfilled line-item children (120 + 80 = 200), reconciling via I-6.
const mk = (id, amount, extra) => applyCommitmentPath({ ...newCommitment(buyer, seller, { offered: [], requested: [money(amount)] }), id, ...extra }, { type: "Fulfilled" }, seller);
const order = mk("order-1", 200, { children: ["line-A", "line-B"] });
const lineA = mk("line-A", 120, { parent: "order-1" });
const lineB = mk("line-B", 80, { parent: "order-1" });
console.log("I-6 static reconciliation (lines 120+80 == order 200):", checkI6TreeConsistency(order, [lineA, lineB]).length === 0);

const session = createReturnsSession({ commitments: [order, lineA, lineB], fulfillments: [], parties: [] });

// ── A partial return: customer returns line-A (worth 120) of the 200 order. ──────────
const opened = session.open({ id: "rma-1", order: "order-1", lines: [{ line: "line-A", amount: { amount: 120, currency: "MAD" }, reason: "wrong size" }] });
console.log(`\nopen rma-1 (return line-A, 120 of 200): ${opened.ok ? "ok" : "rejected — " + opened.reason}`);

// Refund before inspection is GATED by the overlay.
const early = session.settle("rma-1", seller);
console.log(`\nsettle before inspection → ${early.ok ? "accepted" : "BLOCKED [" + early.violations[0].rule + "]"}`);
if (!early.ok) console.log(`  ${early.violations[0].message}`);

// Walk the RMA through its stages (overlay only — the order's committed state is untouched).
for (const stage of ["authorized", "in_transit", "received", "inspected"]) {
  const r = session.advance("rma-1", stage);
  console.log(`advance rma-1 → ${stage}: ${r.ok ? "ok" : "rejected — " + r.reason}`);
}

// Now the refund settles (120 against line-A, within both the line and the tree cap).
const settled = session.settle("rma-1", seller);
console.log(`\nsettle after inspection → ${settled.ok ? "accepted" : "rejected"} (line-A refunded: ${session.refundedSoFar("line-A")?.amount} MAD)`);
console.log(`rma-1 stage is now: ${session.rma("rma-1").stage}`);

// ── An OVER-return is caught by the existing tree cap. ───────────────────────────────
// Open a return on line-B for 120 — but line-B was only worth 80, and the tree has only
// 80 left (200 − 120). Caught by the per-child / tree cap when it settles.
const opened2 = session.open({ id: "rma-2", order: "order-1", lines: [{ line: "line-B", amount: { amount: 120, currency: "MAD" } }] });
console.log(`\nopen rma-2 (return line-B for 120; line-B worth 80, 80 left in tree): ${opened2.ok ? "ok" : "rejected"}`);
for (const stage of ["authorized", "in_transit", "received", "inspected"]) session.advance("rma-2", stage);
const over = session.settle("rma-2", seller);
if (over.ok === false) {
  console.log(`settle rma-2 → BLOCKED [${over.violations[0].rule}]`);
  console.log(`  ${over.violations[0].message}`);
}

// ── A VALID return for the remaining 80 (line-B at its committed worth) completes. ──
const opened3 = session.open({ id: "rma-3", order: "order-1", lines: [{ line: "line-B", amount: { amount: 80, currency: "MAD" } }] });
console.log(`\nopen rma-3 (return line-B for its committed 80): ${opened3.ok ? "ok" : "rejected"}`);
for (const stage of ["authorized", "in_transit", "received", "inspected"]) session.advance("rma-3", stage);
const done = session.settle("rma-3", seller);
const treeTotal = ["line-A", "line-B"].reduce((s, id) => s + (session.refundedSoFar(id)?.amount ?? 0), 0);
console.log(`settle rma-3 → ${done.ok ? "accepted" : "rejected"} (order fully returned: ${treeTotal} MAD == committed 200)`);
console.log(`rma-3 stage is now: ${session.rma("rma-3").stage}`);
