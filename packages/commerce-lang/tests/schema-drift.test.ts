/**
 * The drift gate for the auction vocabularies.
 *
 * The commitment STATES the compiler accepts are read from the model at runtime
 * (`knownCommitmentStates` composes `reachableStates`), so they cannot drift. The
 * auction vocabularies cannot be obtained that way: `AuctionMechanism`,
 * `AuctionState` and `AuctionCloseReason` exist only as TypeScript unions, which
 * are erased at runtime — the model exposes no list of them to read. The compiler
 * therefore carries a small mirror of each.
 *
 * A mirror is only safe if something fails when it drifts. That is this file: it
 * reads `schema/structure/auxiliary.schema.json` — the single source of truth the
 * TS, Python, Rust and Go bindings are all generated from — and asserts the
 * compiler's lists are exactly the schema's. If the model gains a sixth auction
 * mechanism or a new close reason, these tests fail until the grammar is taught
 * about it. This is the same discipline as the repo's codegen-drift gates.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUCTION_CLOSE_REASONS,
  AUCTION_MECHANISM_KINDS,
  AUCTION_STATE_TYPES,
  MECHANISM_SPEC,
} from "../src/compile.js";

const SCHEMA_PATH = fileURLToPath(
  new URL("../../../schema/structure/auxiliary.schema.json", import.meta.url),
);

interface Variant {
  properties?: Record<string, unknown>;
  required?: string[];
}
interface Defs {
  AuctionMechanism: { oneOf: Variant[] };
  AuctionState: { oneOf: Variant[] };
  AuctionCloseReason: { enum: string[] };
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as { $defs: Defs };
const defs = schema.$defs;

/** The `const` of a variant's discriminant property (`kind` or `type`). */
function discriminant(v: Variant, key: string): string {
  return ((v.properties?.[key] as { const: string } | undefined) as { const: string }).const;
}

/** The variant of `AuctionMechanism` whose `kind` is `kind`. */
function mechanismVariant(kind: string): Variant {
  const v = defs.AuctionMechanism.oneOf.find((x) => discriminant(x, "kind") === kind);
  expect(v, `schema has no AuctionMechanism variant '${kind}'`).toBeDefined();
  return v as Variant;
}

/**
 * The grammar's field name for a schema property. Two ScoredSelection properties
 * read better in source as a repeated singular (`criterion "price" 0.6 100`) and
 * as a shorter word (`committee`); every other field is named as the schema names
 * it. The mapping is declared here so the drift check still compares like for like.
 */
const SOURCE_NAME: Readonly<Record<string, string>> = {
  criteria: "criterion",
  evaluation_committee: "committee",
};
const toSourceName = (p: string): string => SOURCE_NAME[p] ?? p;

describe("schema drift — the auction vocabularies mirror schema/structure/auxiliary.schema.json", () => {
  it("mechanism kinds are exactly the schema's AuctionMechanism variants", () => {
    const fromSchema = defs.AuctionMechanism.oneOf.map((v) => discriminant(v, "kind"));
    expect([...AUCTION_MECHANISM_KINDS].sort()).toEqual([...fromSchema].sort());
  });

  it("auction states are exactly the schema's AuctionState variants", () => {
    const fromSchema = defs.AuctionState.oneOf.map((v) => discriminant(v, "type"));
    expect([...AUCTION_STATE_TYPES].sort()).toEqual([...fromSchema].sort());
  });

  it("close reasons are exactly the schema's AuctionCloseReason enum", () => {
    expect([...AUCTION_CLOSE_REASONS].sort()).toEqual([...defs.AuctionCloseReason.enum].sort());
  });

  it("every mechanism's REQUIRED fields are exactly the schema's required (less `kind`)", () => {
    for (const kind of AUCTION_MECHANISM_KINDS) {
      const fromSchema = (mechanismVariant(kind).required ?? [])
        .filter((r) => r !== "kind")
        .map(toSourceName);
      const spec = MECHANISM_SPEC[kind] as { required: readonly string[] };
      expect([...spec.required].sort(), `required fields of '${kind}'`).toEqual(
        [...fromSchema].sort(),
      );
    }
  });

  it("every mechanism's PERMITTED fields are exactly the schema's properties (less `kind`)", () => {
    for (const kind of AUCTION_MECHANISM_KINDS) {
      const variant = mechanismVariant(kind);
      const fromSchema = Object.keys(variant.properties ?? {})
        .filter((p) => p !== "kind")
        .map(toSourceName);
      const spec = MECHANISM_SPEC[kind] as { required: readonly string[]; optional: readonly string[] };
      expect([...spec.required, ...spec.optional].sort(), `fields of '${kind}'`).toEqual(
        [...fromSchema].sort(),
      );
    }
  });
});
