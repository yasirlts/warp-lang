/**
 * The AST — the shape a `.warp` document parses INTO, before it is lowered to the
 * frozen model's structures. Every node carries the source position of its FIRST
 * token so the compiler can report semantic errors (unknown state, undeclared
 * reference) with the same line/col precision the parser gives syntax errors.
 *
 * The AST is deliberately small: it mirrors, one-to-one, the two things the model
 * already has that this rung can author — a commitment LIFECYCLE (states + the
 * legal transitions between them) and a PROFILE (a named data subset of the
 * model). It introduces no node the model has no counterpart for.
 */

import type { SourcePosition } from "./errors.js";

/** An identifier token with its position — a state name, a value-form name, etc. */
export interface Ident {
  name: string;
  pos: SourcePosition;
}

/** `state <Name>` — declares one state of a lifecycle. */
export interface StateDecl {
  kind: "state";
  name: Ident;
  pos: SourcePosition;
}

/** `<From> -> <To1>, <To2>, …` — declares the legal moves out of one state. */
export interface TransitionDecl {
  kind: "transition";
  from: Ident;
  to: Ident[];
  pos: SourcePosition;
}

/** An item inside a `lifecycle { … }` block. */
export type LifecycleItem = StateDecl | TransitionDecl;

/**
 * `lifecycle <name> { state …; <From> -> <To>… }` — authors a commitment
 * lifecycle: a set of named states and the transitions permitted between them.
 * This lowers to the model's transition table (a `Record<StateType, StateType[]>`)
 * — the exact structure `verifyLifecycle` consumes.
 */
export interface LifecycleDecl {
  kind: "lifecycle";
  name: Ident;
  states: StateDecl[];
  transitions: TransitionDecl[];
  pos: SourcePosition;
}

/** One `key value` field inside a `profile { … }` block. */
export interface ProfileField {
  key: "label" | "description" | "states" | "value_forms";
  /** Present for `label` / `description` (a string literal). */
  text?: string;
  /** Present for `states` / `value_forms` (a comma-separated identifier list). */
  list?: Ident[];
  pos: SourcePosition;
}

/**
 * `profile <id> { label …; description …; states …; value_forms … }` — authors a
 * {@link CommerceProfile}: a named DATA subset of the model (which states and which
 * value forms a kind of commerce uses). Lowers to the exact `CommerceProfile`
 * object `guardWithProfile` consumes.
 */
export interface ProfileDecl {
  kind: "profile";
  name: Ident;
  fields: ProfileField[];
  pos: SourcePosition;
}

/** A top-level declaration: a lifecycle or a profile. */
export type Declaration = LifecycleDecl | ProfileDecl;

/** A parsed `.warp` document — a sequence of declarations. */
export interface Document {
  kind: "document";
  declarations: Declaration[];
}
