/**
 * Rung 5A — DERIVED LOGIC: a policy value may be a computed expression over the
 * commerce context, not only a literal.
 *
 * THE SAFETY PROPERTY, WHICH IS THE WHOLE DESIGN. An expression changes how a
 * value is PRODUCED. It never changes whether that value is CHECKED. The
 * evaluator here turns an expression into a concrete `Money` or number, and that
 * value then populates exactly the model structure a literal populated —
 * `NegotiationBounds.floor` and the rest — where the SAME `guardConcession`,
 * `runModel` and invariant checks judge it. A formula that computes an unsound
 * value is refused exactly as if that number had been typed as a literal. There
 * is no path from an expression to the enforcement layer that a constant does not
 * also take. `tests/derived.test.ts` proves this by running the computed value and
 * the equivalent literal through the guard and requiring identical verdicts.
 *
 * WHAT THIS IS NOT. Not general-purpose computation: there are no loops, no
 * user-defined functions, no assignment, no side effects, no I/O, and no way to
 * read a clock. It is arithmetic over a bounded set of commerce quantities.
 *
 * TOTAL AND PURE. Every evaluation returns a value or a precise error — it never
 * throws and never samples anything. `evaluate(expr, ctx)` is a function in the
 * mathematical sense: the same expression and context always yield the same
 * result. Errors (an unknown variable, division by zero, a currency mismatch) are
 * returned as data so a caller can report them rather than catch them.
 *
 * CURRENCY SAFETY. Money is not a number. `MAD + EUR` is an error, not a silent
 * coercion; `Money * Money` is an error because a squared currency is meaningless.
 * The permitted algebra is small and deliberate:
 *
 *   Money  + Money   → Money   (same currency only)
 *   Money  - Money   → Money   (same currency only)
 *   Money  * number  → Money    (and number * Money)
 *   Money  / number  → Money
 *   number ∘ number  → number   (any operator)
 *   min/max(a, b)    → the same kind, same currency
 *
 * Everything else is a typed error naming what was attempted.
 */
import type { SourcePosition } from "./errors.js";

/** A money value produced by evaluation — the model's `Money` shape. */
export interface MoneyValue {
  kind: "money";
  amount: number;
  currency: string;
}

/** A dimensionless number produced by evaluation (a rate, a count, a ratio). */
export interface NumberValue {
  kind: "number";
  value: number;
}

/** What an expression evaluates to. */
export type Value = MoneyValue | NumberValue;

export const money = (amount: number, currency: string): MoneyValue => ({ kind: "money", amount, currency });
export const num = (value: number): NumberValue => ({ kind: "number", value });

/** Why an evaluation could not produce a value. Data, never a thrown error. */
export interface EvalError {
  /** A stable code so a caller can branch without matching on prose. */
  code:
    | "unknown-variable"
    | "unavailable-variable"
    | "currency-mismatch"
    | "division-by-zero"
    | "type-error";
  message: string;
  /** Where in the source the offending sub-expression is. */
  pos: SourcePosition;
}

/** The result of evaluating an expression: a value, or a precise reason it has none. */
export type EvalResult = { ok: true; value: Value } | { ok: false; error: EvalError };

const ok = (value: Value): EvalResult => ({ ok: true, value });
const err = (code: EvalError["code"], message: string, pos: SourcePosition): EvalResult => ({
  ok: false,
  error: { code, message, pos },
});

// ---------------------------------------------------------------------------
// The expression AST
// ---------------------------------------------------------------------------

/** `1500 MAD` — a money literal. */
export interface MoneyLitExpr {
  kind: "money";
  amount: number;
  currency: string;
  pos: SourcePosition;
}
/** `0.75` — a bare number. */
export interface NumberLitExpr {
  kind: "number";
  value: number;
  pos: SourcePosition;
}
/** `committed` — a reference to a commerce-context variable. */
export interface VarExpr {
  kind: "var";
  name: string;
  pos: SourcePosition;
}
/** `a * b` — a binary arithmetic operation. */
export interface BinaryExpr {
  kind: "binary";
  op: "+" | "-" | "*" | "/";
  left: Expr;
  right: Expr;
  pos: SourcePosition;
}
/** `min(a, b)` / `max(a, b)`. */
export interface CallExpr {
  kind: "call";
  fn: "min" | "max";
  args: Expr[];
  pos: SourcePosition;
}

/** A pure arithmetic expression over commerce quantities. */
export type Expr = MoneyLitExpr | NumberLitExpr | VarExpr | BinaryExpr | CallExpr;

/** The functions an expression may call. There are deliberately only two. */
export const EXPR_FUNCTIONS = ["min", "max"] as const;

// ---------------------------------------------------------------------------
// The commerce context — the ONLY variables an expression may reference
// ---------------------------------------------------------------------------

/**
 * The variables an expression may name, and what each means. This list is
 * closed: referencing anything else is a compile error naming these. Every one is
 * derivable from a commitment (plus an explicit `now` for the time-based three) —
 * nothing here requires the evaluator to read a clock or perform I/O.
 *
 * A variable that is not derivable for a given commitment is UNAVAILABLE, which
 * is an error when referenced — never a silent zero. A subscription rule that
 * asks for `remaining_days` on a commitment with no duration should fail loudly,
 * because a prorated refund computed against a zero term is not a small mistake.
 */
export const CONTEXT_VARIABLES = {
  committed:
    "the commitment's committed amount — the single-currency Money in its requested subject (Money)",
  quantity: "the total quantity across the commitment's requested values (number)",
  term_days:
    "whole days from the commitment's created_at to its fixed end (terms.duration.ends_at) — unavailable when the commitment has no fixed duration (number)",
  elapsed_days: "whole days from the commitment's created_at to `now` (number)",
  remaining_days: "term_days − elapsed_days, floored at 0 — unavailable without a fixed duration (number)",
} as const;

/** The name of a variable an expression may reference. */
export type ContextVariable = keyof typeof CONTEXT_VARIABLES;

/** The names, for error messages and validation. */
export const CONTEXT_VARIABLE_NAMES = Object.keys(CONTEXT_VARIABLES) as ContextVariable[];

/**
 * The values available when an expression is evaluated. A variable that is absent
 * (or explicitly `undefined`) is UNAVAILABLE: referencing it is an error, which is
 * different from it being zero.
 */
export type EvalContext = Partial<Record<ContextVariable, Value>>;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function describe(v: Value): string {
  return v.kind === "money" ? `${v.amount} ${v.currency}` : String(v.value);
}

/** Apply a binary operator to two evaluated values, with the currency algebra. */
function applyBinary(op: BinaryExpr["op"], l: Value, r: Value, pos: SourcePosition): EvalResult {
  // number ∘ number — ordinary arithmetic.
  if (l.kind === "number" && r.kind === "number") {
    if (op === "/" && r.value === 0) {
      return err("division-by-zero", `Division by zero: ${l.value} / 0.`, pos);
    }
    const value =
      op === "+" ? l.value + r.value : op === "-" ? l.value - r.value : op === "*" ? l.value * r.value : l.value / r.value;
    return ok(num(value));
  }

  // Money ∘ Money — only + and -, and only in one currency.
  if (l.kind === "money" && r.kind === "money") {
    if (l.currency !== r.currency) {
      return err(
        "currency-mismatch",
        `Cannot compute ${describe(l)} ${op} ${describe(r)} — different currencies. ` +
          `Value is not conserved across a currency mix; convert to one currency first ` +
          `(Invariant 1: Value Conservation).`,
        pos,
      );
    }
    if (op === "+" || op === "-") {
      return ok(money(op === "+" ? l.amount + r.amount : l.amount - r.amount, l.currency));
    }
    return err(
      "type-error",
      `Cannot compute ${describe(l)} ${op} ${describe(r)} — multiplying or dividing money by money ` +
        `has no meaning as a money amount. Scale money by a plain number instead (e.g. committed * 0.75).`,
      pos,
    );
  }

  // Money scaled by a number.
  const m = l.kind === "money" ? l : (r as MoneyValue);
  const k = l.kind === "money" ? (r as NumberValue) : (l as NumberValue);
  if (op === "*") return ok(money(m.amount * k.value, m.currency));
  if (op === "/") {
    if (l.kind === "number") {
      return err(
        "type-error",
        `Cannot compute ${describe(l)} / ${describe(r)} — dividing a number by money has no meaning. ` +
          `Divide money by a number instead.`,
        pos,
      );
    }
    if (k.value === 0) {
      return err("division-by-zero", `Division by zero: ${describe(m)} / 0.`, pos);
    }
    return ok(money(m.amount / k.value, m.currency));
  }
  return err(
    "type-error",
    `Cannot compute ${describe(l)} ${op} ${describe(r)} — money and a plain number can only be ` +
      `combined with '*' or '/'. Adding a bare number to money would lose the currency.`,
    pos,
  );
}

/**
 * Evaluate an expression against a commerce context.
 *
 * Pure and total: the same `(expr, ctx)` always produces the same result, and a
 * failure comes back as `{ ok: false, error }` rather than a thrown exception.
 */
export function evaluate(expr: Expr, ctx: EvalContext): EvalResult {
  switch (expr.kind) {
    case "money":
      return ok(money(expr.amount, expr.currency));
    case "number":
      return ok(num(expr.value));
    case "var": {
      if (!CONTEXT_VARIABLE_NAMES.includes(expr.name as ContextVariable)) {
        return err(
          "unknown-variable",
          `Unknown variable '${expr.name}'. An expression may reference only the commerce ` +
            `context: ${CONTEXT_VARIABLE_NAMES.join(", ")}.`,
          expr.pos,
        );
      }
      const v = ctx[expr.name as ContextVariable];
      if (v === undefined) {
        return err(
          "unavailable-variable",
          `'${expr.name}' is not available for this commitment — ` +
            `${CONTEXT_VARIABLES[expr.name as ContextVariable]}. It has no value here, which is ` +
            `not the same as being zero, so the expression cannot be evaluated.`,
          expr.pos,
        );
      }
      return ok(v);
    }
    case "binary": {
      const l = evaluate(expr.left, ctx);
      if (!l.ok) return l;
      const r = evaluate(expr.right, ctx);
      if (!r.ok) return r;
      return applyBinary(expr.op, l.value, r.value, expr.pos);
    }
    case "call": {
      const values: Value[] = [];
      for (const a of expr.args) {
        const v = evaluate(a, ctx);
        if (!v.ok) return v;
        values.push(v.value);
      }
      const [first, ...rest] = values as [Value, ...Value[]];
      let acc = first;
      for (const v of rest) {
        if (acc.kind !== v.kind) {
          return err(
            "type-error",
            `${expr.fn}() cannot compare ${describe(acc)} with ${describe(v)} — one is money and the ` +
              `other is a plain number.`,
            expr.pos,
          );
        }
        if (acc.kind === "money" && v.kind === "money" && acc.currency !== v.currency) {
          return err(
            "currency-mismatch",
            `${expr.fn}() cannot compare ${describe(acc)} with ${describe(v)} — different currencies.`,
            expr.pos,
          );
        }
        const a = acc.kind === "money" ? acc.amount : acc.value;
        const b = v.kind === "money" ? v.amount : (v as NumberValue).value;
        const pick = expr.fn === "min" ? Math.min(a, b) : Math.max(a, b);
        acc = pick === a ? acc : v;
      }
      return ok(acc);
    }
  }
}

/** True if this expression names no variables — i.e. it is a constant. */
export function isConstant(expr: Expr): boolean {
  switch (expr.kind) {
    case "money":
    case "number":
      return true;
    case "var":
      return false;
    case "binary":
      return isConstant(expr.left) && isConstant(expr.right);
    case "call":
      return expr.args.every(isConstant);
  }
}

/** Every context variable this expression references, deduped, in source order. */
export function variablesOf(expr: Expr): string[] {
  const out: string[] = [];
  const walk = (e: Expr): void => {
    if (e.kind === "var") {
      if (!out.includes(e.name)) out.push(e.name);
    } else if (e.kind === "binary") {
      walk(e.left);
      walk(e.right);
    } else if (e.kind === "call") {
      e.args.forEach(walk);
    }
  };
  walk(expr);
  return out;
}

/** Render an expression back to `.warp` source — for verdicts and diagnostics. */
export function formatExpr(expr: Expr): string {
  switch (expr.kind) {
    case "money":
      return `${expr.amount} ${expr.currency}`;
    case "number":
      return String(expr.value);
    case "var":
      return expr.name;
    case "binary":
      return `${formatExpr(expr.left)} ${expr.op} ${formatExpr(expr.right)}`;
    case "call":
      return `${expr.fn}(${expr.args.map(formatExpr).join(", ")})`;
  }
}
