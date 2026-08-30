/**
 * Rung 5A — derived logic. A policy value may be computed from the commerce
 * context instead of typed as a constant.
 *
 * THE TEST THAT MATTERS IS THE SAFETY ONE. "computed unsound value is refused
 * identically to the literal" is the property that keeps Warp's guarantee intact
 * once the language can compute. Everything else here is power and hygiene; that
 * one is the guarantee. It is written as a direct comparison — the same guard,
 * the same world, a computed floor and the equivalent literal floor — because
 * "behaves the same" is only worth asserting against the alternative it claims to
 * match.
 */
import { describe, expect, it } from "vitest";
import {
  applyCommitmentPath,
  guardConcession,
  newCommitment,
  partyId,
  runModel,
  valueId,
} from "@warp-lang/commerce-types";
import type { Commitment, World } from "@warp-lang/commerce-types";
import { compileSystem, deriveContext, resolveForCommitment, resolveSystem } from "../src/system.js";
import { evaluate, money, num, type EvalContext, type Expr } from "../src/expr.js";
import { compile } from "../src/compile.js";
import { parse } from "../src/parser.js";
import { WarpCompileError } from "../src/errors.js";
import type { PolicyDecl } from "../src/ast.js";

const SELLER = partyId("party:merchant");
const BUYER = partyId("party:buyer");
const FIXED = () => "2030-01-01T00:00:00.000Z";

/** A deal committed at `amount`, optionally with a fixed term. */
function deal(amount: number, opts: { endsAt?: string; state?: Parameters<typeof applyCommitmentPath>[1] } = {}): Commitment {
  const c = newCommitment(BUYER, SELLER, {
    offered: [],
    requested: [
      {
        id: valueId("value:price"),
        form: { kind: "Money", money: { amount, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  const withTerms: Commitment =
    opts.endsAt === undefined
      ? c
      : { ...c, terms: { duration: { kind: "Fixed", ends_at: opts.endsAt } } };
  return opts.state ? applyCommitmentPath(withTerms, opts.state, SELLER) : withTerms;
}
const worldWith = (c: Commitment): World => ({ commitments: [c], fulfillments: [], parties: [] });

/** `floor = committed * 0.75`. */
const DERIVED_FLOOR = `
  policy house {
    label "Three quarters"
    concession_floor committed * 0.75
  }
`;

// ---------------------------------------------------------------------------
// 1. Parsing
// ---------------------------------------------------------------------------

describe("parse — a value position accepts an expression", () => {
  it("a money literal is still a money literal (back-compatible)", () => {
    const doc = parse(`policy p { concession_floor 150 MAD }`);
    const policy = doc.declarations[0] as PolicyDecl;
    expect(policy.fields[0]!.expr).toEqual({
      kind: "money",
      amount: 150,
      currency: "MAD",
      pos: expect.anything(),
    });
  });

  it("parses arithmetic with correct precedence", () => {
    // committed - 100 MAD * 2  ==  committed - (100 MAD * 2)
    const doc = parse(`policy p { concession_floor committed - 100 MAD * 2 }`);
    const e = (doc.declarations[0] as PolicyDecl).fields[0]!.expr as Expr;
    expect(e.kind).toBe("binary");
    if (e.kind === "binary") {
      expect(e.op).toBe("-");
      expect(e.left.kind).toBe("var");
      expect(e.right.kind).toBe("binary");
    }
  });

  it("parses parentheses, min and max", () => {
    const doc = parse(`policy p { concession_floor max(committed * 0.5, 100 MAD) }`);
    const e = (doc.declarations[0] as PolicyDecl).fields[0]!.expr as Expr;
    expect(e.kind).toBe("call");
    if (e.kind === "call") {
      expect(e.fn).toBe("max");
      expect(e.args).toHaveLength(2);
    }
  });

  it("an unknown variable is a positioned compile error naming the context", () => {
    let err: WarpCompileError | undefined;
    try {
      compile(`policy p {\n  concession_floor mrr * 0.75\n}`, { file: "d.warp" });
    } catch (e) {
      err = e as WarpCompileError;
    }
    expect(err).toBeInstanceOf(WarpCompileError);
    expect(err!.message).toContain("unknown variable 'mrr'");
    expect(err!.message).toContain("committed, quantity, term_days, elapsed_days, remaining_days");
    expect(err!.line).toBe(2);
  });

  it("`->` is still an arrow, not a minus", () => {
    const m = compile(`lifecycle l { state Draft  state Proposed  Draft -> Proposed }`);
    expect(m.lifecycles[0]!.transitions["Draft"]).toEqual(["Proposed"]);
  });
});

// ---------------------------------------------------------------------------
// 2. The evaluator: pure, total, currency-safe
// ---------------------------------------------------------------------------

describe("evaluate — pure, total, currency-safe", () => {
  const ctx: EvalContext = { committed: money(200, "MAD"), quantity: num(4) };
  const exprOf = (src: string): Expr =>
    (parse(`policy p { concession_floor ${src} }`).declarations[0] as PolicyDecl).fields[0]!.expr as Expr;

  it("is a function: the same expression and context always give the same value", () => {
    const e = exprOf("committed * 0.75");
    const a = evaluate(e, ctx);
    const b = evaluate(e, ctx);
    expect(a).toEqual(b);
    expect(a).toEqual({ ok: true, value: money(150, "MAD") });
  });

  it("scales money by a number, in both orders", () => {
    expect(evaluate(exprOf("committed * 0.5"), ctx)).toEqual({ ok: true, value: money(100, "MAD") });
    expect(evaluate(exprOf("0.5 * committed"), ctx)).toEqual({ ok: true, value: money(100, "MAD") });
  });

  it("adds and subtracts money in one currency", () => {
    expect(evaluate(exprOf("committed - 50 MAD"), ctx)).toEqual({ ok: true, value: money(150, "MAD") });
  });

  it("refuses to mix currencies — the error is a value, not a throw", () => {
    const r = evaluate(exprOf("committed + 50 EUR"), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("currency-mismatch");
      expect(r.error.message).toContain("Invariant 1");
    }
  });

  it("refuses money * money — a squared currency is meaningless", () => {
    const r = evaluate(exprOf("committed * committed"), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("type-error");
  });

  it("division by zero is an error value, not a throw or an Infinity", () => {
    const r = evaluate(exprOf("committed / 0"), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("division-by-zero");
  });

  it("an unavailable variable is an error — NOT silently zero", () => {
    // `remaining_days` has no value for a commitment with no fixed duration.
    // Treating it as 0 would compute a prorated refund of nothing and look fine.
    const r = evaluate(exprOf("committed * 0.5 - remaining_days"), { committed: money(200, "MAD") });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unavailable-variable");
      expect(r.error.message).toContain("not the same as being zero");
    }
  });

  it("min and max pick across money and refuse a mixed comparison", () => {
    expect(evaluate(exprOf("max(committed * 0.5, 120 MAD)"), ctx)).toEqual({
      ok: true,
      value: money(120, "MAD"),
    });
    const bad = evaluate(exprOf("min(committed, quantity)"), ctx);
    expect(bad.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Context derivation
// ---------------------------------------------------------------------------

describe("deriveContext — only what a commitment genuinely provides", () => {
  it("derives committed and quantity from the subject", () => {
    const ctx = deriveContext(deal(200));
    expect(ctx.committed).toEqual(money(200, "MAD"));
    expect(ctx.quantity).toEqual(num(1));
  });

  it("leaves the time variables absent with no fixed duration", () => {
    const ctx = deriveContext(deal(200), "2026-06-01T00:00:00.000Z");
    expect(ctx.term_days).toBeUndefined();
    expect(ctx.remaining_days).toBeUndefined();
  });

  it("derives term / elapsed / remaining days from a fixed duration and `now`", () => {
    const c = deal(200, { endsAt: "2026-04-01T00:00:00.000Z" });
    const created = Date.parse(c.created_at);
    const now = new Date(created + 10 * 86_400_000).toISOString();
    const ctx = deriveContext(c, now);
    expect(ctx.elapsed_days).toEqual(num(10));
    expect(ctx.term_days!.kind).toBe("number");
    const term = (ctx.term_days as { value: number }).value;
    expect(ctx.remaining_days).toEqual(num(Math.max(0, term - 10)));
  });

  it("leaves `committed` absent for a mixed-currency subject rather than picking one", () => {
    const c = newCommitment(BUYER, SELLER, {
      offered: [],
      requested: [
        { id: valueId("a"), form: { kind: "Money", money: { amount: 100, currency: "MAD" } }, quantity: 1, state: { type: "Available" } },
        { id: valueId("b"), form: { kind: "Money", money: { amount: 50, currency: "EUR" } }, quantity: 1, state: { type: "Available" } },
      ],
    });
    expect(deriveContext(c).committed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. POWER — a computed floor that varies with context
// ---------------------------------------------------------------------------

describe("power — the floor is computed, not hard-coded", () => {
  const system = compileSystem(DERIVED_FLOOR);

  it("compiles to a derived value, not a constant bound", () => {
    expect(system.policies[0]!.bounds).toBeUndefined();
    expect(system.policies[0]!.derived!.floor).toBeDefined();
  });

  it("a different committed amount yields a different floor", () => {
    const at200 = resolveForCommitment(system, deal(200));
    const at400 = resolveForCommitment(system, deal(400));
    expect(at200.ok && at200.model.policies![0]!.bounds!.floor).toEqual({ amount: 150, currency: "MAD" });
    expect(at400.ok && at400.model.policies![0]!.bounds!.floor).toEqual({ amount: 300, currency: "MAD" });
  });

  it("the computed floor is enforced: below is blocked, above passes", () => {
    const c = deal(200);
    const r = resolveForCommitment(system, c);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const below = runModel(r.model, worldWith(c), [
      { type: "concession", commitment: c.id, kind: "offer", price: { amount: 140, currency: "MAD" }, by: SELLER },
    ], { clock: FIXED });
    expect(below.verdicts[0]!.ok).toBe(false);
    expect(below.verdicts[0]!.layer).toBe("policy");

    const above = runModel(r.model, worldWith(c), [
      { type: "concession", commitment: c.id, kind: "offer", price: { amount: 160, currency: "MAD" }, by: SELLER },
    ], { clock: FIXED });
    expect(above.verdicts[0]!.ok).toBe(true);
  });

  it("proration: a floor computed from remaining term", () => {
    const src = `policy sub { concession_floor committed * (remaining_days / term_days) }`;
    const sys = compileSystem(src);
    const c = deal(365, { endsAt: "2027-01-01T00:00:00.000Z" });
    const created = Date.parse(c.created_at);
    const term = Math.floor((Date.parse("2027-01-01T00:00:00.000Z") - created) / 86_400_000);
    const halfway = new Date(created + Math.floor(term / 2) * 86_400_000).toISOString();
    const r = resolveForCommitment(sys, c, halfway);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const floor = r.model.policies![0]!.bounds!.floor;
    // Roughly half the committed value, and strictly between 0 and committed.
    expect(floor.currency).toBe("MAD");
    expect(floor.amount).toBeGreaterThan(0);
    expect(floor.amount).toBeLessThan(365);
  });

  it("a constant policy is unchanged — folded at compile time, no derived part", () => {
    const sys = compileSystem(`policy p { concession_floor 150 MAD  committed_price 200 MAD }`);
    expect(sys.policies[0]!.derived).toBeUndefined();
    expect(sys.policies[0]!.bounds).toEqual({
      floor: { amount: 150, currency: "MAD" },
      committed: { amount: 200, currency: "MAD" },
    });
  });
});

// ---------------------------------------------------------------------------
// 5. SAFETY — the language cannot compute its way past the invariants
// ---------------------------------------------------------------------------

describe("SAFETY — a computed unsound value is refused exactly like the literal", () => {
  /**
   * A floor of `committed * 0` is zero: it would permit conceding the entire
   * committed value away. `guardConcession` refuses a concession below the floor,
   * so what this really tests is that the computed number reaches the guard by
   * the same path a literal does, and is judged by the same rule — and, crucially,
   * that a formula cannot produce a bound the guard treats more leniently.
   */
  it("a computed floor and the identical literal floor produce IDENTICAL verdicts", () => {
    const c = deal(200);
    const computed = resolveForCommitment(compileSystem(DERIVED_FLOOR), c);
    const literal = compileSystem(`policy house { label "Three quarters"  concession_floor 150 MAD }`);
    expect(computed.ok).toBe(true);
    if (!computed.ok) return;

    const computedBounds = computed.model.policies![0]!.bounds!;
    const literalBounds = literal.policies[0]!.bounds!;
    // The computed bound IS the literal bound — same value, so the same input.
    expect(computedBounds.floor).toEqual(literalBounds.floor);

    for (const price of [140, 150, 160, 199]) {
      const viaComputed = guardConcession(worldWith(c), c.id, computedBounds).step({
        kind: "offer",
        price: { amount: price, currency: "MAD" },
        by: SELLER,
      });
      const viaLiteral = guardConcession(worldWith(c), c.id, literalBounds).step({
        kind: "offer",
        price: { amount: price, currency: "MAD" },
        by: SELLER,
      });
      expect(viaComputed.ok).toBe(viaLiteral.ok);
      if (viaComputed.ok === false && viaLiteral.ok === false) {
        expect(viaComputed.violations.map((v) => v.rule)).toEqual(viaLiteral.violations.map((v) => v.rule));
        expect(viaComputed.violations.map((v) => v.message)).toEqual(viaLiteral.violations.map((v) => v.message));
      }
    }
  });

  it("an over-refund is still I-1 under a computed policy — conservation is untouched", () => {
    // The expression layer produces a floor. It has no bearing whatsoever on the
    // invariants, and an unsound action is refused under a computed policy exactly
    // as under a constant one.
    const c = deal(200, { state: { type: "Fulfilled" } });
    const r = resolveForCommitment(compileSystem(DERIVED_FLOOR), c);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const verdict = runModel(r.model, worldWith(c), [
      {
        type: "action",
        action: {
          commitment: c.id,
          to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" },
          actor: SELLER,
        },
      },
    ], { clock: FIXED });
    expect(verdict.verdicts[0]!.ok).toBe(false);
    expect(verdict.verdicts[0]!.layer).toBe("base");
    expect(verdict.verdicts[0]!.violations!.some((v) => v.rule === "I-1")).toBe(true);
  });

  it("a computed floor ABOVE the committed price is refused, exactly as a literal one is", () => {
    // The compile-time check a constant gets (floor ≤ committed) is applied to the
    // evaluated numbers too. A derived value is held to the identical standard.
    const sys = compileSystem(`policy p { concession_floor committed * 2  committed_price 200 MAD }`);
    const r = resolveForCommitment(sys, deal(200));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failures[0]!.error.message).toContain("above the");
    // And the literal equivalent is refused at COMPILE time, by the pre-5A check.
    expect(() => compile(`policy p { concession_floor 400 MAD  committed_price 200 MAD }`)).toThrow(
      WarpCompileError,
    );
  });

  it("a currency mismatch between computed floor and committed price is refused", () => {
    const sys = compileSystem(`policy p { concession_floor committed * 0.75  committed_price 200 EUR }`);
    const r = resolveSystem(sys, { committed: money(200, "MAD") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0]!.error.code).toBe("currency-mismatch");
  });

  it("resolution failures are DATA — resolving never throws", () => {
    const sys = compileSystem(`policy p { concession_floor committed * 0.75 }`);
    // No `committed` in context at all.
    const r = resolveSystem(sys, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures[0]!.policy).toBe("p");
      expect(r.failures[0]!.field).toBe("concession_floor");
      expect(r.failures[0]!.source).toBe("committed * 0.75");
      expect(r.failures[0]!.error.code).toBe("unavailable-variable");
    }
  });
});
