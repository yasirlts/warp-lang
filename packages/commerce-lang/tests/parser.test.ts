/**
 * Parser tests: valid source → the correct AST; invalid source → a precise,
 * positioned {@link WarpSyntaxError}. The positional precision IS the feature —
 * every negative case asserts the exact line and column, not just that it threw.
 */
import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import { WarpSyntaxError } from "../src/errors.js";
import type { LifecycleDecl, ProfileDecl } from "../src/ast.js";

describe("parser — valid source → AST", () => {
  it("parses a lifecycle into states and transitions", () => {
    const doc = parse(`
      lifecycle commitment {
        state Draft
        state Proposed
        Draft -> Proposed, Cancelled
      }
    `);
    expect(doc.declarations).toHaveLength(1);
    const lc = doc.declarations[0] as LifecycleDecl;
    expect(lc.kind).toBe("lifecycle");
    expect(lc.name.name).toBe("commitment");
    expect(lc.states.map((s) => s.name.name)).toEqual(["Draft", "Proposed"]);
    expect(lc.transitions).toHaveLength(1);
    expect(lc.transitions[0]!.from.name).toBe("Draft");
    expect(lc.transitions[0]!.to.map((t) => t.name)).toEqual(["Proposed", "Cancelled"]);
  });

  it("parses a profile into its fields", () => {
    const doc = parse(`
      profile digital {
        label "Digital goods"
        description "digital goods paid in money"
        states Draft, Fulfilled
        value_forms DigitalGood, Money
      }
    `);
    const p = doc.declarations[0] as ProfileDecl;
    expect(p.kind).toBe("profile");
    expect(p.name.name).toBe("digital");
    const byKey = Object.fromEntries(p.fields.map((f) => [f.key, f]));
    expect(byKey.label!.text).toBe("Digital goods");
    expect(byKey.description!.text).toBe("digital goods paid in money");
    expect(byKey.states!.list!.map((i) => i.name)).toEqual(["Draft", "Fulfilled"]);
    expect(byKey.value_forms!.list!.map((i) => i.name)).toEqual(["DigitalGood", "Money"]);
  });

  it("ignores // and # line comments", () => {
    const doc = parse(`
      # a hash comment
      lifecycle x {   // trailing comment
        state Draft   # inline
      }
    `);
    expect((doc.declarations[0] as LifecycleDecl).states).toHaveLength(1);
  });

  it("records 1-based line/col on tokens (position provenance)", () => {
    const doc = parse("lifecycle a {\n  state Draft\n}");
    const lc = doc.declarations[0] as LifecycleDecl;
    // `state Draft` is on line 2; `Draft` starts at column 9.
    expect(lc.states[0]!.name.pos.line).toBe(2);
    expect(lc.states[0]!.name.pos.column).toBe(9);
  });

  it("accepts multiple declarations in one document", () => {
    const doc = parse(`
      lifecycle a { state Draft }
      profile p { states Draft value_forms Money }
    `);
    expect(doc.declarations.map((d) => d.kind)).toEqual(["lifecycle", "profile"]);
  });
});

describe("parser — invalid source → precise error", () => {
  /** Parse `src`, asserting it throws a WarpSyntaxError at (line, col). */
  function expectSyntaxErrorAt(src: string, line: number, column: number, expected?: string) {
    try {
      parse(src, { file: "t.warp" });
      throw new Error("expected a WarpSyntaxError, but parsing succeeded");
    } catch (e) {
      expect(e).toBeInstanceOf(WarpSyntaxError);
      const err = e as WarpSyntaxError;
      expect(err.line).toBe(line);
      expect(err.column).toBe(column);
      if (expected !== undefined) expect(err.expected).toBe(expected);
      expect(err.format()).toContain(`t.warp:${line}:${column}:`);
    }
  }

  it("missing '->' in a transition", () => {
    // line 3: `  Draft Proposed` — 'Proposed' begins at column 9.
    expectSyntaxErrorAt(
      "lifecycle c {\n  state Draft\n  Draft Proposed\n}",
      3,
      9,
      "'->' after the source state",
    );
  });

  it("missing opening brace", () => {
    // `lifecycle c state Draft` — 'state' begins at column 13.
    expectSyntaxErrorAt("lifecycle c state Draft", 1, 13, "'{'");
  });

  it("unterminated string literal", () => {
    // The opening quote is at column 9 on line 2.
    expectSyntaxErrorAt('profile p {\n  label "oops\n}', 2, 9, "a closing '\"'");
  });

  it("unexpected top-level keyword", () => {
    expectSyntaxErrorAt("widget w {}", 1, 1, "'lifecycle', 'profile', 'auction', or 'policy'");
  });

  it("stray '-' that is not an arrow", () => {
    expectSyntaxErrorAt("lifecycle c {\n  Draft - Proposed\n}", 2, 9, "'->'");
  });

  it("unknown profile field", () => {
    expectSyntaxErrorAt(
      'profile p {\n  color "red"\n}',
      2,
      3,
      "one of 'label', 'description', 'states', 'value_forms'",
    );
  });
});
