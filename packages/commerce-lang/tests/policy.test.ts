/**
 * Rung 3 — POLICIES. Where rungs 1–2 author the model's SHAPE, a policy authors
 * commerce RULES. The tests below hold the rung's central claim to account:
 *
 *   the language AUTHORS a rule; the MODEL ENFORCES it.
 *
 * So every enforcement test compiles a policy, hands the compiled value to a
 * function that already shipped in @warp-lang/commerce-types, and requires the
 * verdict to be IDENTICAL to hand-writing that same rule. Nothing in
 * commerce-lang decides an outcome, and the last test proves the language cannot
 * smuggle an unsound one past the invariants.
 */
import { describe, expect, it } from "vitest";
import {
  applyCommitmentPath,
  auditCommerce,
  checkSettlementPolicy,
  guardConcession,
  guardWithProfile,
  newCommitment,
  partyId,
  valueId,
} from "@warp-lang/commerce-types";
import type {
  CommerceProfile,
  Commitment,
  MoneyBreakdown,
  NegotiationBounds,
  PartyID,
  RegulatoryPolicyPack,
  World,
} from "@warp-lang/commerce-types";
import { compile } from "../src/compile.js";
import { parse } from "../src/parser.js";
import { WarpCompileError, WarpSyntaxError } from "../src/errors.js";
import type { PolicyDecl } from "../src/ast.js";

const SELLER: PartyID = partyId("party:merchant");
const BUYER: PartyID = partyId("party:buyer");

/** A document declaring a profile and a policy that narrows it. */
const DOC = `
  profile digital {
    label       "Digital goods"
    description "digital goods paid in money"
    states Draft, Proposed, Accepted, Fulfilled, Disputed, Refunded, Cancelled
    value_forms DigitalGood, Money
  }

  policy strict_digital {
    label       "No disputes on digital"
    description "Digital sales settle or refund; they do not enter dispute."
    applies_to  digital
    forbid_states Disputed
    concession_floor 150 MAD
    committed_price  200 MAD
    tax_rates "MA" 0, 0.1, 0.2
    assert I1, I6
  }
`;

// ---------------------------------------------------------------------------
// 1. Parsing
// ---------------------------------------------------------------------------

describe("parse — a policy becomes a PolicyDecl", () => {
  it("produces a PolicyDecl carrying every authored field, in source order", () => {
    const doc = parse(DOC, { file: "d.warp" });
    const policy = doc.declarations.find((d): d is PolicyDecl => d.kind === "policy");
    expect(policy).toBeDefined();
    expect(policy!.name.name).toBe("strict_digital");
    expect(policy!.fields.map((f) => f.key)).toEqual([
      "label",
      "description",
      "applies_to",
      "forbid_states",
      "concession_floor",
      "committed_price",
      "tax_rates",
      "assert",
    ]);
  });

  it("records 1-based line/col on the declaration and its fields", () => {
    const doc = parse("policy p {\n  assert I1\n}", { file: "d.warp" });
    const policy = doc.declarations[0] as PolicyDecl;
    expect(policy.pos.line).toBe(1);
    expect(policy.pos.column).toBe(1);
    // `assert` begins on line 2, column 3.
    expect(policy.fields[0]!.pos.line).toBe(2);
    expect(policy.fields[0]!.pos.column).toBe(3);
  });

  it("an unknown policy field names the legal ones, at the exact position", () => {
    let err: WarpSyntaxError | undefined;
    try {
      parse("policy p {\n  discount 10\n}", { file: "d.warp" });
    } catch (e) {
      err = e as WarpSyntaxError;
    }
    expect(err).toBeInstanceOf(WarpSyntaxError);
    expect(err!.line).toBe(2);
    expect(err!.column).toBe(3);
    expect(err!.expected).toContain("concession_floor");
    expect(err!.format()).toBe(
      `d.warp:2:3: ${err!.message}`,
    );
  });

  it("a money field with no currency is rejected — as a compile error since rung 5A", () => {
    // Before expressions, `concession_floor 150` was a SYNTAX error: the parser
    // demanded a currency code. Now `150` parses as a valid bare-number
    // expression, and the failure moves to compile time, where the message can
    // say what is actually wrong — a floor must be money, not a plain number.
    let err: WarpCompileError | undefined;
    try {
      compile("policy p {\n  concession_floor 150\n}", { file: "d.warp" });
    } catch (e) {
      err = e as WarpCompileError;
    }
    expect(err).toBeInstanceOf(WarpCompileError);
    expect(err!.message).toContain("must be a money amount");
    expect(err!.message).toContain("evaluates to the plain number 150");
    expect(err!.line).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Compiling to the model's EXISTING structures
// ---------------------------------------------------------------------------

describe("compile — a policy lowers to structures the model already defines", () => {
  const policy = compile(DOC).policies[0]!;

  it("concession_floor / committed_price become NegotiationBounds", () => {
    const expected: NegotiationBounds = {
      floor: { amount: 150, currency: "MAD" },
      committed: { amount: 200, currency: "MAD" },
    };
    expect(policy.bounds).toEqual(expected);
  });

  it("applies_to + forbid_states become a NARROWED CommerceProfile", () => {
    const base = compile(DOC).profiles[0]!;
    expect(base.allowedStates).toContain("Disputed");
    // The policy removes exactly the forbidden state and nothing else.
    expect(policy.profile!.allowedStates).toEqual(
      base.allowedStates.filter((s) => s !== "Disputed"),
    );
    expect(policy.profile!.allowedValueForms).toEqual(base.allowedValueForms);
    expect(policy.appliesTo).toBe("digital");
  });

  it("tax_rates becomes a RegulatoryPolicyPack, rates carried verbatim", () => {
    const expected: RegulatoryPolicyPack["jurisdictions"] = [
      { jurisdiction: "MA", rates: [0, 0.1, 0.2] },
    ];
    expect(policy.pack!.jurisdictions).toEqual(expected);
  });

  it("assert becomes the model's InvariantIds", () => {
    expect(policy.asserts).toEqual(["I-1", "I-6"]);
  });

  it("a policy with no rules compiles to an empty, harmless policy", () => {
    const p = compile("policy bare { label \"nothing\" }").policies[0]!;
    expect(p.asserts).toEqual([]);
    expect(p.bounds).toBeUndefined();
    expect(p.profile).toBeUndefined();
    expect(p.pack).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Reference resolution — dangling references are COMPILE errors
// ---------------------------------------------------------------------------

describe("compile — a dangling reference is a positioned compile error", () => {
  function compileErr(src: string): WarpCompileError {
    try {
      compile(src, { file: "d.warp" });
    } catch (e) {
      return e as WarpCompileError;
    }
    throw new Error("expected a WarpCompileError, but compilation succeeded");
  }

  it("applies_to an undeclared profile names the declared ones", () => {
    const err = compileErr(`
      profile digital { states Draft value_forms Money }
      policy p {
        applies_to physical
      }
    `);
    expect(err).toBeInstanceOf(WarpCompileError);
    expect(err.message).toContain("applies_to profile 'physical'");
    expect(err.message).toContain("Declared profiles: digital");
    expect(err.line).toBe(4);
  });

  it("a forbidden state the model does not define is rejected, listing the real states", () => {
    const err = compileErr(`
      profile digital { states Draft value_forms Money }
      policy p { applies_to digital  forbid_states Reversed }
    `);
    expect(err.message).toContain("Unknown commitment state 'Reversed'");
    expect(err.message).toContain("in policy 'p' forbid_states");
  });

  it("an unknown invariant is rejected, listing the six", () => {
    const err = compileErr(`policy p { assert I7 }`);
    expect(err.message).toContain("Unknown invariant 'I7'");
    expect(err.message).toContain("I1, I2, I3, I4, I5, I6");
  });

  it("forbid_states without applies_to is rejected — there is nothing to narrow", () => {
    const err = compileErr(`policy p { forbid_states Disputed }`);
    expect(err.message).toContain("no 'applies_to'");
  });

  it("a floor above its committed price is rejected", () => {
    const err = compileErr(`policy p { concession_floor 300 MAD  committed_price 200 MAD }`);
    expect(err.message).toContain("above its");
  });

  it("a cross-currency floor is rejected (I-1)", () => {
    const err = compileErr(`policy p { concession_floor 150 EUR  committed_price 200 MAD }`);
    expect(err.message).toContain("cross-currency");
  });

  it("a policy may reference a profile declared AFTER it (two-pass resolution)", () => {
    const m = compile(`
      policy p { applies_to digital  forbid_states Disputed }
      profile digital { states Draft, Disputed value_forms Money }
    `);
    expect(m.policies[0]!.profile!.allowedStates).toEqual(["Draft"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Enforcement round-trip — authored rule == hand-written rule
// ---------------------------------------------------------------------------

/** A Draft deal carrying a 200 MAD opening price in its requested subject. */
function dealWorld(): { world: World; deal: Commitment } {
  const deal = newCommitment(BUYER, SELLER, {
    offered: [
      {
        id: valueId("value:licence"),
        form: {
          kind: "DigitalGood",
          identifier: "licence:single-seat",
          exclusivity: "NonExclusive",
          access_model: {
            kind: "License",
            license_type: "Perpetual",
            seats: 1,
            transferable: false,
          },
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
  return { world: { commitments: [deal], fulfillments: [], parties: [] }, deal };
}

describe("round-trip — an AUTHORED policy enforces identically to a hand-written rule", () => {
  const authored = compile(DOC).policies[0]!;

  /** The same negotiation bounds, written by hand. */
  const handWritten: NegotiationBounds = {
    floor: { amount: 150, currency: "MAD" },
    committed: { amount: 200, currency: "MAD" },
  };

  it("the authored bounds ARE the hand-written bounds", () => {
    expect(authored.bounds).toEqual(handWritten);
  });

  it("a concession WITHIN the floor is accepted identically", () => {
    const a = dealWorld();
    const b = dealWorld();
    const ra = guardConcession(a.world, a.deal.id, authored.bounds!).step({
      kind: "offer",
      price: { amount: 170, currency: "MAD" },
      by: SELLER,
    });
    const rb = guardConcession(b.world, b.deal.id, handWritten).step({
      kind: "offer",
      price: { amount: 170, currency: "MAD" },
      by: SELLER,
    });
    expect(ra.ok).toBe(true);
    expect(ra.ok).toBe(rb.ok);
  });

  it("a concession BELOW the floor is BLOCKED identically, with the same violation rules", () => {
    const a = dealWorld();
    const b = dealWorld();
    const ra = guardConcession(a.world, a.deal.id, authored.bounds!).step({
      kind: "offer",
      price: { amount: 120, currency: "MAD" },
      by: SELLER,
    });
    const rb = guardConcession(b.world, b.deal.id, handWritten).step({
      kind: "offer",
      price: { amount: 120, currency: "MAD" },
      by: SELLER,
    });
    expect(ra.ok).toBe(false);
    expect(rb.ok).toBe(false);
    if (ra.ok === false && rb.ok === false) {
      expect(ra.violations.map((v) => v.rule)).toEqual(rb.violations.map((v) => v.rule));
      expect(ra.violations.map((v) => v.message)).toEqual(rb.violations.map((v) => v.message));
    }
  });

  it("the narrowed profile blocks a forbidden state identically to the hand-written profile", () => {
    const base = compile(DOC).profiles[0]!;
    const handNarrowed: CommerceProfile = {
      ...base,
      id: "strict_digital",
      label: "No disputes on digital",
      // The narrowed profile keeps the BASE profile's description — guardWithProfile
      // renders it as "configured for <description>".
      description: base.description,
      allowedStates: base.allowedStates.filter((s) => s !== "Disputed"),
    };
    expect(authored.profile).toEqual(handNarrowed);

    const { world, deal } = dealWorld();
    const fulfilled: World = {
      ...world,
      commitments: [applyCommitmentPath(deal, { type: "Fulfilled" }, SELLER)],
    };
    const action = {
      commitment: fulfilled.commitments[0]!.id,
      to: { type: "Disputed" as const, by: BUYER, reason: "buyer unhappy", opened_at: "2026-03-01T00:00:00.000Z" },
      actor: BUYER,
    };
    const ra = guardWithProfile(authored.profile!, fulfilled, action);
    const rb = guardWithProfile(handNarrowed, fulfilled, action);
    expect(ra.ok).toBe(false);
    expect(ra).toEqual(rb);
    if (ra.ok === false) {
      expect(ra.violations[0]!.rule).toBe("profile-state");
    }
  });

  it("the authored pack checks a settlement identically to the hand-written pack", () => {
    const hand: RegulatoryPolicyPack = {
      id: "strict_digital",
      label: "No disputes on digital",
      description: "Digital sales settle or refund; they do not enter dispute.",
      jurisdictions: [{ jurisdiction: "MA", rates: [0, 0.1, 0.2] }],
    };
    expect(authored.pack).toEqual(hand);

    const committed = { amount: 240, currency: "MAD" };
    const settlement: MoneyBreakdown = {
      total: committed,
      components: [
        { kind: "Base", amount: { amount: 200, currency: "MAD" } },
        {
          kind: "Tax",
          amount: { amount: 40, currency: "MAD" },
          jurisdiction: "MA",
          tax_rate: 0.2,
        },
      ],
    };
    expect(checkSettlementPolicy(settlement, committed, authored.pack!)).toEqual(
      checkSettlementPolicy(settlement, committed, hand),
    );
    expect(checkSettlementPolicy(settlement, committed, authored.pack!).ok).toBe(true);

    // A rate the pack does not permit is refused — by the model's checker, not ours.
    const offRate: MoneyBreakdown = {
      total: committed,
      components: [
        { kind: "Base", amount: { amount: 200, currency: "MAD" } },
        {
          kind: "Tax",
          amount: { amount: 40, currency: "MAD" },
          jurisdiction: "MA",
          tax_rate: 0.17,
        },
      ],
    };
    const verdict = checkSettlementPolicy(offRate, committed, authored.pack!);
    expect(verdict.ok).toBe(false);
    expect(verdict).toEqual(checkSettlementPolicy(offRate, committed, hand));
  });
});

// ---------------------------------------------------------------------------
// 5. Safety — the language cannot smuggle an unsound outcome past the invariants
// ---------------------------------------------------------------------------

describe("safety — an authored policy cannot make an unsound world pass the invariants", () => {
  it("a policy asserting I-1 does not stop the model from FINDING an I-1 violation", () => {
    // A policy can SAY a deal must conserve value. It cannot MAKE it so — the
    // check belongs to the model, and it still reports the violation.
    const policy = compile(`policy conserve { assert I1 }`).policies[0]!;
    expect(policy.asserts).toEqual(["I-1"]);

    // A commitment that mixes currencies in its requested subject breaks I-1.
    const bad = newCommitment(BUYER, SELLER, {
      offered: [],
      requested: [
        {
          id: valueId("value:a"),
          form: { kind: "Money", money: { amount: 100, currency: "MAD" } },
          quantity: 1,
          state: { type: "Available" },
        },
        {
          id: valueId("value:b"),
          form: { kind: "Money", money: { amount: 50, currency: "EUR" } },
          quantity: 1,
          state: { type: "Available" },
        },
      ],
    });

    const violations = auditCommerce([bad], [], []);
    const asserted = violations.filter((v) => policy.asserts.includes(v.invariant));
    expect(asserted.length).toBeGreaterThan(0);
    expect(asserted[0]!.invariant).toBe("I-1");
  });

  it("a policy that FORGETS to assert an invariant does not disable it", () => {
    // The policy asserts only I-6. The I-1 violation is still found by the model;
    // the policy's assert list SELECTS what it cares about, it does not gate what
    // the model checks. A language that could switch invariants off would be a
    // way to smuggle unsound commerce past them.
    const policy = compile(`policy narrow { assert I6 }`).policies[0]!;
    const bad = newCommitment(BUYER, SELLER, {
      offered: [],
      requested: [
        {
          id: valueId("value:a"),
          form: { kind: "Money", money: { amount: 100, currency: "MAD" } },
          quantity: 1,
          state: { type: "Available" },
        },
        {
          id: valueId("value:b"),
          form: { kind: "Money", money: { amount: 50, currency: "EUR" } },
          quantity: 1,
          state: { type: "Available" },
        },
      ],
    });
    const all = auditCommerce([bad], [], []);
    expect(all.some((v) => v.invariant === "I-1")).toBe(true);
    expect(policy.asserts).toEqual(["I-6"]);
  });

  it("a permissive profile still cannot approve what guardAction rejects", () => {
    // The policy narrows nothing and forbids nothing — the widest profile it can
    // author. An illegal transition is STILL blocked, because guardWithProfile
    // delegates to the unmodified guardAction. A profile only ever narrows.
    const m = compile(`
      profile wide {
        states Draft, Proposed, Tendered, Accepted, Modified, Active,
               PartiallyFulfilled, Fulfilled, Disputed, Cancelled, Refunded
        value_forms DigitalGood, Money
      }
      policy permissive { applies_to wide }
    `);
    const policy = m.policies[0]!;
    expect(policy.profile!.allowedStates).toContain("Fulfilled");

    const { world, deal } = dealWorld();
    // Draft -> Fulfilled is not a legal move in the model's table.
    const verdict = guardWithProfile(policy.profile!, world, {
      commitment: deal.id,
      to: { type: "Fulfilled" },
      actor: SELLER,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.violations.some((v) => v.rule === "I-2")).toBe(true);
    }
  });
});
