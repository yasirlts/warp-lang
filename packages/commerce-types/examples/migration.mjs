// Declarative data migrations: bring stored commerce world data from an older
// shape to the current shape with a pure transform, then RE-VALIDATE the result
// with the existing audit (auditCommerce via guardObject). No schema edit.
//
//   npm install @warp-lang/commerce-types
//   node migration.mjs
//
// HONEST SCOPE: there is exactly ONE published schema version today
// (SCHEMA_VERSION === "1.0.0"). This demonstrates the MECHANISM on an
// ILLUSTRATIVE old-shaped record (a commitment that predates the always-present
// `children` / `history` fields). A real cross-version migration is written the
// same way — defineMigration({ from, to, transform }) — with no change to this
// layer and no edit to schema/.
import {
  defineMigration, migrate, newCommitment, applyCommitmentPath, partyId, valueId, SCHEMA_VERSION,
} from "@warp-lang/commerce-types";

const buyer = partyId("buyer");
const seller = partyId("seller");
const money = (amount) => ({ id: valueId(), form: { kind: "Money", money: { amount, currency: "MAD" } }, quantity: 1, state: { type: "Available" } });
const AT = "2026-03-01T00:00:00.000Z";

console.log("live published schema version:", SCHEMA_VERSION, "(single version — example transform is illustrative)\n");

// An ILLUSTRATIVE old-shaped record: a 200 MAD Fulfilled order written before
// `children` / `history` were always present. We drop those fields to stand in
// for "data from an older shape".
const current = applyCommitmentPath({ ...newCommitment(buyer, seller, { offered: [], requested: [money(200)] }), id: "order-1" }, { type: "Fulfilled" }, seller);
const { children: _c, history: _h, ...oldShaped } = current;
const oldWorld = { commitments: [oldShaped], fulfillments: [], parties: [] };

console.log("old-shaped record has children/history?",
  "children" in oldShaped, "/", "history" in oldShaped);

// The migration: default the missing arrays to bring it to the current shape.
const fillDefaults = defineMigration({
  from: "1.0.0",
  to: "1.1.0",
  transform: (world) => ({
    ...world,
    commitments: world.commitments.map((c) => ({ children: [], history: [], ...c })),
  }),
});

// Apply + re-audit.
const result = migrate(oldWorld, [fillDefaults], { from: "1.0.0", to: "1.1.0" });
if (result.ok) {
  const c = result.world.commitments[0];
  console.log(`\nmigration ${result.applied.join(" → ")}: audit PASSED`);
  console.log("  migrated record children:", JSON.stringify(c.children), "history:", JSON.stringify(c.history));
} else {
  console.log("\nmigration rejected:", result.violations[0].message);
}

// A BAD migration: drive the 200 MAD order into a Refunded state for 500.
// The transform runs, but the existing audit (I-1 value conservation) rejects the
// output — a migration cannot hand back a world that violates an invariant.
const badRefund = defineMigration({
  from: "1.0.0",
  to: "1.1.0",
  transform: (world) => ({
    ...world,
    commitments: world.commitments.map((c) => ({
      ...c, children: [], history: [],
      state: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: AT },
    })),
  }),
});

const bad = migrate(oldWorld, [badRefund], { from: "1.0.0", to: "1.1.0" });
if (bad.ok === false) {
  console.log(`\nbad migration ${bad.at} → BLOCKED at the ${bad.stage} stage [${bad.violations[0].rule}]`);
  console.log("  " + bad.violations[0].message);
  console.log("  fix: " + bad.violations[0].fix);
}
