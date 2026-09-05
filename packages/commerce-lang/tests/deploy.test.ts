/**
 * Rung C — deployment. An authored `.warp` system leaves the repo as DATA and is
 * run by a host that only has the runtime library.
 *
 * The load-bearing test is the BOUNDARY one at the bottom. Everything else here
 * checks the artifact behaves (deterministic, round-trips, refuses to lose a
 * rule); that one checks the claim the rung is actually making — that the host
 * imports the library and never the compiler. A sentence in a README saying so is
 * worth nothing, because the next edit can quietly break it. Reading the host's
 * own imports is worth something.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runModel } from "@warp-lang/commerce-types";
import type { CommerceModel, World } from "@warp-lang/commerce-types";
import { applyCommitmentPath, newCommitment, partyId, valueId } from "@warp-lang/commerce-types";
import { compileSystem } from "../src/system.js";
import {
  loadModel,
  serializeModel,
  serializeSystem,
  undeployableValues,
  WarpDeployError,
} from "../src/artifact.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = join(HERE, "..", "..", "..", "examples", "deploy-host");

const SELLER = partyId("party:merchant");
const BUYER = partyId("party:buyer");
const FIXED = () => "2030-01-01T00:00:00.000Z";

/** The system the deploy-host actually ships — read from disk, not duplicated here. */
const SHOP = readFileSync(join(HOST_DIR, "shop.warp"), "utf8");

function deal(amount: number, state?: Parameters<typeof applyCommitmentPath>[1]) {
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
        form: { kind: "Money", money: { amount, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  return state ? applyCommitmentPath(c, state, SELLER) : c;
}
const worldWith = (c: ReturnType<typeof deal>): World => ({ commitments: [c], fulfillments: [], parties: [] });

// ---------------------------------------------------------------------------
// 1. The artifact
// ---------------------------------------------------------------------------

describe("the artifact — canonical, deterministic, lossless", () => {
  const system = compileSystem(SHOP, { file: "shop.warp" });

  it("serializing twice gives byte-identical output", () => {
    expect(serializeSystem(system)).toBe(serializeSystem(compileSystem(SHOP, { file: "shop.warp" })));
  });

  it("key order does not depend on the order fields were built in", () => {
    const a: CommerceModel = { id: "m", label: "L", profile: undefined, policies: [] };
    const b: CommerceModel = { policies: [], label: "L", id: "m" };
    expect(serializeModel(a)).toBe(serializeModel(b));
  });

  it("round-trips: load(serialize(model)) deep-equals the model", () => {
    const model = system.model;
    expect(loadModel(serializeModel(model))).toEqual(model);
  });

  it("ends with a newline, so it is a well-formed text file", () => {
    expect(serializeSystem(system).endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The loaded model behaves identically to the in-memory one
// ---------------------------------------------------------------------------

describe("a LOADED model runs identically to the in-memory model", () => {
  const system = compileSystem(SHOP, { file: "shop.warp" });
  const loaded = loadModel(serializeSystem(system));

  const cases: { label: string; make: () => { world: World; event: Parameters<typeof runModel>[2][number] } }[] = [
    {
      label: "a valid accept",
      make: () => {
        const c = deal(200, { type: "Proposed" });
        return { world: worldWith(c), event: { type: "action", action: { commitment: c.id, to: { type: "Accepted" }, actor: SELLER } } };
      },
    },
    {
      label: "a concession below the floor",
      make: () => {
        const c = deal(200);
        return { world: worldWith(c), event: { type: "concession", commitment: c.id, kind: "offer", price: { amount: 120, currency: "MAD" }, by: SELLER } };
      },
    },
    {
      label: "an over-refund",
      make: () => {
        const c = deal(200, { type: "Fulfilled" });
        return {
          world: worldWith(c),
          event: {
            type: "action",
            action: { commitment: c.id, to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2030-02-01T00:00:00.000Z" }, actor: SELLER },
          },
        };
      },
    },
  ];

  for (const { label, make } of cases) {
    it(`${label}: same verdict, same layer, same violations`, () => {
      // ONE world and ONE event, run through both models. runModel is pure, so
      // this is safe — and it is the stronger comparison: identical input, so any
      // difference is the model's, not an artefact of two freshly-minted
      // commitments having different ids.
      const { world, event } = make();
      const viaMemory = runModel(system.model, world, [event], { clock: FIXED });
      const viaLoaded = runModel(loaded, world, [event], { clock: FIXED });
      expect(viaLoaded.verdicts[0]!.ok).toBe(viaMemory.verdicts[0]!.ok);
      expect(viaLoaded.verdicts[0]!.layer).toBe(viaMemory.verdicts[0]!.layer);
      expect(viaLoaded.verdicts[0]!.violations).toEqual(viaMemory.verdicts[0]!.violations);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. A rule that cannot be baked in is REFUSED, not silently dropped
// ---------------------------------------------------------------------------

describe("a computed value is refused rather than silently lost", () => {
  const derived = compileSystem(`policy p { concession_floor committed * 0.75 }`);

  it("is reported as undeployable, naming the policy and the expression", () => {
    expect(undeployableValues(derived)).toEqual([
      { policy: "p", field: "concession_floor", source: "committed * 0.75" },
    ]);
  });

  it("serializeSystem throws rather than shipping a model missing the rule", () => {
    expect(() => serializeSystem(derived)).toThrow(WarpDeployError);
    try {
      serializeSystem(derived);
    } catch (e) {
      expect((e as Error).message).toContain("would DROP these rules silently");
      expect((e as Error).message).toContain("resolveForCommitment");
    }
  });

  it("this is the failure it prevents: the raw model has NO bounds at all", () => {
    // Without the check, `serializeModel(system.model)` would emit a policy with
    // no `bounds` — a host would load it, enforce no floor, and nothing would say
    // a rule went missing. That is why the refusal exists.
    const raw = loadModel(serializeModel(derived.model));
    expect(raw.policies![0]!.bounds).toBeUndefined();
  });

  it("a constant policy deploys fine", () => {
    const constant = compileSystem(`policy p { concession_floor 150 MAD }`);
    expect(undeployableValues(constant)).toEqual([]);
    expect(loadModel(serializeSystem(constant)).policies![0]!.bounds!.floor).toEqual({
      amount: 150,
      currency: "MAD",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. THE BOUNDARY — mechanized, because the claim is only as good as its check
// ---------------------------------------------------------------------------

describe("the deploy host imports the LIBRARY, never the compiler", () => {
  const hostSource = readFileSync(join(HOST_DIR, "host.mjs"), "utf8");
  /** Every module specifier the host imports. */
  const specifiers = [...hostSource.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1] as string);

  it("imports at least the runtime library (the test is reading real imports)", () => {
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers).toContain("@warp-lang/commerce-types");
  });

  it("imports NOTHING from this repo's source", () => {
    const offenders = specifiers.filter(
      (s) => s.startsWith(".") || s.startsWith("/") || s.includes("commerce-lang") || s.includes("packages/") || s.includes("src/"),
    );
    expect(offenders).toEqual([]);
  });

  it("never imports the compiler package", () => {
    // Deliberately checks the IMPORT SPECIFIERS, not the raw text. The host's own
    // header comment names @warp-lang/commerce-lang in order to say it does not
    // import it, and a naive grep would flag that sentence — proving only that
    // grepping prose is not the same as reading imports.
    expect(specifiers).not.toContain("@warp-lang/commerce-lang");
    const importedNames = hostSource
      .split("\n")
      .filter((l) => /^\s*import\s/.test(l) || /^\s*}\s*from\s/.test(l))
      .join("\n");
    expect(importedNames).not.toContain("compileSystem");
    expect(importedNames).not.toContain("commerce-lang");
  });

  it("imports only the runtime library and node builtins", () => {
    const allowed = specifiers.filter((s) => s === "@warp-lang/commerce-types" || s.startsWith("node:"));
    expect(allowed).toEqual(specifiers);
  });

  it("declares the library as its ONLY dependency", () => {
    const pkg = JSON.parse(readFileSync(join(HOST_DIR, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies)).toEqual(["@warp-lang/commerce-types"]);
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("the committed sample artifact is loadable and carries the authored rules", () => {
    // Committed so the artifact is inspectable in review, not just generated in CI.
    const sample = loadModel(readFileSync(join(HOST_DIR, "model.json"), "utf8"));
    expect(sample.id).toBe("sales");
    expect(sample.profile!.id).toBe("digital");
    expect(sample.policies![0]!.bounds!.floor).toEqual({ amount: 150, currency: "MAD" });
  });

  it("the committed artifact matches what the compiler produces today", () => {
    // If someone edits shop.warp without recompiling, this fails — the artifact
    // and its source cannot drift apart unnoticed.
    const fresh = serializeSystem(compileSystem(SHOP, { file: "shop.warp" }));
    expect(readFileSync(join(HOST_DIR, "model.json"), "utf8")).toBe(fresh);
  });
});
