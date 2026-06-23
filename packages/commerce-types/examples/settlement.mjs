// Multi-component settlement: validate that a settlement decomposed into
// principal / tax / fees / shipping RECONCILES against the committed total, in
// one currency — and track partial settlements cumulatively so they cannot
// over-settle.
//
// HONEST SCOPE: this validates that the amounts a caller already computed ADD UP
// and conserve value. It does NOT compute tax — the Tax component amount is your
// input; Warp checks the components sum to the committed total (I-1).
//
//   npm install @warp-lang/commerce-types
//   node settlement.mjs
//
import {
  validateSettlement,
  createSettlementTracker,
  componentTotal,
} from "@warp-lang/commerce-types";

// A commitment was committed at 240 MAD. The caller settles it as a multi-component
// breakdown: principal 200 + VAT 30 + shipping 10 = 240. (The 30 is the caller's
// computed tax — Warp does not derive it, only checks it reconciles.)
const committed = { amount: 240, currency: "MAD" };

const reconciling = {
  total: { amount: 240, currency: "MAD" },
  components: [
    { kind: "Base", amount: { amount: 200, currency: "MAD" }, label: "principal" },
    { kind: "Tax", amount: { amount: 30, currency: "MAD" }, label: "VAT 15% (caller-supplied)" },
    { kind: "Shipping", amount: { amount: 10, currency: "MAD" } },
  ],
};

const ok = validateSettlement(reconciling, committed);
console.log(`reconciling settlement (200 + 30 + 10 = 240) → ${ok.ok ? "ACCEPTED" : "REJECTED"}`);
console.log(`  tax lines total: ${componentTotal(reconciling, "Tax").amount} MAD (totalled, not computed)`);

// A settlement whose components do NOT sum to the committed total is caught (I-1).
const mismatch = {
  total: { amount: 240, currency: "MAD" },
  components: [
    { kind: "Base", amount: { amount: 200, currency: "MAD" } },
    { kind: "Tax", amount: { amount: 25, currency: "MAD" } }, // 200 + 25 + 10 = 235 ≠ 240
    { kind: "Shipping", amount: { amount: 10, currency: "MAD" } },
  ],
};
const bad = validateSettlement(mismatch, committed);
if (bad.ok === false) {
  console.log(`\nmismatched settlement (200 + 25 + 10 = 235 ≠ 240) → BLOCKED [${bad.violations[0].rule}]`);
  console.log(`  ${bad.violations[0].message}`);
  console.log(`  fix: ${bad.violations[0].fix}`);
}

// Mixing currencies in the components is caught (single-currency clause).
const mixed = {
  total: { amount: 240, currency: "MAD" },
  components: [
    { kind: "Base", amount: { amount: 210, currency: "MAD" } },
    { kind: "Tax", amount: { amount: 30, currency: "EUR" } }, // wrong currency
  ],
};
const mix = validateSettlement(mixed, committed);
console.log(`\nmixed-currency components → ${mix.ok ? "accepted" : "BLOCKED"} [${mix.ok ? "" : mix.violations[0].rule}]`);

// PARTIAL settlement, tracked cumulatively. Settle the 240 in two reconciling
// installments; a third that would over-settle is blocked.
console.log("\n— partial settlement, tracked cumulatively —");
const tracker = createSettlementTracker(committed);

// Installment 1: 140 (principal 120 + tax 20), reconciles internally.
const part1 = tracker.settle({
  total: { amount: 140, currency: "MAD" },
  components: [
    { kind: "Base", amount: { amount: 120, currency: "MAD" } },
    { kind: "Tax", amount: { amount: 20, currency: "MAD" } },
  ],
});
let p = tracker.progress();
console.log(`installment 1 (140) → ${part1.ok ? "accepted" : "rejected"}. settled ${p.settled.amount}, remaining ${p.remaining.amount} MAD`);

// Installment 2: 100 (principal 80 + tax 10 + shipping 10), reconciles internally.
const part2 = tracker.settle({
  total: { amount: 100, currency: "MAD" },
  components: [
    { kind: "Base", amount: { amount: 80, currency: "MAD" } },
    { kind: "Tax", amount: { amount: 10, currency: "MAD" } },
    { kind: "Shipping", amount: { amount: 10, currency: "MAD" } },
  ],
});
p = tracker.progress();
console.log(`installment 2 (100) → ${part2.ok ? "accepted" : "rejected"}. settled ${p.settled.amount}, remaining ${p.remaining.amount} MAD, fully settled: ${p.fullySettled}`);

// Installment 3: another 50 — each component reconciles, but cumulative 290 > 240.
const part3 = tracker.settle({
  total: { amount: 50, currency: "MAD" },
  components: [{ kind: "Base", amount: { amount: 50, currency: "MAD" } }],
});
if (part3.ok === false) {
  console.log(`\ninstallment 3 (50, cumulative 290) → BLOCKED [${part3.violations[0].rule}]`);
  console.log(`  ${part3.violations[0].message}`);
  console.log(`  fix: ${part3.violations[0].fix}`);
}
