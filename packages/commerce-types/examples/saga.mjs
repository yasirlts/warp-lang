// Saga / compensation: model the UNWINDING of a multi-step flow as an explicit,
// validated sequence of compensating actions, and check the compensation is coherent
// (a reversal that would over-refund is rejected with guidance).
//
//   npm install @warp-lang/commerce-types
//   node saga.mjs
//
// Scope (honest): Warp VALIDATES the compensation sequence — each compensating action
// is a legal reversing transition and the net effect conserves value. Warp does NOT
// execute or orchestrate rollbacks on external systems; the plan is a sequence of
// validated descriptors. Composes validTransitions + createSession; it does not fork
// invariant or transition logic.
import {
  createSession, compensate, compensateSession,
  newCommitment, applyCommitmentPath, partyId, valueId,
} from "@warp-lang/commerce-types";

const buyer = partyId("buyer");
const seller = partyId("seller");
const money = (amount) => ({ id: valueId(), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } });
const AT = "2026-03-01T00:00:00.000Z";

// ── The multi-step forward flow: accept → fulfill → partial refund 50 of 200 ──────
// We drive a 200 MAD order to Fulfilled, then a partial refund of 50 is applied in a
// session (the schema has no partial-refund state, so the session tracks it and keeps
// the order in Fulfilled). This is the world we now need to UNWIND.
const order = applyCommitmentPath(
  { ...newCommitment(buyer, seller, { offered: [], requested: [money(200)] }), id: "order-1" },
  { type: "Fulfilled" },
  seller,
);

const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
const partial = session.propose({ commitment: "order-1", to: { type: "Refunded", amount: { amount: 50, currency: "MAD" }, at: AT }, actor: seller, idempotencyKey: "partial-50" });
console.log(`forward flow: accept → fulfill → partial refund 50 → applied: ${partial.ok}. refunded so far: ${session.refundedSoFar("order-1")?.amount ?? 0} MAD of 200`);

// ── INVALID compensation: try to reverse the Fulfilled step by refunding the FULL 200
// again. The compensation is validated IN THE SAME SESSION the forward flow ran in, so
// the 50 already refunded is counted: 50 + 200 = 250 > 200 — value would not be
// conserved. The session rejects it with the remaining-refundable guidance. A rejected
// compensation does not advance the session, so the world is untouched. ──────────────
const overRefundForward = [
  { commitment: "order-1", to: { type: "Fulfilled" }, actor: seller, compensateWith: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: AT } },
];
const bad = compensateSession(session, overRefundForward, AT).result;
if (bad.ok === false) {
  console.log(`\nINVALID compensation (refund full 200 while 50 already refunded) → BLOCKED at step ${bad.failedAt} [${bad.violations[0].rule}]`);
  console.log(`  ${bad.violations[0].message}`);
  const alt = (bad.alternatives ?? []).find((a) => a.to === "Refunded");
  if (alt?.bounded) console.log(`  guidance: ${alt.bounded}`);
}

// ── VALID compensation: reverse the Fulfilled step by refunding the REMAINING 150.
// Validated in the same session, the cumulative cap accepts it (50 + 150 = 200 ==
// committed), the session marks the order fully Refunded, and the world is coherent. ─
const remainingForward = [
  { commitment: "order-1", to: { type: "Fulfilled" }, actor: seller, compensateWith: { type: "Refunded", amount: { amount: 150, currency: "MAD" }, at: AT } },
];
const valid = compensateSession(session, remainingForward, AT).result;
console.log(`\nVALID compensation (refund the remaining 150) → applied: ${valid.ok}`);
if (valid.ok) {
  const finalState = valid.next.commitments.find((c) => c.id === "order-1").state.type;
  console.log(`  compensating actions applied: ${valid.applied}, skipped: ${valid.skipped}`);
  console.log(`  refunded total: ${session.refundedSoFar("order-1")?.amount ?? 0} MAD; order-1 final state: ${finalState} (50 + 150 = 200 == committed; value conserved)`);
}

// ── Default mapping over the whole flow (no overrides): a fresh accept→active flow
// unwound by Cancellation, showing the non-refund compensation path. ─────────────────
const lease = applyCommitmentPath(
  { ...newCommitment(buyer, seller, { offered: [], requested: [money(100)] }), id: "lease-1" },
  { type: "Active" },
  seller,
);
const leaseWorld = { commitments: [lease], fulfillments: [], parties: [] };
const { plan: leasePlan, result: leaseResult } = compensate(leaseWorld, [{ commitment: "lease-1", to: { type: "Active" }, actor: seller }], AT);
console.log(`\ndefault mapping: Active commitment unwound by Cancellation → applied: ${leaseResult.ok} (plan reverses ${leasePlan.steps.filter((s) => s.action !== null).length} step)`);
if (leaseResult.ok) {
  console.log(`  lease-1 final state: ${leaseResult.next.commitments.find((c) => c.id === "lease-1").state.type} (committed-but-not-delivered → Cancelled)`);
}
