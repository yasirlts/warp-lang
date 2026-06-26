// Host-agnostic effect DESCRIPTORS (Boundary-A: effects-as-data). Validate an
// action in the ONE model, then describe WHAT a host would do as neutral data —
// without binding to a platform and without executing anything.
//
//   npm install @warp-lang/commerce-types
//   node effects.mjs
//
import { toEffect, toEffects, guardAction } from "@warp-lang/commerce-types";
import { fromShopifyOrder } from "@warp-lang/commerce-types/platforms/shopify";

// A paid+fulfilled 200 MAD order, mapped IN once. We reason in the ONE model.
const order = fromShopifyOrder({ id: "order_123", currency: "MAD", total_price: "200.00", financial_status: "paid", fulfillment_status: "fulfilled" });
const world = { commitments: [order], fulfillments: [], parties: [] };

// A valid 40 MAD refund: VALIDATE it first (the descriptor does not re-check).
const refund = { commitment: "order_123", to: { type: "Refunded", amount: { amount: 40, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" }, actor: "agent" };
const verdict = guardAction(world, refund);
console.log(`valid refund 40 MAD → accepted: ${verdict.ok}`);

// Prove NO I/O happens: trap any network/process touch the descriptor might make.
// (The descriptor is pure data, so none of these fire.)
let touchedIO = false;
const trap = () => { touchedIO = true; throw new Error("effect descriptor performed I/O"); };
const originalFetch = globalThis.fetch;
globalThis.fetch = trap;

const effect = toEffect(refund);
console.log("describe (host-agnostic — a descriptor, not a call):", JSON.stringify(effect.descriptor));
console.log(`I/O performed while describing: ${touchedIO}`);

globalThis.fetch = originalFetch;

// The descriptor is plain data: no functions, not a promise. The HOST decides
// how to perform it (which platform, which API, which credentials).
console.log(`descriptor is plain data (no .then): ${typeof effect.descriptor.then === "undefined"}`);

// A cancel describes a host-agnostic cancel effect (no payload beyond target).
const cancel = { commitment: "order_123", to: { type: "Cancelled", by: "agent", reason: "customer changed mind", at: "2026-03-01T00:00:00.000Z" }, actor: "agent" };
console.log("\ndescribe cancel:", JSON.stringify(toEffect(cancel).descriptor));

// An action with no host-agnostic effect → an HONEST non-ok result, not a guess.
const accept = { commitment: "order_123", to: { type: "Accepted" }, actor: "agent" };
const e = toEffect(accept);
if (e.ok === false) console.log(`\ndescribe 'Accepted' → not representable: ${e.reason}`);

// Batch: order and one-to-one correspondence preserved; a non-representable
// action yields a non-ok result in its own slot, it does not sink the batch.
const batch = toEffects([refund, accept, cancel]);
console.log("\nbatch results (ok flags, in order):", batch.map((r) => r.ok));
console.log("batch length matches input:", batch.length === 3);
