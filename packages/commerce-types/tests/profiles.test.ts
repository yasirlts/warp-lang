import { describe, expect, it } from "vitest";

import { guardAction, type World } from "../src/guard.js";
import {
  digitalProfile,
  guardWithProfile,
  physicalProfile,
  PROFILES,
  subscriptionProfile,
} from "../src/profiles.js";
import {
  newCommitment,
  partyId,
  valueId,
  type Commitment,
  type Value,
} from "../src/primitives.js";
import { applyCommitmentPath } from "../src/transitions.js";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

function money(amount: number, currency = "MAD"): Value {
  return {
    id: valueId(),
    form: { kind: "Money", money: { amount, currency } },
    quantity: 1,
    state: { type: "Available" },
  };
}

function physicalGood(): Value {
  return {
    id: valueId(),
    form: { kind: "PhysicalGood", sku: "SKU-1", condition: "New" },
    quantity: 1,
    state: { type: "Available" },
  };
}

function digitalGood(): Value {
  return {
    id: valueId(),
    form: {
      kind: "DigitalGood",
      identifier: "app-pro",
      exclusivity: "NonExclusive",
      access_model: { kind: "Download", redownloadable: true },
    },
    quantity: 1,
    state: { type: "Available" },
  };
}

function service(): Value {
  return {
    id: valueId(),
    form: { kind: "Service", identifier: "consulting", delivery_model: { location: "Remote" } },
    quantity: 1,
    state: { type: "Available" },
  };
}

/** A Fulfilled commitment whose subject offers `good` and requests 200 MAD. */
function fulfilledOrder(good: Value): Commitment {
  const order = newCommitment(buyer, seller, { offered: [good], requested: [money(200)] });
  return applyCommitmentPath(order, { type: "Fulfilled" }, seller);
}

const refund200 = {
  to: { type: "Refunded" as const, amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
  actor: seller,
};

describe("the built-in profile registry", () => {
  it("exposes digital, physical, and subscription profiles", () => {
    expect(PROFILES.digital).toBe(digitalProfile);
    expect(PROFILES.physical).toBe(physicalProfile);
    expect(PROFILES.subscription).toBe(subscriptionProfile);
  });

  it("each profile's allowed value forms are a subset of the model (it narrows, never adds)", () => {
    const modelForms = new Set([
      "PhysicalGood",
      "DigitalGood",
      "Service",
      "Money",
      "Nothing",
      "ContingentValue",
    ]);
    for (const profile of [digitalProfile, physicalProfile, subscriptionProfile]) {
      for (const form of profile.allowedValueForms) {
        expect(modelForms.has(form)).toBe(true);
      }
      expect(profile.allowedValueForms.length).toBeLessThan(modelForms.size);
    }
  });
});

describe("guardWithProfile — value-form constraint", () => {
  it("the digital profile rejects an action on a physical-goods commitment", () => {
    const order = fulfilledOrder(physicalGood());
    const world: World = { commitments: [order], fulfillments: [], parties: [] };
    const verdict = guardWithProfile(digitalProfile, world, { commitment: order.id, ...refund200 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.violations[0]?.rule).toBe("profile-value-form");
      expect(verdict.violations[0]?.message).toContain("PhysicalGood");
    }
  });

  it("the physical profile allows the same action on a physical-goods commitment", () => {
    const order = fulfilledOrder(physicalGood());
    const world: World = { commitments: [order], fulfillments: [], parties: [] };
    const verdict = guardWithProfile(physicalProfile, world, { commitment: order.id, ...refund200 });
    expect(verdict.ok).toBe(true);
  });

  it("the digital profile allows a digital-goods commitment", () => {
    const order = fulfilledOrder(digitalGood());
    const world: World = { commitments: [order], fulfillments: [], parties: [] };
    const verdict = guardWithProfile(digitalProfile, world, { commitment: order.id, ...refund200 });
    expect(verdict.ok).toBe(true);
  });

  it("the subscription profile allows a service commitment", () => {
    const order = fulfilledOrder(service());
    const world: World = { commitments: [order], fulfillments: [], parties: [] };
    const verdict = guardWithProfile(subscriptionProfile, world, { commitment: order.id, ...refund200 });
    expect(verdict.ok).toBe(true);
  });

  it("the physical profile rejects a service commitment (Service not in its forms)", () => {
    const order = fulfilledOrder(service());
    const world: World = { commitments: [order], fulfillments: [], parties: [] };
    const verdict = guardWithProfile(physicalProfile, world, { commitment: order.id, ...refund200 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.violations[0]?.rule).toBe("profile-value-form");
    }
  });
});

describe("guardWithProfile — state constraint", () => {
  it("rejects a target state the profile does not permit", () => {
    // PartiallyFulfilled is a physical multi-line state; the digital profile excludes it.
    const draft = newCommitment(buyer, seller, { offered: [digitalGood()], requested: [money(200)] });
    const world: World = { commitments: [draft], fulfillments: [], parties: [] };
    const verdict = guardWithProfile(digitalProfile, world, {
      commitment: draft.id,
      to: { type: "PartiallyFulfilled", fulfilled_item_ids: [], remaining_item_ids: [] },
      actor: seller,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.violations[0]?.rule).toBe("profile-state");
      expect(verdict.violations[0]?.message).toContain("PartiallyFulfilled");
    }
  });

  it("permits a profile-allowed state and then defers to the model's transition table", () => {
    // Proposed is in every profile, but Draft → Proposed must still be a legal edge.
    const draft = newCommitment(buyer, seller, { offered: [digitalGood()], requested: [money(200)] });
    const world: World = { commitments: [draft], fulfillments: [], parties: [] };
    const verdict = guardWithProfile(digitalProfile, world, {
      commitment: draft.id,
      to: { type: "Proposed" },
      actor: buyer,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("the frozen invariants are unaffected by the profile layer", () => {
  it("an I-1 over-refund is still caught even under a permissive profile", () => {
    const order = fulfilledOrder(physicalGood());
    const world: World = { commitments: [order], fulfillments: [], parties: [] };
    const verdict = guardWithProfile(physicalProfile, world, {
      commitment: order.id,
      to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
      actor: seller,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.violations.some((v) => v.rule === "I-1")).toBe(true);
    }
  });

  it("a profile-valid action yields the SAME verdict as the bare guardAction it delegates to", () => {
    const order = fulfilledOrder(physicalGood());
    const world: World = { commitments: [order], fulfillments: [], parties: [] };
    const action = { commitment: order.id, ...refund200 };
    const viaProfile = guardWithProfile(physicalProfile, world, action);
    const viaModel = guardAction(world, action);
    expect(viaProfile.ok).toBe(viaModel.ok);
    expect(viaProfile.ok).toBe(true);
  });

  it("an unknown commitment defers to guardAction's own reporting", () => {
    const world: World = { commitments: [], fulfillments: [], parties: [] };
    const verdict = guardWithProfile(physicalProfile, world, {
      commitment: "does-not-exist",
      to: { type: "Proposed" },
      actor: buyer,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.violations[0]?.rule).toBe("unknown-commitment");
    }
  });
});
