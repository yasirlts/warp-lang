/**
 * The compiler — lowers a parsed {@link Document} to the EXACT structures the
 * frozen Warp Commerce Model already uses. There is no new representation here:
 *
 *   a `lifecycle`  →  a transition table `Record<StateType, StateType[]>` plus a
 *                     {@link TransitionFn}, the precise shape `verifyLifecycle`
 *                     and `reachableStates` consume.
 *   a `profile`    →  a {@link CommerceProfile}, the precise object
 *                     `guardWithProfile` consumes.
 *
 * The compiled output is INDISTINGUISHABLE from hand-writing those structures —
 * that is the whole claim of this rung, and the round-trip test proves it by
 * running the compiled output through the model's own guard and temporal verifier
 * and getting identical verdicts.
 *
 * WHAT THE COMPILER ENFORCES (well-formedness, keeping the language anchored to
 * the existing model — it adds NO new semantics):
 *   - Every state named in a lifecycle or a profile MUST be one of the model's
 *     commitment states. You cannot invent a state; the grammar authors the frozen
 *     model, so state names come from it. (The set is read FROM the model at
 *     runtime — see {@link knownCommitmentStates} — not hardcoded here.)
 *   - A transition may only reference declared states; declarations are unique.
 *   - A profile supplies the fields `guardWithProfile` needs.
 *
 * WHAT THE COMPILER DOES NOT DO: it does not check that the authored lifecycle is
 * SOUND. An author can declare a transition between two real states that the model
 * forbids (e.g. `Fulfilled -> Draft`); it is well-formed, so it compiles. The
 * model's temporal verifier (`verifyLifecycle`) is what rejects it. The invariants
 * govern; the language cannot smuggle an unsound model past them.
 */

import { reachableStates } from "@warp-lang/commerce-types";
import type { CommerceProfile } from "@warp-lang/commerce-types";
import type { CommitmentStateType } from "@warp-lang/commerce-types";
import type {
  Declaration,
  Document,
  LifecycleDecl,
  ProfileDecl,
} from "./ast.js";
import { WarpCompileError, type SourcePosition } from "./errors.js";
import { parse } from "./parser.js";

/**
 * The set of commitment state NAMES the frozen model defines, read from the model
 * itself: the reachable states of the real commitment lifecycle from its entry
 * (`Draft`). Composing {@link reachableStates} keeps this list a mirror of the
 * model — it is never hand-maintained here, so it cannot drift from the schema.
 * Cached after first read (the model is immutable within a process).
 */
let _known: Set<string> | undefined;
export function knownCommitmentStates(): Set<string> {
  if (_known === undefined) {
    _known = new Set(reachableStates("Draft").states);
  }
  return _known;
}

/**
 * A commitment lifecycle lowered to the model's structures. `transitions` is the
 * `Record<StateType, StateType[]>` table; `transitionFn` is the same table as the
 * function `verifyLifecycle` / `reachableStates` accept as their `transitions`
 * option. A state with no outgoing edges maps to `[]` (a terminal state).
 */
export interface CompiledLifecycle {
  /** The lifecycle's name, as authored. */
  name: string;
  /** The declared states, in source order. */
  states: CommitmentStateType[];
  /** The transition table: from-state → legal target states. */
  transitions: Record<string, string[]>;
  /**
   * The transition table as a function — plug directly into
   * `verifyLifecycle({ transitions })` or `reachableStates(from, { transitions })`.
   * Returns `[]` for any state with no declared outgoing edges.
   */
  transitionFn: (state: string) => string[];
}

/** A profile lowered to the model's {@link CommerceProfile} — a pure data subset. */
export type CompiledProfile = CommerceProfile;

/** The full lowered document: every lifecycle and profile it declared. */
export interface CompiledModel {
  lifecycles: CompiledLifecycle[];
  profiles: CompiledProfile[];
}

/** Assert that `name` is a state the frozen model defines, or throw at `pos`. */
function assertKnownState(name: string, pos: SourcePosition, context: string): void {
  const known = knownCommitmentStates();
  if (!known.has(name)) {
    const list = [...known].sort().join(", ");
    throw new WarpCompileError(
      `Unknown commitment state '${name}' ${context}. The Warp Commerce Model is frozen; ` +
        `you can only author its existing states. Valid states: ${list}.`,
      pos,
    );
  }
}

/** Lower one lifecycle declaration to its transition table. */
function compileLifecycle(decl: LifecycleDecl): CompiledLifecycle {
  // 1. Declared states: each must be a real model state, and unique.
  const declared = new Set<string>();
  const states: CommitmentStateType[] = [];
  for (const s of decl.states) {
    assertKnownState(s.name.name, s.name.pos, `declared in lifecycle '${decl.name.name}'`);
    if (declared.has(s.name.name)) {
      throw new WarpCompileError(
        `Duplicate state '${s.name.name}' in lifecycle '${decl.name.name}'.`,
        s.name.pos,
      );
    }
    declared.add(s.name.name);
    states.push(s.name.name as CommitmentStateType);
  }

  // 2. Transitions: source and targets must be declared states; a source may only
  //    be given once (one edge-set per state, like the model's own table).
  const transitions: Record<string, string[]> = {};
  for (const s of states) transitions[s] = [];
  const sourcesSeen = new Set<string>();
  for (const tr of decl.transitions) {
    if (!declared.has(tr.from.name)) {
      throw new WarpCompileError(
        `Transition source '${tr.from.name}' is not a declared state in lifecycle ` +
          `'${decl.name.name}'. Add 'state ${tr.from.name}' first.`,
        tr.from.pos,
      );
    }
    if (sourcesSeen.has(tr.from.name)) {
      throw new WarpCompileError(
        `State '${tr.from.name}' already has a transition list in lifecycle ` +
          `'${decl.name.name}'. Combine its targets into one '${tr.from.name} -> …' line.`,
        tr.from.pos,
      );
    }
    sourcesSeen.add(tr.from.name);
    const targets: string[] = [];
    for (const t of tr.to) {
      if (!declared.has(t.name)) {
        throw new WarpCompileError(
          `Transition target '${t.name}' is not a declared state in lifecycle ` +
            `'${decl.name.name}'. Add 'state ${t.name}' first.`,
          t.pos,
        );
      }
      if (targets.includes(t.name)) {
        throw new WarpCompileError(
          `Duplicate transition target '${t.name}' from '${tr.from.name}' in lifecycle ` +
            `'${decl.name.name}'.`,
          t.pos,
        );
      }
      targets.push(t.name);
    }
    transitions[tr.from.name] = targets;
  }

  const transitionFn = (state: string): string[] => transitions[state] ?? [];
  return { name: decl.name.name, states, transitions, transitionFn };
}

/** Lower one profile declaration to a {@link CommerceProfile}. */
function compileProfile(decl: ProfileDecl): CompiledProfile {
  let label: string | undefined;
  let description: string | undefined;
  let allowedStates: CommitmentStateType[] | undefined;
  let allowedValueForms: string[] | undefined;

  for (const f of decl.fields) {
    if (f.key === "label") {
      if (label !== undefined) dupField("label", f.pos, decl.name.name);
      label = f.text as string;
    } else if (f.key === "description") {
      if (description !== undefined) dupField("description", f.pos, decl.name.name);
      description = f.text as string;
    } else if (f.key === "states") {
      if (allowedStates !== undefined) dupField("states", f.pos, decl.name.name);
      const seen = new Set<string>();
      const list: CommitmentStateType[] = [];
      for (const s of f.list ?? []) {
        assertKnownState(s.name, s.pos, `in profile '${decl.name.name}' states`);
        if (!seen.has(s.name)) {
          seen.add(s.name);
          list.push(s.name as CommitmentStateType);
        }
      }
      allowedStates = list;
    } else {
      // value_forms — a caller-side data filter; the model treats these as opaque
      // narrowing data (an unknown form simply never matches a subject). Value
      // forms are an open, large set, so they are NOT checked against the model
      // here; only the deduped list is carried through.
      if (allowedValueForms !== undefined) dupField("value_forms", f.pos, decl.name.name);
      allowedValueForms = [...new Set((f.list ?? []).map((v) => v.name))];
    }
  }

  if (allowedStates === undefined) {
    throw new WarpCompileError(
      `Profile '${decl.name.name}' is missing required field 'states' (the commitment ` +
        `states this profile permits).`,
      decl.pos,
    );
  }
  if (allowedValueForms === undefined) {
    throw new WarpCompileError(
      `Profile '${decl.name.name}' is missing required field 'value_forms' (the value-form ` +
        `kinds this profile trades in).`,
      decl.pos,
    );
  }

  return {
    id: decl.name.name,
    label: label ?? decl.name.name,
    description: description ?? decl.name.name,
    allowedStates,
    // CommerceProfile types this as ValueFormKind[]; the value forms are authored
    // as free identifiers (a caller-side filter). Narrowing to the model's kind
    // union is a data-labelling cast, not a semantic change.
    allowedValueForms: allowedValueForms as CommerceProfile["allowedValueForms"],
  };
}

function dupField(key: string, pos: SourcePosition, profile: string): never {
  throw new WarpCompileError(`Duplicate '${key}' field in profile '${profile}'.`, pos);
}

/**
 * Lower a parsed {@link Document} to the frozen model's structures. Enforces
 * well-formedness (known states, resolved references, unique declarations); does
 * NOT judge soundness — that is the model's temporal verifier's job. Throws
 * {@link WarpCompileError} at a precise position on the first semantic problem.
 */
export function compileDocument(doc: Document): CompiledModel {
  const lifecycles: CompiledLifecycle[] = [];
  const profiles: CompiledProfile[] = [];
  const lifecycleNames = new Set<string>();
  const profileNames = new Set<string>();

  for (const decl of doc.declarations as Declaration[]) {
    if (decl.kind === "lifecycle") {
      if (lifecycleNames.has(decl.name.name)) {
        throw new WarpCompileError(
          `Duplicate lifecycle '${decl.name.name}'.`,
          decl.name.pos,
        );
      }
      lifecycleNames.add(decl.name.name);
      lifecycles.push(compileLifecycle(decl));
    } else {
      if (profileNames.has(decl.name.name)) {
        throw new WarpCompileError(`Duplicate profile '${decl.name.name}'.`, decl.name.pos);
      }
      profileNames.add(decl.name.name);
      profiles.push(compileProfile(decl));
    }
  }

  return { lifecycles, profiles };
}

/** Parse `.warp` source and lower it in one step. Throws on syntax or semantic error. */
export function compile(source: string, opts: { file?: string } = {}): CompiledModel {
  return compileDocument(parse(source, opts));
}
