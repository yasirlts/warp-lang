/**
 * `runModel` — the composed engine (rung 4a). The claim under test is that ONE
 * model object, run through ONE entry point, enforces every layer it declares:
 * the base invariants, the profile constraints, the policy bounds, the regulatory
 * pack, and the asserted invariants.
 *
 * Two properties matter as much as the blocking:
 *   - ADDITIVE — a model with no profile and no policies produces exactly the
 *     verdicts `step`/`run` produce. The composition changes no base behaviour.
 *   - DETERMINISTIC — same (model, world, events, fixed clock) → byte-for-byte
 *     the same result, and no input is mutated.
 */
import { describe, it, expect } from "vitest";
import { newCommitment, applyCommitmentPath, partyId, valueId } from "../src/index.js";
import { run, step, type CommerceEvent } from "../src/engine.js";
import { runModel, stepModel, type CommerceModel, type ModelEvent } from "../src/model.js";
import type {
  CommerceProfile,
  CommitmentState,
  MoneyBreakdown,
  ProposedAction,
  World,
} from "../src/index.js";

const seller = partyId("seller_1");
const buyer = partyId("buyer_1");
const FIXED = () => "2030-01-01T00:00:00.000Z";

function order(amount: number, finalState: CommitmentState) {
  const o = newCommitment(buyer, seller, {
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
        id: valueId("v"),
        form: { kind: "Money", money: { amount, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  return applyCommitmentPath(o, finalState, seller);
}

const worldWith = (...cs: ReturnType<typeof order>[]): World => ({
  commitments: cs,
  fulfillments: [],
  parties: [],
});

const event = (commitment: string, to: CommitmentState): CommerceEvent => ({
  type: "action",
  action: { commitment, to, actor: seller } as ProposedAction,
});

/** Normalize the single clock-sampled field so two runs can be compared. */
function normTimes<T>(value: T): T {
  const w = JSON.parse(JSON.stringify(value));
  for (const c of w?.commitments ?? []) {
    for (const h of c?.history ?? []) if (h && typeof h.at === "string") h.at = "<t>";
  }
  return w;
}

/** A digital profile that forbids Disputed — the model's own states, narrowed. */
const DIGITAL_NO_DISPUTE: CommerceProfile = {
  id: "digital_strict",
  label: "Digital goods, no disputes",
  description: "digital goods paid in money",
  allowedStates: ["Draft", "Proposed", "Accepted", "Fulfilled", "Refunded", "Cancelled"],
  allowedValueForms: ["DigitalGood", "Money"],
};

/** The composed model used across the enforcement tests. */
const MODEL: CommerceModel = {
  id: "house",
  label: "House rules",
  profile: DIGITAL_NO_DISPUTE,
  policies: [
    {
      id: "floor",
      bounds: { floor: { amount: 150, currency: "MAD" }, committed: { amount: 200, currency: "MAD" } },
      pack: {
        id: "ma-vat",
        label: "MA VAT",
        description: "permitted MA rates",
        jurisdictions: [{ jurisdiction: "MA", rates: [0, 0.1, 0.2] }],
      },
      asserts: ["I-1"],
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. All four layers, through ONE runModel call over ONE model
// ---------------------------------------------------------------------------

describe("runModel — every layer the model declares is enforced by the same call", () => {
  it("a valid event advances the world (base layer)", () => {
    const c = order(200, { type: "Proposed" });
    const r = runModel(MODEL, worldWith(c), [event(c.id, { type: "Accepted" })], { clock: FIXED });
    expect(r.verdicts[0]!.ok).toBe(true);
    expect(r.world.commitments[0]!.state.type).toBe("Accepted");
  });

  it("a PROFILE violation is blocked — through runModel, not a separate call", () => {
    const c = order(200, { type: "Fulfilled" });
    const r = runModel(
      MODEL,
      worldWith(c),
      [
        event(c.id, {
          type: "Disputed",
          by: buyer,
          reason: "unhappy",
          opened_at: "2030-02-01T00:00:00.000Z",
        }),
      ],
      { clock: FIXED },
    );
    expect(r.verdicts[0]!.ok).toBe(false);
    expect(r.verdicts[0]!.layer).toBe("profile");
    expect(r.verdicts[0]!.violations![0]!.rule).toBe("profile-state");
    // Blocked means blocked: the world did not move.
    expect(r.world.commitments[0]!.state.type).toBe("Fulfilled");
    expect(r.effects).toEqual([]);
  });

  it("a POLICY bound violation is blocked — a concession below the floor", () => {
    const c = order(200, { type: "Draft" });
    const r = runModel(
      MODEL,
      worldWith(c),
      [{ type: "concession", commitment: c.id, kind: "offer", price: { amount: 120, currency: "MAD" }, by: seller }],
      { clock: FIXED },
    );
    expect(r.verdicts[0]!.ok).toBe(false);
    expect(r.verdicts[0]!.layer).toBe("policy");
    expect(r.verdicts[0]!.policy).toBe("floor");
    expect(r.verdicts[0]!.violations![0]!.rule).toBe("I-1");
    expect(r.world.commitments[0]!.state.type).toBe("Draft");
  });

  it("a concession WITHIN the floor advances through the base engine", () => {
    const c = order(200, { type: "Draft" });
    const r = runModel(
      MODEL,
      worldWith(c),
      [{ type: "concession", commitment: c.id, kind: "offer", price: { amount: 170, currency: "MAD" }, by: seller }],
      { clock: FIXED },
    );
    expect(r.verdicts[0]!.ok).toBe(true);
    expect(r.world.commitments[0]!.state.type).toBe("Proposed");
  });

  it("a BASE invariant violation is blocked — an over-refund is I-1", () => {
    const c = order(200, { type: "Fulfilled" });
    const r = runModel(
      MODEL,
      worldWith(c),
      [event(c.id, { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" })],
      { clock: FIXED },
    );
    expect(r.verdicts[0]!.ok).toBe(false);
    expect(r.verdicts[0]!.layer).toBe("base");
    expect(r.verdicts[0]!.violations!.some((v) => v.rule === "I-1")).toBe(true);
    expect(r.world.commitments[0]!.state.type).toBe("Fulfilled");
  });

  it("a settlement is checked against the policy's pack, and advances nothing", () => {
    const c = order(200, { type: "Accepted" });
    const committedTotal = { amount: 240, currency: "MAD" };
    const good: MoneyBreakdown = {
      total: committedTotal,
      components: [
        { kind: "Base", amount: { amount: 200, currency: "MAD" } },
        { kind: "Tax", amount: { amount: 40, currency: "MAD" }, jurisdiction: "MA", tax_rate: 0.2 },
      ],
    };
    const okRun = runModel(MODEL, worldWith(c), [{ type: "settlement", commitment: c.id, settlement: good, committedTotal }], { clock: FIXED });
    expect(okRun.verdicts[0]!.ok).toBe(true);
    expect(okRun.world.commitments[0]!.state.type).toBe("Accepted");

    const bad: MoneyBreakdown = {
      total: committedTotal,
      components: [
        { kind: "Base", amount: { amount: 200, currency: "MAD" } },
        { kind: "Tax", amount: { amount: 40, currency: "MAD" }, jurisdiction: "MA", tax_rate: 0.17 },
      ],
    };
    const badRun = runModel(MODEL, worldWith(c), [{ type: "settlement", commitment: c.id, settlement: bad, committedTotal }], { clock: FIXED });
    expect(badRun.verdicts[0]!.ok).toBe(false);
    expect(badRun.verdicts[0]!.layer).toBe("policy");
    expect(badRun.verdicts[0]!.policy).toBe("floor");
  });

  it("one sequence exercises all four layers over the SAME model object", () => {
    const c = order(200, { type: "Draft" });
    const events: ModelEvent[] = [
      { type: "concession", commitment: c.id, kind: "offer", price: { amount: 120, currency: "MAD" }, by: seller }, // policy
      { type: "concession", commitment: c.id, kind: "offer", price: { amount: 170, currency: "MAD" }, by: seller }, // ok
      event(c.id, { type: "Accepted" }), // ok
    ];
    const r = runModel(MODEL, worldWith(c), events, { clock: FIXED });
    expect(r.verdicts.map((v) => (v.ok ? "ok" : v.layer))).toEqual(["policy", "ok", "ok"]);
    expect(r.world.commitments[0]!.state.type).toBe("Accepted");
  });
});

// ---------------------------------------------------------------------------
// 2. Additive — a bare model is exactly the base engine
// ---------------------------------------------------------------------------

describe("runModel — a model with no profile and no policies IS the base engine", () => {
  const BARE: CommerceModel = { id: "bare" };

  it("produces byte-for-byte the verdicts and world `run` produces", () => {
    const c = order(200, { type: "Fulfilled" });
    const events = [
      event(c.id, { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" }),
    ];
    const base = run(worldWith(c), events, { clock: FIXED });
    const composed = runModel(BARE, worldWith(c), events, { clock: FIXED });
    expect(normTimes(composed.world)).toEqual(normTimes(base.world));
    expect(composed.effects).toEqual(base.effects);
    expect(composed.verdicts.map((v) => v.ok)).toEqual(base.verdicts.map((v) => v.ok));
  });

  it("blocks what the base engine blocks, with the same violations", () => {
    const c = order(200, { type: "Fulfilled" });
    const bad = event(c.id, { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" });
    const base = step(worldWith(c), bad, { clock: FIXED });
    const composed = stepModel(BARE, worldWith(c), bad, { clock: FIXED });
    expect(composed.verdict.ok).toBe(false);
    expect(composed.verdict.violations).toEqual(base.verdict.violations);
    expect(composed.verdict.alternatives).toEqual(base.verdict.alternatives);
  });

  it("`step`/`run` themselves are unchanged — the base path still works alone", () => {
    const c = order(200, { type: "Proposed" });
    const r = step(worldWith(c), event(c.id, { type: "Accepted" }), { clock: FIXED });
    expect(r.verdict.ok).toBe(true);
    expect(r.world.commitments[0]!.state.type).toBe("Accepted");
  });
});

// ---------------------------------------------------------------------------
// 3. Purity and determinism
// ---------------------------------------------------------------------------

describe("runModel — pure, total, deterministic", () => {
  it("same (model, world, events, fixed clock) → byte-for-byte identical", () => {
    const c = order(200, { type: "Draft" });
    const events: ModelEvent[] = [
      { type: "concession", commitment: c.id, kind: "offer", price: { amount: 170, currency: "MAD" }, by: seller },
      event(c.id, { type: "Accepted" }),
    ];
    const a = runModel(MODEL, worldWith(c), events, { clock: FIXED });
    const b = runModel(MODEL, worldWith(c), events, { clock: FIXED });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate the input world or the model", () => {
    const c = order(200, { type: "Fulfilled" });
    const world = worldWith(c);
    const worldBefore = JSON.stringify(world);
    const modelBefore = JSON.stringify(MODEL);
    runModel(
      MODEL,
      world,
      [
        event(c.id, { type: "Disputed", by: buyer, reason: "x", opened_at: "2030-02-01T00:00:00.000Z" }),
        event(c.id, { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" }),
      ],
      { clock: FIXED },
    );
    expect(JSON.stringify(world)).toBe(worldBefore);
    expect(JSON.stringify(MODEL)).toBe(modelBefore);
  });

  it("is total — a malformed event yields a verdict, never a throw", () => {
    const c = order(200, { type: "Draft" });
    const r = stepModel(
      MODEL,
      worldWith(c),
      { type: "concession", commitment: "commitment:does-not-exist", kind: "offer", price: { amount: 170, currency: "MAD" }, by: seller },
      { clock: FIXED },
    );
    expect(r.verdict.ok).toBe(false);
    expect(r.world.commitments[0]!.state.type).toBe("Draft");
  });
});

// ---------------------------------------------------------------------------
// 4. Assertions select; they never widen
// ---------------------------------------------------------------------------

describe("runModel — `asserts` is declared intent, not a gate", () => {
  it("the base guard audits all six invariants regardless of what a policy asserts", () => {
    // The policy asserts NOTHING. An over-refund is still blocked, at the base
    // layer — omitting an invariant from `asserts` cannot switch it off.
    const noAsserts: CommerceModel = { id: "m", policies: [{ id: "p" }] };
    const c = order(200, { type: "Fulfilled" });
    const r = stepModel(
      noAsserts,
      worldWith(c),
      event(c.id, { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" }),
      { clock: FIXED },
    );
    expect(r.verdict.ok).toBe(false);
    expect(r.verdict.layer).toBe("base");
    expect(r.verdict.violations!.some((v) => v.rule === "I-1")).toBe(true);
  });

  it("asserting an invariant changes nothing — the same event, the same verdict", () => {
    // Asserting I-1 cannot strengthen a check the base guard already runs on every
    // action. The two models must be indistinguishable.
    const c = order(200, { type: "Fulfilled" });
    const bad = event(c.id, { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" });
    const silent = stepModel({ id: "m", policies: [{ id: "p" }] }, worldWith(c), bad, { clock: FIXED });
    const asserting = stepModel({ id: "m", policies: [{ id: "p", asserts: ["I-1"] }] }, worldWith(c), bad, { clock: FIXED });
    expect(asserting.verdict.layer).toBe(silent.verdict.layer);
    expect(asserting.verdict.violations).toEqual(silent.verdict.violations);
  });

  it("a world already violating an invariant blocks every event, asserted or not", () => {
    // `guardAction` audits the whole resulting WORLD, not just the targeted
    // commitment — so a pre-existing violation anywhere blocks an action on a
    // healthy commitment too. Pinned here because it is the reason an assertion
    // layer would have nothing to catch.
    const healthy = order(200, { type: "Proposed" });
    const mixed = newCommitment(buyer, seller, {
      offered: [],
      requested: [
        { id: valueId("a"), form: { kind: "Money", money: { amount: 100, currency: "MAD" } }, quantity: 1, state: { type: "Available" } },
        { id: valueId("b"), form: { kind: "Money", money: { amount: 50, currency: "EUR" } }, quantity: 1, state: { type: "Available" } },
      ],
    });
    const world: World = { commitments: [healthy, mixed], fulfillments: [], parties: [] };
    const r = stepModel({ id: "m" }, world, event(healthy.id, { type: "Accepted" }), { clock: FIXED });
    expect(r.verdict.ok).toBe(false);
    expect(r.verdict.layer).toBe("base");
    expect(r.verdict.violations!.some((v) => v.rule === "I-1")).toBe(true);
  });
});
