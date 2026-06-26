/**
 * conformance/case-studies/_generate.mjs — provenance generator for the
 * domain case-study corpus, re-pointed at the CANONICAL Warp Commerce Model
 * schema v1.0.0 (schema/structure/*.schema.json) and the canonical runner
 * (conformance/runner/run.mjs).
 *
 * Agent D's original corpus (PR #1) was authored against a bespoke minimal
 * schema and a standalone audit.mjs — both superseded and NOT used here. This
 * generator re-authors each domain as a canonical `scene` fixture
 * ({kind:"scene", payload:{parties, commitments, fulfillments}}) so the
 * existing canonical runner judges them. It also rewrites the case-study
 * manifest block in conformance/manifest.json (idempotent: it strips any
 * existing case-studies/* entries and re-appends).
 *
 * Each scene is authored to audit clean (I-1..I-6) AND to exercise the domain's
 * signature v0.3 construct THROUGH the canonical schema (CommitmentCondition,
 * PaymentTiming, DeliveryMethod, AccessModel, Evidence, CascadeCancellation,
 * VolumePricing, LoyaltyEarnTerm, ValueState::Retired, Tendered/auction). This
 * is the executable proof that the canonical schema expresses these domains —
 * refuting D's "pending-v1.1" flags, which were artifacts of D's minimal schema.
 *
 * Run:  node conformance/case-studies/_generate.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONF = join(HERE, "..");

// ---- timestamps (deterministic, monotonic) --------------------------------
const V = "2026-01-01T00:00:00.000Z"; // capacity verified
const t = (h) => `2026-03-10T${String(h).padStart(2, "0")}:00:00.000Z`;

// ---- party / value builders -----------------------------------------------
const FULLCAP = { can_buy: true, can_sell: true, can_fulfill: true, can_guarantee: true, verified_at: V };
const loc = (currency = "MAD", language = "fr-MA", jurisdiction = "MA") => ({ language, currency, jurisdiction });
const party = (id, party_type = "Individual", currency = "MAD") => ({
  id, party_type, locale: loc(currency), capacity: { ...FULLCAP },
});
const money = (amount, currency = "MAD") => ({ kind: "Money", money: { amount, currency } });
const moneyVal = (id, amount, currency = "MAD", state = { type: "Available" }) => ({
  id, form: money(amount, currency), quantity: 1, state,
});
const goodVal = (id, sku, { condition = "New", state = { type: "Available" } } = {}) => ({
  id, form: { kind: "PhysicalGood", sku, condition }, quantity: 1, state,
});
const digitalVal = (id, identifier, exclusivity, access_model, state = { type: "Available" }) => ({
  id, form: { kind: "DigitalGood", identifier, exclusivity, access_model }, quantity: 1, state,
});
const serviceVal = (id, identifier, delivery_model, state = { type: "Available" }) => ({
  id, form: { kind: "Service", identifier, delivery_model }, quantity: 1, state,
});

// ---- state constructors ----------------------------------------------------
const S = {
  draft: { type: "Draft" },
  proposed: { type: "Proposed" },
  accepted: { type: "Accepted" },
  active: { type: "Active" },
  fulfilled: { type: "Fulfilled" },
  tendered: (amount, currency, closes_at, superseded_by) => ({ type: "Tendered", offer_amount: amount, offer_currency: currency, closes_at, ...(superseded_by ? { superseded_by } : {}) }),
  modified: (by, reason) => ({ type: "Modified", modified_by: by, reason }),
  partially: (f, r) => ({ type: "PartiallyFulfilled", fulfilled_item_ids: f, remaining_item_ids: r }),
  cancelled: (by, reason, at) => ({ type: "Cancelled", by, reason, at }),
  disputed: (by, reason, opened_at) => ({ type: "Disputed", by, reason, opened_at }),
  refunded: (amount, currency, at) => ({ type: "Refunded", amount: { amount, currency }, at }),
};

// statesSeq: [{ state, at, actor }] ; index 0 is the initial state (created_at).
function commitment(id, parties, subject, statesSeq, opts = {}) {
  const history = [];
  for (let i = 1; i < statesSeq.length; i++) {
    history.push({ from: statesSeq[i - 1].state, to: statesSeq[i].state, at: statesSeq[i].at, actor: statesSeq[i].actor });
  }
  const c = {
    id, parties, subject,
    state: statesSeq[statesSeq.length - 1].state,
    history,
    children: opts.children || [],
    created_at: statesSeq[0].at,
  };
  if (opts.parent) c.parent = opts.parent;
  if (opts.originated_from) c.originated_from = opts.originated_from;
  if (opts.terms) c.terms = opts.terms;
  return c;
}
const parties = (initiator, counterparty, intermediaries = []) => ({ initiator, counterparty, intermediaries });
const subj = (offered, requested) => ({ offered, requested });

// fulfillment: stepsSeq [{state, at, actor}], index0 = Planned (planned_at)
function fulfillment(id, commitmentId, stepsSeq, evidence = []) {
  const history = [];
  for (let i = 1; i < stepsSeq.length; i++) {
    history.push({ from: stepsSeq[i - 1].state, to: stepsSeq[i].state, at: stepsSeq[i].at, actor: stepsSeq[i].actor });
  }
  const f = { id, commitment: commitmentId, state: stepsSeq[stepsSeq.length - 1].state, history, planned_at: stepsSeq[0].at };
  const started = stepsSeq.find((s) => s.state.type === "InProgress");
  const done = stepsSeq.find((s) => s.state.type === "Completed");
  if (started) f.started_at = started.at;
  if (done) f.completed_at = done.at;
  if (evidence.length) f.evidence = evidence;
  return f;
}
const FS = { planned: { type: "Planned" }, inprogress: { type: "InProgress" }, completed: { type: "Completed" }, failed: (reason, recoverable) => ({ type: "Failed", reason, recoverable }), reversed: (reason, by, at) => ({ type: "Reversed", reason, initiated_by: by, at }) };

// Common life-cycle helpers ------------------------------------------------
// A commitment that goes Draft→Proposed→Accepted→PartiallyFulfilled→Fulfilled.
const lifeFulfilled = (initActor, cpActor) => [
  { state: S.draft, at: t(8), actor: initActor },
  { state: S.proposed, at: t(9), actor: initActor },
  { state: S.accepted, at: t(10), actor: cpActor },
  { state: S.partially(["pay"], ["good"]), at: t(11), actor: cpActor },
  { state: S.fulfilled, at: t(12), actor: cpActor },
];
const lifeAccepted = (initActor, cpActor) => [
  { state: S.draft, at: t(8), actor: initActor },
  { state: S.proposed, at: t(9), actor: initActor },
  { state: S.accepted, at: t(10), actor: cpActor },
];
const lifeActive = (initActor, cpActor) => [
  { state: S.draft, at: t(8), actor: initActor },
  { state: S.proposed, at: t(9), actor: initActor },
  { state: S.accepted, at: t(10), actor: cpActor },
  { state: S.active, at: t(11), actor: cpActor },
];
// payment + delivery fulfillments completed after acceptance (I-4 safe).
// `h` = {p:plan, s:start, c:complete} hours, defaulted for the common
// early-accept case; late-accept domains (auctions, thresholds) pass later hours.
const payFul = (id, cid, payer, payee, ref, amt, cur = "MAD", h = { p: 10, s: 11, c: 11 }) => fulfillment(id, cid, [
  { state: FS.planned, at: t(h.p), actor: payer }, { state: FS.inprogress, at: t(h.s), actor: payer }, { state: FS.completed, at: t(h.c), actor: payee },
], [{ kind: "PaymentReceipt", reference: ref, amount: { amount: amt, currency: cur }, timestamp: t(h.c), mechanism: "card" }]);
const delFul = (id, cid, by, recipient, h = { p: 10, s: 11, c: 12 }) => fulfillment(id, cid, [
  { state: FS.planned, at: t(h.p), actor: by }, { state: FS.inprogress, at: t(h.s), actor: by }, { state: FS.completed, at: t(h.c), actor: by },
], [{ kind: "ProofOfDelivery", timestamp: t(h.c), recipient, signature: "sig" }]);

// ===========================================================================
// Domains
// ===========================================================================
const D = {};

// 1. physical e-commerce — order Fulfilled + a return as a NEW role-reversed commitment.
D["physical-ecommerce"] = () => {
  const buyer = party("party:amina"), seller = party("party:marjane", "Organization");
  const order = commitment("commitment:ord-1", parties(buyer.id, seller.id),
    subj([goodVal("value:kettle", "SKU-KETTLE-2L")], [moneyVal("value:ord-total", 349)]),
    lifeFulfilled(buyer.id, seller.id), { originated_from: "intent:cart-1" });
  // return = new forward commitment, parties' value flow reversed; original untouched.
  const ret = commitment("commitment:ret-1", parties(buyer.id, seller.id),
    subj([goodVal("value:kettle-back", "SKU-KETTLE-2L", { condition: "Used" })], [moneyVal("value:refund-total", 349)]),
    [
      { state: S.draft, at: t(13), actor: buyer.id }, { state: S.proposed, at: t(14), actor: buyer.id },
      { state: S.accepted, at: t(15), actor: seller.id }, { state: S.partially(["good"], ["pay"]), at: t(16), actor: buyer.id },
      { state: S.fulfilled, at: t(17), actor: seller.id },
    ]);
  return {
    title: "1P order fulfilled, then a return as a new role-reversed Commitment",
    doc: "Order paid + delivered (Fulfilled). The return is a NEW forward Commitment (Invariant 2) — the original ord-1 is never moved backward. No v0.3 construct; pure five-primitive base.",
    parties: [buyer, seller],
    commitments: [order, ret],
    fulfillments: [payFul("fulfillment:pay-1", order.id, buyer.id, seller.id, "rcpt-1", 349), delFul("fulfillment:del-1", order.id, seller.id, buyer.id),
      fulfillment("fulfillment:refund-1", ret.id, [{ state: FS.planned, at: t(15), actor: seller.id }, { state: FS.inprogress, at: t(16), actor: seller.id }, { state: FS.completed, at: t(17), actor: seller.id }], [{ kind: "PaymentReceipt", reference: "refund-1", amount: { amount: 349, currency: "MAD" }, timestamp: t(17), mechanism: "card_reversal" }])],
  };
};

// 2. gifting — parent + 3 children tree (I-6 sum). One child PartiallyFulfilled (ResolutionProcess documented).
D["gifting"] = () => {
  const buyer = party("party:gifter"), v1 = party("party:vendor1", "Organization"), v2 = party("party:vendor2", "Organization");
  const child = (n, vendor, amt, last) => commitment(`commitment:gift-${n}`, parties(buyer.id, vendor),
    subj([goodVal(`value:gift-${n}`, `SKU-GIFT-${n}`)], [moneyVal(`value:gift-${n}-amt`, amt)]),
    last === "partial"
      ? [{ state: S.draft, at: t(8), actor: buyer.id }, { state: S.proposed, at: t(9), actor: buyer.id }, { state: S.accepted, at: t(10), actor: vendor }, { state: S.partially([], [`g${n}`]), at: t(11), actor: vendor }]
      : lifeFulfilled(buyer.id, vendor),
    { parent: "commitment:gift-parent" });
  const c1 = child(1, v1.id, 200, "full"), c2 = child(2, v2.id, 300, "partial"), c3 = child(3, v1.id, 150, "full");
  const parent = commitment("commitment:gift-parent", parties(buyer.id, v1.id),
    subj([], [moneyVal("value:gift-total", 650)]), lifeAccepted(buyer.id, v1.id),
    { children: [c1.id, c2.id, c3.id], originated_from: "intent:multi-gift" });
  return {
    title: "Multi-recipient gift: one parent Commitment, three children (tree sum, I-6)",
    doc: "One Intent → one parent Commitment with three child Commitments to different recipients/vendors. Children's requested money (200+300+150) sums exactly to the parent's 650 MAD (Invariant 6). Child 2 hits a stock failure → PartiallyFulfilled; its ResolutionProcess (substitute) is an auxiliary record validated by conformance/case-studies/validate-aux.mjs, documented in gifting.md.",
    parties: [buyer, v1, v2], commitments: [parent, c1, c2, c3],
    fulfillments: [payFul("fulfillment:gift-1-pay", c1.id, buyer.id, v1.id, "g1", 200), delFul("fulfillment:gift-1-del", c1.id, v1.id, buyer.id)],
  };
};

// 3. POS — InPersonHandover + StaffDiscount condition + split payment (loyalty+card+cash).
D["pos"] = () => {
  const cust = party("party:pos-cust"), store = party("party:pos-store", "Organization");
  const sale = commitment("commitment:sale-1", parties(cust.id, store.id),
    subj([goodVal("value:sku-shoe", "SKU-SHOE-42")], [moneyVal("value:sale-total", 480)]),
    lifeFulfilled(cust.id, store.id),
    { terms: {
      delivery: { method: { kind: "InPersonHandover", location: "Casablanca — Anfa store", staff_id: store.id } },
      payment: { timing: { type: "Immediate" }, split: [
        { method: "loyalty_points", amount: { amount: 80, currency: "PTS" }, reference: "pts-redeem" },
        { method: "card", amount: { amount: 300, currency: "MAD" } },
        { method: "cash", amount: { amount: 100, currency: "MAD" } },
      ] },
      conditions: [{ kind: "StaffDiscount", rate: 0.1 }],
    } });
  return {
    title: "Counter sale: in-person handover, staff discount, split tender",
    doc: "POS sale with DeliveryMethod::InPersonHandover, a StaffDiscount CommitmentCondition, and a three-way split payment (loyalty points + card + cash) on PaymentTerms.split. All canonical v1.0.0 constructs.",
    parties: [cust, store], commitments: [sale],
    fulfillments: [payFul("fulfillment:sale-pay", sale.id, cust.id, store.id, "pos-1", 400), delFul("fulfillment:sale-hand", sale.id, store.id, cust.id)],
  };
};

// 4. services — subscription Active + NoShowPolicy + GracePeriod + ServicePerformance.
D["services"] = () => {
  const client = party("party:client"), spa = party("party:spa", "Organization");
  const appt = commitment("commitment:appt-1", parties(client.id, spa.id),
    subj([serviceVal("value:massage", "SVC-MASSAGE-60", { location: "Physical", performer: spa.id })], [moneyVal("value:appt-fee", 400)]),
    lifeFulfilled(client.id, spa.id),
    { terms: {
      delivery: { method: { kind: "ServicePerformance", performer: spa.id, location: "Spa Maarif", scheduled_at: t(11), duration_minutes: 60 } },
      payment: { timing: { type: "OnServiceCompletion" } },
      conditions: [{ kind: "NoShowPolicy", grace_minutes: 15, fee: { amount: 100, currency: "MAD" } }],
    } });
  const sub = commitment("commitment:sub-1", parties(client.id, spa.id),
    subj([serviceVal("value:gym", "SVC-GYM-MONTHLY", { location: "Physical" })], [moneyVal("value:sub-fee", 300)]),
    lifeActive(client.id, spa.id),
    { terms: { payment: { timing: { type: "Recurring" } }, conditions: [{ kind: "GracePeriod", duration_days: 7, if_not_restored: "Cancelled" }] } });
  return {
    title: "Appointment (no-show policy) + ongoing subscription (Active) with grace period",
    doc: "ServicePerformance delivery, NoShowPolicy + GracePeriod CommitmentConditions, and a subscription that goes Accepted→Active and stays Active (never Fulfilled). Failed-payment retry recoverability is exercised by the canonical transition fixtures.",
    parties: [client, spa], commitments: [appt, sub],
    fulfillments: [fulfillment("fulfillment:massage", appt.id, [{ state: FS.planned, at: t(10), actor: spa.id }, { state: FS.inprogress, at: t(11), actor: spa.id }, { state: FS.completed, at: t(12), actor: spa.id }], [{ kind: "ServiceCompletion", confirmed_by: client.id, timestamp: t(12), notes: "60-min massage delivered" }])],
  };
};

// 5. BNPL — Installments payment timing; purchase parent + financing child (I-6 sum equal).
D["bnpl"] = () => {
  const buyer = party("party:bnpl-buyer"), shop = party("party:bnpl-shop", "Organization"), fin = party("party:bnpl-provider", "Organization");
  const purchase = commitment("commitment:bnpl-purchase", parties(buyer.id, shop.id, [fin.id]),
    subj([goodVal("value:laptop", "SKU-LAPTOP")], [moneyVal("value:bnpl-price", 2400)]),
    lifeFulfilled(buyer.id, shop.id), { children: ["commitment:bnpl-financing"] });
  const financing = commitment("commitment:bnpl-financing", parties(buyer.id, fin.id),
    subj([], [moneyVal("value:bnpl-repay", 2400)]),
    lifeActive(buyer.id, fin.id),
    { parent: "commitment:bnpl-purchase", terms: { payment: { timing: { type: "Installments" } } } });
  return {
    title: "BNPL: purchase fulfilled, financing child carries the installment schedule",
    doc: "Purchase Commitment (buyer↔shop, BNPL provider as intermediary) with a financing child (buyer↔provider) on PaymentTiming::Installments. The financing principal (2400) equals the parent price (2400) — I-6 holds. Interest/schedule detail is prose (the model carries the timing kind, not the amortization table).",
    parties: [buyer, shop, fin], commitments: [purchase, financing],
    fulfillments: [payFul("fulfillment:bnpl-settle", purchase.id, fin.id, shop.id, "bnpl-settle", 2400), delFul("fulfillment:bnpl-del", purchase.id, shop.id, buyer.id),
      fulfillment("fulfillment:bnpl-inst1", financing.id, [{ state: FS.planned, at: t(11), actor: buyer.id }, { state: FS.inprogress, at: t(12), actor: buyer.id }, { state: FS.completed, at: t(13), actor: fin.id }], [{ kind: "PaymentReceipt", reference: "inst-1", amount: { amount: 630, currency: "MAD" }, timestamp: t(13), mechanism: "direct_debit" }])],
  };
};

// 6. escrow — AfterGoodsReceived timing; guarantor intermediary.
D["escrow"] = () => {
  const buyer = party("party:esc-buyer"), seller = party("party:esc-seller", "Organization"), agent = party("party:escrow-agent", "Organization");
  const c = commitment("commitment:escrow-1", parties(buyer.id, seller.id, [agent.id]),
    subj([goodVal("value:esc-good", "SKU-MACHINE")], [moneyVal("value:esc-amt", 3200)]),
    lifeFulfilled(buyer.id, seller.id),
    { terms: { payment: { timing: { type: "AfterGoodsReceived" } } } });
  return {
    title: "Three-party escrow: funds released to seller only after goods received",
    doc: "Escrow agent is a Guarantor in intermediaries (can_guarantee). PaymentTiming::AfterGoodsReceived gates release. Pay-in, delivery, and release are Fulfillments; value conservation (3200 in = 3200 released) holds.",
    parties: [buyer, seller, agent], commitments: [c],
    fulfillments: [payFul("fulfillment:esc-payin", c.id, buyer.id, agent.id, "esc-in", 3200), delFul("fulfillment:esc-del", c.id, seller.id, buyer.id),
      fulfillment("fulfillment:esc-release", c.id, [{ state: FS.planned, at: t(11), actor: agent.id }, { state: FS.inprogress, at: t(12), actor: agent.id }, { state: FS.completed, at: t(12), actor: agent.id }], [{ kind: "PaymentReceipt", reference: "esc-rel", amount: { amount: 3200, currency: "MAD" }, timestamp: t(12), mechanism: "escrow_release" }])],
  };
};

// 7. FX — two INDEPENDENT single-currency commitments (avoids I-1 mixing) + Simultaneous + currency_conversion.
D["fx"] = () => {
  const cust = party("party:fx-cust"), bureau = party("party:fx-bureau", "Organization", "EUR");
  const conv = { from: "MAD", to: "EUR", rate: 11, customer_pays: { amount: 11000, currency: "MAD" } };
  const legMad = commitment("commitment:fx-mad", parties(cust.id, bureau.id),
    subj([], [moneyVal("value:fx-mad", 11000, "MAD")]), lifeFulfilled(cust.id, bureau.id),
    { terms: { payment: { timing: { type: "Simultaneous" }, currency_conversion: conv } } });
  const legEur = commitment("commitment:fx-eur", parties(bureau.id, cust.id),
    subj([], [moneyVal("value:fx-eur", 1000, "EUR")]), lifeFulfilled(bureau.id, cust.id),
    { terms: { payment: { timing: { type: "Simultaneous" }, currency_conversion: conv } } });
  return {
    title: "Currency exchange: two single-currency legs settled simultaneously",
    doc: "MAD↔EUR swap modelled as TWO independent single-currency Commitments — the model never sums MAD and EUR in one subject (the canonical I-1 no_currency_mixing rule rejects a mixed-currency subject, so the two currencies live in two Commitments). PaymentTiming::Simultaneous + PaymentTerms.currency_conversion carry the swap semantics.",
    parties: [cust, bureau], commitments: [legMad, legEur],
    fulfillments: [payFul("fulfillment:fx-mad-leg", legMad.id, cust.id, bureau.id, "fx-mad", 11000, "MAD"), payFul("fulfillment:fx-eur-leg", legEur.id, bureau.id, cust.id, "fx-eur", 1000, "EUR")],
  };
};

// 8. SaaS — DigitalGood NonExclusive License + DigitalDelivery + AccessGrant evidence.
D["saas"] = () => {
  const org = party("party:saas-org", "Organization"), vendor = party("party:saas-vendor", "Organization");
  const lic = digitalVal("value:license", "WARP-PRO-LICENSE", "NonExclusive", { kind: "License", license_type: "Perpetual", seats: 5, transferable: false }, { type: "Transferred", to: org.id, at: t(12) });
  const c = commitment("commitment:saas-1", parties(org.id, vendor.id),
    subj([lic], [moneyVal("value:saas-fee", 12000)]), lifeFulfilled(org.id, vendor.id),
    { terms: { delivery: { method: { kind: "DigitalDelivery", mechanism: "license_key", delivered_at: t(12), access_token: "KEY-XYZ" } }, payment: { timing: { type: "Upfront" } } } });
  return {
    title: "Perpetual seat-limited software license (non-exclusive digital good)",
    doc: "DigitalGood with exclusivity NonExclusive and AccessModel::License (Perpetual, 5 seats). Conservation (I-1) applies to access rights, not units — the provider keeps its copy. DigitalDelivery + AccessGrant evidence.",
    parties: [org, vendor], commitments: [c],
    fulfillments: [payFul("fulfillment:saas-pay", c.id, org.id, vendor.id, "saas-1", 12000),
      fulfillment("fulfillment:saas-grant", c.id, [{ state: FS.planned, at: t(11), actor: vendor.id }, { state: FS.inprogress, at: t(11), actor: vendor.id }, { state: FS.completed, at: t(12), actor: vendor.id }], [{ kind: "AccessGrant", token: "KEY-XYZ", granted_at: t(12) }])],
  };
};

// 9. streaming — subscription Active + DigitalGood Stream + GracePeriod. (Access-suspension ValueState is a v1.1 gap.)
D["streaming"] = () => {
  const sub = party("party:stream-sub"), svc = party("party:stream-svc", "Organization");
  const stream = digitalVal("value:stream", "STREAM-PLAN", "NonExclusive", { kind: "Stream", simultaneous_streams: 2 });
  const c = commitment("commitment:stream-1", parties(sub.id, svc.id),
    subj([stream], [moneyVal("value:stream-fee", 79)]), lifeActive(sub.id, svc.id),
    { terms: { payment: { timing: { type: "Recurring" } }, conditions: [{ kind: "GracePeriod", duration_days: 5, if_not_restored: "Cancelled" }] } });
  return {
    title: "Streaming subscription (Active) with a payment grace period",
    doc: "AccessModel::Stream, subscription Active, GracePeriod condition. NOTE: a failed-payment access SUSPENSION is modelled at the Commitment level (GracePeriod) — canonical ValueState has no AccessSuspended/Revoked/Expired variants (a genuine v1.1 gap, see BACKLOG B-2).",
    parties: [sub, svc], commitments: [c],
    fulfillments: [payFul("fulfillment:stream-m1", c.id, sub.id, svc.id, "stream-m1", 79)],
  };
};

// 10. API metering — DigitalGood APIAccess + Metered; plan(Active) + sibling overage(Fulfilled). EntitlementConsumption documented.
D["api-metering"] = () => {
  const dev = party("party:dev", "Organization"), api = party("party:api-co", "Organization", "USD");
  const access = digitalVal("value:api", "API-PLAN", "NonExclusive", { kind: "APIAccess", calls_per_period: 100000, endpoint: "https://api.example.com/v1" });
  const plan = commitment("commitment:api-plan", parties(dev.id, api.id),
    subj([access], [moneyVal("value:api-fee", 100, "USD")]), lifeActive(dev.id, api.id),
    { terms: { payment: { timing: { type: "Metered" } } } });
  const overage = commitment("commitment:api-overage", parties(dev.id, api.id),
    subj([], [moneyVal("value:api-over", 35, "USD")]), lifeFulfilled(dev.id, api.id),
    { terms: { payment: { timing: { type: "Metered" } } } });
  return {
    title: "Metered API plan with an auto-created overage Commitment",
    doc: "AccessModel::APIAccess + PaymentTiming::Metered. The plan is Active; an overage Commitment is created (sibling, not child — overage ≠ plan fee, so they are not an I-6 tree). Per-call EntitlementConsumption is an auxiliary record (validated by conformance/case-studies/validate-aux.mjs, documented in api-metering.md) — a Fulfillment-per-call would be architecturally wrong.",
    parties: [dev, api], commitments: [plan, overage],
    fulfillments: [payFul("fulfillment:api-fee", plan.id, dev.id, api.id, "api-fee", 100, "USD"), payFul("fulfillment:api-over", overage.id, dev.id, api.id, "api-over", 35, "USD")],
  };
};

// 11. NFT — DigitalGood Exclusive NFT, transfer (Transferred), RoyaltyDistribution condition on resale + sibling royalty payment.
D["nft"] = () => {
  const artist = party("party:artist"), a = party("party:collector-a"), b = party("party:collector-b");
  const nftVal = (state) => digitalVal("value:nft", "TOKEN-4419", "Exclusive", { kind: "NFT", blockchain: "Ethereum", contract_address: "0xABC", token_id: "4419" }, state);
  const primary = commitment("commitment:nft-primary", parties(a.id, artist.id),
    subj([nftVal({ type: "Transferred", to: a.id, at: t(12) })], [moneyVal("value:nft-p", 500, "USD")]), lifeFulfilled(a.id, artist.id));
  const resale = commitment("commitment:nft-resale", parties(b.id, a.id),
    subj([nftVal({ type: "Transferred", to: b.id, at: t(16) })], [moneyVal("value:nft-r", 800, "USD")]),
    [{ state: S.draft, at: t(13), actor: b.id }, { state: S.proposed, at: t(14), actor: b.id }, { state: S.accepted, at: t(15), actor: a.id }, { state: S.partially(["pay"], ["nft"]), at: t(16), actor: a.id }, { state: S.fulfilled, at: t(17), actor: a.id }],
    { terms: { conditions: [{ kind: "RoyaltyDistribution", beneficiaries: [{ to: artist.id, rate: 0.1 }] }] } });
  const royalty = commitment("commitment:nft-royalty", parties(a.id, artist.id),
    subj([], [moneyVal("value:nft-roy", 80, "USD")]), lifeFulfilled(a.id, artist.id));
  return {
    title: "NFT primary sale + resale with artist royalty (exclusive digital good)",
    doc: "DigitalGood exclusivity Exclusive (transfer means the originator loses it — conservation like a physical good). Resale carries a RoyaltyDistribution condition; the 80 USD royalty (10% of 800) is a sibling Commitment paid to the artist.",
    parties: [artist, a, b], commitments: [primary, resale, royalty],
    fulfillments: [payFul("fulfillment:nft-p-pay", primary.id, a.id, artist.id, "nft-p", 500, "USD"), payFul("fulfillment:nft-roy-pay", royalty.id, a.id, artist.id, "nft-roy", 80, "USD")],
  };
};

// 12. auction family — Tendered bids (winner→Accepted→Fulfilled, loser→Cancelled). AuctionProcess auxiliary documented.
D["auction-family"] = () => {
  const seller = party("party:auc-seller", "Organization"), a = party("party:bidder-a"), bb = party("party:bidder-b");
  const item = (state) => goodVal("value:painting", "ART-PAINTING", { state });
  const closes = t(20);
  const winner = commitment("commitment:bid-b", parties(bb.id, seller.id),
    subj([item({ type: "Transferred", to: bb.id, at: t(21) })], [moneyVal("value:bid-b-amt", 12000)]),
    [{ state: S.draft, at: t(8), actor: bb.id }, { state: S.tendered(12000, "MAD", closes), at: t(9), actor: bb.id }, { state: S.accepted, at: t(20), actor: seller.id }, { state: S.partially(["pay"], ["art"]), at: t(21), actor: seller.id }, { state: S.fulfilled, at: t(22), actor: seller.id }]);
  const loser = commitment("commitment:bid-a", parties(a.id, seller.id),
    subj([item({ type: "Available" })], [moneyVal("value:bid-a-amt", 10000)]),
    [{ state: S.draft, at: t(8), actor: a.id }, { state: S.tendered(10000, "MAD", closes, "commitment:bid-b"), at: t(9), actor: a.id }, { state: S.cancelled(seller.id, "Outbid", t(20)), at: t(20), actor: seller.id }]);
  return {
    title: "English auction: competing Tendered bids; winner Accepted, loser Cancelled",
    doc: "Two Tendered Commitments. Bidder A is outbid (superseded_by → winner) and goes Tendered→Cancelled; Bidder B wins Tendered→Accepted→…→Fulfilled. The coordinating AuctionProcess (mechanism English/Dutch/SealedBid/Vickrey/ScoredSelection) is an auxiliary record validated by conformance/case-studies/validate-aux.mjs, documented in auction-family.md.",
    parties: [seller, a, bb], commitments: [winner, loser],
    fulfillments: [payFul("fulfillment:auc-pay", winner.id, bb.id, seller.id, "auc", 12000, "MAD", { p: 20, s: 21, c: 21 }), delFul("fulfillment:auc-del", winner.id, seller.id, bb.id, { p: 20, s: 21, c: 22 })],
  };
};

// 13. real estate — FinancingContingency + InspectionContingency, TitleTransfer, RegistryRecording evidence + a contingency-failure commitment.
D["real-estate"] = () => {
  const buyer = party("party:re-buyer"), seller = party("party:re-seller", "Organization"), notary = party("party:notary", "Organization"), lender = party("party:lender", "Organization");
  const conds = [
    { kind: "FinancingContingency", lender: lender.id, amount: { amount: 1500000, currency: "MAD" }, approval_deadline: t(15), if_not_met: "Cancelled" },
    { kind: "InspectionContingency", inspector: notary.id, deadline: t(14), if_failed: "Cancelled" },
  ];
  const happy = commitment("commitment:re-happy", parties(buyer.id, seller.id, [notary.id, lender.id]),
    subj([goodVal("value:villa", "PROP-VILLA-1")], [moneyVal("value:re-price", 2000000)]),
    lifeFulfilled(buyer.id, seller.id),
    { terms: { delivery: { method: { kind: "TitleTransfer", mechanism: "NotarialDeed", registry: "Conservation Foncière Casablanca", title_number: "CF-12345", notary: notary.id } }, payment: { timing: { type: "Upfront" } }, conditions: conds } });
  const failed = commitment("commitment:re-failed", parties(buyer.id, seller.id, [lender.id]),
    subj([goodVal("value:apt", "PROP-APT-9")], [moneyVal("value:re-price-2", 900000)]),
    [{ state: S.draft, at: t(8), actor: buyer.id }, { state: S.proposed, at: t(9), actor: buyer.id }, { state: S.accepted, at: t(10), actor: seller.id }, { state: S.cancelled(buyer.id, "financing contingency not met", t(15)), at: t(15), actor: buyer.id }],
    { terms: { conditions: [conds[0]] } });
  return {
    title: "Property purchase with financing + inspection contingencies; title transfer",
    doc: "FinancingContingency + InspectionContingency CommitmentConditions, DeliveryMethod::TitleTransfer (NotarialDeed), RegistryRecording Evidence. Second Commitment shows the contingency-failure exit: Accepted→Cancelled with deposit handling in prose.",
    parties: [buyer, seller, notary, lender], commitments: [happy, failed],
    fulfillments: [payFul("fulfillment:re-pay", happy.id, buyer.id, seller.id, "re-1", 2000000),
      fulfillment("fulfillment:re-title", happy.id, [{ state: FS.planned, at: t(11), actor: notary.id }, { state: FS.inprogress, at: t(11), actor: notary.id }, { state: FS.completed, at: t(12), actor: notary.id }], [{ kind: "RegistryRecording", registry: "Conservation Foncière Casablanca", reference: "CF-12345", recorded_at: t(12), notary: "notary office" }])],
  };
};

// 14. healthcare — PostFulfillment(InsuranceAdjudication), PrescriptionRequired + NoReturnPolicy, split copay+insurer, MedicalRecord, price finalize via Modified.
D["healthcare"] = () => {
  const patient = party("party:patient"), clinic = party("party:clinic", "Organization"), insurer = party("party:insurer", "Organization");
  const visit = commitment("commitment:visit-1", parties(patient.id, clinic.id, [insurer.id]),
    subj([serviceVal("value:consult", "SVC-CONSULT", { location: "Physical", performer: clinic.id })], [moneyVal("value:visit-fee", 800)]),
    [{ state: S.draft, at: t(8), actor: patient.id }, { state: S.proposed, at: t(9), actor: patient.id }, { state: S.accepted, at: t(10), actor: clinic.id }, { state: S.partially([], ["fee"]), at: t(11), actor: clinic.id }, { state: S.modified(insurer.id, "price finalized after insurer adjudication"), at: t(12), actor: insurer.id }, { state: S.accepted, at: t(13), actor: patient.id }, { state: S.partially(["copay"], ["insurer"]), at: t(14), actor: clinic.id }, { state: S.fulfilled, at: t(15), actor: clinic.id }],
    { terms: {
      payment: { timing: { type: "PostFulfillment", trigger: { type: "InsuranceAdjudication", adjudicator: insurer.id, claim_reference: "CLM-1", deadline: t(13) } }, split: [{ method: "copay", amount: { amount: 200, currency: "MAD" } }, { method: "insurer", amount: { amount: 600, currency: "MAD" } }] },
      conditions: [{ kind: "PrescriptionRequired", must_verify_before: "Fulfilled", verified_by: clinic.id }, { kind: "NoReturnPolicy", basis: "medical service rendered", jurisdiction: "MA" }],
    } });
  return {
    title: "Insured visit: price finalized after adjudication, split copay + insurer",
    doc: "PaymentTiming::PostFulfillment(InsuranceAdjudication) — the price is finalized AFTER the service (modelled via a Modified transition), opposite of upfront. Split payment (copay + insurer). PrescriptionRequired + NoReturnPolicy conditions; MedicalRecord evidence. All canonical v1.0.0.",
    parties: [patient, clinic, insurer], commitments: [visit],
    fulfillments: [fulfillment("fulfillment:visit-svc", visit.id, [{ state: FS.planned, at: t(10), actor: clinic.id }, { state: FS.inprogress, at: t(11), actor: clinic.id }, { state: FS.completed, at: t(11), actor: clinic.id }], [{ kind: "MedicalRecord", reference: "MR-1", issued_by: "clinic", patient: "patient", service_date: t(11) }]),
      payFul("fulfillment:visit-copay", visit.id, patient.id, clinic.id, "copay", 200), payFul("fulfillment:visit-insurer", visit.id, insurer.id, clinic.id, "insurer", 600)],
  };
};

// 15. government procurement — Tendered bids + ScoredSelection (auxiliary), ComplianceDocumentation, AwardProtest (auxiliary).
D["government-procurement"] = () => {
  const ministry = party("party:ministry", "Organization"), sa = party("party:supplier-a", "Organization"), sc = party("party:supplier-c", "Organization");
  const closes = t(18);
  const comply = { kind: "ComplianceDocumentation", required_documents: ["tax_clearance", "technical_dossier"], submission_deadline: t(12), verified_by: ministry.id, if_not_submitted: "Cancelled" };
  // Supplier C initially awarded, then protest upheld → Cancelled.
  const cWinThenLose = commitment("commitment:bid-c", parties(sc.id, ministry.id),
    subj([serviceVal("value:it-deploy-c", "SVC-IT", { location: "Either" })], [moneyVal("value:bid-c-amt", 9200000)]),
    [{ state: S.draft, at: t(8), actor: sc.id }, { state: S.tendered(9200000, "MAD", closes), at: t(9), actor: sc.id }, { state: S.accepted, at: t(18), actor: ministry.id }, { state: S.cancelled(ministry.id, "award protest upheld — re-evaluation", t(20)), at: t(20), actor: ministry.id }],
    { terms: { conditions: [comply] } });
  // Supplier A re-awarded after protest.
  const aReaward = commitment("commitment:bid-a", parties(sa.id, ministry.id),
    subj([serviceVal("value:it-deploy-a", "SVC-IT", { location: "Either" })], [moneyVal("value:bid-a-amt", 9000000)]),
    [{ state: S.draft, at: t(8), actor: sa.id }, { state: S.tendered(9000000, "MAD", closes), at: t(9), actor: sa.id }, { state: S.accepted, at: t(21), actor: ministry.id }, { state: S.partially(["mobilise"], ["deliver"]), at: t(22), actor: sa.id }, { state: S.fulfilled, at: t(23), actor: sa.id }],
    { terms: { conditions: [comply] } });
  return {
    title: "Public tender: scored selection, compliance docs, award protest upheld",
    doc: "Sealed competitive bids as Tendered Commitments + ComplianceDocumentation condition. The award mechanism (AuctionMechanism::ScoredSelection — weighted multi-criteria, evaluation committee) and the AwardProtest (Upheld → ReEvaluation) are auxiliary records validated by conformance/case-studies/validate-aux.mjs, documented in government-procurement.md. Protest upheld: initial award (C) Accepted→Cancelled, re-award (A) runs to Fulfilled.",
    parties: [ministry, sa, sc], commitments: [cWinThenLose, aReaward],
    fulfillments: [payFul("fulfillment:gp-pay", aReaward.id, ministry.id, sa.id, "gp", 9000000, "MAD", { p: 21, s: 22, c: 22 }), fulfillment("fulfillment:gp-deliver", aReaward.id, [{ state: FS.planned, at: t(21), actor: sa.id }, { state: FS.inprogress, at: t(22), actor: sa.id }, { state: FS.completed, at: t(23), actor: sa.id }], [{ kind: "ServiceCompletion", confirmed_by: ministry.id, timestamp: t(23) }])],
  };
};

// 16. wholesale — RecurringDelivery + Net terms + VolumePricing; blanket parent(Active) + call-off children (I-6 sum).
D["wholesale"] = () => {
  const retailer = party("party:retailer", "Organization"), distro = party("party:distributor", "Organization");
  const callOff = (n, amt) => commitment(`commitment:co-${n}`, parties(retailer.id, distro.id),
    subj([goodVal(`value:olive-${n}`, "SKU-OLIVEOIL")], [moneyVal(`value:co-${n}-amt`, amt)]),
    lifeFulfilled(retailer.id, distro.id),
    { parent: "commitment:blanket-po", terms: { payment: { timing: { type: "Net", days: 30, from: "InvoiceDate", early_payment_discount: 0.02 } } } });
  const c1 = callOff(1, 43200), c2 = callOff(2, 54000);
  const blanket = commitment("commitment:blanket-po", parties(retailer.id, distro.id),
    subj([], [moneyVal("value:blanket-total", 97200)]), lifeActive(retailer.id, distro.id),
    { children: [c1.id, c2.id], terms: {
      delivery: { method: { kind: "RecurringDelivery", schedule: "monthly", quantity_per_delivery: { amount: 120, unit: "cartons" }, first_delivery: t(11), last_delivery: t(23) } },
      payment: { timing: { type: "Net", days: 30, from: "InvoiceDate" } },
      volume_pricing: { tiers: [{ min: 0, max: 1000, price_per_unit: { amount: 360, currency: "MAD" } }, { min: 1001, price_per_unit: { amount: 340, currency: "MAD" } }], true_up: { reconcile_at: t(23), applies_to_prior_units: true } },
    } });
  return {
    title: "Blanket PO (Active parent) with monthly call-off children; volume pricing + Net 30",
    doc: "Blanket purchase order is an Active parent Commitment; each monthly call-off is a child (43200 + 54000 = 97200 parent — I-6 holds). DeliveryMethod::RecurringDelivery, PaymentTiming::Net (Net30), and VolumePricing with year-end true-up. All canonical v1.0.0.",
    parties: [retailer, distro], commitments: [blanket, c1, c2],
    fulfillments: [payFul("fulfillment:co-1-pay", c1.id, retailer.id, distro.id, "co1", 43200), delFul("fulfillment:co-1-del", c1.id, distro.id, retailer.id)],
  };
};

// 17. marketplace — CommissionSplit DoubleSided; parent + payout child + commission child (I-6 sum).
D["marketplace"] = () => {
  const buyer = party("party:mp-buyer"), seller = party("party:mp-seller", "Organization"), platform = party("party:mp-platform", "System", "USD");
  const payout = commitment("commitment:mp-payout", parties(buyer.id, seller.id),
    subj([], [moneyVal("value:mp-payout", 360)]), lifeAccepted(buyer.id, seller.id), { parent: "commitment:mp-1" });
  const commission = commitment("commitment:mp-commission", parties(buyer.id, platform.id),
    subj([], [moneyVal("value:mp-comm", 70)]), lifeAccepted(buyer.id, platform.id), { parent: "commitment:mp-1" });
  const root = commitment("commitment:mp-1", parties(buyer.id, seller.id, [platform.id]),
    subj([goodVal("value:mp-good", "SKU-TAGINE")], [moneyVal("value:mp-total", 430)]), lifeAccepted(buyer.id, seller.id),
    { children: [payout.id, commission.id], terms: { payment: { timing: { type: "CommissionSplit", structure: { type: "DoubleSided", buyer_fee: { rate: 0.075, paid_to: platform.id }, seller_fee: { rate: 0.10, paid_to: platform.id } } } } } });
  return {
    title: "Marketplace double-sided commission: buyer total = seller payout + platform fee",
    doc: "PaymentTiming::CommissionSplit (DoubleSided). Buyer pays 430 = seller payout 360 + platform fee 70 — value conservation across the platform intermediary, and the two children sum exactly to the 430 parent (I-6).",
    parties: [buyer, seller, platform], commitments: [root, payout, commission], fulfillments: [],
  };
};

// 18. trade finance — DocumentsAgainstPayment, RequiredDocuments, CustomsRelease, DocumentaryCollection, BillOfLading + CustomsClearance evidence.
D["trade-finance"] = () => {
  const importer = party("party:importer", "Organization"), exporter = party("party:exporter", "Organization", "EUR"), bank = party("party:bank", "Organization"), customs = party("party:customs", "Organization");
  const docs = digitalVal("value:title-docs", "BL-DOCS", "Exclusive", { kind: "DocumentaryCollection", held_by: bank.id, release_condition: "payment confirmed" }, { type: "Transferred", to: importer.id, at: t(12) });
  const c = commitment("commitment:tf-1", parties(importer.id, exporter.id, [bank.id, customs.id]),
    subj([goodVal("value:machinery", "SKU-MACHINERY"), docs], [moneyVal("value:tf-amt", 50000)]),
    lifeFulfilled(importer.id, exporter.id),
    { terms: {
      delivery: { method: { kind: "CustomsRelease", customs_reference: "CUST-REF-1", cleared_at: t(12), duties_paid: { amount: 5000, currency: "MAD" }, inspection_required: true } },
      payment: { timing: { type: "DocumentsAgainstPayment", documents_held_by: bank.id, release_condition: "documents released against payment" } },
      required_documents: { bill_of_lading: true, commercial_invoice: true, certificate_of_origin: true, customs_declaration: true },
    } });
  return {
    title: "Documentary collection: bank-held title, documents against payment, customs release",
    doc: "DocumentaryCollection (exclusive digital good held by the bank), PaymentTiming::DocumentsAgainstPayment, DeliveryMethod::CustomsRelease, RequiredDocuments, and BillOfLading + CustomsClearance Evidence — all present in canonical v1.0.0 (refuting D's 'evidence is a closed set of 5' flag).",
    parties: [importer, exporter, bank, customs], commitments: [c],
    fulfillments: [payFul("fulfillment:tf-pay", c.id, importer.id, bank.id, "tf", 50000),
      fulfillment("fulfillment:tf-ship", c.id, [{ state: FS.planned, at: t(10), actor: exporter.id }, { state: FS.inprogress, at: t(11), actor: exporter.id }, { state: FS.completed, at: t(12), actor: exporter.id }], [{ kind: "BillOfLading", reference: "BL-1", issued_by: bank.id, origin_port: "Hamburg", destination_port: "Casablanca", issued_at: t(11) }, { kind: "CustomsClearance", reference: "CUST-REF-1", cleared_at: t(12), jurisdiction: "MA" }])],
  };
};

// 19. events — CascadeCancellation term + EventCancellationPolicy + EventAccess; parent event + ticket children, cascade Cancelled.
D["events"] = () => {
  const org = party("party:event-org", "Organization"), f1 = party("party:fan-1"), f2 = party("party:fan-2");
  const ticket = (n, fan, last) => commitment(`commitment:tkt-${n}`, parties(fan, org.id),
    subj([digitalVal(`value:tkt-${n}`, `TKT-${n}`, "Exclusive", { kind: "EventAccess", event: "Jazzablanca 2026", location: "Casablanca", date: "2026-07-10", entry_window_start: "2026-07-10T18:00:00.000Z", entry_window_end: "2026-07-10T20:00:00.000Z", transferable: false })], [moneyVal(`value:tkt-${n}-amt`, 350)]),
    last === "cancel"
      ? [{ state: S.draft, at: t(8), actor: fan }, { state: S.proposed, at: t(9), actor: fan }, { state: S.accepted, at: t(10), actor: org.id }, { state: S.cancelled(org.id, "event cancelled — force majeure (cascade)", t(16)), at: t(16), actor: org.id }]
      : [{ state: S.draft, at: t(8), actor: fan }, { state: S.proposed, at: t(9), actor: fan }, { state: S.accepted, at: t(10), actor: org.id }, { state: S.cancelled(org.id, "event cancelled — force majeure (cascade)", t(16)), at: t(16), actor: org.id }],
    { parent: "commitment:event-parent" });
  const t1 = ticket(1, f1.id, "cancel"), t2 = ticket(2, f2.id, "cancel");
  const ev = commitment("commitment:event-parent", parties(org.id, org.id),
    subj([], [moneyVal("value:event-total", 700)]),
    [{ state: S.draft, at: t(8), actor: org.id }, { state: S.proposed, at: t(9), actor: org.id }, { state: S.accepted, at: t(10), actor: org.id }, { state: S.cancelled(org.id, "force majeure", t(16)), at: t(16), actor: org.id }],
    { children: [t1.id, t2.id], terms: {
      cascade: { trigger: { type: "ParentCancelled" }, applies_to: { type: "AllChildren" }, child_transition: S.cancelled(org.id, "cascade", t(16)), auto_refund: { amount: "FullRefund", deadline_days: 14 } },
      conditions: [{ kind: "EventCancellationPolicy", if_cancelled: { amount: "FullRefund", deadline_days: 14 } }],
    } });
  return {
    title: "Event cancelled (force majeure): CascadeCancellation propagates to all ticket children",
    doc: "EventAccess tickets as children of an event Commitment. CascadeCancellation term + EventCancellationPolicy condition: parent Cancelled → all children Cancelled (each refunded). The children's prices (350+350) sum to the 700 parent (I-6). Cascade is declared in terms (canonical) and realized as child Cancelled transitions.",
    parties: [org, f1, f2], commitments: [ev, t1, t2],
    fulfillments: [fulfillment("fulfillment:tkt-1-refund", t1.id, [{ state: FS.planned, at: t(16), actor: org.id }, { state: FS.inprogress, at: t(16), actor: org.id }, { state: FS.completed, at: t(17), actor: org.id }], [{ kind: "PaymentReceipt", reference: "refund-tkt-1", amount: { amount: 350, currency: "MAD" }, timestamp: t(17), mechanism: "card_reversal" }])],
  };
};

// 20. loyalty — LoyaltyEarnTerm + custom-currency points + split cash+points.
D["loyalty"] = () => {
  const cust = party("party:loy-cust"), merch = party("party:loy-merch", "Organization");
  const earn = commitment("commitment:loy-earn", parties(cust.id, merch.id),
    subj([goodVal("value:loy-good", "SKU-BASKET")], [moneyVal("value:loy-spend", 349)]),
    lifeFulfilled(cust.id, merch.id),
    { terms: { loyalty: { program: "AIMER Rewards", earn_rate: 1, points_earned: 349, credited_on: "FulfillmentComplete", currency: "PTS" } } });
  const redeem = commitment("commitment:loy-redeem", parties(cust.id, merch.id),
    subj([goodVal("value:loy-good-2", "SKU-COFFEE")], [moneyVal("value:loy-spend-2", 149)]),
    lifeFulfilled(cust.id, merch.id),
    { terms: { payment: { timing: { type: "Immediate" }, split: [{ method: "cash", amount: { amount: 149, currency: "MAD" } }, { method: "points", amount: { amount: 200, currency: "PTS" } }] } } });
  return {
    title: "Loyalty: points earned on purchase (value creation) + split cash/points redemption",
    doc: "LoyaltyEarnTerm credits points (CurrencyCode::Custom 'PTS') on FulfillmentComplete — Invariant 1's fourth clause (controlled value CREATION by the issuer). Redemption uses split payment (cash MAD + points PTS). Custom currency codes are first-class in canonical Money.",
    parties: [cust, merch], commitments: [earn, redeem],
    fulfillments: [payFul("fulfillment:loy-pay", earn.id, cust.id, merch.id, "loy", 349), delFul("fulfillment:loy-del", earn.id, merch.id, cust.id)],
  };
};

// 21. group buying — ThresholdActivation condition; pledges as commitments activating together / cancelling together.
D["group-buying"] = () => {
  const a = party("party:gb-a"), b = party("party:gb-b"), c = party("party:gb-c"), shop = party("party:gb-shop", "Organization");
  const th = { kind: "ThresholdActivation", minimum_participants: 50, maximum_participants: 500, activation_deadline: t(16), if_threshold_not_met: "Cancelled", if_threshold_met: "Accepted" };
  const pledge = (id, buyer) => commitment(id, parties(buyer, shop.id),
    subj([goodVal(`value:${id}-good`, "SKU-MACHINE")], [moneyVal(`value:${id}-amt`, 260)]),
    [{ state: S.draft, at: t(8), actor: buyer }, { state: S.tendered(260, "MAD", t(16)), at: t(9), actor: buyer }, { state: S.accepted, at: t(16), actor: shop.id }, { state: S.partially(["pay"], ["good"]), at: t(17), actor: shop.id }, { state: S.fulfilled, at: t(18), actor: shop.id }],
    { terms: { conditions: [th] } });
  const p1 = pledge("commitment:pledge-a", a.id), p2 = pledge("commitment:pledge-b", b.id), p3 = pledge("commitment:pledge-c", c.id);
  return {
    title: "Group buying: pledges activate simultaneously when the threshold is met",
    doc: "ThresholdActivation CommitmentCondition (min 50 participants). Threshold met → all pledges activate at the SAME timestamp (Tendered→Accepted at t16). GroupPriceTier (price drops with group size) is the auxiliary ThresholdActivation record (price_tiers), documented in group-buying.md.",
    parties: [a, b, c, shop], commitments: [p1, p2, p3],
    fulfillments: [payFul("fulfillment:gb-a-pay", p1.id, a.id, shop.id, "gb-a", 260, "MAD", { p: 16, s: 17, c: 17 }), delFul("fulfillment:gb-a-del", p1.id, shop.id, a.id, { p: 16, s: 17, c: 18 })],
  };
};

// 22. carbon credits — CarbonCredit AccessModel, ValueState::Retired (terminal), RegistryVerification, RegistryRetirement, RetirementCertificate.
D["carbon-credits"] = () => {
  const corp = party("party:cc-corp", "Organization", "USD"), dev = party("party:cc-dev", "Organization", "USD"), registry = party("party:cc-registry", "Organization");
  const credit = (state) => digitalVal("value:credit", "VCS-CREDIT", "Exclusive", { kind: "CarbonCredit", standard: "Verra VCS", vintage: 2024, project_id: "VCS-001", project_type: "Reforestation", location: "Brazil", quantity: 500, retired: true, additionality_verified: true, verification_body: "Verra" }, state);
  const c = commitment("commitment:cc-1", parties(corp.id, dev.id, [registry.id]),
    subj([credit({ type: "Retired", retired_at: t(13), retired_by: corp.id, reason: "offset 2026 emissions", certificate: "VCS-RET-12345" })], [moneyVal("value:cc-amt", 7500, "USD")]),
    lifeFulfilled(corp.id, dev.id),
    { terms: { delivery: { method: { kind: "RegistryRetirement", registry: registry.id, retirement_reference: "VCS-RET-12345", retired_on_behalf_of: corp.id, reason: "offset 2026 emissions" } }, conditions: [{ kind: "RegistryVerification", registry: registry.id, must_verify_before: "Accepted", verifies: ["additionality", "vintage"] }] } });
  return {
    title: "Carbon credit purchase + retirement (ValueState::Retired terminal)",
    doc: "AccessModel::CarbonCredit (exclusive digital good), RegistryVerification condition (additionality), DeliveryMethod::RegistryRetirement, RetirementCertificate Evidence, and the terminal ValueState::Retired (value extinguished — Invariant 1's retirement clause). All canonical v1.0.0.",
    parties: [corp, dev, registry], commitments: [c],
    fulfillments: [payFul("fulfillment:cc-pay", c.id, corp.id, dev.id, "cc", 7500, "USD"),
      fulfillment("fulfillment:cc-retire", c.id, [{ state: FS.planned, at: t(11), actor: registry.id }, { state: FS.inprogress, at: t(12), actor: registry.id }, { state: FS.completed, at: t(13), actor: registry.id }], [{ kind: "RetirementCertificate", reference: "VCS-RET-12345", issued_by: "Verra", quantity: 500, retired_at: t(13), project_id: "VCS-001" }])],
  };
};

// 23. insurance — coverage as a Commitment; a claim is a payout (settlement)
// against that coverage. The accept scene pays a claim WITHIN the coverage
// limit (claim <= coverage). Value Conservation (I-1) governs the relationship:
// a payout cannot exceed the captured/committed value, modelled here as a
// Refunded settlement amount <= the requested coverage amount (same currency).
D["insurance"] = () => {
  const holder = party("party:policyholder"), insurer = party("party:insurer", "Organization");
  // Coverage limit committed = 10000 MAD; the adjudicated claim pays out 7000 MAD (<= limit).
  const claim = 7000, coverage = 10000;
  const policy = commitment("commitment:claim-1", parties(holder.id, insurer.id),
    subj([], [moneyVal("value:coverage-limit", coverage)]),
    [
      { state: S.draft, at: t(8), actor: holder.id },
      { state: S.proposed, at: t(9), actor: holder.id },
      { state: S.accepted, at: t(10), actor: insurer.id },
      { state: S.partially(["assessed"], ["payout"]), at: t(11), actor: insurer.id },
      { state: S.fulfilled, at: t(12), actor: insurer.id },
      { state: S.refunded(claim, "MAD", t(13)), at: t(13), actor: insurer.id },
    ],
    { terms: {
      conditions: [{ kind: "PrescriptionRequired", must_verify_before: "Fulfilled", verified_by: insurer.id }],
    } });
  return {
    title: "Insurance claim paid within coverage: payout 7000 <= coverage 10000 MAD",
    doc: "Coverage limit is a Commitment (requested 10000 MAD); the adjudicated claim is a settlement payout (Refunded 7000 MAD) against it. claim <= coverage, so Value Conservation (I-1) holds. The over-claim counterpart (insurance-violation) pays out MORE than the coverage and is rejected by I-1.",
    parties: [holder, insurer], commitments: [policy],
    fulfillments: [payFul("fulfillment:claim-assess", policy.id, insurer.id, holder.id, "assess", claim, "MAD", { p: 10, s: 11, c: 11 })],
  };
};

// ===========================================================================
// Violation case studies — each maps a domain onto the primitives and shows a
// domain-specific error being CAUGHT by one of the six invariants. Composed
// from the same builders as the accept scenes; no new audit logic. Each emits a
// scene fixture (expect:reject, with the triggering rule) + an .expected sidecar,
// exactly like conformance/invalid/*. The runner asserts the declared rule
// actually fires; the four-way crosscheck asserts all bindings agree.
// ===========================================================================
const VIOL = {};

// INSURANCE — over-claim: a claim paid out ABOVE the coverage limit. Same shape
// as the accept scene but the settlement payout (Refunded 15000) exceeds the
// committed coverage (10000). Value Conservation (I-1): a payout cannot exceed
// the captured/committed value. (History reaches Accepted with a capable
// initiator so I-2/I-3/I-4 stay clean; the rejection is unambiguously I-1.)
VIOL["insurance"] = () => {
  const holder = party("party:policyholder"), insurer = party("party:insurer", "Organization");
  const overclaim = 15000, coverage = 10000;
  const policy = commitment("commitment:claim-over", parties(holder.id, insurer.id),
    subj([], [moneyVal("value:coverage-limit", coverage)]),
    [
      { state: S.draft, at: t(8), actor: holder.id },
      { state: S.proposed, at: t(9), actor: holder.id },
      { state: S.accepted, at: t(10), actor: insurer.id },
      { state: S.partially(["assessed"], ["payout"]), at: t(11), actor: insurer.id },
      { state: S.fulfilled, at: t(12), actor: insurer.id },
      { state: S.refunded(overclaim, "MAD", t(13)), at: t(13), actor: insurer.id },
    ]);
  return {
    rule: "I-1", rule_name: "Value Conservation",
    title: "Insurance over-claim: payout 15000 exceeds coverage 10000 MAD",
    because: "A claim settlement (Refunded 15000 MAD) paid against a 10000 MAD coverage limit, same currency. A payout cannot exceed the captured/committed value — paying out more than the coverage creates value from nothing. Value Conservation (I-1) rejects it.",
    parties: [holder, insurer], commitments: [policy], fulfillments: [],
  };
};

// HEALTHCARE — dispense-before-authorization: a medication is dispensed (a
// Completed fulfillment) but the prescription/insurer authorization commitment
// never reached Accepted. Temporal Integrity (I-4): commitments form (here, the
// authorization is granted) before fulfillments (the dispense) execute.
VIOL["healthcare"] = () => {
  const patient = party("party:patient"), pharmacy = party("party:pharmacy", "Organization");
  const auth = commitment("commitment:rx-auth", parties(patient.id, pharmacy.id),
    subj([serviceVal("value:dispense", "SVC-DISPENSE", { location: "Physical", performer: "party:pharmacy" })], [moneyVal("value:rx-fee", 300)]),
    [
      { state: S.draft, at: t(8), actor: patient.id },
      { state: S.proposed, at: t(9), actor: patient.id },
    ]);
  // The dispense executes to Completed even though auth is only Proposed.
  const dispense = fulfillment("fulfillment:rx-dispense", auth.id, [
    { state: FS.planned, at: t(10), actor: pharmacy.id },
    { state: FS.inprogress, at: t(11), actor: pharmacy.id },
    { state: FS.completed, at: t(12), actor: pharmacy.id },
  ], [{ kind: "MedicalRecord", reference: "MR-DISPENSE-1", issued_by: "pharmacy", patient: "patient", service_date: t(12) }]);
  return {
    rule: "I-4", rule_name: "Temporal Integrity",
    title: "Healthcare dispense-before-authorization: medication dispensed before auth granted",
    because: "A Completed dispense fulfillment whose authorization Commitment is only Proposed (never reached Accepted). Temporal Integrity (I-4): authorization must be granted (the commitment accepted) before the dispense executes.",
    parties: [patient, pharmacy], commitments: [auth], fulfillments: [dispense],
  };
};

// PROCUREMENT — three-way match failure: the invoice bills MORE than the goods
// actually received (the receipt-verified PO amount). Modelled as a settlement
// payout (Refunded = the invoiced amount) against the committed/receipt-matched
// PO value. Value Conservation (I-1): the disbursement cannot exceed the
// captured value (what was received). invoice > receipt fails I-1.
VIOL["procurement"] = () => {
  const buyer = party("party:buyer-org", "Organization"), supplier = party("party:supplier", "Organization");
  const received = 8000, invoiced = 9500; // PO/receipt-matched = 8000; invoice bills 9500.
  const po = commitment("commitment:po-1", parties(buyer.id, supplier.id),
    subj([goodVal("value:po-goods", "SKU-WIDGET")], [moneyVal("value:po-amount", received)]),
    [
      { state: S.draft, at: t(8), actor: buyer.id },
      { state: S.proposed, at: t(9), actor: buyer.id },
      { state: S.accepted, at: t(10), actor: supplier.id },
      { state: S.partially(["receipt"], ["invoice"]), at: t(11), actor: supplier.id },
      { state: S.fulfilled, at: t(12), actor: supplier.id },
      { state: S.refunded(invoiced, "MAD", t(13)), at: t(13), actor: buyer.id },
    ]);
  return {
    rule: "I-1", rule_name: "Value Conservation",
    title: "Procurement three-way-match failure: invoice 9500 exceeds receipt 8000 MAD",
    because: "An invoice settlement (Refunded 9500 MAD) disbursed against a receipt-matched PO of 8000 MAD, same currency. In a PO/receipt/invoice three-way match, the invoice cannot exceed the goods actually received. The disbursement exceeds the captured value, so Value Conservation (I-1) rejects it.",
    parties: [buyer, supplier], commitments: [po], fulfillments: [],
  };
};

// ===========================================================================
// Emit fixtures + rewrite the case-studies manifest block
// ===========================================================================
const order = [
  "physical-ecommerce", "gifting", "pos", "services", "bnpl", "escrow", "fx", "saas",
  "streaming", "api-metering", "nft", "auction-family", "real-estate", "healthcare",
  "government-procurement", "wholesale", "marketplace", "trade-finance", "events",
  "loyalty", "group-buying", "carbon-credits", "insurance",
];

// Domains that also ship a VIOLATION case study (accept scene + violation scene).
const violOrder = ["insurance", "healthcare", "procurement"];

const entries = [];
for (const domain of order) {
  const built = D[domain]();
  const id = `case-${domain}`;
  const file = join(HERE, domain, `${domain}.json`);
  mkdirSync(dirname(file), { recursive: true });
  const fixture = {
    fixture: id, schema: "1.0.0", kind: "scene", expect: "accept",
    domain, title: built.title, doc: built.doc,
    payload: { parties: built.parties, commitments: built.commitments, fulfillments: built.fulfillments },
  };
  writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
  entries.push({ id, kind: "scene", path: `case-studies/${domain}/${domain}.json`, expect: "accept", domain });
}

// Emit violation case studies (scene fixture + .expected sidecar), one per
// domain in violOrder. These live alongside the accept scene under the domain's
// directory and are wired into the manifest as expect:reject with the rule.
for (const domain of violOrder) {
  const built = VIOL[domain]();
  const id = `case-${domain}-violation`;
  const dir = join(HERE, domain);
  mkdirSync(dir, { recursive: true });
  const fixture = {
    fixture: id, schema: "1.0.0", kind: "scene", expect: "reject",
    domain, title: built.title, doc: built.because, rule: built.rule, rule_name: built.rule_name,
    payload: { parties: built.parties, commitments: built.commitments, fulfillments: built.fulfillments },
  };
  writeFileSync(join(dir, `${domain}-violation.json`), JSON.stringify(fixture, null, 2) + "\n");
  const sidecar = { fixture: id, expect: "reject", rule: built.rule, rule_name: built.rule_name, because: built.because };
  writeFileSync(join(dir, `${domain}-violation.expected.json`), JSON.stringify(sidecar, null, 2) + "\n");
  entries.push({
    id, kind: "scene", path: `case-studies/${domain}/${domain}-violation.json`,
    expect: "reject", rule: built.rule, rule_name: built.rule_name, domain,
    expected: `case-studies/${domain}/${domain}-violation.expected.json`,
  });
}

// Rewrite manifest: strip existing case-studies/* entries, append fresh.
const manifestPath = join(CONF, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.fixtures = manifest.fixtures.filter((f) => !String(f.path).startsWith("case-studies/"));
manifest.fixtures.push(...entries);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`✓ wrote ${entries.length} case-study scene fixtures + manifest entries`);
