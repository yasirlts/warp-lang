/**
 * Rung C — the DEPLOYABLE ARTIFACT.
 *
 * A `.warp` file is source. What a host runs is a `CommerceModel`, and a
 * `CommerceModel` is plain data — so it serializes. That is the whole deployment
 * story: author in `.warp`, compile to `model.json`, ship the JSON, and let a
 * host that has never seen the compiler load and run it.
 *
 *   compileSystem(source).model  →  serializeModel(...)  →  model.json
 *                                                             │
 *                                   loadModel(...)  ←─────────┘
 *                                        │
 *                                   runModel(loaded, world, events)
 *
 * WHY THIS IS THE BOUNDARY THAT MATTERS. A host that imports the compiler is not
 * a deployment, it is the test harness with a different name. A host that imports
 * only the runtime library and loads DATA is an adopter. The artifact is what
 * makes the second thing possible, and `examples/deploy-host/` is a host built
 * that way, with a test that mechanically checks it never reaches into this repo.
 *
 * DETERMINISM. `serializeModel` emits canonical JSON: object keys sorted, two-space
 * indent, a trailing newline. The same model always produces byte-identical output,
 * so an artifact can be committed, diffed, and checksummed like any other build
 * output — and a rebuild that changes nothing changes no bytes.
 */
import type { CommerceModel } from "@warp-lang/commerce-types";
import { formatExpr } from "./expr.js";
import type { CompiledSystem } from "./system.js";

/** Recursively sort object keys so serialization is canonical. Arrays keep their order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      // `undefined` is not JSON; dropping it here keeps the artifact stable
      // whether a field was absent or explicitly undefined.
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a {@link CommerceModel} to canonical JSON — the deployable artifact.
 *
 * Deterministic: the same model always yields byte-identical text, because keys
 * are sorted and formatting is fixed. Round-trips exactly — `loadModel` of this
 * output deep-equals the input (minus any `undefined`-valued fields, which JSON
 * cannot represent and which mean the same as absent).
 */
export function serializeModel(model: CommerceModel): string {
  return `${JSON.stringify(canonical(model), null, 2)}\n`;
}

/**
 * Parse a serialized artifact back into a {@link CommerceModel}.
 *
 * This is a PARSE, not a validation: it does not re-check the model against the
 * schema, because a `CommerceModel` is not a schema object — it is a bundle of
 * structures the engine's own layers judge when they run. A malformed artifact
 * surfaces as an engine verdict, not as a silent acceptance. `runModel` never
 * trusts a model to be sound: the base guard, the profile layer and the policy
 * layer all decide for themselves on every event.
 */
export function loadModel(json: string): CommerceModel {
  return JSON.parse(json) as CommerceModel;
}


// ---------------------------------------------------------------------------
// Deployability — what a STATIC artifact can and cannot carry
// ---------------------------------------------------------------------------

/** A reason a system cannot be baked into a static artifact. */
export interface UndeployableValue {
  /** The policy holding the computed value. */
  policy: string;
  /** Which value — `concession_floor` or `committed_price`. */
  field: "concession_floor" | "committed_price";
  /** The expression as authored. */
  source: string;
}

/**
 * Find every value that cannot be serialized into a static artifact.
 *
 * A rung-5A DERIVED value (`concession_floor committed * 0.75`) is computed from
 * the commitment it applies to. There is no commitment at compile time, so there
 * is no number to bake in — and a `CommerceModel` carries numbers, not
 * expressions.
 *
 * This matters more than it sounds. Without this check the derived value simply
 * would NOT APPEAR in the artifact: the policy would serialize with no `bounds`
 * at all, a host would load it, enforce no floor, and nothing anywhere would say
 * a rule had gone missing. Silently dropping a rule is far worse than refusing to
 * ship one, so {@link serializeSystem} refuses.
 *
 * The two honest ways to deploy a computed rule are named in the error: use a
 * constant, or keep the compiler in-process and resolve per commitment with
 * `resolveForCommitment` before each run.
 */
export function undeployableValues(system: CompiledSystem): UndeployableValue[] {
  const out: UndeployableValue[] = [];
  for (const policy of system.policies) {
    if (policy.derived?.floor !== undefined) {
      out.push({ policy: policy.id, field: "concession_floor", source: formatExpr(policy.derived.floor) });
    }
    if (policy.derived?.committed !== undefined) {
      out.push({ policy: policy.id, field: "committed_price", source: formatExpr(policy.derived.committed) });
    }
  }
  return out;
}

/** Raised when a system carries values a static artifact cannot represent. */
export class WarpDeployError extends Error {
  readonly values: UndeployableValue[];
  constructor(values: UndeployableValue[]) {
    const list = values.map((v) => `  - policy '${v.policy}': ${v.field} = ${v.source}`).join("\n");
    super(
      `This system has computed values, which a static artifact cannot carry:\n${list}\n\n` +
        `A computed value depends on the commitment it applies to, and a model.json holds ` +
        `numbers rather than expressions — so serializing would DROP these rules silently, ` +
        `and a host would enforce nothing where you wrote a rule.\n\n` +
        `Two ways forward:\n` +
        `  1. Use a constant (e.g. 'concession_floor 150 MAD') if the value does not vary.\n` +
        `  2. Keep the compiler in-process and call resolveForCommitment(system, commitment) ` +
        `before each run, which computes the value against a real commitment.`,
    );
    this.name = "WarpDeployError";
    this.values = values;
  }
}

/**
 * Serialize a compiled system to a deployable artifact, refusing to ship one that
 * would silently lose a computed rule. Prefer this over {@link serializeModel}
 * whenever you hold the {@link CompiledSystem}, because only the system knows
 * which values were computed.
 */
export function serializeSystem(system: CompiledSystem): string {
  const undeployable = undeployableValues(system);
  if (undeployable.length > 0) throw new WarpDeployError(undeployable);
  return serializeModel(system.model);
}
