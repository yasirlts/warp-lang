/**
 * @warp-lang/commerce-lang — a focused SYNTAX for authoring the current Warp
 * Commerce Model.
 *
 * A `.warp` file describes a commitment LIFECYCLE (named states + the legal
 * transitions between them), a PROFILE (a named data subset of the model), an
 * AUCTION (the market-making form: the `AuctionProcess` auxiliary record and the
 * `Tendered` commitments it collects), and a POLICY (commerce RULES — a negotiation
 * floor, a narrowed profile, a jurisdiction rate pack, the invariants a deal must
 * satisfy). This package parses that source and compiles it DOWN to the exact
 * structures the model already uses — a transition table, a `CommerceProfile`, an
 * `AuctionProcess`, `Tendered` commitment states, the `UnderAuction` value state,
 * `NegotiationBounds`, and a `RegulatoryPolicyPack`. It introduces no new states,
 * no new invariants, and no new schema: it is a nicer way to WRITE a model the
 * runtime already understands.
 *
 * The language AUTHORS rules; the MODEL ENFORCES them. Every compiled policy is
 * the same value a caller would have hand-written, handed to the same shipped
 * function (`guardConcession`, `guardWithProfile`, `checkSettlementPolicy`,
 * `auditCommerce`) — so an authored rule and a hand-written one agree by
 * construction. The compiled output is checked by the model's OWN guard and
 * temporal verifier; the invariants govern.
 *
 * Public surface:
 *   - {@link parse}            source → AST (precise line/col syntax errors)
 *   - {@link compile}          source → compiled model structures (in one step)
 *   - {@link compileDocument}  AST → compiled model structures
 *   - error classes with `.line` / `.column` / `.format()`
 *   - the AST and compiled-output types
 *
 * This is rung 3 of the language: rungs 1–2 author the model's SHAPE (lifecycle,
 * profile, auction); this rung adds its LOGIC (policies). Still ahead: authoring
 * Party / Value / Intent / Fulfillment, commitment terms, and settlement
 * breakdowns. It is a commerce-model authoring language, not a general-purpose
 * one.
 */

export { compileSystem, systemFromDocument, resolveSystem, resolveForCommitment, deriveContext } from "./system.js";
export { buildComposition } from "./system.js";
export type {
  CompiledSystem,
  SystemOptions,
  ResolveResult,
  ResolutionFailure,
  BuildOptions,
  BuildResult,
  LegOptions,
  LegFailure,
} from "./system.js";
export {
  evaluate,
  formatExpr,
  isConstant,
  variablesOf,
  CONTEXT_VARIABLES,
  CONTEXT_VARIABLE_NAMES,
  EXPR_FUNCTIONS,
  money,
  num,
} from "./expr.js";
export type {
  Expr,
  EvalContext,
  EvalError,
  EvalResult,
  Value,
  MoneyValue,
  NumberValue,
  ContextVariable,
} from "./expr.js";
export { parse } from "./parser.js";
export { tokenize } from "./lexer.js";
export type { Token, TokenType } from "./lexer.js";
export {
  compile,
  compileDocument,
  knownCommitmentStates,
  AUCTION_MECHANISM_KINDS,
  AUCTION_STATE_TYPES,
  AUCTION_CLOSE_REASONS,
} from "./compile.js";
export type {
  CompiledModel,
  CompiledLifecycle,
  CompiledProfile,
  CompiledPolicy,
  CompiledComposition,
  CompiledAuction,
  CompiledTender,
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
  CompositionDecl,
  CompositionField,
  LegDecl,
  PolicyDecl,
  PolicyField,
  PolicyFieldKey,
  TaxRatesLit,
  LifecycleItem,
  StateDecl,
  TransitionDecl,
  ProfileField,
  Ident,
  AuctionDecl,
  AuctionItem,
  AuctionStateDecl,
  MechanismDecl,
  TenderDecl,
  Field,
  FieldValue,
  MoneyLit,
  CriterionLit,
} from "./ast.js";
