/**
 * @warp-lang/commerce-lang — a focused SYNTAX for authoring the frozen Warp
 * Commerce Model.
 *
 * A `.warp` file describes a commitment LIFECYCLE (named states + the legal
 * transitions between them) and, optionally, a PROFILE (a named data subset of the
 * model). This package parses that source and compiles it DOWN to the exact
 * structures the model already uses — a transition table and a `CommerceProfile`.
 * It introduces no new states, no new invariants, and no new schema: it is a nicer
 * way to WRITE a model the runtime already understands. The compiled output is
 * checked by the model's OWN guard and temporal verifier; the invariants govern.
 *
 * Public surface:
 *   - {@link parse}            source → AST (precise line/col syntax errors)
 *   - {@link compile}          source → compiled model structures (in one step)
 *   - {@link compileDocument}  AST → compiled model structures
 *   - error classes with `.line` / `.column` / `.format()`
 *   - the AST and compiled-output types
 *
 * This is an EARLY rung: today it can author a lifecycle and a profile — the two
 * things that map one-to-one onto structures the model already has. It is a
 * commerce-model authoring language, not a general-purpose one.
 */

export { parse } from "./parser.js";
export { tokenize } from "./lexer.js";
export type { Token, TokenType } from "./lexer.js";
export {
  compile,
  compileDocument,
  knownCommitmentStates,
} from "./compile.js";
export type {
  CompiledModel,
  CompiledLifecycle,
  CompiledProfile,
} from "./compile.js";
export {
  WarpLangError,
  WarpSyntaxError,
  WarpCompileError,
} from "./errors.js";
export type { SourcePosition } from "./errors.js";
export type {
  Document,
  Declaration,
  LifecycleDecl,
  ProfileDecl,
  LifecycleItem,
  StateDecl,
  TransitionDecl,
  ProfileField,
  Ident,
} from "./ast.js";
