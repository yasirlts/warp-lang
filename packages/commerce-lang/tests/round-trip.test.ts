/**
 * The round-trip proof — the whole point of this rung. An authored `.warp` model,
 * once compiled, must produce results IDENTICAL to hand-writing the model, checked
 * by the model's OWN guard and temporal verifier. And the language must NOT be
 * able to smuggle an unsound model past the invariants: an illegal transition
 * authored in `.warp` is still caught by the temporal verifier.
 *
 * These tests import the model's real checks from @warp-lang/commerce-types and
 * run the COMPILED output through them unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  verifyLifecycle,
  validTransitions,
  guardWithProfile,
  PROFILES,
  newCommitment,
  applyCommitmentPath,
  partyId,
  valueId,
} from "@warp-lang/commerce-types";
import type { CommitmentState, PartyID, TransitionFn, World } from "@warp-lang/commerce-types";
import { compile } from "../src/compile.js";

/** The compiled table's plain-string fn, viewed as the model's branded TransitionFn.
 *  Sound because the compiler validated every state against the frozen model. */
const asTransitionFn = (fn: (s: string) => string[]): TransitionFn => fn as unknown as TransitionFn;

// The frozen commitment lifecycle, authored in .warp — the 11 states and 26 edges.
const COMMITMENT_WARP = `
  lifecycle commitment {
    state Draft
    state Proposed
    state Tendered
    state Accepted
    state Modified
    state Active
    state PartiallyFulfilled
    state Fulfilled
    state Disputed
    state Cancelled
    state Refunded

    Draft              -> Proposed, Tendered, Cancelled
    Proposed           -> Accepted, Cancelled, Modified
    Tendered           -> Accepted, Cancelled
    Accepted           -> Modified, PartiallyFulfilled, Active, Cancelled, Disputed
    Modified           -> Accepted, Cancelled
    PartiallyFulfilled -> Fulfilled, Modified, Cancelled
    Active             -> Modified, Cancelled, Disputed
    Fulfilled          -> Disputed, Refunded
    Disputed           -> Fulfilled, Refunded, Cancelled
  }
`;

describe("round-trip — authored lifecycle == hand-written model", () => {
  const lc = compile(COMMITMENT_WARP).lifecycles[0]!;

  it("the compiled table equals the model's own edges, state by state", () => {
    // validTransitions IS the model's hand-written table. The authored table must
    // match it exactly for every state — structural identity, not just 'sound'.
    for (const s of lc.states) {
      const authored = [...lc.transitionFn(s)].sort();
      const model = [...validTransitions({ type: s } as CommitmentState)].sort();
      expect(authored, `edges out of ${s}`).toEqual(model);
    }
  });

  it("the temporal verifier gives an identical verdict to the hand-written model", () => {
    const authored = verifyLifecycle({ from: "Draft", transitions: asTransitionFn(lc.transitionFn) });
    const handWritten = verifyLifecycle({ from: "Draft" });
    expect(authored.verdict).toBe("fixpoint-sound");
    expect(authored.verdict).toBe(handWritten.verdict);
    expect(authored.explored).toBe(handWritten.explored);
    expect(authored.fixpointReached).toBe(handWritten.fixpointReached);
    expect(authored.violations).toEqual(handWritten.violations);
  });
});

describe("round-trip — authored profile == built-in profile through the guard", () => {
  // The built-in PROFILES.physical, authored in .warp — same states, same forms.
  const authoredPhysical = compile(`
    profile physical {
      label "Physical goods"
      description "physical, shippable goods paid in money"
      states Draft, Proposed, Accepted, Modified, Active, Fulfilled, Cancelled, Disputed, Refunded, PartiallyFulfilled, Tendered
      value_forms PhysicalGood, Money
    }
  `).profiles[0]!;

  const seller: PartyID = partyId("seller_1");

  function physicalOrderWorld(): World {
    const order = newCommitment(partyId("buyer_1"), seller, {
      offered: [
        {
          id: valueId("value:tshirt"),
          form: { kind: "PhysicalGood", sku: "TSHIRT-1", condition: "New" },
          quantity: 1,
          state: { type: "Available" },
        },
      ],
      requested: [
        {
          id: valueId("value:total"),
          form: { kind: "Money", money: { amount: 200, currency: "MAD" } },
          quantity: 1,
          state: { type: "Available" },
        },
      ],
    });
    return { commitments: [applyCommitmentPath(order, { type: "Fulfilled" }, seller)], fulfillments: [], parties: [] };
  }

  it("a valid refund: authored profile verdict == built-in profile verdict", () => {
    const world = physicalOrderWorld();
    const action = {
      commitment: world.commitments[0]!.id,
      to: { type: "Refunded" as const, amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
      actor: seller,
    };
    const a = guardWithProfile(authoredPhysical, world, action);
    const b = guardWithProfile(PROFILES.physical!, world, action);
    expect(a.ok).toBe(b.ok);
    expect(a.ok).toBe(true);
  });

  it("an over-refund (I-1) is still caught identically under the authored profile", () => {
    const world = physicalOrderWorld();
    const action = {
      commitment: world.commitments[0]!.id,
      to: { type: "Refunded" as const, amount: { amount: 500, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
      actor: seller,
    };
    const a = guardWithProfile(authoredPhysical, world, action);
    const b = guardWithProfile(PROFILES.physical!, world, action);
    expect(a.ok).toBe(false);
    expect(a.ok).toBe(b.ok);
    if (a.ok === false && b.ok === false) {
      // The model's invariant fires under the authored profile just as under the built-in.
      expect(a.violations.some((v) => v.rule === "I-1")).toBe(true);
      expect(a.violations.map((v) => v.rule).sort()).toEqual(b.violations.map((v) => v.rule).sort());
    }
  });
});

describe("round-trip — the language cannot smuggle an unsound model", () => {
  it("an illegal transition authored in .warp is caught by the temporal verifier", () => {
    // Fulfilled -> Draft is forbidden by the frozen model. It is WELL-FORMED
    // (both are real states) so it compiles — but it is not sound.
    const lc = compile(`
      lifecycle sneaky {
        state Draft
        state Proposed
        state Accepted
        state PartiallyFulfilled
        state Fulfilled
        Draft              -> Proposed
        Proposed           -> Accepted
        Accepted           -> PartiallyFulfilled
        PartiallyFulfilled -> Fulfilled
        Fulfilled          -> Draft
      }
    `).lifecycles[0]!;

    const result = verifyLifecycle({ from: "Draft", transitions: asTransitionFn(lc.transitionFn) });
    expect(result.verdict).toBe("violation-found");
    const v = result.violations.find((x) => x.state === "Draft");
    expect(v).toBeDefined();
    expect(v!.rule).toBe("I-2");
    expect(v!.path).toEqual(["Draft", "Proposed", "Accepted", "PartiallyFulfilled", "Fulfilled", "Draft"]);
  });

  it("a legal-but-partial authored lifecycle explores soundly (no forbidden edge)", () => {
    // Only real, legal edges — a strict subset of the model. No violation.
    const lc = compile(`
      lifecycle happy {
        state Draft
        state Proposed
        state Accepted
        state Cancelled
        Draft    -> Proposed, Cancelled
        Proposed -> Accepted, Cancelled
      }
    `).lifecycles[0]!;
    const result = verifyLifecycle({ from: "Draft", transitions: asTransitionFn(lc.transitionFn) });
    expect(result.violations).toHaveLength(0);
    expect(["fixpoint-sound", "sound-within-bound"]).toContain(result.verdict);
  });
});
