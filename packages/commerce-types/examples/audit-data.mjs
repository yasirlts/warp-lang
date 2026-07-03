/**
 * Platform Auditor — Tier 2, runnable. It scans SUPPLIED order records for
 * commerce-integrity violations that already happened, per record. It must find
 * real per-record problems — not just say "ok":
 *
 *   - most orders clean
 *   - a planted OVER-REFUND        → caught (I-1) on the right order, with the amount
 *   - a CURRENCY-MIXED settlement  → caught (I-1)
 *   - an ILLEGAL state history     → caught (I-2)
 *   - one UNMAPPABLE record        → listed as unauditable, NOT counted clean
 *
 * Scope: audits the records you SUPPLY, for commerce-integrity only. Not
 * live-connected (you bring the data); not a fraud/UI/tax-rate/security scanner.
 *
 *   node examples/audit-data.mjs
 */
import { auditPlatformData, formatDataAuditReport } from "@warp-lang/commerce-types";

const records = [
  // clean: a normal fulfilled order with a legal history
  {
    id: "ord-1001",
    committed: { amount: 200, currency: "MAD" },
    finalState: "Fulfilled",
    history: [
      { from: "Proposed", to: "Accepted" },
      { from: "Accepted", to: "PartiallyFulfilled" },
      { from: "PartiallyFulfilled", to: "Fulfilled" },
    ],
  },
  // clean: a full refund (refund == captured is the conservation boundary)
  { id: "ord-1002", committed: { amount: 150, currency: "MAD" }, refund: { amount: 150, currency: "MAD" } },
  // VIOLATION (I-1): refunded more than was captured
  { id: "ord-1003", committed: { amount: 200, currency: "MAD" }, refund: { amount: 250, currency: "MAD" } },
  // VIOLATION (I-1): settlement breakdown mixes currencies
  {
    id: "ord-1004",
    committed: { amount: 300, currency: "MAD" },
    settlement: {
      total: { amount: 300, currency: "MAD" },
      components: [
        { kind: "Base", amount: { amount: 250, currency: "MAD" } },
        { kind: "Tax", amount: { amount: 50, currency: "EUR" } }, // wrong currency
      ],
    },
  },
  // VIOLATION (I-2): recorded history reverts a shipped order
  {
    id: "ord-1005",
    committed: { amount: 120, currency: "MAD" },
    history: [
      { from: "Proposed", to: "Accepted" },
      { from: "Accepted", to: "PartiallyFulfilled" },
      { from: "PartiallyFulfilled", to: "Fulfilled" },
      { from: "Fulfilled", to: "Accepted" }, // illegal: revert after fulfilment
    ],
  },
  // UNMAPPABLE: no committed amount to map
  { id: "ord-1006", note: "malformed export row" },
];

const result = auditPlatformData({ platform: "Generic export", records });
console.log(formatDataAuditReport(result));

console.log("\nJSON summary:", JSON.stringify(result.summary));
console.log(
  `Check: clean(${result.summary.clean}) + withViolations(${result.summary.withViolations}) = recordsAudited(${result.summary.recordsAudited}); ` +
    `unauditable(${result.summary.unauditable}) is separate — total ${result.summary.total}.`,
);
