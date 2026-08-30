/**
 * Rung 5B — authoring a WEB of related commitments.
 *
 * The division this rung rests on: the LANGUAGE authors the structure (which legs
 * exist, how each leg's amount is computed); the MODEL enforces the coherence
 * (I-6 tree reconciliation, the session's per-tree cumulative refund ledger).
 *
 * The load-bearing tests are the ones showing the compiler does NOT check
 * reconciliation. A composition whose legs over-sum the parent COMPILES and
 * BUILDS, and is then caught by `checkI6TreeConsistency`. That is the whole
 * design: one implementation of conservation, in the model, not a second copy in
 * the compiler that has to be kept in step.
 */
import { describe, expect, it } from "vitest";
import {
  applyCommitmentPath,
  auditCommerce,
  checkI6TreeConsistency,
  createSession,
  newCommitment,
  partyId,
  valueId,
} from "@warp-lang/commerce-types";
import type { Commitment, World } from "@warp-lang/commerce-types";
import { buildComposition, compileSystem } from "../src/system.js";
import { compile } from "../src/compile.js";
import { WarpCompileError, WarpSyntaxError } from "../src/errors.js";

const SELLER = partyId("party:seller");
const BUYER = partyId("party:buyer");

/** The marketplace shape from the case-study corpus: 430 = 360 payout + 70 commission. */
const MARKETPLACE = `
composition marketplace_order {
  label       "Marketplace order"
  description "A buyer's order splits into a seller payout and a platform commission."
  leg payout     { amount committed - 70 MAD }
  leg commission { amount 70 MAD }
}
`;

function order(amount: number, state?: Parameters<typeof applyCommitmentPath>[1]): Commitment {
  const c = newCommitment(BUYER, SELLER, {
    offered: [],
    requested: [
      {
        id: valueId("value:order"),
        form: { kind: "Money", money: { amount, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  return state ? applyCommitmentPath(c, state, SELLER) : c;
}

function compileErr(src: string): WarpCompileError {
  try {
    compile(src, { file: "d.warp" });
  } catch (e) {
    return e as WarpCompileError;
  }
  throw new Error("expected a WarpCompileError, but compilation succeeded");
}

// ---------------------------------------------------------------------------
// 1. Authoring
// ---------------------------------------------------------------------------

describe("compile — a composition authors the shape of a split", () => {
  it("lowers the legs in source order, with their amount expressions", () => {
    const sys = compileSystem(MARKETPLACE, { file: "mp.warp" });
    const comp = sys.compositions[0]!;
    expect(comp.id).toBe("marketplace_order");
    expect(comp.label).toBe("Marketplace order");
    expect(comp.legs.map((l) => l.name)).toEqual(["payout", "commission"]);
    expect(comp.legs[0]!.amount.kind).toBe("binary");
    expect(comp.legs[1]!.amount.kind).toBe("money");
  });

  it("a composition with no legs is rejected", () => {
    const err = compileErr(`composition c { label "empty" }`);
    expect(err.message).toContain("declares no legs");
  });

  it("a duplicate leg name is rejected — leg names address the children", () => {
    const err = compileErr(`composition c {\n  leg a { amount 10 MAD }\n  leg a { amount 20 MAD }\n}`);
    expect(err.message).toContain("Duplicate leg 'a'");
    expect(err.line).toBe(3);
  });

  it("a leg with no amount is rejected", () => {
    const err = compileErr(`composition c { leg a { } }`);
    expect(err.message).toContain("has no 'amount'");
  });

  it("a leg referencing an unknown variable names the closed context", () => {
    const err = compileErr(`composition c {\n  leg a { amount mrr * 0.5 }\n}`);
    expect(err.message).toContain("unknown variable 'mrr'");
    expect(err.message).toContain("committed, quantity, term_days, elapsed_days, remaining_days");
  });

  it("a malformed leg body is a positioned syntax error", () => {
    let err: WarpSyntaxError | undefined;
    try {
      compile(`composition c {\n  leg a { price 10 MAD }\n}`, { file: "d.warp" });
    } catch (e) {
      err = e as WarpSyntaxError;
    }
    expect(err).toBeInstanceOf(WarpSyntaxError);
    expect(err!.expected).toBe("'amount'");
    expect(err!.line).toBe(2);
  });

  it("a duplicate composition id is rejected", () => {
    const err = compileErr(`composition c { leg a { amount 1 MAD } }  composition c { leg b { amount 1 MAD } }`);
    expect(err.message).toContain("Duplicate composition 'c'");
  });
});

// ---------------------------------------------------------------------------
// 2. Building — the model's own tree, nothing new
// ---------------------------------------------------------------------------

describe("buildComposition — produces the model's parent/children tree", () => {
  const comp = compileSystem(MARKETPLACE).compositions[0]!;

  it("links children to the parent and the parent to its children", () => {
    const parent = order(430);
    const built = buildComposition(comp, parent);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.children).toHaveLength(2);
    expect(built.children.every((c) => c.parent === parent.id)).toBe(true);
    expect(built.parent.children).toEqual(built.children.map((c) => c.id));
  });

  it("computes each leg's amount from the parent", () => {
    const built = buildComposition(comp, order(430));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const amounts = built.children.map(
      (c) => (c.subject.requested[0]!.form as { money: { amount: number } }).money.amount,
    );
    expect(amounts).toEqual([360, 70]);
  });

  it("the amounts follow the parent — a different order, different legs", () => {
    const built = buildComposition(comp, order(1070));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const amounts = built.children.map(
      (c) => (c.subject.requested[0]!.form as { money: { amount: number } }).money.amount,
    );
    expect(amounts).toEqual([1000, 70]);
  });

  it("is indistinguishable from a hand-built tree, so the existing checks apply", () => {
    const parent = order(430);
    const built = buildComposition(comp, parent);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // The whole point: a built tree is ordinary commitments, so auditCommerce —
    // which knows nothing about compositions — judges it as it judges any tree.
    expect(auditCommerce([built.parent, ...built.children], [], [])).toEqual([]);
  });

  it("a leg amount that is not money is a failure, returned as data", () => {
    const bare = compileSystem(`composition c { leg a { amount 0.5 } }`).compositions[0]!;
    const built = buildComposition(bare, order(430));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failures[0]!.leg).toBe("a");
    expect(built.failures[0]!.error.message).toContain("must be money");
  });

  it("an unavailable variable fails loudly rather than defaulting", () => {
    const timed = compileSystem(`composition c { leg a { amount committed * (remaining_days / 30) } }`)
      .compositions[0]!;
    const built = buildComposition(timed, order(430));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failures[0]!.error.code).toBe("unavailable-variable");
  });

  it("the host supplies party ids per leg — they are runtime data, not authored", () => {
    const platform = partyId("party:platform");
    const built = buildComposition(comp, order(430), {
      legs: { commission: { counterparty: platform } },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.children[1]!.parties.counterparty).toBe(platform);
    expect(built.children[0]!.parties.counterparty).toBe(SELLER);
  });
});

// ---------------------------------------------------------------------------
// 3. THE DIVISION — the language does not check coherence; the model does
// ---------------------------------------------------------------------------

describe("coherence is the MODEL's, not the language's", () => {
  it("a composition whose legs OVER-SUM the parent still compiles and builds", () => {
    // Deliberate. Re-deriving I-6 in the compiler would be a second implementation
    // of conservation to keep in step, for no gain.
    const over = compileSystem(`
      composition greedy {
        leg a { amount committed * 0.7 }
        leg b { amount committed * 0.7 }
      }
    `).compositions[0]!;
    const built = buildComposition(over, order(100));
    expect(built.ok).toBe(true);
  });

  it("...and I-6 catches it", () => {
    const over = compileSystem(`
      composition greedy {
        leg a { amount committed * 0.7 }
        leg b { amount committed * 0.7 }
      }
    `).compositions[0]!;
    const built = buildComposition(over, order(100));
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const violations = checkI6TreeConsistency(built.parent, built.children);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.invariant).toBe("I-6");
    expect(violations[0]!.description).toContain("sum to 140");
    expect(violations[0]!.description).toContain("parent requests 100");

    // And the whole-world audit sees it too — nothing special is needed.
    expect(auditCommerce([built.parent, ...built.children], [], []).some((v) => v.invariant === "I-6")).toBe(true);
  });

  it("legs that UNDER-sum the parent are caught the same way", () => {
    const under = compileSystem(`composition c { leg a { amount committed * 0.5 } }`).compositions[0]!;
    const built = buildComposition(under, order(100));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(checkI6TreeConsistency(built.parent, built.children)).toHaveLength(1);
  });

  it("mixed currencies across legs are caught by I-6, not by the builder", () => {
    const mixed = compileSystem(`
      composition c {
        leg a { amount 50 MAD }
        leg b { amount 50 EUR }
      }
    `).compositions[0]!;
    const built = buildComposition(mixed, order(100));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const v = checkI6TreeConsistency(built.parent, built.children);
    expect(v[0]!.description).toContain("mixed currencies");
  });
});

// ---------------------------------------------------------------------------
// 4. The session's per-tree cumulative ledger, on an authored tree
// ---------------------------------------------------------------------------

describe("an authored tree runs under the session's cumulative checks", () => {
  const comp = compileSystem(MARKETPLACE).compositions[0]!;

  /** The built tree, with every commitment moved to Fulfilled so it can refund. */
  function fulfilledTree(): World {
    const parent = order(430);
    const built = buildComposition(comp, parent);
    if (!built.ok) throw new Error("build failed");
    const advance = (c: Commitment) => applyCommitmentPath(c, { type: "Fulfilled" }, SELLER);
    return {
      commitments: [advance(built.parent), ...built.children.map(advance)],
      fulfillments: [],
      parties: [],
    };
  }

  it("a refund within the child's own committed amount is accepted", () => {
    const world = fulfilledTree();
    const child = world.commitments[1]!;
    const session = createSession(world);
    const r = session.propose({
      commitment: child.id,
      to: { type: "Refunded", amount: { amount: 100, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" },
      actor: SELLER,
    });
    expect(r.ok).toBe(true);
  });

  it("a cumulative over-refund on one leg is blocked by the session ledger (I-1)", () => {
    const world = fulfilledTree();
    const child = world.commitments[1]!; // the 360 payout leg
    const session = createSession(world);
    const refund = (amount: number, at: string) =>
      session.propose({
        commitment: child.id,
        to: { type: "Refunded", amount: { amount, currency: "MAD" }, at },
        actor: SELLER,
      });
    expect(refund(300, "2030-02-01T00:00:00.000Z").ok).toBe(true);
    const second = refund(200, "2030-02-02T00:00:00.000Z");
    expect(second.ok).toBe(false);
    if (second.ok === false) {
      expect(second.violations[0]!.rule).toBe("I-1");
      expect(second.violations[0]!.message).toContain("Cumulative refunds");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Back-compat
// ---------------------------------------------------------------------------

describe("back-compat — a file with no composition is unchanged", () => {
  it("compiles to an empty composition list and an unchanged model", () => {
    const sys = compileSystem(`
      profile digital { states Draft, Accepted value_forms Money }
      policy p { concession_floor 150 MAD }
    `);
    expect(sys.compositions).toEqual([]);
    expect(sys.model.profile!.id).toBe("digital");
    expect(sys.model.policies![0]!.bounds!.floor).toEqual({ amount: 150, currency: "MAD" });
  });

  it("a composition does not enter the CommerceModel — it describes commitments, not config", () => {
    const sys = compileSystem(MARKETPLACE);
    expect(Object.keys(sys.model)).not.toContain("composition");
    expect(Object.keys(sys.model)).not.toContain("compositions");
  });
});
