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
 * AUCTIONS RUN. An authored auction populates `model.auction`, and `runModel`'s
 * auction layer checks its RESOLUTION for soundness on every event: the winner
 * was a bid the auction collected, only one bid is awarded, losing bids are
 * released, and the clearing price is in the winner's currency and no higher than
 * their offer. Those checks are not re-expressions of the six invariants — an
 * unsound resolution is invariant-clean — and they do not judge whether the
 * mechanism produced a good price.
 */
import type {
  CommerceModel,
  CommercePolicy,
  CommerceProfile,
  Commitment,
  Money,
} from "@warp-lang/commerce-types";
import {
  evaluate,
  formatExpr,
  type EvalContext,
  type EvalError,
  type Expr,
} from "./expr.js";
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
  /** Which declared auction the system runs, when the file declares more than one. */
  auction?: string;
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
   * Every auction the file declared, in source order. The one that governs the
   * run also populates `model.auction`, where `runModel`'s auction layer checks
   * its resolution.
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

  // --- auction -------------------------------------------------------------
  // Selected exactly like the lifecycle and the profile: one is unambiguous, more
  // than one needs saying which, because runModel holds a single auction.
  let auction: CompiledAuction | undefined;
  if (opts.auction !== undefined) {
    auction = compiled.auctions.find((a) => a.process.id === opts.auction);
    if (auction === undefined) {
      const names = compiled.auctions.map((a) => a.process.id);
      throw new WarpCompileError(
        `No auction '${opts.auction}' in this document. ` +
          (names.length === 0 ? `It declares no auction.` : `Declared auctions: ${names.join(", ")}.`),
        doc.declarations[0]?.pos ?? { line: 1, column: 1 },
      );
    }
  } else if (compiled.auctions.length === 1) {
    auction = compiled.auctions[0] as CompiledAuction;
  } else if (compiled.auctions.length > 1) {
    const names = compiled.auctions.map((a) => a.process.id);
    const second = doc.declarations.filter((d) => d.kind === "auction")[1];
    throw new WarpCompileError(
      `This document declares ${compiled.auctions.length} auctions (${orList(names)}), but a system ` +
        `runs one. Select it with the 'auction' option, or keep one auction per system.`,
      second?.pos ?? { line: 1, column: 1 },
    );
  }

  const id = opts.id ?? lifecycle?.name ?? base?.id ?? opts.file ?? "system";
  const model: CommerceModel = { id };
  if (opts.label !== undefined) model.label = opts.label;
  if (opts.description !== undefined) model.description = opts.description;
  // Provenance only — see the module header. runModel does not consult this.
  if (lifecycle !== undefined) model.transitions = lifecycle.transitions;
  if (base !== undefined) model.profile = base as CommerceProfile;
  if (policies.length > 0) model.policies = policies;
  // The authored auction RUNS: runModel's auction layer checks its resolution.
  if (auction !== undefined) model.auction = auction.process;

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


// ---------------------------------------------------------------------------
// Rung 5A — resolving DERIVED values against a real commitment
// ---------------------------------------------------------------------------

/**
 * Build an {@link EvalContext} from a commitment. This is the ONLY place a
 * context is derived, so the documented variable list and what an expression can
 * actually see cannot drift apart.
 *
 * A variable that is not derivable is left ABSENT rather than defaulted, so
 * referencing it fails loudly. A prorated refund computed against a term of zero
 * because the commitment had no duration is not a small error, and silently
 * substituting zero would hide it.
 *
 * `now` is passed in, never sampled: this function is pure, and the engine's
 * clock is injectable for the same reason.
 */
export function deriveContext(commitment: Commitment, now?: string): EvalContext {
  const ctx: EvalContext = {};

  // committed — the single-currency Money in the requested subject.
  const monies: Money[] = [];
  let quantity = 0;
  for (const v of commitment.subject.requested) {
    if (v.form.kind === "Money") monies.push(v.form.money);
    quantity += typeof v.quantity === "number" ? v.quantity : 0;
  }
  const currencies = [...new Set(monies.map((m) => m.currency))];
  if (monies.length > 0 && currencies.length === 1) {
    ctx.committed = {
      kind: "money",
      amount: monies.reduce((sum, m) => sum + m.amount, 0),
      currency: currencies[0] as string,
    };
  }
  // A mixed-currency subject leaves `committed` unavailable rather than picking
  // one — summing across currencies is exactly what I-1 forbids.

  if (quantity > 0) ctx.quantity = { kind: "number", value: quantity };

  // The time-based three, from created_at, a fixed duration, and `now`.
  const DAY = 86_400_000;
  const created = Date.parse(commitment.created_at);
  const endsAt =
    commitment.terms?.duration?.kind === "Fixed" ? Date.parse(commitment.terms.duration.ends_at) : NaN;
  const nowMs = now === undefined ? NaN : Date.parse(now);

  const termDays = Number.isFinite(created) && Number.isFinite(endsAt)
    ? Math.max(0, Math.floor((endsAt - created) / DAY))
    : undefined;
  const elapsedDays = Number.isFinite(created) && Number.isFinite(nowMs)
    ? Math.max(0, Math.floor((nowMs - created) / DAY))
    : undefined;

  if (termDays !== undefined) ctx.term_days = { kind: "number", value: termDays };
  if (elapsedDays !== undefined) ctx.elapsed_days = { kind: "number", value: elapsedDays };
  if (termDays !== undefined && elapsedDays !== undefined) {
    ctx.remaining_days = { kind: "number", value: Math.max(0, termDays - elapsedDays) };
  }

  return ctx;
}

/** A derived value that could not be computed, with where and why. */
export interface ResolutionFailure {
  /** The policy whose value failed. */
  policy: string;
  /** Which value — `concession_floor` or `committed_price`. */
  field: "concession_floor" | "committed_price";
  /** The expression as authored, for the message. */
  source: string;
  error: EvalError;
}

/** The outcome of resolving a system's derived values against a context. */
export type ResolveResult =
  | { ok: true; model: CommerceModel }
  | { ok: false; failures: ResolutionFailure[] };

/**
 * Resolve every derived policy value against a commerce context, producing the
 * plain {@link CommerceModel} the engine's `runModel` takes.
 *
 * THE SAFETY BOUNDARY, RESTATED WHERE IT MATTERS. This function produces a
 * NUMBER. It grants that number nothing: the resulting model is byte-identical in
 * kind to one whose values were typed as literals, and `guardConcession` and the
 * six invariants judge it exactly the same way. A formula that computes an
 * unsound floor is refused by the guard precisely as the same unsound literal
 * would be — the expression layer has no route to the enforcement layer that a
 * constant does not also take.
 *
 * The two well-formedness checks a compile-time constant gets (a floor no higher
 * than the committed price, both in one currency) are applied here too, to the
 * evaluated numbers, so a derived value is not held to a lesser standard.
 *
 * Total: failures come back as data, never as a thrown error.
 */
export function resolveSystem(system: CompiledSystem, ctx: EvalContext): ResolveResult {
  const failures: ResolutionFailure[] = [];
  const policies: CommercePolicy[] = [];

  for (const compiled of system.policies) {
    const out: CommercePolicy = {
      id: compiled.id,
      label: compiled.label,
      description: compiled.description,
    };
    if (compiled.profile !== undefined) out.profile = compiled.profile as CommerceProfile;
    if (compiled.appliesTo !== undefined) out.appliesTo = compiled.appliesTo;
    if (compiled.pack !== undefined) out.pack = compiled.pack;
    if (compiled.asserts.length > 0) out.asserts = compiled.asserts;

    const evalMoney = (
      expr: Expr,
      field: ResolutionFailure["field"],
    ): Money | undefined => {
      const r = evaluate(expr, ctx);
      if (!r.ok) {
        failures.push({ policy: compiled.id, field, source: formatExpr(expr), error: r.error });
        return undefined;
      }
      if (r.value.kind !== "money") {
        failures.push({
          policy: compiled.id,
          field,
          source: formatExpr(expr),
          error: {
            code: "type-error",
            message:
              `'${formatExpr(expr)}' evaluates to the plain number ${r.value.value}, but ${field} ` +
              `must be a money amount. Scale a money value (e.g. 'committed * 0.75') rather than ` +
              `computing a bare number.`,
            pos: expr.pos,
          },
        });
        return undefined;
      }
      return { amount: r.value.amount, currency: r.value.currency };
    };

    if (compiled.derived !== undefined) {
      const floor =
        compiled.derived.floor !== undefined
          ? evalMoney(compiled.derived.floor, "concession_floor")
          : compiled.bounds?.floor;
      const committed =
        compiled.derived.committed !== undefined
          ? evalMoney(compiled.derived.committed, "committed_price")
          : compiled.bounds?.committed;

      if (floor !== undefined) {
        // The same two checks a constant gets at compile time, applied to the
        // computed numbers. A derived value is held to the identical standard.
        if (committed !== undefined && committed.currency !== floor.currency) {
          failures.push({
            policy: compiled.id,
            field: "concession_floor",
            source: formatExpr(compiled.derived.floor ?? compiled.derived.committed!),
            error: {
              code: "currency-mismatch",
              message:
                `The computed concession_floor is in ${floor.currency} but the committed_price is in ` +
                `${committed.currency}. A cross-currency concession is out of scope — value is not ` +
                `conserved across a currency mix (Invariant 1).`,
              pos: (compiled.derived.floor ?? compiled.derived.committed!).pos,
            },
          });
        } else if (committed !== undefined && floor.amount > committed.amount) {
          failures.push({
            policy: compiled.id,
            field: "concession_floor",
            source: formatExpr(compiled.derived.floor ?? compiled.derived.committed!),
            error: {
              code: "type-error",
              message:
                `The computed concession_floor of ${floor.amount} ${floor.currency} is above the ` +
                `committed_price of ${committed.amount} ${committed.currency}. The floor is the ` +
                `LOWEST acceptable price, so it cannot exceed the opening price.`,
              pos: (compiled.derived.floor ?? compiled.derived.committed!).pos,
            },
          });
        } else {
          out.bounds = committed === undefined ? { floor } : { floor, committed };
        }
      }
    } else if (compiled.bounds !== undefined) {
      out.bounds = compiled.bounds;
    }

    policies.push(out);
  }

  if (failures.length > 0) return { ok: false, failures };

  const model: CommerceModel = { ...system.model };
  if (policies.length > 0) model.policies = policies;
  return { ok: true, model };
}

/**
 * Convenience: resolve a system's derived values against a COMMITMENT, deriving
 * the context from it. Equivalent to `resolveSystem(system, deriveContext(c, now))`.
 */
export function resolveForCommitment(
  system: CompiledSystem,
  commitment: Commitment,
  now?: string,
): ResolveResult {
  return resolveSystem(system, deriveContext(commitment, now));
}
