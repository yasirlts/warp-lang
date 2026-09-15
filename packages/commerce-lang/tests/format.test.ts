/**
 * Rung D — the formatter's guarantees, tested rather than promised.
 *
 * The one that matters: formatting NEVER changes meaning. For every source
 * here, `parse(format(src))` must equal `parse(src)` once positions are
 * stripped. A formatter that could alter an AST — drop a parenthesis, reorder a
 * transition, lose a field — would be a way to change a commerce system without
 * a diff anyone reads. This file makes that impossible to ship.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { format, formatExprCanonical } from "../src/format.js";
import { parse } from "../src/parser.js";
import { WarpSyntaxError } from "../src/errors.js";
import type { PolicyDecl } from "../src/ast.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/** The AST with every position removed — what "same meaning" compares. */
function shape(src: string): unknown {
  return JSON.parse(JSON.stringify(parse(src), (k, v) => (k === "pos" || k === "end" ? undefined : v)));
}

/** Every construct the language has, in one file, deliberately messy. */
const EVERYTHING = `
# header comment
#   with a second line

lifecycle   sales{
  state Draft   # opening
  state Proposed
   state Tendered
  state Accepted
  state Fulfilled
  state Cancelled
  Draft->Proposed,Tendered,  Cancelled
  Proposed  -> Accepted , Cancelled
  Tendered -> Accepted, Cancelled
  # a comment between transitions
  Accepted -> Fulfilled, Cancelled
}
profile digital { label "Digital goods"
description "digital goods paid in money"
  states Draft, Proposed, Accepted, Fulfilled, Cancelled
  value_forms DigitalGood,Money }

auction "auction:spectrum" {
  subject "value:block-a"   seller "party:regulator"
  opens_at "2026-03-01T09:00:00.000Z"
  closes_at "2026-03-07T17:00:00.000Z"
  mechanism ScoredSelection {
    criterion "price" 0.6 100
    criterion "tech" 0.4 100
    minimum_threshold 65
    committee "party:a", "party:b"
    publication_required true
  }
  tender "commitment:bid-1" { offer 1050000 MAD  closes_at "2026-03-07T17:00:00.000Z" }
  tender "commitment:bid-2" {
    offer 1100000 MAD
    closes_at "2026-03-07T17:00:00.000Z"
    superseded_by "commitment:bid-1"
  }
  state Closed { reason NormalClose  winner "commitment:bid-2"  winning_price 1100000 MAD }
}

policy house { label "House"
  applies_to digital
  forbid_states Cancelled
  concession_floor (committed - 50 MAD) * 0.75   # computed
  committed_price 200 MAD
  tax_rates "MA" 0,0.1,0.2
  tax_rates "FR" 0, 0.2
  assert I1,I6
}

composition mp {
  label "Marketplace"
  leg payout { amount committed - (10 MAD - 5 MAD) }
  leg fee { amount max(committed * 0.1, 5 MAD) }
}
`;

describe("format — never changes meaning", () => {
  it("parse(format(src)) equals parse(src) for a file using every construct", () => {
    const formatted = format(EVERYTHING);
    expect(shape(formatted)).toEqual(shape(EVERYTHING));
  });

  it("is idempotent: format(format(x)) === format(x)", () => {
    const once = format(EVERYTHING);
    expect(format(once)).toBe(once);
  });

  it("keeps parentheses that carry meaning, and only those", () => {
    const src = `policy p {
      concession_floor (committed - 50 MAD) * 2
      committed_price committed - (10 MAD - 5 MAD)
    }`;
    const out = format(src);
    expect(out).toContain("(committed - 50 MAD) * 2");
    expect(out).toContain("committed - (10 MAD - 5 MAD)");
    // Redundant parens are dropped: (a * b) + c needs none.
    const redundant = format(`policy p { concession_floor (committed * 2) + 5 MAD }`);
    expect(redundant).toContain("committed * 2 + 5 MAD");
    expect(shape(redundant)).toEqual(shape(`policy p { concession_floor (committed * 2) + 5 MAD }`));
  });

  it("keeps every comment, in place", () => {
    const out = format(EVERYTHING);
    expect(out).toContain("# header comment");
    expect(out).toContain("# with a second line");
    expect(out).toContain("state Draft  # opening");
    expect(out).toContain("# a comment between transitions");
    expect(out).toContain("# computed");
  });

  it("preserves the author's order — it lays out, it does not rearrange", () => {
    // Transitions authored out of state order stay out of state order.
    const src = `lifecycle l {
      state B
      state A
      B -> A
    }`;
    const out = format(src);
    expect(out.indexOf("state B")).toBeLessThan(out.indexOf("state A"));
    expect(shape(out)).toEqual(shape(src));
  });

  it("aligns keys and arrows within a block", () => {
    const out = format(`profile p { label "x"  description "y"  states Draft  value_forms Money }`);
    expect(out).toBe(`profile p {\n  label       "x"\n  description "y"\n  states      Draft\n  value_forms Money\n}\n`);
  });

  it("refuses malformed input with the parser's own positioned error", () => {
    expect(() => format(`lifecycle l { state }`)).toThrow(WarpSyntaxError);
  });

  it("re-quotes strings with the escapes the lexer reads", () => {
    const src = `profile p { label "say \\"hi\\"\\n"  states Draft  value_forms Money }`;
    expect(shape(format(src))).toEqual(shape(src));
  });
});

describe("format — every commerce-lang .warp file in the repo", () => {
  /** Walk the repo for .warp files, skipping node_modules. */
  function warpFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git" || name === "target") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) warpFiles(p, out);
      else if (name.endsWith(".warp")) out.push(p);
    }
    return out;
  }

  const files = warpFiles(REPO);
  const commerceLang = files.filter((f) => {
    try {
      parse(readFileSync(f, "utf8"));
      return true;
    } catch {
      return false; // the workflow DSL shares the extension; those are not ours to format
    }
  });

  it("finds at least the deploy-host system", () => {
    expect(commerceLang.some((f) => f.endsWith("examples/deploy-host/shop.warp"))).toBe(true);
  });

  for (const f of commerceLang) {
    const rel = f.replace(`${REPO}/`, "");
    it(`${rel}: formats to itself (already canonical), idempotently, with the same AST`, () => {
      const src = readFileSync(f, "utf8");
      const out = format(src, { file: rel });
      expect(shape(out)).toEqual(shape(src));
      expect(format(out)).toBe(out);
      // The files we ship are kept canonical, so a reader sees the formatter's
      // output as the house style.
      expect(out).toBe(src);
    });
  }

  it("the workflow-DSL .warp files are recognised as a different language, not silently formatted", () => {
    const other = files.filter((f) => !commerceLang.includes(f));
    expect(other.length).toBeGreaterThan(0);
    for (const f of other) expect(() => format(readFileSync(f, "utf8"))).toThrow(WarpSyntaxError);
  });
});

describe("formatExprCanonical", () => {
  const exprOf = (s: string) => (parse(`policy p { concession_floor ${s} }`).declarations[0] as PolicyDecl).fields[0]!.expr!;
  it.each([
    ["committed * 0.75", "committed * 0.75"],
    ["(committed - 50 MAD) * 2", "(committed - 50 MAD) * 2"],
    ["committed - (10 MAD - 5 MAD)", "committed - (10 MAD - 5 MAD)"],
    ["(committed * 2) + 5 MAD", "committed * 2 + 5 MAD"],
    ["max(committed * 0.5, 100 MAD)", "max(committed * 0.5, 100 MAD)"],
    ["committed / (2 * 2)", "committed / (2 * 2)"],
  ])("%s → %s", (input, expected) => {
    expect(formatExprCanonical(exprOf(input))).toBe(expected);
  });
});
