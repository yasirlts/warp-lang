// Regulatory policy pack (VAT reconciliation): check a settlement's tax
// components against a jurisdiction's permitted rates, layered as DATA over the
// frozen validateSettlement reconciliation check.
//
// HONEST SCOPE: this is NOT a tax calculator or tax engine. The permitted rates
// are pack DATA (supplied by the caller); the taxable base, the tax amount, and
// the tax_rate are caller-supplied inputs on the components. The pack only checks
// that (1) the components reconcile to the committed total (I-1, via
// validateSettlement), (2) each Tax component's rate is one the pack permits for
// its jurisdiction, and (3) the tax amount equals rate × base. It does not decide
// which rate the law requires.
//
//   npm install @warp-lang/commerce-types
//   node vat-pack.mjs
//
import { checkSettlementPolicy, SAMPLE_VAT_PACK } from "@warp-lang/commerce-types";

// A commitment committed at 240 MAD, settled as base 200 + VAT 40 (20% of 200) in
// Morocco ("MA"). 0.2 is a rate the sample pack permits for MA, and 0.2 × 200 = 40.
const committed = { amount: 240, currency: "MAD" };

const reconciling = {
  total: { amount: 240, currency: "MAD" },
  components: [
    { kind: "Base", amount: { amount: 200, currency: "MAD" }, label: "principal" },
    {
      kind: "Tax",
      amount: { amount: 40, currency: "MAD" },
      label: "VAT 20%",
      jurisdiction: "MA",
      tax_rate: 0.2,
    },
  ],
};

const ok = checkSettlementPolicy(reconciling, committed, SAMPLE_VAT_PACK);
console.log(`reconciling VAT settlement (base 200 + 20% VAT 40 = 240, MA) → ${ok.ok ? "ACCEPTED" : "REJECTED"}`);

// A Tax component whose amount does NOT match rate × base is caught — the caller
// declared 0.2 but the amount (30) is not 0.2 × 200 (40).
const wrongAmount = {
  total: { amount: 230, currency: "MAD" },
  components: [
    { kind: "Base", amount: { amount: 200, currency: "MAD" } },
    { kind: "Tax", amount: { amount: 30, currency: "MAD" }, jurisdiction: "MA", tax_rate: 0.2 },
  ],
};
const bad = checkSettlementPolicy(wrongAmount, { amount: 230, currency: "MAD" }, SAMPLE_VAT_PACK);
if (bad.ok === false) {
  console.log(`\nmismatched tax (declared 30 at 20% on base 200, expected 40) → BLOCKED [${bad.violations[0].rule}]`);
  console.log(`  ${bad.violations[0].message}`);
  console.log(`  fix: ${bad.violations[0].fix}`);
}

// A rate the pack does not permit for the jurisdiction is caught. 0.25 is not in
// MA's permitted rates, even though 0.25 × 200 = 50 reconciles to the total.
const badRate = {
  total: { amount: 250, currency: "MAD" },
  components: [
    { kind: "Base", amount: { amount: 200, currency: "MAD" } },
    { kind: "Tax", amount: { amount: 50, currency: "MAD" }, jurisdiction: "MA", tax_rate: 0.25 },
  ],
};
const rate = checkSettlementPolicy(badRate, { amount: 250, currency: "MAD" }, SAMPLE_VAT_PACK);
if (rate.ok === false) {
  console.log(`\nrate not permitted for MA (0.25) → BLOCKED [${rate.violations[0].rule}]`);
  console.log(`  ${rate.violations[0].message}`);
}

// A settlement that does not reconcile is caught by the underlying validateSettlement
// FIRST — the pack rate check is not even reached.
const notReconciling = {
  total: { amount: 240, currency: "MAD" },
  components: [
    { kind: "Base", amount: { amount: 200, currency: "MAD" } },
    { kind: "Tax", amount: { amount: 30, currency: "MAD" }, jurisdiction: "MA", tax_rate: 0.2 }, // 230 ≠ 240
  ],
};
const recon = checkSettlementPolicy(notReconciling, committed, SAMPLE_VAT_PACK);
if (recon.ok === false) {
  console.log(`\ncomponents do not sum to committed total (230 ≠ 240) → BLOCKED [${recon.violations[0].rule}]`);
  console.log(`  (delegated to validateSettlement — reconciliation runs before the rate check)`);
}
