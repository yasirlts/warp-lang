import { describe, expect, it } from "vitest";

import { order } from "../src/builder.js";
import { auditCommerce } from "../src/invariants.js";
import { newCommitment, newFulfillment, partyId, valueId } from "../src/primitives.js";
import type { Value } from "../src/primitives.js";
import { applyCommitmentPath, applyFulfillmentPath } from "../src/transitions.js";

/** Narrow a Result to its value, failing the test (no `!`) if it is an error. */
function expectOk<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.value;
}

/** The shape of a history: the ordered list of from→to state types. */
function shape(history: { from: { type: string }; to: { type: string } }[]): string[] {
  return history.map((h) => `${h.from.type}->${h.to.type}`);
}

describe("order() — happy path", () => {
  it("produces a history-complete order that passes auditCommerce", () => {
    const built = order()
      .from("buyer_1")
      .to("seller_1")
      .item({ sku: "SKU-1", price: { amount: 200, currency: "MAD" } })
      .paid()
      .fulfilled()
      .build();

    const o = expectOk(built);
    expect(o.audit()).toEqual([]);
    // The one-call audit must match calling auditCommerce by hand.
    expect(auditCommerce(o.commitments, o.fulfillments, o.parties)).toEqual([]);
  });

  it("drives the commitment to Fulfilled with a real replayed history", () => {
    const o = expectOk(
      order()
        .from("buyer_1")
        .to("seller_1")
        .value({ amount: 200, currency: "MAD" })
        .paid()
        .fulfilled()
        .build(),
    );
    expect(o.commitment.state.type).toBe("Fulfilled");
    expect(shape(o.commitment.history)).toEqual([
      "Draft->Proposed",
      "Proposed->Accepted",
      "Accepted->PartiallyFulfilled",
      "PartiallyFulfilled->Fulfilled",
    ]);
    expect(o.fulfillments).toHaveLength(1);
    expect(o.fulfillments[0]?.state.type).toBe("Completed");
    expect(shape(o.fulfillments[0]?.history ?? [])).toEqual([
      "Planned->InProgress",
      "InProgress->Completed",
    ]);
  });

  it("stops at Proposed by default and at Accepted when only paid()", () => {
    const proposed = expectOk(
      order().from("b").to("s").value({ amount: 10, currency: "MAD" }).build(),
    );
    expect(proposed.commitment.state.type).toBe("Proposed");
    expect(proposed.fulfillments).toHaveLength(0);
    expect(proposed.audit()).toEqual([]);

    const paid = expectOk(
      order().from("b").to("s").value({ amount: 10, currency: "MAD" }).paid().build(),
    );
    expect(paid.commitment.state.type).toBe("Accepted");
    expect(paid.audit()).toEqual([]);
  });
});

describe("order() — equivalence with hand-built primitives", () => {
  it("the builder is sugar: its history matches the primitive path exactly", () => {
    const buyer = partyId("buyer_1");
    const seller = partyId("seller_1");

    const built = expectOk(
      order()
        .from(buyer)
        .to(seller)
        .value({ amount: 200, currency: "MAD" })
        .paid()
        .fulfilled()
        .build(),
    );

    // Hand-build the same flow through the public primitives + replay helpers.
    const requested: Value[] = [
      {
        id: valueId(),
        form: { kind: "Money", money: { amount: 200, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ];
    const draft = newCommitment(buyer, seller, { offered: [], requested });
    const handCommitment = applyCommitmentPath(draft, { type: "Fulfilled" }, buyer);
    const handFulfillment = applyFulfillmentPath(
      newFulfillment(handCommitment.id),
      { type: "Completed" },
      seller,
    );

    // Same code path ⇒ identical state and identical history shape (ids and
    // timestamps differ by construction; the transition sequence does not).
    expect(built.commitment.state.type).toBe(handCommitment.state.type);
    expect(shape(built.commitment.history)).toEqual(shape(handCommitment.history));
    expect(shape(built.fulfillments[0]?.history ?? [])).toEqual(shape(handFulfillment.history));
  });
});

describe("order() — invalid compositions return { ok: false }, never coerce", () => {
  it("missing buyer", () => {
    const r = order().to("seller_1").value({ amount: 10, currency: "MAD" }).build();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/buyer/i);
  });

  it("missing seller", () => {
    const r = order().from("buyer_1").value({ amount: 10, currency: "MAD" }).build();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/seller/i);
  });

  it("no value", () => {
    const r = order().from("buyer_1").to("seller_1").build();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one value/i);
  });

  it("buyer and seller are the same party (Invariant 5)", () => {
    const r = order().from("p").to("p").value({ amount: 10, currency: "MAD" }).build();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/distinct parties/i);
  });

  it("mixed currencies (Invariant 1)", () => {
    const r = order()
      .from("buyer_1")
      .to("seller_1")
      .value({ amount: 200, currency: "MAD" })
      .value({ amount: 30, currency: "EUR" })
      .paid()
      .build();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mixes currencies/i);
  });

  it("a non-finite money amount", () => {
    const r = order()
      .from("buyer_1")
      .to("seller_1")
      .value({ amount: Number.POSITIVE_INFINITY, currency: "MAD" })
      .build();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/finite/i);
  });
});
