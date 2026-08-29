/**
 * Rung 4 — a whole `.warp` file compiled to the one object the engine runs, then
 * run. The claim is narrow and literal:
 *
 *   compileSystem(source).model  IS  the CommerceModel runModel takes.
 *
 * So the equivalence that matters is on the MODEL OBJECT, not on verdicts: an
 * authored system and a hand-built one that deep-equal are the same input to the
 * same function and cannot diverge. Verdict tests below are there to show the
 * layers firing end-to-end, not to establish the equivalence.
 *
 * Two tests exist purely to stop the language overclaiming, and they are the ones
 * to read first:
 *   - an authored `assert` changes NOTHING about enforcement;
 *   - an authored lifecycle does NOT govern which moves are legal.
 */
import { describe, expect, it } from "vitest";
import {
  applyCommitmentPath,
  newCommitment,
  partyId,
  runModel,
  valueId,
} from "@warp-lang/commerce-types";
import type {
  CommerceModel,
  CommerceProfile,
  CommitmentState,
  ModelEvent,
  World,
} from "@warp-lang/commerce-types";
import { compileSystem } from "../src/system.js";
import { WarpCompileError } from "../src/errors.js";

const SELLER = partyId("party:merchant");
const BUYER = partyId("party:buyer");
const FIXED = () => "2030-01-01T00:00:00.000Z";

/** The system under test, authored in full. */
const SOURCE = `
lifecycle sales {
  state Draft
  state Proposed
  state Accepted
  state Fulfilled
  state Disputed
  state Refunded
  state Cancelled

  Draft     -> Proposed, Cancelled
  Proposed  -> Accepted, Cancelled
  Accepted  -> Fulfilled, Cancelled, Disputed
  Fulfilled -> Disputed, Refunded
  Disputed  -> Fulfilled, Refunded, Cancelled
}

profile digital {
  label       "Digital goods"
  description "digital goods paid in money"
  states Draft, Proposed, Accepted, Fulfilled, Refunded, Cancelled
  value_forms DigitalGood, Money
}

policy house_rules {
  label       "House rules"
  description "Never below 150 MAD; MA VAT rates only."
  applies_to  digital
  concession_floor 150 MAD
  committed_price  200 MAD
  tax_rates "MA" 0, 0.1, 0.2
  assert I1
}
`;

function deal(state: CommitmentState) {
  const c = newCommitment(BUYER, SELLER, {
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
        form: { kind: "Money", money: { amount: 200, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  return applyCommitmentPath(c, state, SELLER);
}
const worldWith = (c: ReturnType<typeof deal>): World => ({ commitments: [c], fulfillments: [], parties: [] });

function compileErr(src: string, opts?: Parameters<typeof compileSystem>[1]): WarpCompileError {
  try {
    compileSystem(src, { file: "d.warp", ...opts });
  } catch (e) {
    return e as WarpCompileError;
  }
  throw new Error("expected a WarpCompileError, but compilation succeeded");
}

// ---------------------------------------------------------------------------
// 1. The gather
// ---------------------------------------------------------------------------

describe("compileSystem — a whole file becomes one CommerceModel", () => {
  const system = compileSystem(SOURCE, { file: "shop.warp" });

  it("gathers the lifecycle table, the base profile, and every policy", () => {
    expect(system.model.id).toBe("sales");
    expect(system.model.transitions!["Fulfilled"]).toEqual(["Disputed", "Refunded"]);
    expect(system.model.profile!.id).toBe("digital");
    expect(system.model.policies!.map((p) => p.id)).toEqual(["house_rules"]);
  });

  it("carries each policy's rule structures through unchanged", () => {
    const p = system.model.policies![0]!;
    expect(p.bounds).toEqual({
      floor: { amount: 150, currency: "MAD" },
      committed: { amount: 200, currency: "MAD" },
    });
    expect(p.pack!.jurisdictions).toEqual([{ jurisdiction: "MA", rates: [0, 0.1, 0.2] }]);
    expect(p.appliesTo).toBe("digital");
  });

  it("keeps the compiled pieces alongside the model", () => {
    expect(system.lifecycle!.name).toBe("sales");
    expect(system.profiles.map((p) => p.id)).toEqual(["digital"]);
    expect(system.policies.map((p) => p.id)).toEqual(["house_rules"]);
    expect(system.auctions).toEqual([]);
  });

  it("a file with no profile and no policies yields a bare model", () => {
    const s = compileSystem(`lifecycle l { state Draft  Draft -> Proposed  state Proposed }`);
    expect(s.model.profile).toBeUndefined();
    expect(s.model.policies).toBeUndefined();
    expect(s.model.transitions).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-declaration checks
// ---------------------------------------------------------------------------

describe("compileSystem — cross-declaration references are resolved at compile time", () => {
  it("a policy applying to an undeclared profile is a positioned error", () => {
    const err = compileErr(`
      profile digital { states Draft value_forms Money }
      policy p { applies_to physical }
    `);
    expect(err).toBeInstanceOf(WarpCompileError);
    expect(err.message).toContain("applies_to profile 'physical'");
    expect(err.line).toBe(3);
  });

  it("a profile permitting a state its own lifecycle omits is a positioned error", () => {
    const err = compileErr(`
      lifecycle l {
        state Draft
        state Proposed
        Draft -> Proposed
      }
      profile p {
        states Draft, Proposed, Fulfilled
        value_forms Money
      }
    `);
    expect(err.message).toContain("permits the state 'Fulfilled'");
    expect(err.message).toContain("does not declare it");
    // Points at 'Fulfilled' inside the profile's states list, not the whole block.
    expect(err.line).toBe(8);
    expect(err.format()).toContain("d.warp:8:");
  });

  it("two profiles are ambiguous, and the message says why it matters", () => {
    const err = compileErr(`
      profile a { states Draft value_forms Money }
      profile b { states Draft value_forms Money }
    `);
    expect(err.message).toContain("declares 2 profiles");
    expect(err.message).toContain("EVERY profile it holds to EVERY action");
    expect(err.line).toBe(3);
  });

  it("`profile` selects the base when several are declared", () => {
    const s = compileSystem(
      `profile a { states Draft value_forms Money }
       profile b { states Draft value_forms DigitalGood }`,
      { profile: "b" },
    );
    expect(s.model.profile!.id).toBe("b");
  });

  it("two lifecycles are ambiguous, and `lifecycle` selects one", () => {
    const src = `lifecycle x { state Draft }  lifecycle y { state Draft }`;
    expect(() => compileSystem(src)).toThrow(WarpCompileError);
    expect(compileSystem(src, { lifecycle: "y" }).model.id).toBe("y");
  });

  it("selecting a lifecycle that is not declared names the ones that are", () => {
    const err = compileErr(`lifecycle x { state Draft }`, { lifecycle: "nope" });
    expect(err.message).toContain("No lifecycle 'nope'");
    expect(err.message).toContain("Declared lifecycles: x");
  });
});

// ---------------------------------------------------------------------------
// 3. The equivalence that carries the rung
// ---------------------------------------------------------------------------

describe("the compiled model IS the hand-built model", () => {
  it("deep-equals the CommerceModel written by hand for the same system", () => {
    const authored = compileSystem(SOURCE, { file: "shop.warp" }).model;

    const digital: CommerceProfile = {
      id: "digital",
      label: "Digital goods",
      description: "digital goods paid in money",
      allowedStates: ["Draft", "Proposed", "Accepted", "Fulfilled", "Refunded", "Cancelled"],
      allowedValueForms: ["DigitalGood", "Money"],
    };
    const handBuilt: CommerceModel = {
      id: "sales",
      transitions: {
        Draft: ["Proposed", "Cancelled"],
        Proposed: ["Accepted", "Cancelled"],
        Accepted: ["Fulfilled", "Cancelled", "Disputed"],
        Fulfilled: ["Disputed", "Refunded"],
        Disputed: ["Fulfilled", "Refunded", "Cancelled"],
        Refunded: [],
        Cancelled: [],
      },
      profile: digital,
      policies: [
        {
          id: "house_rules",
          label: "House rules",
          description: "Never below 150 MAD; MA VAT rates only.",
          bounds: { floor: { amount: 150, currency: "MAD" }, committed: { amount: 200, currency: "MAD" } },
          profile: {
            id: "house_rules",
            label: "House rules",
            description: "digital goods paid in money",
            allowedStates: ["Draft", "Proposed", "Accepted", "Fulfilled", "Refunded", "Cancelled"],
            allowedValueForms: ["DigitalGood", "Money"],
          },
          appliesTo: "digital",
          pack: {
            id: "house_rules",
            label: "House rules",
            description: "Never below 150 MAD; MA VAT rates only.",
            jurisdictions: [{ jurisdiction: "MA", rates: [0, 0.1, 0.2] }],
          },
          asserts: ["I-1"],
        },
      ],
    };

    // The load-bearing assertion: identical INPUT to runModel. Equal verdicts
    // follow from this; they are not independent evidence of it.
    expect(authored).toEqual(handBuilt);
  });
});

// ---------------------------------------------------------------------------
// 4. End to end — the authored system, run
// ---------------------------------------------------------------------------

describe("runModel over the authored system — host events, every layer", () => {
  const { model } = compileSystem(SOURCE, { file: "shop.warp" });

  it("a valid host event advances the world", () => {
    const c = deal({ type: "Proposed" });
    const r = runModel(model, worldWith(c), [
      { type: "action", action: { commitment: c.id, to: { type: "Accepted" }, actor: SELLER } },
    ], { clock: FIXED });
    expect(r.verdicts[0]!.ok).toBe(true);
    expect(r.world.commitments[0]!.state.type).toBe("Accepted");
  });

  it("an event violating the authored PROFILE is blocked at the profile layer", () => {
    const c = deal({ type: "Fulfilled" });
    const r = runModel(model, worldWith(c), [
      {
        type: "action",
        action: {
          commitment: c.id,
          to: { type: "Disputed", by: BUYER, reason: "unhappy", opened_at: "2030-02-01T00:00:00.000Z" },
          actor: BUYER,
        },
      },
    ], { clock: FIXED });
    expect(r.verdicts[0]!.ok).toBe(false);
    expect(r.verdicts[0]!.layer).toBe("profile");
    expect(r.world.commitments[0]!.state.type).toBe("Fulfilled");
  });

  it("an event violating the authored POLICY is blocked at the policy layer", () => {
    const c = deal({ type: "Draft" });
    const r = runModel(model, worldWith(c), [
      { type: "concession", commitment: c.id, kind: "offer", price: { amount: 120, currency: "MAD" }, by: SELLER },
    ], { clock: FIXED });
    expect(r.verdicts[0]!.ok).toBe(false);
    expect(r.verdicts[0]!.layer).toBe("policy");
    expect(r.verdicts[0]!.policy).toBe("house_rules");
  });

  it("a base invariant violation is blocked at the base layer", () => {
    const c = deal({ type: "Fulfilled" });
    const r = runModel(model, worldWith(c), [
      {
        type: "action",
        action: {
          commitment: c.id,
          to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" },
          actor: SELLER,
        },
      },
    ], { clock: FIXED });
    expect(r.verdicts[0]!.ok).toBe(false);
    expect(r.verdicts[0]!.layer).toBe("base");
    expect(r.verdicts[0]!.violations!.some((v) => v.rule === "I-1")).toBe(true);
  });

  it("one host-supplied sequence exercises all three layers", () => {
    const c = deal({ type: "Draft" });
    const events: ModelEvent[] = [
      { type: "concession", commitment: c.id, kind: "offer", price: { amount: 120, currency: "MAD" }, by: SELLER },
      { type: "concession", commitment: c.id, kind: "offer", price: { amount: 170, currency: "MAD" }, by: SELLER },
      { type: "action", action: { commitment: c.id, to: { type: "Accepted" }, actor: SELLER } },
      {
        type: "action",
        action: {
          commitment: c.id,
          to: { type: "Disputed", by: BUYER, reason: "x", opened_at: "2030-02-01T00:00:00.000Z" },
          actor: BUYER,
        },
      },
    ];
    const r = runModel(model, worldWith(c), events, { clock: FIXED });
    expect(r.verdicts.map((v) => (v.ok ? "ok" : v.layer))).toEqual(["policy", "ok", "ok", "profile"]);
    expect(r.world.commitments[0]!.state.type).toBe("Accepted");
  });
});

// ---------------------------------------------------------------------------
// 5. Honesty — what authoring does NOT do
// ---------------------------------------------------------------------------

describe("honesty — an authored `assert` is documentation, not a gate", () => {
  const withAssert = compileSystem(SOURCE).model;
  const withoutAssert = compileSystem(SOURCE.replace("  assert I1\n", "")).model;

  it("removing the assert changes nothing but the recorded intent", () => {
    expect(withAssert.policies![0]!.asserts).toEqual(["I-1"]);
    expect(withoutAssert.policies![0]!.asserts).toBeUndefined();
    // Everything else about the two models is identical.
    const strip = (m: CommerceModel) => ({
      ...m,
      policies: m.policies!.map(({ asserts, ...rest }) => rest),
    });
    expect(strip(withAssert)).toEqual(strip(withoutAssert));
  });

  it("the engine blocks an over-refund identically with or WITHOUT the assert", () => {
    // The authored `assert I1` does not cause I-1 to be enforced — guardAction
    // audits all six invariants on every action regardless. Asserting cannot
    // strengthen that, and omitting cannot weaken it.
    const c = deal({ type: "Fulfilled" });
    const overRefund: ModelEvent = {
      type: "action",
      action: {
        commitment: c.id,
        to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" },
        actor: SELLER,
      },
    };
    const a = runModel(withAssert, worldWith(c), [overRefund], { clock: FIXED });
    const b = runModel(withoutAssert, worldWith(c), [overRefund], { clock: FIXED });
    expect(a.verdicts[0]!.ok).toBe(false);
    expect(b.verdicts[0]!.ok).toBe(false);
    expect(a.verdicts[0]!.layer).toBe(b.verdicts[0]!.layer);
    expect(a.verdicts[0]!.violations).toEqual(b.verdicts[0]!.violations);
  });
});

describe("honesty — an authored lifecycle is provenance, it does not govern", () => {
  it("authoring an illegal edge does not make the engine permit it", () => {
    // This lifecycle claims Draft -> Fulfilled. It is well-formed (both are real
    // model states), so it compiles and lands in model.transitions. The engine
    // still refuses the move: the table that governs is guardAction's.
    const src = `
      lifecycle wishful {
        state Draft
        state Fulfilled
        Draft -> Fulfilled
      }
    `;
    const { model } = compileSystem(src);
    expect(model.transitions!["Draft"]).toEqual(["Fulfilled"]);

    const c = deal({ type: "Draft" });
    const r = runModel(model, worldWith(c), [
      { type: "action", action: { commitment: c.id, to: { type: "Fulfilled" }, actor: SELLER } },
    ], { clock: FIXED });

    expect(r.verdicts[0]!.ok).toBe(false);
    expect(r.verdicts[0]!.layer).toBe("base");
    expect(r.verdicts[0]!.violations!.some((v) => v.rule === "I-2")).toBe(true);
    expect(r.world.commitments[0]!.state.type).toBe("Draft");
  });

  it("a model with NO authored transitions permits exactly the same moves", () => {
    // If the authored table governed anything, dropping it would change behaviour.
    // It does not.
    const c = deal({ type: "Draft" });
    const move: ModelEvent = {
      type: "action",
      action: { commitment: c.id, to: { type: "Fulfilled" }, actor: SELLER },
    };
    const authored = compileSystem(`lifecycle w { state Draft  state Fulfilled  Draft -> Fulfilled }`).model;
    const withNoTable: CommerceModel = { id: "w" };
    const a = runModel(authored, worldWith(c), [move], { clock: FIXED });
    const b = runModel(withNoTable, worldWith(c), [move], { clock: FIXED });
    expect(a.verdicts[0]!.ok).toBe(b.verdicts[0]!.ok);
    expect(a.verdicts[0]!.violations).toEqual(b.verdicts[0]!.violations);
  });
});
