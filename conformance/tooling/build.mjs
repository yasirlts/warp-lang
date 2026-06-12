/**
 * conformance/tooling/build.mjs — fixture generator + canonical cross-check.
 *
 * This script is BUILD-TIME provenance, not part of the shipped contract. It:
 *   1. defines every conformance fixture as plain data (derived from the Warp
 *      Commerce Model v0.3 — the five primitives, the 26-transition table, the
 *      six invariants, currency-safe Money);
 *   2. writes each fixture to conformance/{valid,invalid,transitions}/ and the
 *      invalid sidecars + manifest.json;
 *   3. ASSERTS the canonical reference implementation (@warp-lang/commerce-types,
 *      the real auditCommerce / isValid*Transition / currencyDecimals) agrees
 *      with every declared outcome. If the package and a fixture disagree, this
 *      script throws — so a committed fixture can never silently drift from the
 *      model it claims to encode.
 *
 * The shipped, language-neutral runner (conformance/runner/run.mjs) re-validates
 * the same fixtures with ZERO dependencies. Canonical agreement here + zero-dep
 * agreement there = the cross-language contract is real.
 */

import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditCommerce,
  isValidCommitmentTransition,
  isValidIntentTransition,
  isValidFulfillmentTransition,
  currencyDecimals,
} from "../../packages/commerce-types/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Canonical timestamps — clean, monotonic, deterministic (no `now()`), so the
// fixtures are reproducible and human-readable. The model's temporal invariants
// (I-2, I-4) compare these values directly; they never need to be "now".
// ---------------------------------------------------------------------------
const T = {
  verified: "2026-01-01T00:00:00.000Z",
  t0: "2026-01-02T08:00:00.000Z",
  t1: "2026-01-02T09:00:00.000Z",
  t2: "2026-01-02T10:00:00.000Z",
  t3: "2026-01-02T11:00:00.000Z",
  t4: "2026-01-02T12:00:00.000Z",
  future: "2099-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Party / capacity builders
// ---------------------------------------------------------------------------
const locale = { language: "fr-MA", currency: "MAD", jurisdiction: "MA" };
const noCapacity = {
  can_buy: false,
  can_sell: false,
  can_fulfill: false,
  can_guarantee: false,
  verified_at: T.verified,
};
const fullCapacity = {
  can_buy: true,
  can_sell: true,
  can_fulfill: true,
  can_guarantee: true,
  verified_at: T.verified,
};

function party(id, party_type, capacity) {
  return { id, party_type, locale, capacity };
}
const buyer = (cap = fullCapacity) => party("party:buyer", "Individual", cap);
const seller = () => party("party:seller", "Organization", fullCapacity);
const platform = () => ({
  id: "party:platform",
  party_type: "System",
  locale: { language: "en", currency: "USD", jurisdiction: "MA" },
  capacity: fullCapacity,
});

// ---------------------------------------------------------------------------
// Value / Money builders
// ---------------------------------------------------------------------------
let valueSeq = 0;
function moneyValue(amount, currency = "MAD", id) {
  return {
    id: id ?? `value:money-${++valueSeq}`,
    form: { kind: "Money", money: { amount, currency } },
    quantity: 1,
    state: { type: "Available" },
  };
}

// ---------------------------------------------------------------------------
// Commitment / fulfillment builders
// ---------------------------------------------------------------------------
function commitment(id, { initiator, counterparty, intermediaries = [], requested = [], offered = [], state, history = [], children = [], terms, parent }) {
  const c = {
    id,
    parties: { initiator, counterparty, intermediaries },
    subject: { offered, requested },
    state,
    history,
    children,
    created_at: T.t0,
  };
  if (terms) c.terms = terms;
  if (parent) c.parent = parent;
  return c;
}

function fulfillment(id, { commitment: cid, state, history = [], planned_at = T.t1, started_at, completed_at }) {
  const f = { id, commitment: cid, state, history, planned_at };
  if (started_at) f.started_at = started_at;
  if (completed_at) f.completed_at = completed_at;
  return f;
}

// Commitment-state value constructors (carry the model's required payloads).
const S = {
  draft: { type: "Draft" },
  proposed: { type: "Proposed" },
  tendered: { type: "Tendered", offer_amount: 100, offer_currency: "MAD", closes_at: T.future },
  accepted: { type: "Accepted" },
  modified: { type: "Modified", modified_by: "party:seller", reason: "price update" },
  partial: { type: "PartiallyFulfilled", fulfilled_item_ids: ["item:1"], remaining_item_ids: ["item:2"] },
  active: { type: "Active" },
  fulfilled: { type: "Fulfilled" },
  cancelled: { type: "Cancelled", by: "party:buyer", reason: "changed mind", at: T.t2 },
  disputed: { type: "Disputed", by: "party:buyer", reason: "item damaged", opened_at: T.t2 },
  refunded: { type: "Refunded", amount: { amount: 100, currency: "MAD" }, at: T.t4 },
};

// ===========================================================================
// FIXTURE DEFINITIONS
// ===========================================================================
const fixtures = []; // { id, kind, dir, payload, expect, rule?, ruleName?, regression?, title, doc }

function add(f) {
  fixtures.push(f);
}

// --- VALID: scenes ---------------------------------------------------------

// A paid + fulfilled order with a synthesized, valid history (BUG 2 regression:
// proves the adapter-synthesis fix — a Fulfilled order with real history reaching
// Accepted audits clean; the pre-fix empty-history version is the i4 invalid below).
add({
  id: "order-paid-fulfilled",
  kind: "scene",
  dir: "valid",
  expect: "accept",
  regression: "bug-2-adapter-empty-history",
  title: "Paid + fulfilled order with synthesized valid history",
  doc: "A Fulfilled commitment whose history replays Draft→Proposed→Accepted→PartiallyFulfilled→Fulfilled, with a Completed fulfillment that starts after acceptance. Must audit with zero violations (I-1..I-6 all clean). Regression for BUG 2: adapters once emitted empty histories that falsely failed I-4.",
  payload: {
    parties: [buyer(), seller()],
    commitments: [
      commitment("commitment:order-1", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        requested: [moneyValue(100, "MAD", "value:order-total")],
        state: S.fulfilled,
        history: [
          { from: S.draft, to: S.proposed, at: T.t0, actor: "party:buyer" },
          { from: S.proposed, to: S.accepted, at: T.t1, actor: "party:seller" },
          { from: S.accepted, to: S.partial, at: T.t2, actor: "party:seller" },
          { from: S.partial, to: S.fulfilled, at: T.t3, actor: "party:seller" },
        ],
      }),
    ],
    fulfillments: [
      fulfillment("fulfillment:f-1", {
        commitment: "commitment:order-1",
        state: { type: "Completed" },
        history: [
          { from: { type: "Planned" }, to: { type: "InProgress" }, at: T.t2, actor: "party:seller" },
          { from: { type: "InProgress" }, to: { type: "Completed" }, at: T.t3, actor: "party:seller" },
        ],
        planned_at: T.t1,
        started_at: T.t2,
        completed_at: T.t3,
      }),
    ],
  },
});

// A single-currency MoneyBreakdown (multiple line items, one currency) that does
// NOT mix currencies — the clean side of I-1.
add({
  id: "money-breakdown-single-currency",
  kind: "scene",
  dir: "valid",
  expect: "accept",
  title: "MoneyBreakdown with multiple same-currency line items",
  doc: "A commitment subject carrying several MAD money values (60 + 40). One currency throughout, so Value Conservation (I-1) is satisfied — no implicit FX.",
  payload: {
    parties: [buyer()],
    commitments: [
      commitment("commitment:breakdown-1", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        requested: [moneyValue(60, "MAD"), moneyValue(40, "MAD")],
        state: S.draft,
        history: [],
      }),
    ],
    fulfillments: [],
  },
});

// Multi-party marketplace commission split, with the parent split into a seller
// payout child + a platform commission child that sum exactly to the parent.
add({
  id: "commission-split-multiparty",
  kind: "scene",
  dir: "valid",
  expect: "accept",
  title: "Multi-party commission split summing to parent (I-6 clean)",
  doc: "A marketplace commitment (buyer↔seller, platform intermediary) with a DoubleSided CommissionSplit payment timing, decomposed into a 95.00 MAD seller payout and a 5.00 MAD platform commission. Children sum exactly to the 100.00 MAD parent — Commitment Tree Consistency (I-6) holds.",
  payload: {
    parties: [buyer(), seller(), platform()],
    commitments: [
      commitment("commitment:mkt-1", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        intermediaries: ["party:platform"],
        requested: [moneyValue(100, "MAD", "value:mkt-total")],
        state: S.accepted,
        history: [
          { from: S.draft, to: S.proposed, at: T.t0, actor: "party:buyer" },
          { from: S.proposed, to: S.accepted, at: T.t1, actor: "party:seller" },
        ],
        children: ["commitment:mkt-payout", "commitment:mkt-commission"],
        terms: {
          payment: {
            timing: {
              type: "CommissionSplit",
              structure: {
                type: "DoubleSided",
                buyer_fee: { rate: 0.02, paid_to: "party:platform" },
                seller_fee: { rate: 0.05, paid_to: "party:platform" },
              },
            },
          },
        },
      }),
      commitment("commitment:mkt-payout", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        parent: "commitment:mkt-1",
        requested: [moneyValue(95, "MAD", "value:mkt-payout")],
        state: S.accepted,
        history: [
          { from: S.draft, to: S.proposed, at: T.t0, actor: "party:buyer" },
          { from: S.proposed, to: S.accepted, at: T.t1, actor: "party:seller" },
        ],
      }),
      commitment("commitment:mkt-commission", {
        initiator: "party:buyer",
        counterparty: "party:platform",
        parent: "commitment:mkt-1",
        requested: [moneyValue(5, "MAD", "value:mkt-commission")],
        state: S.accepted,
        history: [
          { from: S.draft, to: S.proposed, at: T.t0, actor: "party:buyer" },
          { from: S.proposed, to: S.accepted, at: T.t1, actor: "party:platform" },
        ],
      }),
    ],
    fulfillments: [],
  },
});

// A parent split into three children via largest-remainder allocation that sum
// EXACTLY to the parent (the allocate() guarantee) — I-6 clean.
add({
  id: "tree-parent-children-sum",
  kind: "scene",
  dir: "valid",
  expect: "accept",
  title: "Parent / child tree that sums exactly (allocate split)",
  doc: "A 100.00 MAD parent split into 33.34 + 33.33 + 33.33 (largest-remainder allocation). Children sum to exactly 100.00 — no cent is lost or gained — so I-6 holds.",
  payload: {
    parties: [buyer()],
    commitments: [
      commitment("commitment:tree-parent", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        requested: [moneyValue(100, "MAD", "value:tree-total")],
        state: S.draft,
        history: [],
        children: ["commitment:tree-c1", "commitment:tree-c2", "commitment:tree-c3"],
      }),
      commitment("commitment:tree-c1", { initiator: "party:buyer", counterparty: "party:seller", parent: "commitment:tree-parent", requested: [moneyValue(33.34, "MAD")], state: S.draft }),
      commitment("commitment:tree-c2", { initiator: "party:buyer", counterparty: "party:seller", parent: "commitment:tree-parent", requested: [moneyValue(33.33, "MAD")], state: S.draft }),
      commitment("commitment:tree-c3", { initiator: "party:buyer", counterparty: "party:seller", parent: "commitment:tree-parent", requested: [moneyValue(33.33, "MAD")], state: S.draft }),
    ],
    fulfillments: [],
  },
});

// BUG 3 regression (valid side): 0.1 + 0.2 children vs a 0.3 parent must NOT be
// falsely flagged by I-6 despite IEEE-754 (0.1 + 0.2 === 0.30000000000000004).
add({
  id: "tree-float-0.1-plus-0.2",
  kind: "scene",
  dir: "valid",
  expect: "accept",
  regression: "bug-3-i6-float-equality",
  title: "Float guard — 0.1 + 0.2 children vs 0.3 parent (I-6 must NOT fail)",
  doc: "Children of 0.10 MAD and 0.20 MAD reconcile against a 0.30 MAD parent. Exact float equality would falsely flag this (0.1 + 0.2 !== 0.3 in IEEE-754); the model compares within half a minor unit. Regression for BUG 3.",
  payload: {
    parties: [buyer()],
    commitments: [
      commitment("commitment:float-parent", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        requested: [moneyValue(0.3, "MAD", "value:float-total")],
        state: S.draft,
        history: [],
        children: ["commitment:float-c1", "commitment:float-c2"],
      }),
      commitment("commitment:float-c1", { initiator: "party:buyer", counterparty: "party:seller", parent: "commitment:float-parent", requested: [moneyValue(0.1, "MAD")], state: S.draft }),
      commitment("commitment:float-c2", { initiator: "party:buyer", counterparty: "party:seller", parent: "commitment:float-parent", requested: [moneyValue(0.2, "MAD")], state: S.draft }),
    ],
    fulfillments: [],
  },
});

// --- VALID: state catalog (every primitive, every state) -------------------

add({
  id: "catalog-commitment-states",
  kind: "state-catalog",
  dir: "valid",
  expect: "accept",
  title: "Every CommitmentState variant (all 11)",
  doc: "One structurally-valid instance of each of the 11 commitment states. Structural conformance only — no cross-object invariants.",
  payload: {
    primitive: "CommitmentState",
    instances: [
      { label: "Draft", value: S.draft },
      { label: "Proposed", value: S.proposed },
      { label: "Tendered", value: S.tendered },
      { label: "Accepted", value: S.accepted },
      { label: "Modified", value: S.modified },
      { label: "PartiallyFulfilled", value: S.partial },
      { label: "Active", value: S.active },
      { label: "Fulfilled", value: S.fulfilled },
      { label: "Cancelled", value: S.cancelled },
      { label: "Disputed", value: S.disputed },
      { label: "Refunded", value: S.refunded },
    ],
  },
});

add({
  id: "catalog-fulfillment-states",
  kind: "state-catalog",
  dir: "valid",
  expect: "accept",
  title: "Every FulfillmentState variant (all 5)",
  doc: "One structurally-valid instance of each of the 5 fulfillment states.",
  payload: {
    primitive: "FulfillmentState",
    instances: [
      { label: "Planned", value: { type: "Planned" } },
      { label: "InProgress", value: { type: "InProgress" } },
      { label: "Completed", value: { type: "Completed" } },
      { label: "Failed", value: { type: "Failed", reason: "carrier lost parcel", recoverable: true } },
      { label: "Reversed", value: { type: "Reversed", reason: "buyer refused", initiated_by: "party:seller", at: T.t3 } },
    ],
  },
});

add({
  id: "catalog-intent-states",
  kind: "state-catalog",
  dir: "valid",
  expect: "accept",
  title: "Every IntentState variant (all 4)",
  doc: "One structurally-valid instance of each of the 4 intent states.",
  payload: {
    primitive: "IntentState",
    instances: [
      { label: "Active", value: { type: "Active" } },
      { label: "Abandoned", value: { type: "Abandoned" } },
      { label: "Converted", value: { type: "Converted", commitment_id: "commitment:order-1" } },
      { label: "Expired", value: { type: "Expired" } },
    ],
  },
});

add({
  id: "catalog-value-states",
  kind: "state-catalog",
  dir: "valid",
  expect: "accept",
  title: "Every ValueState variant (all 8)",
  doc: "One structurally-valid instance of each of the 8 value states.",
  payload: {
    primitive: "ValueState",
    instances: [
      { label: "Available", value: { type: "Available" } },
      { label: "Reserved", value: { type: "Reserved", commitment_id: "commitment:order-1", basis: "PhysicalStock" } },
      { label: "UnderAuction", value: { type: "UnderAuction", auction_process_id: "auction:1", closes_at: T.future } },
      { label: "Committed", value: { type: "Committed", commitment_id: "commitment:order-1" } },
      { label: "InTransit", value: { type: "InTransit", fulfillment_id: "fulfillment:f-1" } },
      { label: "Transferred", value: { type: "Transferred", to: "party:buyer", at: T.t3 } },
      { label: "Returned", value: { type: "Returned", from: "party:buyer", initiated_at: T.t4 } },
      { label: "Retired", value: { type: "Retired", retired_at: T.t4, retired_by: "party:seller", reason: "carbon offset used" } },
    ],
  },
});

add({
  id: "catalog-value-forms",
  kind: "state-catalog",
  dir: "valid",
  expect: "accept",
  title: "Every ValueForm variant (all 6)",
  doc: "One structurally-valid instance of each of the 6 value forms (Primitive 2: Value).",
  payload: {
    primitive: "ValueForm",
    instances: [
      { label: "PhysicalGood", value: { kind: "PhysicalGood", sku: "SKU-1", condition: "New", location: "Casablanca" } },
      { label: "DigitalGood", value: { kind: "DigitalGood", identifier: "ebook-1", exclusivity: "NonExclusive", access_model: { kind: "Download", redownloadable: true } } },
      { label: "Service", value: { kind: "Service", identifier: "consult-1", delivery_model: { location: "Remote", performer: "party:seller" } } },
      { label: "Money", value: { kind: "Money", money: { amount: 100, currency: "MAD" } } },
      { label: "Nothing", value: { kind: "Nothing" } },
      { label: "ContingentValue", value: { kind: "ContingentValue", trigger_type: "FlightDelay", if_triggered_description: "payout 500 MAD", if_not_triggered_description: "Nothing" } },
    ],
  },
});

add({
  id: "catalog-party-types",
  kind: "state-catalog",
  dir: "valid",
  expect: "accept",
  title: "Every PartyType variant (all 3)",
  doc: "One structurally-valid instance of each of the 3 party types (Primitive 1: Party).",
  payload: {
    primitive: "Party",
    instances: [
      { label: "Individual", value: buyer(noCapacity) },
      { label: "Organization", value: seller() },
      { label: "System", value: platform() },
    ],
  },
});

// --- VALID: money round-trip (BUG 1 regression) ----------------------------

add({
  id: "money-roundtrip-minor-units",
  kind: "money-roundtrip",
  dir: "valid",
  expect: "accept",
  regression: "bug-1-tnd-three-decimal",
  title: "Minor-unit round-trip across 0/2/3-decimal currencies (TND 10x guard)",
  doc: "Decimal ↔ minor-unit conversion must use each currency's real precision: 3 decimals for TND/BHD (×1000), 0 for JPY (×1), 2 for USD/MAD (×100). Regression for BUG 1: TND was treated as two-decimal, making every TND amount 10× wrong.",
  payload: {
    cases: [
      { minor_amount: 1500, currency: "TND", decimal_amount: 1.5 },
      { minor_amount: 1500, currency: "BHD", decimal_amount: 1.5 },
      { minor_amount: 1500, currency: "JPY", decimal_amount: 1500 },
      { minor_amount: 1500, currency: "USD", decimal_amount: 15 },
      { minor_amount: 10000, currency: "MAD", decimal_amount: 100 },
    ],
  },
});

// --- VALID: MoneyBreakdown (schema v1.0.0 type; money_breakdown_sum rule) ---

// A total decomposed into labelled components that sum exactly to it (with a
// negative discount). The task's "MoneyBreakdown that sums correctly".
add({
  id: "money-breakdown-sums-correctly",
  kind: "money-breakdown",
  dir: "valid",
  expect: "accept",
  title: "MoneyBreakdown whose components sum to the total",
  doc: "Base 80 + Tax 16 + Shipping 10 − Discount 6 = 100.00 MAD. One currency throughout; the Discount component is negative; the components sum to the total within minor-unit tolerance (money_breakdown_sum, an expression of invariant I-1). MoneyComponent.kind uses the canonical enum (Base/Tax/Discount/Shipping/Surcharge/Tip/Adjustment).",
  payload: {
    total: { amount: 100, currency: "MAD" },
    components: [
      { kind: "Base", amount: { amount: 80, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 16, currency: "MAD" } },
      { kind: "Shipping", amount: { amount: 10, currency: "MAD" } },
      { kind: "Discount", amount: { amount: -6, currency: "MAD" } },
    ],
  },
});

// BUG 3 at the MoneyBreakdown level: 0.10 + 0.20 components vs a 0.30 total must
// reconcile within tolerance, not fail on IEEE-754 float drift.
add({
  id: "money-breakdown-float-tolerance",
  kind: "money-breakdown",
  dir: "valid",
  expect: "accept",
  regression: "bug-3-i6-float-equality",
  title: "MoneyBreakdown float tolerance — 0.10 + 0.20 = 0.30",
  doc: "Components of 0.10 and 0.20 MAD against a 0.30 MAD total. Exact float equality would falsely fail (0.1 + 0.2 !== 0.3); money_breakdown_sum compares within half a minor unit. Canonical enum kinds (Base + Adjustment).",
  payload: {
    total: { amount: 0.3, currency: "MAD" },
    components: [
      { kind: "Base", amount: { amount: 0.1, currency: "MAD" } },
      { kind: "Adjustment", amount: { amount: 0.2, currency: "MAD" } },
    ],
  },
});

// --- INVALID: MoneyBreakdown ----------------------------------------------

add({
  id: "money-breakdown-currency-mixed",
  kind: "money-breakdown",
  dir: "invalid",
  expect: "reject",
  rule: "money_breakdown_sum",
  ruleName: "MoneyBreakdown Sum (single-currency clause of I-1)",
  title: "Currency-mixed MoneyBreakdown",
  doc: "A MoneyBreakdown whose components mix MAD and EUR. The canonical money_breakdown_sum rule (an expression of invariant I-1) requires every component to share the total's currency; mixing currencies without explicit conversion is rejected.",
  payload: {
    total: { amount: 100, currency: "MAD" },
    components: [
      { kind: "Base", amount: { amount: 80, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 20, currency: "EUR" } },
    ],
  },
});

add({
  id: "money-breakdown-sum-mismatch",
  kind: "money-breakdown",
  dir: "invalid",
  expect: "reject",
  rule: "money_breakdown_sum",
  ruleName: "MoneyBreakdown Sum (sum clause of I-1)",
  title: "MoneyBreakdown components do not sum to total",
  doc: "Components sum to 96.00 MAD but the total claims 100.00 MAD — a 4.00 MAD discrepancy, far above minor-unit tolerance. The canonical money_breakdown_sum rule (an expression of invariant I-1) rejects it.",
  payload: {
    total: { amount: 100, currency: "MAD" },
    components: [
      { kind: "Base", amount: { amount: 80, currency: "MAD" } },
      { kind: "Tax", amount: { amount: 16, currency: "MAD" } },
    ],
  },
});

// --- INVALID: one per invariant -------------------------------------------

add({
  id: "i1-currency-mixed",
  kind: "scene",
  dir: "invalid",
  expect: "reject",
  rule: "I-1",
  ruleName: "Value Conservation",
  title: "Currency-mixed MoneyBreakdown",
  doc: "A commitment subject mixing MAD and EUR with no explicit conversion. Value Conservation (I-1) forbids implicit FX.",
  payload: {
    parties: [buyer()],
    commitments: [
      commitment("commitment:mixed-1", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        requested: [moneyValue(100, "MAD"), moneyValue(50, "EUR")],
        state: S.draft,
        history: [],
      }),
    ],
    fulfillments: [],
  },
});

add({
  id: "i2-backward-transition",
  kind: "scene",
  dir: "invalid",
  expect: "reject",
  rule: "I-2",
  ruleName: "State Monotonicity",
  title: "Backward transition recorded in history",
  doc: "A commitment whose history contains Fulfilled→Accepted — a backward move not in the model's 26-transition table. State Monotonicity (I-2) rejects it. (Initiator has can_buy so I-3 stays clean and the rejection is unambiguous.)",
  payload: {
    parties: [buyer()],
    commitments: [
      commitment("commitment:backward-1", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        requested: [moneyValue(100, "MAD")],
        state: S.accepted,
        history: [{ from: S.fulfilled, to: S.accepted, at: T.t0, actor: "party:buyer" }],
      }),
    ],
    fulfillments: [],
  },
});

add({
  id: "i3-accept-without-capacity",
  kind: "scene",
  dir: "invalid",
  expect: "reject",
  rule: "I-3",
  ruleName: "Capacity Verification",
  title: "Commitment Accepted without buyer capacity",
  doc: "A commitment reaches Accepted but its initiator's capacity has can_buy=false. Capacity Verification (I-3) requires verified capacity before acceptance.",
  payload: {
    parties: [buyer(noCapacity)],
    commitments: [
      commitment("commitment:nocap-1", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        requested: [moneyValue(100, "MAD")],
        state: S.accepted,
        history: [
          { from: S.draft, to: S.proposed, at: T.t0, actor: "party:buyer" },
          { from: S.proposed, to: S.accepted, at: T.t1, actor: "party:seller" },
        ],
      }),
    ],
    fulfillments: [],
  },
});

add({
  id: "i4-fulfillment-before-commitment",
  kind: "scene",
  dir: "invalid",
  expect: "reject",
  rule: "I-4",
  ruleName: "Temporal Integrity",
  title: "Fulfillment executing before commitment accepted",
  doc: "A Completed fulfillment whose commitment is only Proposed (never reached Accepted). Temporal Integrity (I-4): commitments form before fulfillments execute.",
  payload: {
    parties: [buyer()],
    commitments: [
      commitment("commitment:early-1", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        requested: [moneyValue(100, "MAD")],
        state: S.proposed,
        history: [{ from: S.draft, to: S.proposed, at: T.t0, actor: "party:buyer" }],
      }),
    ],
    fulfillments: [
      fulfillment("fulfillment:early-f", {
        commitment: "commitment:early-1",
        state: { type: "Completed" },
        history: [
          { from: { type: "Planned" }, to: { type: "InProgress" }, at: T.t1, actor: "party:seller" },
          { from: { type: "InProgress" }, to: { type: "Completed" }, at: T.t2, actor: "party:seller" },
        ],
        planned_at: T.t0,
        started_at: T.t1,
        completed_at: T.t2,
      }),
    ],
  },
});

add({
  id: "i4-empty-history-fulfilled",
  kind: "scene",
  dir: "invalid",
  expect: "reject",
  rule: "I-4",
  ruleName: "Temporal Integrity",
  regression: "bug-2-adapter-empty-history",
  title: "Fulfilled order with EMPTY history (pre-fix adapter output)",
  doc: "A Fulfilled commitment with an empty history and a Completed fulfillment. With no recorded Accepted transition the auditor cannot place fulfillment after commitment, so I-4 rejects it. This is exactly the un-synthesized adapter output BUG 2 fixed by replaying a real history (see valid/order-paid-fulfilled).",
  payload: {
    parties: [buyer()],
    commitments: [
      commitment("commitment:empty-1", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        requested: [moneyValue(100, "MAD")],
        state: S.fulfilled,
        history: [],
      }),
    ],
    fulfillments: [
      fulfillment("fulfillment:empty-f", {
        commitment: "commitment:empty-1",
        state: { type: "Completed" },
        history: [],
        planned_at: T.t0,
        started_at: T.t1,
        completed_at: T.t2,
      }),
    ],
  },
});

add({
  id: "i5-duplicate-id",
  kind: "scene",
  dir: "invalid",
  expect: "reject",
  rule: "I-5",
  ruleName: "Identity Permanence",
  title: "Duplicate commitment identifier",
  doc: "Two distinct commitments share the id commitment:dup. Identity Permanence (I-5): ids are globally unique and never reused.",
  payload: {
    parties: [buyer()],
    commitments: [
      commitment("commitment:dup", { initiator: "party:buyer", counterparty: "party:seller", requested: [moneyValue(100, "MAD")], state: S.draft }),
      commitment("commitment:dup", { initiator: "party:buyer", counterparty: "party:seller", requested: [moneyValue(50, "MAD")], state: S.draft }),
    ],
    fulfillments: [],
  },
});

add({
  id: "i6-children-exceed-parent",
  kind: "scene",
  dir: "invalid",
  expect: "reject",
  rule: "I-6",
  ruleName: "Commitment Tree Consistency",
  title: "Children sum exceeds parent",
  doc: "A 100.00 MAD parent split into 80.00 + 40.00 = 120.00 MAD children. Commitment Tree Consistency (I-6): child values must sum to the parent.",
  payload: {
    parties: [buyer()],
    commitments: [
      commitment("commitment:exceed-parent", {
        initiator: "party:buyer",
        counterparty: "party:seller",
        requested: [moneyValue(100, "MAD")],
        state: S.draft,
        children: ["commitment:exceed-c1", "commitment:exceed-c2"],
      }),
      commitment("commitment:exceed-c1", { initiator: "party:buyer", counterparty: "party:seller", parent: "commitment:exceed-parent", requested: [moneyValue(80, "MAD")], state: S.draft }),
      commitment("commitment:exceed-c2", { initiator: "party:buyer", counterparty: "party:seller", parent: "commitment:exceed-parent", requested: [moneyValue(40, "MAD")], state: S.draft }),
    ],
    fulfillments: [],
  },
});

// --- TRANSITIONS ----------------------------------------------------------

add({
  id: "commitment-happy-path",
  kind: "transition-sequence",
  dir: "transitions",
  expect: "accept", // sequence-level: all steps must match
  title: "Commitment lifecycle to Refunded, then a rejected backward move",
  doc: "Draft→Proposed→Accepted→PartiallyFulfilled→Fulfilled→Refunded (all valid), then Refunded→Accepted rejected (terminal, I-2).",
  payload: {
    primitive: "commitment",
    initial: S.draft,
    steps: [
      { to: S.proposed, expect: "accept" },
      { to: S.accepted, expect: "accept" },
      { to: S.partial, expect: "accept" },
      { to: S.fulfilled, expect: "accept" },
      { to: S.refunded, expect: "accept" },
      { to: S.accepted, expect: "reject", rule: "I-2" },
    ],
  },
});

add({
  id: "commitment-reject-backward",
  kind: "transition-sequence",
  dir: "transitions",
  expect: "accept",
  title: "Backward commitment transitions rejected; forward still allowed",
  doc: "From Fulfilled: →Accepted and →Draft are rejected (I-2); →Disputed is accepted (Fulfilled→Disputed is valid).",
  payload: {
    primitive: "commitment",
    initial: S.fulfilled,
    steps: [
      { to: S.accepted, expect: "reject", rule: "I-2" },
      { to: S.draft, expect: "reject", rule: "I-2" },
      { to: S.disputed, expect: "accept" },
    ],
  },
});

add({
  id: "intent-abandon",
  kind: "transition-sequence",
  dir: "transitions",
  expect: "accept",
  title: "Intent Active→Abandoned, then terminal rejection",
  doc: "Active→Abandoned is valid; Abandoned→Active is rejected (terminal, I-2).",
  payload: {
    primitive: "intent",
    initial: { type: "Active" },
    steps: [
      { to: { type: "Abandoned" }, expect: "accept" },
      { to: { type: "Active" }, expect: "reject", rule: "I-2" },
    ],
  },
});

add({
  id: "intent-convert",
  kind: "transition-sequence",
  dir: "transitions",
  expect: "accept",
  title: "Intent Active→Converted, then terminal rejection",
  doc: "Active→Converted is valid; Converted→Expired is rejected (terminal, I-2).",
  payload: {
    primitive: "intent",
    initial: { type: "Active" },
    steps: [
      { to: { type: "Converted", commitment_id: "commitment:order-1" }, expect: "accept" },
      { to: { type: "Expired" }, expect: "reject", rule: "I-2" },
    ],
  },
});

add({
  id: "fulfillment-failed-recoverable",
  kind: "transition-sequence",
  dir: "transitions",
  expect: "accept",
  title: "Failed (recoverable) → Planned retry → Completed",
  doc: "Planned→InProgress→Failed(recoverable:true)→Planned→InProgress→Completed. A recoverable failure may retry to Planned.",
  payload: {
    primitive: "fulfillment",
    initial: { type: "Planned" },
    steps: [
      { to: { type: "InProgress" }, expect: "accept" },
      { to: { type: "Failed", reason: "carrier delay", recoverable: true }, expect: "accept" },
      { to: { type: "Planned" }, expect: "accept" },
      { to: { type: "InProgress" }, expect: "accept" },
      { to: { type: "Completed" }, expect: "accept" },
    ],
  },
});

add({
  id: "fulfillment-failed-nonrecoverable",
  kind: "transition-sequence",
  dir: "transitions",
  expect: "accept",
  title: "Failed (non-recoverable) cannot retry to Planned",
  doc: "From Failed(recoverable:false): →Planned is rejected and →Reversed is rejected (Failed is terminal unless the failure was recoverable). I-2.",
  payload: {
    primitive: "fulfillment",
    initial: { type: "Failed", reason: "package destroyed", recoverable: false },
    steps: [
      { to: { type: "Planned" }, expect: "reject", rule: "I-2" },
      { to: { type: "Reversed", reason: "n/a", initiated_by: "party:seller", at: T.t3 }, expect: "reject", rule: "I-2" },
    ],
  },
});

// ===========================================================================
// CANONICAL CROSS-CHECK — assert @warp-lang/commerce-types agrees
// ===========================================================================

function canonicalSceneViolations(payload) {
  return auditCommerce(payload.commitments, payload.fulfillments, payload.parties).map((v) => v.invariant);
}

function canonicalMoneyEquals(a, b, currency) {
  const eps = 0.5 * Math.pow(10, -currencyDecimals(currency));
  return Math.abs(a - b) < eps;
}

// money_breakdown_sum (schema/behavior/invariants.json): single currency,
// discounts negative, components sum to total within minor-unit tolerance.
// Returns the rejecting rule, or null when the breakdown is valid.
// Canonical money_breakdown_sum (schema/behavior/invariants.json, expression of
// I-1): every component shares the total's currency AND the components sum to the
// total within minor-unit tolerance. (The canonical rule does NOT enforce a
// discount-sign convention — matching packages/.../money.py validate_money_breakdown.)
function canonicalBreakdownRule(b) {
  const currency = b.total.currency;
  for (const c of b.components) if (c.amount.currency !== currency) return "money_breakdown_sum";
  const sum = b.components.reduce((s, c) => s + c.amount.amount, 0);
  if (!canonicalMoneyEquals(sum, b.total.amount, currency)) return "money_breakdown_sum";
  return null;
}

function checkTransition(primitive, from, to) {
  if (primitive === "commitment") return isValidCommitmentTransition(from, to);
  if (primitive === "intent") return isValidIntentTransition(from, to);
  if (primitive === "fulfillment") return isValidFulfillmentTransition(from, to);
  throw new Error(`unknown primitive ${primitive}`);
}

let canonicalErrors = 0;
for (const f of fixtures) {
  if (f.kind === "scene") {
    const violations = canonicalSceneViolations(f.payload);
    if (f.expect === "accept") {
      if (violations.length !== 0) {
        console.error(`✗ CANONICAL DISAGREES: ${f.id} expected clean but got [${violations.join(", ")}]`);
        canonicalErrors++;
      }
    } else {
      if (!violations.includes(f.rule)) {
        console.error(`✗ CANONICAL DISAGREES: ${f.id} expected ${f.rule} but got [${violations.join(", ")}]`);
        canonicalErrors++;
      }
    }
  } else if (f.kind === "transition-sequence") {
    let cur = f.payload.initial;
    for (let i = 0; i < f.payload.steps.length; i++) {
      const step = f.payload.steps[i];
      const ok = checkTransition(f.payload.primitive, cur, step.to);
      const want = step.expect === "accept";
      if (ok !== want) {
        console.error(`✗ CANONICAL DISAGREES: ${f.id} step ${i} (${cur.type}→${step.to.type}) got ${ok}, expected ${want}`);
        canonicalErrors++;
      }
      if (ok) cur = step.to;
    }
  } else if (f.kind === "money-breakdown") {
    const rule = canonicalBreakdownRule(f.payload);
    if (f.expect === "accept") {
      if (rule !== null) {
        console.error(`✗ CANONICAL DISAGREES: ${f.id} expected clean but money_breakdown rule ${rule} fired`);
        canonicalErrors++;
      }
    } else if (rule !== f.rule) {
      console.error(`✗ CANONICAL DISAGREES: ${f.id} expected ${f.rule} but got ${rule}`);
      canonicalErrors++;
    }
  } else if (f.kind === "money-roundtrip") {
    for (const c of f.payload.cases) {
      const factor = Math.pow(10, currencyDecimals(c.currency));
      const decimal = c.minor_amount / factor;
      const back = Math.round(decimal * factor);
      if (decimal !== c.decimal_amount || back !== c.minor_amount) {
        console.error(`✗ CANONICAL DISAGREES: ${f.id} ${c.currency} ${c.minor_amount} → ${decimal} (expected ${c.decimal_amount})`);
        canonicalErrors++;
      }
    }
  }
}

if (canonicalErrors > 0) {
  console.error(`\n${canonicalErrors} canonical disagreement(s) — fixtures do NOT match the reference implementation. Aborting.`);
  process.exit(1);
}
console.log(`✓ canonical cross-check passed for ${fixtures.length} fixtures`);

// ===========================================================================
// WRITE FIXTURE FILES + SIDECARS + MANIFEST
// ===========================================================================

// Clean the fixture dirs (keep tooling/runner/schema/README/VERSION).
for (const d of ["valid", "invalid", "transitions"]) {
  const dir = join(ROOT, d);
  mkdirSync(dir, { recursive: true });
  for (const file of readdirSync(dir)) rmSync(join(dir, file));
}

const manifest = {
  schema: SCHEMA_VERSION,
  contract: "warp-conformance",
  generated_by: "conformance/tooling/build.mjs",
  fixtures: [],
};

function envelope(f) {
  const env = {
    fixture: f.id,
    schema: SCHEMA_VERSION,
    kind: f.kind,
    expect: f.expect,
    title: f.title,
    doc: f.doc,
  };
  if (f.rule) env.rule = f.rule;
  if (f.ruleName) env.rule_name = f.ruleName;
  if (f.regression) env.regression = f.regression;
  return { ...env, payload: f.payload };
}

for (const f of fixtures) {
  const file = `${f.id}.json`;
  const rel = `${f.dir}/${file}`;
  writeFileSync(join(ROOT, f.dir, file), JSON.stringify(envelope(f), null, 2) + "\n");

  const entry = {
    id: f.id,
    kind: f.kind,
    path: rel,
    expect: f.expect,
  };
  if (f.rule) {
    entry.rule = f.rule;
    entry.rule_name = f.ruleName;
  }
  if (f.regression) entry.regression = f.regression;

  // Invalid fixtures get a .expected.json sidecar naming the rejecting rule.
  if (f.dir === "invalid") {
    const sidecar = {
      fixture: f.id,
      expect: "reject",
      rule: f.rule,
      rule_name: f.ruleName,
      because: f.doc,
    };
    if (f.regression) sidecar.regression = f.regression;
    const sidecarRel = `${f.dir}/${f.id}.expected.json`;
    writeFileSync(join(ROOT, f.dir, `${f.id}.expected.json`), JSON.stringify(sidecar, null, 2) + "\n");
    entry.expected = sidecarRel;
  }

  manifest.fixtures.push(entry);
}

writeFileSync(join(ROOT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const counts = manifest.fixtures.reduce((m, e) => ((m[e.kind] = (m[e.kind] || 0) + 1), m), {});
console.log(`✓ wrote ${manifest.fixtures.length} fixtures + manifest.json`, counts);
