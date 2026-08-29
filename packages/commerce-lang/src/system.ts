/**
 * Rung 4 — compiling a WHOLE `.warp` file into the one object the engine runs.
 *
 * Rungs 1–3 compile each declaration on its own: a lifecycle to a transition
 * table, a profile to a `CommerceProfile`, an auction to an `AuctionProcess`, a
 * policy to `NegotiationBounds` / a narrowed profile / a `RegulatoryPolicyPack`.
 * Rung 4a gave the engine `runModel`, which takes ONE `CommerceModel` and applies
 * every layer it declares.
 *
 *   compileSystem(source) -> { model, ... }   then   runModel(model, world, events)
 *
 * This module is the join: it GATHERS the already-compiled pieces into that one
 * `CommerceModel`. It is assembly, not lowering — every piece is produced by the
 * rung-1/2/3 compilers, unchanged, and nothing here computes a new structure.
 *
 * WHAT `.warp` AUTHORS, AND WHAT IT DOES NOT. A `.warp` file authors the SYSTEM:
 * the standing model a business runs under. It does not author EVENTS. Events are
 * runtime input — the I/O a host performs — and giving them syntax would turn a
 * system definition into a test fixture. So the division is: the language
 * produces the model, the host supplies the events, and `runModel` runs them
 * against it.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT CLAIM. Each is a real property of the
 * engine, carried here so the language does not describe itself as more than it
 * is:
 *
 *  1. An authored `assert` is DECLARED INTENT, not a gate. `guardAction` already
 *     audits all six invariants over the whole resulting world on every action.
 *     Asserting `I1` does not cause the engine to check I-1 — it already does —
 *     and omitting it does not stop the engine checking. The list round-trips
 *     into the model as documentation of what the author cared about.
 *  2. An authored lifecycle is PROVENANCE. It populates `model.transitions` for
 *     the record and for separate checking with `verifyLifecycle`, but the table
 *     that governs a move is the model's own, inside `guardAction`. Authoring a
 *     lifecycle cannot widen or narrow what the engine permits.
 *  3. `guardAction` audits the WHOLE world. A pre-existing violation on any
 *     commitment blocks every event, including one targeting a different,
 *     healthy commitment. There is no per-commitment isolation to rely on.
 *
 * AUCTIONS. An authored auction compiles (rung 2) and is returned alongside the
 * model, but `CommerceModel` has no auction field and `runModel` has no auction
 * layer — so an auction is NOT enforced by the engine run. It is carried as
 * compiled data for a caller to use. Saying otherwise would be the easiest
 * overclaim in this rung.
 */
import type {
  CommerceModel,
  CommercePolicy,
  CommerceProfile,
} from "@warp-lang/commerce-types";
import type { Document, ProfileDecl } from "./ast.js";
import {
  compileDocument,
  type CompiledAuction,
  type CompiledLifecycle,
  type CompiledModel,
  type CompiledPolicy,
  type CompiledProfile,
} from "./compile.js";
import { WarpCompileError, type SourcePosition } from "./errors.js";
import { parse } from "./parser.js";

/** Options for {@link compileSystem}. */
export interface SystemOptions {
  /** Source file name, threaded into every error position so messages print `file:line:col`. */
  file?: string;
  /** Which declared lifecycle populates `model.transitions`, when the file declares more than one. */
  lifecycle?: string;
  /** Which declared profile is the system's base profile, when the file declares more than one. */
  profile?: string;
  /** Override the model id (defaults to the single lifecycle's name, else the file name). */
  id?: string;
  label?: string;
  description?: string;
}

/**
 * A whole `.warp` file, compiled. `model` is the object {@link runModel} takes;
 * the other fields are the compiled pieces it was gathered from, kept so a caller
 * can reach them without recompiling.
 */
export interface CompiledSystem {
  /** The composed model the engine runs. */
  model: CommerceModel;
  /** The lifecycle whose table populated `model.transitions`, if one was declared. */
  lifecycle?: CompiledLifecycle;
  /** Every profile the file declared, in source order. */
  profiles: CompiledProfile[];
  /** Every policy the file declared, in source order. */
  policies: CompiledPolicy[];
  /**
   * Every auction the file declared. NOT part of `model`, and NOT enforced by
   * `runModel` — the engine has no auction layer. Compiled data for a caller.
   */
  auctions: CompiledAuction[];
}

/** Find a profile declaration by id, for error positions. */
function profileDeclOf(doc: Document, id: string): ProfileDecl | undefined {
  return doc.declarations.find(
    (d): d is ProfileDecl => d.kind === "profile" && d.name.name === id,
  );
}

/** The position of a profile's `states` list entry naming `state`, else the declaration's. */
function statePos(decl: ProfileDecl | undefined, state: string): SourcePosition | undefined {
  if (!decl) return undefined;
  for (const f of decl.fields) {
    if (f.key !== "states") continue;
    for (const s of f.list ?? []) if (s.name === state) return s.pos;
  }
  return decl.pos;
}

function orList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] as string}`;
}

/**
 * Gather an already-compiled document into one {@link CommerceModel}.
 *
 * Selection rules, and why they are errors rather than guesses:
 *
 *  - **Lifecycle.** None → `model.transitions` is absent. Exactly one → it is
 *    used. More than one → a compile error unless `opts.lifecycle` names which,
 *    because a system records ONE lifecycle and silently picking the first would
 *    hide the ambiguity.
 *  - **Profile.** None → no base profile. Exactly one → it is the base. More than
 *    one → a compile error unless `opts.profile` names which. This one matters:
 *    `runModel` applies EVERY profile it holds to EVERY action, so two profiles
 *    that permit different states would together permit only their intersection —
 *    usually nothing. Better a compile error than a system that blocks everything.
 *  - **Policies.** All of them, in source order. Each policy's narrowed profile is
 *    applied by `runModel` in addition to the base, which is sound because a
 *    profile only ever narrows.
 */
export function systemFromDocument(
  doc: Document,
  compiled: CompiledModel,
  opts: SystemOptions = {},
): CompiledSystem {
  // --- lifecycle ------------------------------------------------------------
  let lifecycle: CompiledLifecycle | undefined;
  if (opts.lifecycle !== undefined) {
    lifecycle = compiled.lifecycles.find((l) => l.name === opts.lifecycle);
    if (lifecycle === undefined) {
      const names = compiled.lifecycles.map((l) => l.name);
      throw new WarpCompileError(
        `No lifecycle '${opts.lifecycle}' in this document. ` +
          (names.length === 0
            ? `It declares no lifecycle.`
            : `Declared lifecycles: ${names.join(", ")}.`),
        doc.declarations[0]?.pos ?? { line: 1, column: 1 },
      );
    }
  } else if (compiled.lifecycles.length === 1) {
    lifecycle = compiled.lifecycles[0] as CompiledLifecycle;
  } else if (compiled.lifecycles.length > 1) {
    const names = compiled.lifecycles.map((l) => l.name);
    const second = doc.declarations.filter((d) => d.kind === "lifecycle")[1];
    throw new WarpCompileError(
      `This document declares ${compiled.lifecycles.length} lifecycles (${orList(names)}), so which ` +
        `one the system records is ambiguous. Select one with the 'lifecycle' option, or keep one ` +
        `lifecycle per system.`,
      second?.pos ?? { line: 1, column: 1 },
    );
  }

  // --- base profile ---------------------------------------------------------
  let base: CompiledProfile | undefined;
  if (opts.profile !== undefined) {
    base = compiled.profiles.find((p) => p.id === opts.profile);
    if (base === undefined) {
      const names = compiled.profiles.map((p) => p.id);
      throw new WarpCompileError(
        `No profile '${opts.profile}' in this document. ` +
          (names.length === 0 ? `It declares no profile.` : `Declared profiles: ${names.join(", ")}.`),
        doc.declarations[0]?.pos ?? { line: 1, column: 1 },
      );
    }
  } else if (compiled.profiles.length === 1) {
    base = compiled.profiles[0] as CompiledProfile;
  } else if (compiled.profiles.length > 1) {
    const names = compiled.profiles.map((p) => p.id);
    const second = doc.declarations.filter((d) => d.kind === "profile")[1];
    throw new WarpCompileError(
      `This document declares ${compiled.profiles.length} profiles (${orList(names)}), so the system's ` +
        `base profile is ambiguous. runModel applies EVERY profile it holds to EVERY action, so two ` +
        `profiles permitting different states would together permit only what both allow. Select one ` +
        `with the 'profile' option, or keep one profile per system and narrow it with policies.`,
      second?.pos ?? { line: 1, column: 1 },
    );
  }

  // --- consistency: a profile may not permit a state its own lifecycle omits --
  // A document-level consistency check on what the AUTHOR wrote. It does not
  // change what the engine permits — the governing table is guardAction's — it
  // catches a profile and a lifecycle in the same file disagreeing about which
  // states this system uses.
  if (lifecycle !== undefined) {
    const declared = new Set<string>(lifecycle.states as readonly string[]);
    for (const profile of compiled.profiles) {
      for (const st of profile.allowedStates) {
        if (!declared.has(st)) {
          const decl = profileDeclOf(doc, profile.id);
          throw new WarpCompileError(
            `Profile '${profile.id}' permits the state '${st}', but the lifecycle ` +
              `'${lifecycle.name}' in this document does not declare it (it declares ` +
              `${[...declared].sort().join(", ")}). Either add 'state ${st}' to the lifecycle or ` +
              `remove it from the profile — a system's profile and its lifecycle should agree ` +
              `about which states it uses. (This is a consistency check on this document; the ` +
              `transition table that governs a move is the model's own.)`,
            statePos(decl, st) ?? decl?.pos ?? { line: 1, column: 1 },
          );
        }
      }
    }
  }

  // --- gather ---------------------------------------------------------------
  // Each CompiledPolicy is already structurally a CommercePolicy: rung 3 lowers to
  // exactly the shapes rung 4a's engine takes. This is a carry-through, not a
  // translation.
  const policies: CommercePolicy[] = compiled.policies.map((p) => {
    const out: CommercePolicy = { id: p.id, label: p.label, description: p.description };
    if (p.bounds !== undefined) out.bounds = p.bounds;
    if (p.profile !== undefined) out.profile = p.profile as CommerceProfile;
    if (p.appliesTo !== undefined) out.appliesTo = p.appliesTo;
    if (p.pack !== undefined) out.pack = p.pack;
    // Carried as DOCUMENTATION of the author's intent. The engine audits all six
    // invariants regardless; this list neither adds nor removes a check.
    if (p.asserts.length > 0) out.asserts = p.asserts;
    return out;
  });

  const id = opts.id ?? lifecycle?.name ?? base?.id ?? opts.file ?? "system";
  const model: CommerceModel = { id };
  if (opts.label !== undefined) model.label = opts.label;
  if (opts.description !== undefined) model.description = opts.description;
  // Provenance only — see the module header. runModel does not consult this.
  if (lifecycle !== undefined) model.transitions = lifecycle.transitions;
  if (base !== undefined) model.profile = base as CommerceProfile;
  if (policies.length > 0) model.policies = policies;

  const system: CompiledSystem = {
    model,
    profiles: compiled.profiles,
    policies: compiled.policies,
    auctions: compiled.auctions,
  };
  if (lifecycle !== undefined) system.lifecycle = lifecycle;
  return system;
}

/**
 * Compile a whole `.warp` source into the one {@link CommerceModel} the engine
 * runs, plus the pieces it was gathered from.
 *
 * ```ts
 * const { model } = compileSystem(source, { file: "shop.warp" })
 * const { world, verdicts } = runModel(model, initialWorld, hostEvents, { clock })
 * ```
 *
 * Throws a positioned {@link WarpSyntaxError} or {@link WarpCompileError} — the
 * same errors the per-declaration compilers raise, plus the cross-declaration
 * checks described on {@link systemFromDocument}.
 */
export function compileSystem(source: string, opts: SystemOptions = {}): CompiledSystem {
  const doc = parse(source, opts.file !== undefined ? { file: opts.file } : {});
  return systemFromDocument(doc, compileDocument(doc), opts);
}
