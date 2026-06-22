// Idempotency & replay-safety: agents retry and networks duplicate, so the SAME
// action applied twice must not double-apply. A retried refund is recognized as a
// replay — a no-op reporting the original outcome — not a second refund.
//
//   npm install @warp-lang/commerce-types
//   node idempotency.mjs
//
// Scope: per-session, in-memory. Durable cross-session idempotency (a persistent
// store) is not provided — see the README.
import { createSession, newCommitment, applyCommitmentPath, partyId } from "@warp-lang/commerce-types";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

const order = applyCommitmentPath(
  newCommitment(buyer, seller, {
    offered: [],
    requested: [{ id: "value:order-total", form: { kind: "Money", money: { amount: 200, currency: "MAD" } }, quantity: 1, state: { type: "Available" } }],
  }),
  { type: "Fulfilled" },
  seller,
);

const session = createSession({ commitments: [order], fulfillments: [], parties: [] });
const refund = (amount, key) => ({ commitment: order.id, to: { type: "Refunded", amount: { amount, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor: "support_agent", idempotencyKey: key });

const sofar = () => session.refundedSoFar(order.id)?.amount ?? 0;

// 1) A refund with an idempotency key — applied.
const first = session.propose(refund(50, "refund-key-1"));
console.log(`refund 50 (key refund-key-1) → ok: ${first.ok}, replay: ${first.replay === true}. refunded so far: ${sofar()} MAD`);

// 2) The SAME action retried (same key) — recognized as a replay. No double refund.
const retry = session.propose(refund(50, "refund-key-1"));
console.log(`retry 50 (key refund-key-1) → ok: ${retry.ok}, replay: ${retry.replay === true}. refunded so far (unchanged): ${sofar()} MAD`);

// 3) A DIFFERENT refund (new key) — applied normally.
const second = session.propose(refund(30, "refund-key-2"));
console.log(`refund 30 (key refund-key-2) → ok: ${second.ok}, replay: ${second.replay === true}. refunded so far: ${sofar()} MAD`);

// 4) Fingerprint fallback — no key supplied. A first keyless refund applies; an
//    identical keyless retry is deduped by its derived fingerprint.
const keyless = session.propose(refund(20));
const keylessRetry = session.propose(refund(20));
console.log(`keyless refund 20 → ok: ${keyless.ok}, replay: ${keyless.replay === true}`);
console.log(`identical keyless retry → ok: ${keylessRetry.ok}, replay: ${keylessRetry.replay === true}. total refunded: ${sofar()} MAD`);
