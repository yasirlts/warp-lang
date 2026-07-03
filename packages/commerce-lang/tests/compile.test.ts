/**
 * Compiler tests: AST → the EXACT model structures. A lifecycle lowers to the
 * transition table `verifyLifecycle`/`reachableStates` consume; a profile lowers
 * to the `CommerceProfile` `guardWithProfile` consumes. Plus the semantic checks
 * that keep the language anchored to the frozen model (unknown state, undeclared
 * reference, duplicate, missing profile field) — each positioned.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.js";
import { WarpCompileError } from "../src/errors.js";

describe("compiler — lifecycle → transition table", () => {
  it("produces the exact table, including terminal states as []", () => {
    const { lifecycles } = compile(`
      lifecycle c {
        state Draft
        state Proposed
        state Cancelled
        Draft    -> Proposed, Cancelled
        Proposed -> Cancelled
        // Cancelled is terminal
      }
    `);
    expect(lifecycles).toHaveLength(1);
    const lc = lifecycles[0]!;
    expect(lc.name).toBe("c");
    expect(lc.states).toEqual(["Draft", "Proposed", "Cancelled"]);
    expect(lc.transitions).toEqual({
      Draft: ["Proposed", "Cancelled"],
      Proposed: ["Cancelled"],
      Cancelled: [],
    });
    // transitionFn mirrors the table; unknown/terminal states yield [].
    expect(lc.transitionFn("Draft")).toEqual(["Proposed", "Cancelled"]);
    expect(lc.transitionFn("Cancelled")).toEqual([]);
  });

  it("a declared state with no transition line is terminal ([])", () => {
    const lc = compile(`lifecycle c { state Draft state Cancelled Draft -> Cancelled }`)
      .lifecycles[0]!;
    expect(lc.transitions.Cancelled).toEqual([]);
  });
});

describe("compiler — profile → CommerceProfile", () => {
  it("lowers all four fields exactly", () => {
    const p = compile(`
      profile digital {
        label "Digital goods"
        description "digital goods paid in money"
        states Draft, Fulfilled, Refunded
        value_forms DigitalGood, Money
      }
    `).profiles[0]!;
    expect(p).toEqual({
      id: "digital",
      label: "Digital goods",
      description: "digital goods paid in money",
      allowedStates: ["Draft", "Fulfilled", "Refunded"],
      allowedValueForms: ["DigitalGood", "Money"],
    });
  });

  it("label/description default to the id when omitted", () => {
    const p = compile(`profile p { states Draft value_forms Money }`).profiles[0]!;
    expect(p.label).toBe("p");
    expect(p.description).toBe("p");
  });

  it("dedupes repeated states and value forms", () => {
    const p = compile(`profile p { states Draft, Draft value_forms Money, Money }`).profiles[0]!;
    expect(p.allowedStates).toEqual(["Draft"]);
    expect(p.allowedValueForms).toEqual(["Money"]);
  });
});

describe("compiler — semantic errors keep the language anchored to the model", () => {
  function expectCompileErrorContaining(src: string, needle: string, line?: number) {
    try {
      compile(src, { file: "t.warp" });
      throw new Error("expected a WarpCompileError, but compilation succeeded");
    } catch (e) {
      expect(e).toBeInstanceOf(WarpCompileError);
      const err = e as WarpCompileError;
      expect(err.message).toContain(needle);
      if (line !== undefined) expect(err.line).toBe(line);
    }
  }

  it("rejects a state the frozen model does not define", () => {
    // 'Shipped' is not one of the model's commitment states.
    expectCompileErrorContaining(
      `lifecycle c { state Draft state Shipped Draft -> Shipped }`,
      "Unknown commitment state 'Shipped'",
    );
  });

  it("lists the valid states in the unknown-state message", () => {
    try {
      compile(`lifecycle c { state Nope }`);
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as WarpCompileError).message;
      // The valid set is read from the model itself, not hardcoded.
      for (const s of ["Draft", "Proposed", "Accepted", "Fulfilled", "Refunded", "Cancelled"]) {
        expect(msg).toContain(s);
      }
    }
  });

  it("rejects a transition referencing an undeclared state", () => {
    expectCompileErrorContaining(
      `lifecycle c { state Draft Draft -> Proposed }`,
      "Transition target 'Proposed' is not a declared state",
    );
  });

  it("rejects a duplicate state declaration", () => {
    expectCompileErrorContaining(
      `lifecycle c { state Draft state Draft }`,
      "Duplicate state 'Draft'",
    );
  });

  it("rejects two transition lists for the same source", () => {
    expectCompileErrorContaining(
      `lifecycle c { state Draft state Proposed state Cancelled Draft -> Proposed Draft -> Cancelled }`,
      "already has a transition list",
    );
  });

  it("rejects a profile missing 'states'", () => {
    expectCompileErrorContaining(`profile p { value_forms Money }`, "missing required field 'states'");
  });

  it("rejects a profile missing 'value_forms'", () => {
    expectCompileErrorContaining(`profile p { states Draft }`, "missing required field 'value_forms'");
  });

  it("rejects an unknown state named in a profile", () => {
    expectCompileErrorContaining(
      `profile p { states Draft, Shipped value_forms Money }`,
      "Unknown commitment state 'Shipped'",
    );
  });

  it("rejects duplicate lifecycle names", () => {
    expectCompileErrorContaining(
      `lifecycle c { state Draft } lifecycle c { state Draft }`,
      "Duplicate lifecycle 'c'",
    );
  });
});
