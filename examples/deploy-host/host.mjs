/**
 * A STANDALONE HOST running a Warp commerce model.
 *
 * This is what an adopter's service looks like. Read its imports first, because
 * they are the entire point of this rung:
 *
 *   - `@warp-lang/commerce-types` — the runtime library, installed from a package
 *     tarball exactly as it would be installed from npm.
 *   - `node:fs` — to read the model.
 *
 * That is all. There is NO import of `@warp-lang/commerce-lang`, no `../../packages/…`,
 * no reach into repo source. This file cannot parse `.warp`; it has never seen the
 * grammar. It loads DATA and runs it through the LIBRARY.
 *
 * `tests/deploy.test.ts` asserts that mechanically, because a claim like this one
 * is worth nothing if a later edit can quietly break it.
 *
 * What the host owns — the I/O the engine deliberately does not do:
 *   - the world (here, an in-memory order; in a real service, a database)
 *   - the events (here, three simulated inbound actions; in a real service, HTTP
 *     requests, a queue, a webhook)
 *   - the clock (fixed here so the run is reproducible)
 *   - acting on the verdicts (advance, or reject and report)
 */
import { readFileSync } from "node:fs";
import {
  applyCommitmentPath,
  newCommitment,
  partyId,
  runModel,
  valueId,
} from "@warp-lang/commerce-types";

const modelPath = process.argv[2] ?? "model.json";

// ── 1. Load the compiled commerce brain. Plain JSON; no compiler involved. ────
const model = JSON.parse(readFileSync(modelPath, "utf8"));

console.log(`\nhost: loaded ${modelPath}`);
console.log(`host: model '${model.id}'`);
console.log(`host:   profile  ${model.profile?.id ?? "(none)"} — allows ${model.profile?.allowedStates?.join(", ") ?? "-"}`);
console.log(`host:   policies ${(model.policies ?? []).map((p) => p.id).join(", ") || "(none)"}`);
const floor = model.policies?.[0]?.bounds?.floor;
if (floor) console.log(`host:   floor    ${floor.amount} ${floor.currency}`);

// ── 2. The host's own world. A real service would read this from its database. ─
const seller = partyId("party:merchant");
const buyer = partyId("party:buyer");

function order(amount, state) {
  const c = newCommitment(buyer, seller, {
    offered: [
      {
        id: valueId("value:licence"),
        form: {
          kind: "DigitalGood",
          identifier: "licence:single-seat",
          exclusivity: "NonExclusive",
          access_model: { kind: "License", license_type: "Perpetual", seats: 1, transferable: false },
        },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
    requested: [
      {
        id: valueId("value:price"),
        form: { kind: "Money", money: { amount, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  return state ? applyCommitmentPath(c, state, seller) : c;
}

const deal = order(200, { type: "Proposed" });
let world = { commitments: [deal], fulfillments: [], parties: [] };

// ── 3. The host's own events. A real service gets these from HTTP or a queue. ──
const inbound = [
  { label: "accept the order", event: { type: "action", action: { commitment: deal.id, to: { type: "Accepted" }, actor: seller } } },
  { label: "discount to 120 MAD", event: { type: "concession", commitment: deal.id, kind: "counter", price: { amount: 120, currency: "MAD" }, by: seller } },
  {
    label: "raise a dispute",
    event: {
      type: "action",
      action: {
        commitment: deal.id,
        to: { type: "Disputed", by: buyer, reason: "changed mind", opened_at: "2030-02-01T00:00:00.000Z" },
        actor: buyer,
      },
    },
  },
];

// ── 4. Run each event through the loaded model, and ACT on the verdict. ────────
const clock = () => "2030-01-01T00:00:00.000Z";
let accepted = 0;
let rejected = 0;

console.log("\nhost: processing inbound events\n");
for (const { label, event } of inbound) {
  const result = runModel(model, world, [event], { clock });
  const verdict = result.verdicts[0];

  if (verdict.ok) {
    world = result.world; // the host commits the advance
    accepted++;
    console.log(`  ✓ ${label}`);
    console.log(`      state is now ${world.commitments[0].state.type}`);
  } else {
    rejected++;
    console.log(`  ✗ ${label}  — refused at the ${verdict.layer} layer`);
    console.log(`      ${verdict.violations[0].message}`);
    console.log(`      fix: ${verdict.violations[0].fix}`);
  }
}

console.log(`\nhost: ${accepted} accepted, ${rejected} refused`);
console.log(`host: final state ${world.commitments[0].state.type}\n`);

// Exit non-zero if the run did not go as this host expects, so the deploy flow is
// a gate in CI rather than a script that prints something.
const EXPECTED = { accepted: 1, rejected: 2, finalState: "Accepted" };
const actual = { accepted, rejected, finalState: world.commitments[0].state.type };
if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
  console.error(`host: UNEXPECTED OUTCOME\n  expected ${JSON.stringify(EXPECTED)}\n  actual   ${JSON.stringify(actual)}`);
  process.exit(1);
}
console.log("host: outcome as expected — the deployed model enforced the rules it was authored with.\n");
