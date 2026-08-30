/**
 * The compiler — lowers a parsed {@link Document} to the EXACT structures the
 * current Warp Commerce Model already uses. There is no new representation here:
 *
 *   a `lifecycle`  →  a transition table `Record<StateType, StateType[]>` plus a
 *                     {@link TransitionFn}, the precise shape `verifyLifecycle`
 *                     and `reachableStates` consume.
 *   a `profile`    →  a {@link CommerceProfile}, the precise object
 *                     `guardWithProfile` consumes.
 *   an `auction`   →  an `AuctionProcess` (the model's auxiliary coordination
 *                     record), the `Tendered` `CommitmentState` of each tender it
 *                     collects, and the `UnderAuction` `ValueState` its subject
 *                     carries while the auction is open. All three are existing
 *                     model structures; the auction form authors a REFERENCE to
 *                     the auxiliary record, it does not reinvent it.
 *
 * The compiled output is INDISTINGUISHABLE from hand-writing those structures —
 * that is the whole claim of this rung, and the round-trip test proves it by
 * running the compiled output through the model's own guard and temporal verifier
 * and getting identical verdicts.
 *
 * WHAT THE COMPILER ENFORCES (well-formedness, keeping the language anchored to
 * the existing model — it adds NO new semantics):
 *   - Every state named in a lifecycle or a profile MUST be one of the model's
 *     commitment states. You cannot invent a state; the grammar authors the current
 *     model, so state names come from it. (The set is read FROM the model at
 *     runtime — see {@link knownCommitmentStates} — not hardcoded here.)
 *   - A transition may only reference declared states; declarations are unique.
 *   - A profile supplies the fields `guardWithProfile` needs.
 *   - An auction's mechanism kind, state, and close reason must be ones the model
 *     defines; each mechanism carries exactly the fields the schema gives that
 *     variant; a declared winner must be one of the auction's own tenders.
 *     (These three vocabularies have no runtime form to read, so they are mirrored
 *     here and held to the schema by `tests/schema-drift.test.ts`.)
 *
 * WHAT THE COMPILER DOES NOT DO: it does not check that the authored lifecycle is
 * SOUND. An author can declare a transition between two real states that the model
 * forbids (e.g. `Fulfilled -> Draft`, or `Tendered -> Fulfilled`, which skips the
 * commitment); it is well-formed, so it compiles. The model's temporal verifier
 * (`verifyLifecycle`) is what rejects it. Nor does it check auction DATA — that
 * `opens_at` precedes `closes_at`, that an offer clears the reserve, or that
 * ScoredSelection weights sum to 1.0. The invariants govern; the language cannot
 * smuggle an unsound model past them.
 */

import { reachableStates } from "@warp-lang/commerce-types";
import type { CommerceProfile } from "@warp-lang/commerce-types";
import type {
  InvariantId,
  JurisdictionTaxRates,
  NegotiationBounds,
  RegulatoryPolicyPack,
} from "@warp-lang/commerce-types";
import type { CommitmentStateType } from "@warp-lang/commerce-types";
import type {
  AuctionCloseReason,
  AuctionMechanism,
  AuctionProcess,
  AuctionState,
  CommitmentID,
  CommitmentState,
  Money,
  PartyID,
  ValueID,
  ValueState,
} from "@warp-lang/commerce-types";
import type {
  AuctionDecl,
  Declaration,
  Document,
  Field,
  Ident,
  LifecycleDecl,
  MoneyLit,
  ProfileDecl,
  TenderDecl,
  CompositionDecl,
  PolicyDecl,
} from "./ast.js";
import { WarpCompileError, type SourcePosition } from "./errors.js";
import {
  CONTEXT_VARIABLE_NAMES,
  evaluate,
  formatExpr,
  isConstant,
  variablesOf,
  type EvalContext,
  type Expr,
} from "./expr.js";
import { parse } from "./parser.js";

/**
 * The set of commitment state NAMES the current model defines, read from the model
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

/**
 * A policy lowered to the model's EXISTING rule structures. Every field is a
 * structure some already-shipped function consumes; this object holds no
 * enforcement logic of its own, and the language never decides an outcome:
 *
 *   `bounds`   → `guardConcession(world, commitmentId, bounds)`
 *   `profile`  → `guardWithProfile(profile, world, action)`
 *   `pack`     → `checkSettlementPolicy(settlement, committedTotal, pack)`
 *   `asserts`  → the invariant ids to select from `auditCommerce(...)` output
 *
 * Because each field is exactly the type the model already takes, an authored
 * policy and a hand-written rule are the SAME VALUE, and therefore produce the
 * same verdict by construction rather than by a re-implementation that agrees.
 */
export interface CompiledPolicy {
  /** The policy id, as authored. */
  id: string;
  /** Human-readable label (defaults to the id). */
  label: string;
  /** One-line description (defaults to the id). */
  description: string;
  /**
   * Negotiation bounds, when the policy declared `concession_floor`. Feed
   * straight to `guardConcession`, which enforces the floor via I-1.
   */
  bounds?: NegotiationBounds;
  /**
   * A narrowed {@link CommerceProfile}, when the policy declared `applies_to`.
   * It is the referenced profile with any `forbid_states` removed. Feed straight
   * to `guardWithProfile`. The profile only ever NARROWS the model.
   */
  profile?: CommerceProfile;
  /** The profile id this policy narrowed, when it declared `applies_to`. */
  appliesTo?: string;
  /**
   * A regulatory policy pack, when the policy declared `tax_rates`. Feed straight
   * to `checkSettlementPolicy`. The rates are carried VERBATIM as authored — the
   * language does not compute, validate, or vouch for tax law.
   */
  pack?: RegulatoryPolicyPack;
  /**
   * The invariant ids this policy asserts must hold, in source order. These SELECT
   * from `auditCommerce(...)` output; the checks themselves are the model's.
   */
  asserts: InvariantId[];
  /**
   * The unevaluated expressions behind `bounds`, when the policy computed them
   * (rung 5A). Present only where a value referenced the commerce context; a
   * constant is folded into `bounds` at compile time and leaves nothing here.
   *
   * A derived value is resolved by `resolveSystem(...)` into exactly the same
   * `NegotiationBounds` a literal produces, and is then enforced by the same
   * `guardConcession`. The expression decides how the number is PRODUCED; it has
   * no bearing on whether the number is CHECKED.
   */
  derived?: {
    floor?: Expr;
    committed?: Expr;
  };
}

/**
 * One authored tender, lowered to the model's existing `Tendered` commitment
 * state. The id is used exactly as authored and never derived — commitment ids
 * are permanent (Invariant 5, Identity Permanence).
 */
export interface CompiledTender {
  /** The tendered commitment's id, verbatim from the source. */
  commitment: CommitmentID;
  /** The model's `Tendered` CommitmentState, carrying the offer and closing time. */
  state: Extract<CommitmentState, { type: "Tendered" }>;
}

/**
 * An authored auction, lowered to the model's structures.
 *
 * `process` is an `AuctionProcess` exactly as `schema/structure/auxiliary.schema.json`
 * defines it — its `tendered_commitments` are the ids of `tenders`, in source order.
 *
 * `subjectState` is the model's existing `UnderAuction` `ValueState` for the
 * auction's subject, present ONLY while the auction's state is `Open` (the state in
 * which the model says a value is under an active auction and so cannot be reserved
 * or committed elsewhere); it is `null` for a `Scheduled` or `Closed` auction. This
 * is a LOWERING of authored data into an existing model record — the compiler does
 * not, and cannot, check the real state of any Value, because a `.warp` document
 * declares no values.
 */
export interface CompiledAuction {
  /** The model's AuctionProcess auxiliary record. */
  process: AuctionProcess;
  /** Each authored tender, as the model's `Tendered` commitment state. */
  tenders: CompiledTender[];
  /** The `UnderAuction` ValueState the subject carries while open; `null` otherwise. */
  subjectState: ValueState | null;
}

/**
 * One authored composition, lowered (rung 5B). It describes how a commitment
 * decomposes into child commitments: the legs, and how each leg's amount is
 * computed from the parent.
 *
 * It holds no coherence logic. `buildComposition` instantiates it into ordinary
 * commitments linked by the model's own `parent` / `children` fields, and
 * `checkI6TreeConsistency` and the session's per-tree ledger — both unchanged —
 * decide whether the resulting tree reconciles. Notably, the compiler does NOT
 * check that the legs sum to the parent: that is exactly I-6's job, and
 * re-deriving it here would be a second implementation to keep in step.
 */
export interface CompiledComposition {
  /** The composition id, as authored. */
  id: string;
  label: string;
  description: string;
  /** The legs, in source order. */
  legs: {
    /** The leg name, as authored — used to address it when building. */
    name: string;
    /** How this leg's amount is computed from the parent (a rung-5A expression). */
    amount: Expr;
  }[];
}

/** The full lowered document: every lifecycle, profile, auction, policy, and composition. */
export interface CompiledModel {
  lifecycles: CompiledLifecycle[];
  profiles: CompiledProfile[];
  auctions: CompiledAuction[];
  policies: CompiledPolicy[];
  compositions: CompiledComposition[];
}

/** Assert that `name` is a state the current model defines, or throw at `pos`. */
function assertKnownState(name: string, pos: SourcePosition, context: string): void {
  const known = knownCommitmentStates();
  if (!known.has(name)) {
    const list = [...known].sort().join(", ");
    throw new WarpCompileError(
      `Unknown commitment state '${name}' ${context}. The Warp Commerce Model is versioned and evolves only through an accepted model change; ` +
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

// ---------------------------------------------------------------------------
// Auction lowering
//
// The three vocabularies below MIRROR `schema/structure/auxiliary.schema.json`.
// Unlike the commitment states — which are read from the model at runtime via
// {@link knownCommitmentStates} — the model exposes no RUNTIME enumeration of
// them (they exist only as erased TypeScript unions), so they cannot be derived
// the same way. `tests/schema-drift.test.ts` therefore reads the schema and fails
// if these lists drift from it, which is what keeps the schema the source of
// truth here, exactly as the repo's codegen-drift gates do elsewhere.
// ---------------------------------------------------------------------------

/** The model's `AuctionMechanism` variants. */
export const AUCTION_MECHANISM_KINDS = [
  "English",
  "Dutch",
  "SealedBid",
  "Vickrey",
  "ScoredSelection",
] as const;

/** The model's `AuctionState` variants. */
export const AUCTION_STATE_TYPES = ["Scheduled", "Open", "Closed"] as const;

/** The model's `AuctionCloseReason` values. */
export const AUCTION_CLOSE_REASONS = [
  "NormalClose",
  "ReserveNotMet",
  "BuyItNowExercised",
  "SellerCancelled",
  "AwardProtestUpheld",
] as const;

/**
 * Which authored fields each mechanism variant requires and permits. Exported so
 * `tests/schema-drift.test.ts` can hold it against the schema's own `required` /
 * `properties` for each variant.
 */
export const MECHANISM_SPEC: Readonly<
  Record<string, { required: readonly string[]; optional: readonly string[] }>
> = {
  English: { required: [], optional: ["reserve_price", "increment"] },
  Dutch: { required: ["start_price", "decrement", "interval_seconds"], optional: [] },
  SealedBid: { required: ["reveal_at"], optional: ["reserve_price"] },
  Vickrey: { required: [], optional: ["reserve_price"] },
  ScoredSelection: {
    required: ["criterion", "committee", "publication_required"],
    optional: ["minimum_threshold"],
  },
};

/** `'a', 'b', or 'c'` for an error message. */
function orList(items: readonly string[]): string {
  const q = items.map((i) => `'${i}'`);
  if (q.length === 0) return "(none)";
  if (q.length === 1) return q[0] as string;
  return `${q.slice(0, -1).join(", ")}, or ${q[q.length - 1] as string}`;
}

/**
 * Index a block's fields by key, rejecting a repeat of any key except `criterion`
 * (a ScoredSelection names several criteria, one per line).
 */
function indexFields(fields: Field[], blockLabel: string): Map<string, Field[]> {
  const byKey = new Map<string, Field[]>();
  for (const f of fields) {
    const existing = byKey.get(f.key.name);
    if (existing === undefined) {
      byKey.set(f.key.name, [f]);
      continue;
    }
    if (f.key.name !== "criterion") {
      throw new WarpCompileError(
        `Duplicate '${f.key.name}' field in ${blockLabel}.`,
        f.key.pos,
      );
    }
    existing.push(f);
  }
  return byKey;
}

/** The single field for `key`, or undefined. */
function one(byKey: Map<string, Field[]>, key: string): Field | undefined {
  return byKey.get(key)?.[0];
}

/** Lower a money literal to the model's `Money`. */
function toMoney(lit: MoneyLit): Money {
  return { amount: lit.amount, currency: lit.currency };
}

/** Read a required field, or throw naming what is missing and where. */
function required(
  byKey: Map<string, Field[]>,
  key: string,
  blockLabel: string,
  pos: SourcePosition,
): Field {
  const f = one(byKey, key);
  if (f === undefined) {
    throw new WarpCompileError(`${blockLabel} is missing required field '${key}'.`, pos);
  }
  return f;
}

/** The money value of a field (its shape is fixed by the parser's field table). */
function moneyOf(f: Field): Money {
  return toMoney((f.value as Extract<typeof f.value, { shape: "money" }>).money);
}

/** The string value of a field. */
function textOf(f: Field): string {
  return (f.value as Extract<typeof f.value, { shape: "string" }>).text;
}

/** The number value of a field. */
function numberOf(f: Field): number {
  return (f.value as Extract<typeof f.value, { shape: "number" }>).number;
}

/**
 * Lower a `mechanism` block to the model's `AuctionMechanism`. Checks the variant
 * name against the model's list, that every field the variant REQUIRES is present,
 * and that no field belongs to a different variant (the schema declares each
 * variant `additionalProperties: false`).
 */
function compileMechanism(decl: NonNullable<AuctionDecl["mechanism"]>, auction: string): AuctionMechanism {
  const kind = decl.mechanismKind.name;
  if (!(AUCTION_MECHANISM_KINDS as readonly string[]).includes(kind)) {
    throw new WarpCompileError(
      `Unknown auction mechanism '${kind}' in auction '${auction}'. The model defines ` +
        `${orList(AUCTION_MECHANISM_KINDS)}.`,
      decl.mechanismKind.pos,
    );
  }
  const spec = MECHANISM_SPEC[kind] as { required: readonly string[]; optional: readonly string[] };
  const label = `mechanism '${kind}' in auction '${auction}'`;
  const byKey = indexFields(decl.fields, label);

  // No field from a different variant — the schema forbids extra properties.
  const permitted = new Set([...spec.required, ...spec.optional]);
  for (const [key, fields] of byKey) {
    if (!permitted.has(key)) {
      throw new WarpCompileError(
        `Field '${key}' does not belong to the '${kind}' mechanism. '${kind}' takes ` +
          `${orList([...spec.required, ...spec.optional])}.`,
        (fields[0] as Field).key.pos,
      );
    }
  }
  for (const key of spec.required) {
    required(byKey, key, label[0]!.toUpperCase() + label.slice(1), decl.mechanismKind.pos);
  }

  switch (kind) {
    case "English": {
      const reserve = one(byKey, "reserve_price");
      const increment = one(byKey, "increment");
      return {
        kind: "English",
        ...(reserve ? { reserve_price: moneyOf(reserve) } : {}),
        ...(increment ? { increment: moneyOf(increment) } : {}),
      };
    }
    case "Dutch":
      return {
        kind: "Dutch",
        start_price: moneyOf(required(byKey, "start_price", label, decl.pos)),
        decrement: moneyOf(required(byKey, "decrement", label, decl.pos)),
        interval_seconds: numberOf(required(byKey, "interval_seconds", label, decl.pos)),
      };
    case "SealedBid": {
      const reserve = one(byKey, "reserve_price");
      return {
        kind: "SealedBid",
        ...(reserve ? { reserve_price: moneyOf(reserve) } : {}),
        reveal_at: textOf(required(byKey, "reveal_at", label, decl.pos)),
      };
    }
    case "Vickrey": {
      const reserve = one(byKey, "reserve_price");
      return {
        kind: "Vickrey",
        ...(reserve ? { reserve_price: moneyOf(reserve) } : {}),
      };
    }
    default: {
      const criteria = (byKey.get("criterion") ?? []).map((f) => {
        const c = (f.value as Extract<typeof f.value, { shape: "criterion" }>).criterion;
        return { name: c.name, weight: c.weight, max_points: c.maxPoints };
      });
      const committee = (
        one(byKey, "committee")!.value as Extract<Field["value"], { shape: "strings" }>
      ).texts.map((t) => t as PartyID);
      const publication = (
        one(byKey, "publication_required")!.value as Extract<Field["value"], { shape: "bool" }>
      ).bool;
      const threshold = one(byKey, "minimum_threshold");
      return {
        kind: "ScoredSelection",
        criteria,
        ...(threshold ? { minimum_threshold: numberOf(threshold) } : {}),
        evaluation_committee: committee,
        publication_required: publication,
      };
    }
  }
}

/** Lower one `tender` block to the model's `Tendered` commitment state. */
function compileTender(decl: TenderDecl, auction: string): CompiledTender {
  const label = `Tender '${decl.id.name}' in auction '${auction}'`;
  const byKey = indexFields(decl.fields, `tender '${decl.id.name}'`);
  const offer = required(byKey, "offer", label, decl.pos);
  const closesAt = required(byKey, "closes_at", label, decl.pos);
  const superseded = one(byKey, "superseded_by");
  const money = moneyOf(offer);
  return {
    commitment: decl.id.name as CommitmentID,
    state: {
      type: "Tendered",
      offer_amount: money.amount,
      offer_currency: money.currency,
      closes_at: textOf(closesAt),
      ...(superseded ? { superseded_by: textOf(superseded) as CommitmentID } : {}),
    },
  };
}

/**
 * Lower an auction `state` block to the model's `AuctionState`. A `Closed` auction
 * must name a close reason from the model's list; a `winner`, if given, must be one
 * of the auction's own declared tenders (a reference-resolution check, the same
 * kind the lifecycle form makes for a transition target — NOT a model invariant).
 */
function compileAuctionState(
  decl: NonNullable<AuctionDecl["state"]>,
  auction: string,
  tenderIds: Set<string>,
): AuctionState {
  const type = decl.stateType.name;
  if (!(AUCTION_STATE_TYPES as readonly string[]).includes(type)) {
    throw new WarpCompileError(
      `Unknown auction state '${type}' in auction '${auction}'. The model defines ` +
        `${orList(AUCTION_STATE_TYPES)}.`,
      decl.stateType.pos,
    );
  }
  if (type !== "Closed") {
    if (decl.fields.length > 0) {
      throw new WarpCompileError(
        `Auction state '${type}' takes no fields; only 'Closed' carries a reason, a ` +
          `winner, and a winning price.`,
        (decl.fields[0] as Field).key.pos,
      );
    }
    return { type: type as "Scheduled" | "Open" };
  }

  const label = `Auction '${auction}' state 'Closed'`;
  const byKey = indexFields(decl.fields, `auction '${auction}' state 'Closed'`);
  const reasonField = required(byKey, "reason", label, decl.stateType.pos);
  const reason = (reasonField.value as Extract<Field["value"], { shape: "ident" }>).ident;
  if (!(AUCTION_CLOSE_REASONS as readonly string[]).includes(reason.name)) {
    throw new WarpCompileError(
      `Unknown auction close reason '${reason.name}'. The model defines ` +
        `${orList(AUCTION_CLOSE_REASONS)}.`,
      reason.pos,
    );
  }
  const winner = one(byKey, "winner");
  if (winner !== undefined && !tenderIds.has(textOf(winner))) {
    throw new WarpCompileError(
      `Winning commitment '${textOf(winner)}' is not a tender of auction '${auction}'. ` +
        `An auction can only be won by a commitment it collected — declare it with ` +
        `'tender "${textOf(winner)}" { … }'.`,
      winner.key.pos,
    );
  }
  const price = one(byKey, "winning_price");
  return {
    type: "Closed",
    ...(winner ? { winning_commitment: textOf(winner) as CommitmentID } : {}),
    ...(price ? { winning_price: moneyOf(price) } : {}),
    reason: reason.name as AuctionCloseReason,
  };
}

/** Lower one `auction` declaration to the model's AuctionProcess + its tenders. */
function compileAuction(decl: AuctionDecl): CompiledAuction {
  const name = decl.name.name;
  const label = `Auction '${name}'`;
  const byKey = indexFields(decl.fields, `auction '${name}'`);

  const subject = textOf(required(byKey, "subject", label, decl.pos)) as ValueID;
  const seller = textOf(required(byKey, "seller", label, decl.pos)) as PartyID;
  const opensAt = textOf(required(byKey, "opens_at", label, decl.pos));
  const closesAt = textOf(required(byKey, "closes_at", label, decl.pos));

  if (decl.mechanism === undefined) {
    throw new WarpCompileError(
      `${label} is missing its 'mechanism' (how the winner is determined).`,
      decl.pos,
    );
  }
  if (decl.state === undefined) {
    throw new WarpCompileError(`${label} is missing its 'state'.`, decl.pos);
  }

  // Tenders, in source order — their ids ARE the process's tendered_commitments.
  const tenders: CompiledTender[] = [];
  const seen = new Set<string>();
  for (const t of decl.tenders) {
    if (seen.has(t.id.name)) {
      throw new WarpCompileError(
        `Duplicate tender '${t.id.name}' in auction '${name}'. A commitment id ` +
          `identifies exactly one commitment (Invariant 5: Identity Permanence).`,
        t.id.pos,
      );
    }
    seen.add(t.id.name);
    tenders.push(compileTender(t, name));
  }

  const mechanism = compileMechanism(decl.mechanism, name);
  const state = compileAuctionState(decl.state, name, seen);

  const process: AuctionProcess = {
    id: name,
    subject,
    seller,
    mechanism,
    tendered_commitments: tenders.map((t) => t.commitment),
    opens_at: opensAt,
    closes_at: closesAt,
    state,
  };

  // The model's UnderAuction ValueState applies to the subject while the auction
  // is OPEN — that is the state in which the value is under an active auction.
  const subjectState: ValueState | null =
    state.type === "Open"
      ? { type: "UnderAuction", auction_process_id: process.id, closes_at: closesAt }
      : null;

  return { process, tenders, subjectState };
}

/**
 * Lower a parsed {@link Document} to the current model's structures. Enforces
 * well-formedness (known states, resolved references, unique declarations); does
 * NOT judge soundness — that is the model's temporal verifier's job. Throws
 * {@link WarpCompileError} at a precise position on the first semantic problem.
 */

// ---------------------------------------------------------------------------
// Policy lowering
//
// A policy authors RULES. Each field below becomes a value some existing model
// function already takes as a parameter — so "the authored rule enforces like the
// hand-written one" is true by CONSTRUCTION (they are the same value), not by a
// second implementation that happens to agree.
//
// What the compiler checks here is WELL-FORMEDNESS and REFERENCE RESOLUTION only:
// that an asserted invariant is one of the model's six, that a narrowed state is a
// real model state, that `applies_to` names a profile the document declares, and
// that a floor and its committed price share a currency. It does NOT check whether
// a rule is economically sound — an authored policy that permits an incoherent
// outcome still compiles, and is still caught downstream by the model's own
// invariants. The language cannot smuggle unsound logic past them.
// ---------------------------------------------------------------------------

/** `I1`…`I6` as authored → the model's `InvariantId` (`"I-1"`…`"I-6"`). */
const INVARIANT_ALIASES: Readonly<Record<string, InvariantId>> = {
  I1: "I-1",
  I2: "I-2",
  I3: "I-3",
  I4: "I-4",
  I5: "I-5",
  I6: "I-6",
};

function dupPolicyField(key: string, pos: SourcePosition, policy: string): never {
  throw new WarpCompileError(`Duplicate '${key}' field in policy '${policy}'.`, pos);
}

/**
 * Lower one policy declaration. `profilesById` is every profile the document
 * declared, already compiled — policies are lowered in a SECOND pass so a policy
 * may reference a profile declared before OR after it in the file.
 */
function compilePolicy(decl: PolicyDecl, profilesById: Map<string, CompiledProfile>): CompiledPolicy {
  const id = decl.name.name;
  let label: string | undefined;
  let description: string | undefined;
  let appliesTo: { ident: string; pos: SourcePosition } | undefined;
  let forbidStates: { names: string[]; pos: SourcePosition } | undefined;
  let floorExpr: Expr | undefined;
  let floorPos: SourcePosition | undefined;
  let committedExpr: Expr | undefined;
  let committedPos: SourcePosition | undefined;
  const jurisdictions: JurisdictionTaxRates[] = [];
  const seenJurisdictions = new Set<string>();
  let asserts: InvariantId[] | undefined;

  for (const f of decl.fields) {
    if (f.key === "label") {
      if (label !== undefined) dupPolicyField("label", f.pos, id);
      label = f.text as string;
    } else if (f.key === "description") {
      if (description !== undefined) dupPolicyField("description", f.pos, id);
      description = f.text as string;
    } else if (f.key === "applies_to") {
      if (appliesTo !== undefined) dupPolicyField("applies_to", f.pos, id);
      const ref = f.ref as Ident;
      appliesTo = { ident: ref.name, pos: ref.pos };
    } else if (f.key === "forbid_states") {
      if (forbidStates !== undefined) dupPolicyField("forbid_states", f.pos, id);
      const names: string[] = [];
      for (const st of f.list ?? []) {
        assertKnownState(st.name, st.pos, `in policy '${id}' forbid_states`);
        if (!names.includes(st.name)) names.push(st.name);
      }
      forbidStates = { names, pos: f.pos };
    } else if (f.key === "concession_floor") {
      if (floorExpr !== undefined) dupPolicyField("concession_floor", f.pos, id);
      floorExpr = f.expr as Expr;
      floorPos = f.pos;
    } else if (f.key === "committed_price") {
      if (committedExpr !== undefined) dupPolicyField("committed_price", f.pos, id);
      committedExpr = f.expr as Expr;
      committedPos = f.pos;
    } else if (f.key === "tax_rates") {
      const tr = f.taxRates as NonNullable<typeof f.taxRates>;
      if (seenJurisdictions.has(tr.jurisdiction)) {
        throw new WarpCompileError(
          `Duplicate 'tax_rates' entry for jurisdiction "${tr.jurisdiction}" in policy '${id}'. ` +
            `List each jurisdiction once, with all its permitted rates on that line.`,
          tr.pos,
        );
      }
      seenJurisdictions.add(tr.jurisdiction);
      jurisdictions.push({ jurisdiction: tr.jurisdiction, rates: [...tr.rates] });
    } else {
      // assert
      if (asserts !== undefined) dupPolicyField("assert", f.pos, id);
      const ids: InvariantId[] = [];
      for (const a of f.list ?? []) {
        const mapped = INVARIANT_ALIASES[a.name];
        if (mapped === undefined) {
          throw new WarpCompileError(
            `Unknown invariant '${a.name}' asserted by policy '${id}'. The model defines six ` +
              `invariants; assert them as ${Object.keys(INVARIANT_ALIASES).join(", ")} ` +
              `(I1 = Value Conservation, I2 = State Monotonicity, I3 = Capacity Verification, ` +
              `I4 = Temporal Integrity, I5 = Identity Permanence, I6 = Commitment Tree Consistency).`,
            a.pos,
          );
        }
        if (!ids.includes(mapped)) ids.push(mapped);
      }
      asserts = ids;
    }
  }

  // --- reference resolution: applies_to must name a profile this document declares
  let narrowed: CommerceProfile | undefined;
  if (appliesTo !== undefined) {
    const base = profilesById.get(appliesTo.ident);
    if (base === undefined) {
      const declared = [...profilesById.keys()].sort();
      throw new WarpCompileError(
        `Policy '${id}' applies_to profile '${appliesTo.ident}', which this document does not ` +
          `declare. ` +
          (declared.length === 0
            ? `No profile is declared in this document — declare one with 'profile ${appliesTo.ident} { … }'.`
            : `Declared profiles: ${declared.join(", ")}.`),
        appliesTo.pos,
      );
    }
    const forbidden = forbidStates?.names ?? [];
    narrowed = {
      id,
      label: label ?? id,
      // The BASE profile's description, deliberately: `guardWithProfile` embeds it
      // as "configured for <description>", which needs the noun phrase describing
      // the KIND OF COMMERCE, not the policy's rationale. The policy's own
      // description stays on CompiledPolicy.description.
      description: base.description,
      allowedStates: base.allowedStates.filter((st) => !forbidden.includes(st)),
      allowedValueForms: base.allowedValueForms,
    };
  } else if (forbidStates !== undefined) {
    throw new WarpCompileError(
      `Policy '${id}' declares 'forbid_states' but no 'applies_to'. A forbidden state narrows a ` +
        `profile, so the policy must say which profile it narrows: add ` +
        `'applies_to <profile-id>'.`,
      forbidStates.pos,
    );
  }

  // --- negotiation bounds -------------------------------------------------
  //
  // A value position is an EXPRESSION (rung 5A). Two things happen here:
  //
  //  1. Every variable an expression names is checked against the closed context
  //     list, at compile time, with the offending token's position. A typo is a
  //     compile error, not a runtime surprise.
  //  2. A CONSTANT expression is folded to its value immediately, so a policy
  //     that was written before 5A produces exactly the `bounds` it always did,
  //     and the pre-existing well-formedness checks below still apply to it.
  //     A value that references the context cannot be folded — it becomes
  //     `derived`, resolved later against a real commitment.
  //
  // The checks that CANNOT be made at compile time for a derived value (floor ≤
  // committed, matching currencies) are not skipped: `resolveSystem` applies the
  // identical checks to the evaluated numbers, and beyond that `guardConcession`
  // enforces the floor exactly as it does for a literal. A computed value gets
  // strictly no dispensation.
  const evalConst = (e: Expr, what: string, pos: SourcePosition): Money => {
    const r = evaluate(e, {});
    if (!r.ok) {
      throw new WarpCompileError(
        `Policy '${id}': ${what} could not be computed — ${r.error.message}`,
        r.error.pos,
      );
    }
    if (r.value.kind !== "money") {
      throw new WarpCompileError(
        `Policy '${id}': ${what} must be a money amount, but '${formatExpr(e)}' evaluates to the ` +
          `plain number ${r.value.value}. Give it a currency (e.g. '${r.value.value} MAD'), or ` +
          `scale a money value (e.g. 'committed * 0.75').`,
        pos,
      );
    }
    return { amount: r.value.amount, currency: r.value.currency };
  };

  const checkVars = (e: Expr, what: string): void => {
    for (const name of variablesOf(e)) {
      if (!CONTEXT_VARIABLE_NAMES.includes(name as (typeof CONTEXT_VARIABLE_NAMES)[number])) {
        const at = (function find(x: Expr): SourcePosition | undefined {
          if (x.kind === "var") return x.name === name ? x.pos : undefined;
          if (x.kind === "binary") return find(x.left) ?? find(x.right);
          if (x.kind === "call") return x.args.map(find).find((p) => p !== undefined);
          return undefined;
        })(e);
        throw new WarpCompileError(
          `Policy '${id}': ${what} references unknown variable '${name}'. An expression may use ` +
            `only the commerce context: ${CONTEXT_VARIABLE_NAMES.join(", ")}.`,
          at ?? decl.pos,
        );
      }
    }
  };

  let bounds: NegotiationBounds | undefined;
  let derived: CompiledPolicy["derived"];

  if (floorExpr !== undefined) checkVars(floorExpr, "concession_floor");
  if (committedExpr !== undefined) checkVars(committedExpr, "committed_price");

  if (floorExpr !== undefined) {
    const floorConst = isConstant(floorExpr);
    const committedConst = committedExpr === undefined || isConstant(committedExpr);

    if (floorConst && committedConst) {
      // Fully constant — fold now and apply the original checks unchanged.
      const floor = evalConst(floorExpr, "concession_floor", floorPos as SourcePosition);
      const committed =
        committedExpr === undefined
          ? undefined
          : evalConst(committedExpr, "committed_price", committedPos as SourcePosition);
      if (committed !== undefined && committed.currency !== floor.currency) {
        throw new WarpCompileError(
          `Policy '${id}' sets a concession_floor in ${floor.currency} but a committed_price in ` +
            `${committed.currency}. A cross-currency concession is out of scope — express both in ` +
            `one currency (Invariant 1: Value Conservation).`,
          committedPos as SourcePosition,
        );
      }
      if (committed !== undefined && floor.amount > committed.amount) {
        throw new WarpCompileError(
          `Policy '${id}' sets a concession_floor of ${floor.amount} ${floor.currency} above its ` +
            `committed_price of ${committed.amount} ${committed.currency}. The floor is the LOWEST ` +
            `acceptable price, so it cannot exceed the opening price.`,
          floorPos as SourcePosition,
        );
      }
      bounds = committed === undefined ? { floor } : { floor, committed };
    } else {
      // At least one value depends on the commitment — resolve it later.
      derived = {};
      if (!floorConst) derived.floor = floorExpr;
      else bounds = { floor: evalConst(floorExpr, "concession_floor", floorPos as SourcePosition) };
      if (committedExpr !== undefined) {
        if (!committedConst) derived.committed = committedExpr;
        else {
          const c = evalConst(committedExpr, "committed_price", committedPos as SourcePosition);
          bounds = bounds === undefined ? ({ committed: c } as unknown as NegotiationBounds) : { ...bounds, committed: c };
        }
      }
    }
  } else if (committedExpr !== undefined) {
    throw new WarpCompileError(
      `Policy '${id}' sets a 'committed_price' but no 'concession_floor'. The committed price is ` +
        `the opening price a floor is measured against, so it is only meaningful alongside one.`,
      committedPos as SourcePosition,
    );
  }

  const pack: RegulatoryPolicyPack | undefined =
    jurisdictions.length === 0
      ? undefined
      : {
          id,
          label: label ?? id,
          description: description ?? id,
          jurisdictions,
        };

  const compiled: CompiledPolicy = {
    id,
    label: label ?? id,
    description: description ?? id,
    asserts: asserts ?? [],
  };
  if (bounds !== undefined) compiled.bounds = bounds;
  if (derived !== undefined) compiled.derived = derived;
  if (narrowed !== undefined) {
    compiled.profile = narrowed;
    compiled.appliesTo = appliesTo?.ident as string;
  }
  if (pack !== undefined) compiled.pack = pack;
  return compiled;
}

/**
 * Lower one composition declaration.
 *
 * Every leg must declare an `amount`, and every variable it names is checked
 * against the closed rung-5A context at compile time. What is deliberately NOT
 * checked here is whether the legs reconcile with the parent — that is I-6, it
 * already exists, and a second copy of it in the compiler would be one more thing
 * to keep in step for no gain.
 */
function compileComposition(decl: CompositionDecl): CompiledComposition {
  const id = decl.name.name;
  let label: string | undefined;
  let description: string | undefined;

  for (const f of decl.fields) {
    if (f.key === "label") {
      if (label !== undefined) {
        throw new WarpCompileError(`Duplicate 'label' field in composition '${id}'.`, f.pos);
      }
      label = f.text;
    } else {
      if (description !== undefined) {
        throw new WarpCompileError(`Duplicate 'description' field in composition '${id}'.`, f.pos);
      }
      description = f.text;
    }
  }

  if (decl.legs.length === 0) {
    throw new WarpCompileError(
      `Composition '${id}' declares no legs. A composition describes how a commitment splits, ` +
        `so it needs at least one 'leg <name> { amount … }'.`,
      decl.pos,
    );
  }

  const seen = new Set<string>();
  const legs: CompiledComposition["legs"] = [];
  for (const leg of decl.legs) {
    if (seen.has(leg.name.name)) {
      throw new WarpCompileError(
        `Duplicate leg '${leg.name.name}' in composition '${id}'. Leg names address the child ` +
          `commitments a build produces, so they must be unique.`,
        leg.name.pos,
      );
    }
    seen.add(leg.name.name);

    if (leg.amount === undefined) {
      throw new WarpCompileError(
        `Leg '${leg.name.name}' in composition '${id}' has no 'amount'. Every leg needs one — ` +
          `a money literal, or an expression over the parent (e.g. 'committed * 0.85').`,
        leg.pos,
      );
    }
    for (const name of variablesOf(leg.amount)) {
      if (!CONTEXT_VARIABLE_NAMES.includes(name as (typeof CONTEXT_VARIABLE_NAMES)[number])) {
        throw new WarpCompileError(
          `Composition '${id}', leg '${leg.name.name}': amount references unknown variable ` +
            `'${name}'. An expression may use only the commerce context: ` +
            `${CONTEXT_VARIABLE_NAMES.join(", ")}.`,
          leg.amount.pos,
        );
      }
    }
    legs.push({ name: leg.name.name, amount: leg.amount });
  }

  return { id, label: label ?? id, description: description ?? id, legs };
}

/**
 * Lower a parsed {@link Document} to the model's structures.
 *
 * TWO PASSES. Lifecycles, profiles and auctions are lowered in source order;
 * POLICIES are lowered afterwards, once every profile in the document is known,
 * so a policy may `applies_to` a profile declared either before or after it. An
 * unresolved reference is a positioned {@link WarpCompileError}, not a silent
 * skip.
 */
export function compileDocument(doc: Document): CompiledModel {
  const lifecycles: CompiledLifecycle[] = [];
  const profiles: CompiledProfile[] = [];
  const auctions: CompiledAuction[] = [];
  const policies: CompiledPolicy[] = [];
  const compositions: CompiledComposition[] = [];
  const lifecycleNames = new Set<string>();
  const profileNames = new Set<string>();
  const auctionNames = new Set<string>();
  const policyNames = new Set<string>();
  const compositionNames = new Set<string>();
  const policyDecls: PolicyDecl[] = [];

  // Pass 1 — structure (lifecycle / profile / auction), in source order.
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
    } else if (decl.kind === "profile") {
      if (profileNames.has(decl.name.name)) {
        throw new WarpCompileError(`Duplicate profile '${decl.name.name}'.`, decl.name.pos);
      }
      profileNames.add(decl.name.name);
      profiles.push(compileProfile(decl));
    } else if (decl.kind === "auction") {
      if (auctionNames.has(decl.name.name)) {
        throw new WarpCompileError(
          `Duplicate auction '${decl.name.name}'. An AuctionProcess id identifies ` +
            `exactly one auction (Invariant 5: Identity Permanence).`,
          decl.name.pos,
        );
      }
      auctionNames.add(decl.name.name);
      auctions.push(compileAuction(decl));
    } else if (decl.kind === "policy") {
      if (policyNames.has(decl.name.name)) {
        throw new WarpCompileError(`Duplicate policy '${decl.name.name}'.`, decl.name.pos);
      }
      policyNames.add(decl.name.name);
      policyDecls.push(decl);
    } else {
      if (compositionNames.has(decl.name.name)) {
        throw new WarpCompileError(`Duplicate composition '${decl.name.name}'.`, decl.name.pos);
      }
      compositionNames.add(decl.name.name);
      compositions.push(compileComposition(decl));
    }
  }

  // Pass 2 — policies, now that every profile is resolvable.
  const profilesById = new Map<string, CompiledProfile>(profiles.map((pr) => [pr.id, pr]));
  for (const decl of policyDecls) {
    policies.push(compilePolicy(decl, profilesById));
  }

  return { lifecycles, profiles, auctions, policies, compositions };
}

/** Parse `.warp` source and lower it in one step. Throws on syntax or semantic error. */
export function compile(source: string, opts: { file?: string } = {}): CompiledModel {
  return compileDocument(parse(source, opts));
}
