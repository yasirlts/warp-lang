# @warp-lang/commerce-runtime

A **reference, self-host durable-execution runtime** for the Warp commerce model.

Feed it a list of events — each event is a proposed commerce action — and it:

1. runs every action through a single
   [`createSession`](https://www.npmjs.com/package/@warp-lang/commerce-types)
   (which composes `guardAction` + the cross-step cumulative checks),
2. appends an entry to an **append-only audit log** — the action, the verdict,
   and the resulting state version,
3. accumulates the final world, and
4. can **replay** the log to rebuild the same final state.

This package is a **thin composition** over the published
[`@warp-lang/commerce-types`](https://www.npmjs.com/package/@warp-lang/commerce-types).
It does not re-implement the six invariants or the transition table; it runs the
model's own `createSession` and records what it answered.

## Scope — what this is, and what it is not

**It is** a runnable reference you host yourself, in your own process, to run the
commerce model over a stream of actions, keep a durable record of every verdict,
and reconstruct state by replaying that record.

**It is not:**

- **not a hosted SaaS** — it is a library you run, not a service we operate;
- **not a payment executor** — it validates and logs; it authorizes nothing,
  settles nothing, and moves no money. Carrying out an accepted action is the
  host's job, and the thing to carry out is a **Boundary-A effect descriptor**
  (plain `{ kind, target, payload }` data) — `describeEffects` restates accepted
  actions as that data. This package makes **no network call**, holds no
  credentials, and reads no environment;
- **not a distributed/HA execution engine** — the "durable" property here is the
  append-only log plus replay: the log can survive the process (the file store)
  and re-running it reproduces the same final state. It is not a clustered
  scheduler, not crash-atomic, and makes no liveness or exactly-once delivery
  guarantee.

## Determinism and replay

The runtime adds no nondeterminism of its own — it does not read the clock, the
network, or random state to **decide** a verdict. A verdict is a function of the
world and the action. So replaying the recorded actions through a fresh runtime
over the same initial world reproduces the same verdicts and the same model
state.

One field is not reproducible, and that is stated plainly: the frozen
commerce-model stamps each transition's history record with a wall-clock instant
at apply time, so a later replay's history stamps differ from the live run's.
`worldsEqual` compares model state **up to** those model-sampled
`history[].at` stamps (it normalizes them before comparing); the recorded
verdicts and the action inputs are compared verbatim.

## Install

```bash
npm install @warp-lang/commerce-types
# then add this package to your workspace (it is unpublished — 0.1.0, private)
```

## Use

```ts
import {
  applyCommitmentPath,
  newCommitment,
  partyId,
  valueId,
} from "@warp-lang/commerce-types";
import {
  CommerceRuntime,
  FileAuditStore,
  replayLog,
  worldsEqual,
  describeEffects,
} from "@warp-lang/commerce-runtime";

// A Fulfilled order committed at 200 MAD.
const order = newCommitment(partyId("buyer"), partyId("seller"), {
  offered: [],
  requested: [
    {
      id: valueId("value:order-total"),
      form: { kind: "Money", money: { amount: 200, currency: "MAD" } },
      quantity: 1,
      state: { type: "Available" },
    },
  ],
});
const initialWorld = {
  commitments: [applyCommitmentPath(order, { type: "Fulfilled" }, partyId("seller"))],
  fulfillments: [],
  parties: [],
};

// Persist the log to a file so it survives the process.
const live = new CommerceRuntime(initialWorld, {
  store: new FileAuditStore("audit.log", { truncate: true }),
});

live.run([
  // Blocked: an over-refund. Logged, but the world does not advance.
  { commitment: id, to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: t0 }, actor: "agent" },
  // Accepted: the corrected full refund.
  { commitment: id, to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: t1 }, actor: "agent" },
]);

live.store.entries(); // the append-only audit log (action, verdict, version)

// Rebuild the final state by replaying the log over the same initial world.
const replay = replayLog(initialWorld, live.store);
worldsEqual(replay.world, live.world); // true — replay reproduces the state

// Boundary-A descriptors for the accepted actions (data only; the host performs them).
describeEffects(live.store); // [{ ok: true, effect: { kind: "refund", ... } }]
```

## API

| Export | What it is |
| --- | --- |
| `CommerceRuntime` | The runtime. `process(action)` runs and logs one action; `run(actions)` runs a batch; `world` is the accumulated state; `store` is the audit log. |
| `InMemoryAuditStore` | The default append-only log, backed by an in-process array. |
| `FileAuditStore` | An append-only log persisted as JSON lines, one entry per line — survives the process and can be replayed later. |
| `replayLog(initialWorld, source)` | Re-run a recorded log (a store or a raw entry array) over an initial world; returns the rebuilt world and the per-action verdicts. |
| `worldsEqual(a, b)` | Structural world equality (normalizing the model-sampled history stamps) for asserting a replay matches the original. |
| `describeEffects(source)` | Boundary-A effect descriptors for the accepted actions in a log — data only, no I/O. |

The `AuditEntry` shape: `{ at, action, verdict, version }`, where `version` is
`{ seq, commitment, commitmentVersion }` — `seq` is a per-log monotonic counter,
`commitmentVersion` is derived from the published `commitmentVersion()`.

A blocked, replayed, or conflicting action is **still logged** — it just does not
advance the world. The log is a complete record of what the runtime was asked to
do and how it answered.

## Run the example

```bash
npm run build
npm run example   # node examples/runtime.mjs
```

It builds a small world (one fulfilled 200 MAD order), feeds the runtime a stream
including a blocked over-refund, prints the audit log, replays the log, shows the
replayed final state matches the live one, and prints the Boundary-A effect
descriptors.

## Test

```bash
npm test
```

Covers replay determinism, audit completeness, a blocked action being logged
without advancing state, and file-backed persistence + cross-process replay.

## Where this sits

This is the **execution-side reference** to the rest of `warp-lang`:
[`commerce-types`](https://www.npmjs.com/package/@warp-lang/commerce-types) is the
model and the checks; this runtime runs those checks over a sequence and keeps the
durable record. It pairs with `commerce-mcp` (the same checks as MCP tools) — that
one answers single verdicts over a transport; this one runs a stream and logs it.

License: MIT.
