// Optimistic-concurrency: two actors act on the SAME commitment. Each action is
// individually valid, but one was PLANNED against a stale version. Warp detects
// "you planned against version N; it is now N+1 and changed" and rejects the stale
// action as a CONFLICT — so the caller re-reads and re-plans.
//
//   npm install @warp-lang/commerce-types
//   node concurrency.mjs
//
// Scope: OPTIMISTIC concurrency over the caller's world view. It is NOT a lock,
// distributed consensus, or a transaction manager — see the README.
import {
  createSession, commitmentVersion, newCommitment, applyCommitmentPath, partyId,
} from "@warp-lang/commerce-types";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

// An accepted order both actors are looking at.
const order = applyCommitmentPath(newCommitment(buyer, seller), { type: "Accepted" }, seller);
const id = String(order.id);
const session = createSession({ commitments: [order], fulfillments: [], parties: [] });

// Both actors read the commitment and note the version they planned against.
const planned = commitmentVersion(session.world.commitments[0]);
console.log(`both actors planned against version: ${planned}`);

// Actor A activates the order — applied. The commitment advances.
const a = session.propose({ commitment: id, to: { type: "Active" }, actor: seller, expectedVersion: planned, idempotencyKey: "A-activate" });
console.log(`\nActor A: activate (planned ${planned}) → ok: ${a.ok}. commitment is now version ${commitmentVersion(session.world.commitments[0])}`);

// Actor B planned against the OLD version and proposes a dispute — individually
// valid, but stale. Warp rejects it as a CONFLICT, not an invariant violation.
const dispute = (key) => ({ commitment: id, to: { type: "Disputed", by: buyer, reason: "item issue", opened_at: "2026-03-01T00:00:00.000Z" }, actor: buyer, idempotencyKey: key });
const b = session.propose({ ...dispute("B-dispute"), expectedVersion: planned });
if (b.ok === false && b.conflict) {
  console.log(`\nActor B: dispute (planned ${planned}) → CONFLICT`);
  console.log(`  expected ${b.expected}, but actual is ${b.actual}`);
  console.log(`  ${b.violations[0].fix}`);
}

// Actor B re-reads, recomputes the current version, and re-plans. Now it applies.
const current = commitmentVersion(session.world.commitments[0]);
const b2 = session.propose({ ...dispute("B-dispute-2"), expectedVersion: current });
console.log(`\nActor B re-reads (version ${current}) and re-plans → ok: ${b2.ok}. commitment is now ${session.world.commitments[0].state.type}`);

// Backward-compatible: an action with NO expectedVersion is applied unconditionally.
const order2 = applyCommitmentPath(newCommitment(buyer, seller), { type: "Accepted" }, seller);
const session2 = createSession({ commitments: [order2], fulfillments: [], parties: [] });
const noVersion = session2.propose({ commitment: String(order2.id), to: { type: "Active" }, actor: seller });
console.log(`\nno expectedVersion supplied → applied unconditionally (backward-compatible): ${noVersion.ok}`);

// A replay (same idempotency key) is NOT a conflict — it dedups, even with a now-stale version.
const replay = session.propose({ commitment: id, to: { type: "Active" }, actor: seller, expectedVersion: planned, idempotencyKey: "A-activate" });
console.log(`replay of Actor A (same key, stale version) → replay: ${replay.replay === true}, conflict: ${replay.conflict === true} (a retry is a replay, not a conflict)`);
