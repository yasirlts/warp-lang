/**
 * Regression tests for the v0.3.1 audit-confirmed bug fixes:
 *   BUG 1 — three-decimal currencies (TND/BHD/KWD/OMR/JOD) in the Stripe adapter
 *   BUG 2 — adapters synthesized empty histories, failing the package's own audit
 *   BUG 3 — Invariant 6 used exact float equality; + the allocate() exact split
 */

import { describe, expect, it } from "vitest";
import { allocate, type Money } from "../src/index.js";
import { auditCommerce, checkI6TreeConsistency } from "../src/index.js";
import { type Commitment, newCommitment, partyId, valueId } from "../src/index.js";
import { fromStripeAmount, toStripeAmount } from "../src/platforms/stripe.js";
import {
  type ShopifyOrder,
  fromShopifyCustomer,
  fromShopifyFulfillment,
  fromShopifyOrder,
} from "../src/platforms/shopify.js";

// --- helpers ---------------------------------------------------------------

/** A commitment whose `requested` subject is a single Money value. */
function moneyCommitment(id: string, amount: number, currency = "MAD"): Commitment {
  const c = newCommitment(partyId("buyer"), partyId("seller"));
  return {
    ...c,
    id: id as Commitment["id"],
    subject: {
      offered: [],
      requested: [{ id: valueId(), form: { kind: "Money", money: { amount, currency } }, quantity: 1, state: { type: "Available" } }],
    },
  };
}

/** Sum allocate() parts back to minor units (the exactness test). */
function sumMinorUnits(parts: Money[], factor: number): number {
  return parts.reduce((s, p) => s + Math.round(p.amount * factor), 0);
}

// --- BUG 1 -----------------------------------------------------------------

describe("BUG 1 — three-decimal currency minor units", () => {
  it("TND round-trips 1.5 <-> 1500 millimes (factor 1000, not 100)", () => {
    expect(fromStripeAmount(1500, "TND")).toEqual({ amount: 1.5, currency: "TND" });
    expect(toStripeAmount({ amount: 1.5, currency: "TND" }).amount).toBe(1500);
  });

  it("JPY stays zero-decimal (factor 1)", () => {
    expect(fromStripeAmount(1500, "JPY")).toEqual({ amount: 1500, currency: "JPY" });
    expect(toStripeAmount({ amount: 1500, currency: "JPY" }).amount).toBe(1500);
  });

  it("USD stays two-decimal (factor 100)", () => {
    expect(fromStripeAmount(1500, "USD")).toEqual({ amount: 15, currency: "USD" });
    expect(toStripeAmount({ amount: 15, currency: "USD" }).amount).toBe(1500);
  });

  it("toStripeAmount rounds cleanly (1.5 * 1000 = 1500, never 1499.9999)", () => {
    // BHD is also three-decimal.
    expect(toStripeAmount({ amount: 1.5, currency: "BHD" }).amount).toBe(1500);
  });
});

// --- BUG 2 -----------------------------------------------------------------

describe("BUG 2 — adapter output passes the package's own auditor", () => {
  it("a paid+fulfilled Shopify order with a verified customer audits with ZERO violations", () => {
    const customerId = "shopify-cust-1";
    const order: ShopifyOrder = {
      id: "shopify-order-1",
      currency: "MAD",
      total_price: "100.00",
      financial_status: "paid",
      fulfillment_status: "fulfilled",
      customer: { id: customerId },
    };
    const commitment = fromShopifyOrder(order);
    const fulfillment = fromShopifyFulfillment({ id: "ful-1", order_id: "shopify-order-1", status: "success" });

    // A *verified* customer (can_buy) so Invariant 3 is satisfied.
    const base = fromShopifyCustomer({ id: customerId });
    const buyer = {
      ...base,
      capacity: { ...base.capacity, can_buy: true },
    };

    const violations = auditCommerce([commitment], [fulfillment], [buyer]);
    expect(violations).toEqual([]);
  });

  it("the synthesized commitment carries a real history reaching Accepted", () => {
    const c = fromShopifyOrder({
      id: "o2",
      currency: "MAD",
      total_price: "10.00",
      financial_status: "paid",
      fulfillment_status: "fulfilled",
      customer: { id: "c2" },
    });
    expect(c.state.type).toBe("Fulfilled");
    expect(c.history.length).toBeGreaterThan(0);
    expect(c.history.some((h) => h.to.type === "Accepted")).toBe(true);
  });
});

// --- BUG 3 -----------------------------------------------------------------

describe("BUG 3 — Invariant 6 float tolerance + exact allocate()", () => {
  it("parent 0.3 MAD with children 0.1 and 0.2 MAD: no I-6 violation", () => {
    const parent = moneyCommitment("p", 0.3);
    const c1 = moneyCommitment("c1", 0.1);
    const c2 = moneyCommitment("c2", 0.2);
    // 0.1 + 0.2 === 0.30000000000000004 — exact equality would falsely flag.
    expect(checkI6TreeConsistency(parent, [c1, c2])).toEqual([]);
  });

  it("a real discrepancy (740 vs 750) is still flagged", () => {
    const parent = moneyCommitment("p", 750);
    const c1 = moneyCommitment("c1", 500);
    const c2 = moneyCommitment("c2", 240);
    expect(checkI6TreeConsistency(parent, [c1, c2]).length).toBe(1);
  });

  it("allocate(0.3 MAD, [1,2]) sums exactly to 0.3", () => {
    const parts = allocate({ amount: 0.3, currency: "MAD" }, [1, 2]);
    expect(parts.map((p) => p.amount)).toEqual([0.1, 0.2]);
    expect(sumMinorUnits(parts, 100)).toBe(30);
  });

  it("allocate(100 MAD, [1,1,1]) sums exactly to 100 (not 99.99)", () => {
    const parts = allocate({ amount: 100, currency: "MAD" }, [1, 1, 1]);
    expect(sumMinorUnits(parts, 100)).toBe(10000); // 100.00 exactly
    expect(parts.length).toBe(3);
    // Largest-remainder hands the leftover minor unit to one part: 33.34/33.33/33.33.
    expect(parts.map((p) => p.amount).sort((a, b) => b - a)).toEqual([33.34, 33.33, 33.33]);
  });

  it("allocate respects three-decimal currencies (TND, factor 1000)", () => {
    const parts = allocate({ amount: 1, currency: "TND" }, [1, 1, 1]);
    expect(sumMinorUnits(parts, 1000)).toBe(1000); // 1.000 TND exactly
  });
});
