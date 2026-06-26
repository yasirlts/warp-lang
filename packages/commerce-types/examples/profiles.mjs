// Data profiles — constrain a kind of commerce (digital / physical / subscription)
// as a caller-side filter, composed on top of the frozen invariants.
//
//   npm install @warp-lang/commerce-types
//   node profiles.mjs
//
import {
  guardWithProfile, guardAction, PROFILES,
  newCommitment, applyCommitmentPath, partyId,
} from "@warp-lang/commerce-types";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

// A physical, shippable order — 200 MAD, with a PhysicalGood line — shipped (Fulfilled).
function physicalOrder() {
  const order = newCommitment(buyer, seller, {
    offered: [{
      id: "value:tshirt",
      form: { kind: "PhysicalGood", sku: "TSHIRT-1", condition: "New" },
      quantity: 1,
      state: { type: "Available" },
    }],
    requested: [{
      id: "value:order-total",
      form: { kind: "Money", money: { amount: 200, currency: "MAD" } },
      quantity: 1,
      state: { type: "Available" },
    }],
  });
  return applyCommitmentPath(order, { type: "Fulfilled" }, seller);
}

// 1) A physical-shipping order under the PHYSICAL profile: the profile allows the
//    PhysicalGood form, so a profile-valid refund passes (and the frozen invariants
//    still run — a 200 MAD refund of a 200 MAD order is fine).
{
  const world = { commitments: [physicalOrder()], fulfillments: [], parties: [] };
  const refund = guardWithProfile(PROFILES.physical, world, {
    commitment: world.commitments[0].id,
    to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
    actor: seller,
  });
  console.log(`[physical profile] refund of a physical order approved? ${refund.ok}`);
}

// 2) The SAME physical-shipping order under the DIGITAL profile: the digital
//    profile does not trade in PhysicalGood, so the profile layer rejects it BEFORE
//    delegating — a digital-goods account cannot act on a physical-shipping order.
{
  const world = { commitments: [physicalOrder()], fulfillments: [], parties: [] };
  const blocked = guardWithProfile(PROFILES.digital, world, {
    commitment: world.commitments[0].id,
    to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
    actor: seller,
  });
  if (blocked.ok === false) {
    const v = blocked.violations[0];
    console.log(`[digital profile] BLOCKED [${v.rule}] ${v.message}`);
    console.log(`[digital profile] FIX: ${v.fix}`);
  }
}

// 3) The frozen invariants still hold UNDER a profile. An I-1 over-refund (500 MAD
//    against a 200 MAD order) is caught by the delegated guardAction even when the
//    profile would otherwise allow the move — the profile only narrows, never widens.
{
  const world = { commitments: [physicalOrder()], fulfillments: [], parties: [] };
  const overRefund = guardWithProfile(PROFILES.physical, world, {
    commitment: world.commitments[0].id,
    to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
    actor: seller,
  });
  if (overRefund.ok === false) {
    const v = overRefund.violations.find((x) => x.rule === "I-1");
    console.log(`[physical profile] over-refund still caught [${v.rule}] ${v.message}`);
  }
}

// 4) A profile-valid action passes the SAME guardAction it delegates to — the
//    profile adds a constraint, it does not change the model's verdict.
{
  const world = { commitments: [physicalOrder()], fulfillments: [], parties: [] };
  const action = {
    commitment: world.commitments[0].id,
    to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
    actor: seller,
  };
  const viaProfile = guardWithProfile(PROFILES.physical, world, action);
  const viaModel = guardAction(world, action);
  console.log(`[physical profile] profile verdict == bare model verdict? ${viaProfile.ok === viaModel.ok}`);
}
