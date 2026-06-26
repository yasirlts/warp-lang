/**
 * Demo: the reference durable-execution runtime.
 *
 *   node examples/runtime.mjs
 *
 * It builds a small world (one fulfilled 200 MAD order), feeds the runtime a
 * stream of proposed actions — including a BLOCKED over-refund — prints the
 * append-only audit log, then REPLAYS the log from the same initial world and
 * shows the replayed final state matches the live one (determinism).
 *
 * The runtime runs the model and logs verdicts. It does not authorize, settle, or
 * move money: an accepted action's side-effect is a Boundary-A descriptor (plain
 * data), shown at the end. No network calls are made.
 */
import { newCommitment, applyCommitmentPath, partyId } from "@warp-lang/commerce-types";
import { CommerceRuntime, replayLog, worldsEqual, describeEffects } from "../dist/index.js";

function summarize(verdict) {
  if (verdict.ok) return verdict.replay ? "ok (replay no-op)" : "ok";
  const v = verdict.violations[0];
  return `BLOCKED [${v.rule}]`;
}

function main() {
  // A real, shipped (Fulfilled) order committed at 200 MAD.
  const buyer = partyId("buyer_1");
  const seller = partyId("seller_1");
  const order = newCommitment(buyer, seller, {
    offered: [],
    requested: [
      {
        id: "value:order-total",
        form: { kind: "Money", money: { amount: 200, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  const shipped = applyCommitmentPath(order, { type: "Fulfilled" }, seller);
  const initialWorld = { commitments: [shipped], fulfillments: [], parties: [] };

  // A stream of proposed commerce actions an agent might emit. The over-refund is
  // intentionally unsafe; the runtime must log it as blocked WITHOUT advancing the
  // world, then accept the corrected 200 MAD refund.
  const events = [
    {
      commitment: shipped.id,
      to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
      actor: "support_agent",
      reason: "customer asked for 500 back",
    },
    {
      commitment: shipped.id,
      to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T01:00:00.000Z" },
      actor: "support_agent",
      reason: "corrected: full refund of the 200 order",
    },
  ];

  // Fixed clock so the printed audit stamps are stable for the demo.
  const live = new CommerceRuntime(initialWorld, { now: () => "2026-02-01T12:00:00.000Z" });
  live.run(events);

  console.log("=== AUDIT LOG (append-only) ===");
  for (const entry of live.store.entries()) {
    const v = entry.version;
    console.log(
      `#${v.seq}  ${entry.action.to.type} ${entry.action.to.amount?.amount ?? ""} ${entry.action.to.amount?.currency ?? ""}`.trimEnd() +
        `  ->  ${summarize(entry.verdict)}   [version ${v.commitment}@${v.commitmentVersion}]`,
    );
    if (!entry.verdict.ok) {
      console.log(`        why: ${entry.verdict.violations[0].message}`);
      console.log(`        fix: ${entry.verdict.violations[0].fix}`);
    }
  }
  console.log();

  // REPLAY the recorded log from the same initial world.
  const replay = replayLog(initialWorld, live.store);
  const match = worldsEqual(replay.world, live.world);
  console.log("=== REPLAY ===");
  console.log(`replayed ${replay.verdicts.length} action(s) from the log`);
  console.log(`live final commitment state:    ${live.world.commitments[0].state.type}`);
  console.log(`replayed final commitment state: ${replay.world.commitments[0].state.type}`);
  console.log(`replay reproduces live final state: ${match ? "YES (deterministic)" : "NO"}`);
  if (!match) {
    process.exit(1);
  }
  console.log();

  // Boundary-A: the side-effects for the ACCEPTED actions, as descriptors only.
  console.log("=== BOUNDARY-A EFFECT DESCRIPTORS (data only; host performs them) ===");
  for (const eff of describeEffects(live.store)) {
    if (eff.ok) {
      console.log(`  ${eff.effect.kind} ${eff.effect.target}`, JSON.stringify(eff.effect.payload));
    } else {
      console.log(`  (no host-agnostic effect: ${eff.reason})`);
    }
  }
  console.log();
  console.log(
    "The runtime ran the model and logged every verdict. It authorized, settled,\n" +
      "and moved nothing — performing the descriptors above is the host's job.",
  );
}

main();
