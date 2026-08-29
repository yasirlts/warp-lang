/**
 * The AST — the shape a `.warp` document parses INTO, before it is lowered to the
 * current model's structures. Every node carries the source position of its FIRST
 * token so the compiler can report semantic errors (unknown state, undeclared
 * reference) with the same line/col precision the parser gives syntax errors.
 *
 * The AST is deliberately small: every node mirrors, one-to-one, something the
 * model ALREADY has — a commitment LIFECYCLE (states + the legal transitions
 * between them), a PROFILE (a named data subset of the model), an AUCTION
 * (the `AuctionProcess` auxiliary coordination record, plus the `Tendered`
 * commitment states it collects), and a POLICY (commerce RULES that lower to the
 * model's existing rule structures: `NegotiationBounds`, a narrowed
 * `CommerceProfile`, a `RegulatoryPolicyPack`, and the invariant ids an audit
 * selects on). It introduces no node the model has no counterpart for.
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

// ---------------------------------------------------------------------------
// Auction (this rung) — the market-making forms. Every node below lowers to a
// structure the model already defines in `schema/structure/auxiliary.schema.json`
// (`AuctionProcess`, `AuctionMechanism`, `AuctionState`) or to the model's
// existing `Tendered` commitment state. Nothing here is a new model concept.
// ---------------------------------------------------------------------------

/** A money literal — `1050000 MAD`. Lowers to the model's `Money`. */
export interface MoneyLit {
  amount: number;
  currency: string;
  pos: SourcePosition;
}

/** One weighted award criterion — `criterion "price" 0.6 100` (ScoredSelection). */
export interface CriterionLit {
  name: string;
  weight: number;
  maxPoints: number;
  pos: SourcePosition;
}

/**
 * The value side of a `key value` field. Which shape a key takes is fixed by the
 * key (see the parser's field tables), so the parser knows what to read next and
 * can name it precisely when it is missing.
 */
export type FieldValue =
  | { shape: "money"; money: MoneyLit }
  | { shape: "number"; number: number }
  | { shape: "string"; text: string }
  | { shape: "bool"; bool: boolean }
  | { shape: "strings"; texts: string[] }
  | { shape: "ident"; ident: Ident }
  | { shape: "criterion"; criterion: CriterionLit };

/** One `key value` field inside an auction, mechanism, tender, or state block. */
export interface Field {
  kind: "field";
  key: Ident;
  value: FieldValue;
  pos: SourcePosition;
}

/**
 * `mechanism <Kind> { … }` — how the auction determines its winner. `kind` is one
 * of the model's `AuctionMechanism` variants; the fields are that variant's.
 */
export interface MechanismDecl {
  kind: "mechanism";
  /** The mechanism variant name (English, Dutch, SealedBid, Vickrey, ScoredSelection). */
  mechanismKind: Ident;
  fields: Field[];
  pos: SourcePosition;
}

/**
 * `state <Scheduled | Open | Closed { … }>` inside an auction — the model's
 * `AuctionState`. Only `Closed` takes a block (it carries the close reason and,
 * optionally, the winner and winning price).
 */
export interface AuctionStateDecl {
  kind: "auctionState";
  /** The state variant name (Scheduled, Open, Closed). */
  stateType: Ident;
  fields: Field[];
  pos: SourcePosition;
}

/**
 * `tender "<commitment-id>" { offer … closes_at … }` — one open offer in the
 * auction. Lowers to the model's existing `Tendered` commitment state. The id is
 * authored as a STRING and used verbatim: commitment ids are never derived
 * (Invariant 5, Identity Permanence).
 */
export interface TenderDecl {
  kind: "tender";
  /** The tendered commitment's id, exactly as authored. */
  id: Ident;
  fields: Field[];
  pos: SourcePosition;
}

/** An item inside an `auction { … }` block: a plain field, a mechanism, a state, or a tender. */
export type AuctionItem = Field | MechanismDecl | AuctionStateDecl | TenderDecl;

/**
 * `auction "<id>" { subject … seller … mechanism … tender … state … }` — authors
 * the model's `AuctionProcess` auxiliary record together with the `Tendered`
 * commitments it collects. It is a coordination record, NOT a sixth primitive.
 */
export interface AuctionDecl {
  kind: "auction";
  /** The AuctionProcess id, exactly as authored. */
  name: Ident;
  fields: Field[];
  mechanism: MechanismDecl | undefined;
  state: AuctionStateDecl | undefined;
  tenders: TenderDecl[];
  pos: SourcePosition;
}


// ---------------------------------------------------------------------------
// Policy (this rung) — the LOGIC forms. Where a lifecycle/profile/auction author
// the model's SHAPE, a policy authors commerce RULES. Every field below lowers to
// a rule structure the model ALREADY defines and ALREADY enforces:
//
//   concession_floor / committed_price  → NegotiationBounds   (guardConcession)
//   applies_to + forbid_states          → CommerceProfile     (guardWithProfile)
//   tax_rates                           → RegulatoryPolicyPack (checkSettlementPolicy)
//   assert                              → InvariantId[]       (auditCommerce)
//
// The language AUTHORS these rules; the model ENFORCES them. No new rule type is
// introduced here, because a rule the model cannot enforce would be fiction.
// ---------------------------------------------------------------------------

/** `tax_rates "MA" 0, 0.1, 0.2` — one jurisdiction's permitted rates. Lowers to `JurisdictionTaxRates`. */
export interface TaxRatesLit {
  /** ISO 3166-1 alpha-2 jurisdiction code, exactly as authored. */
  jurisdiction: string;
  /** The permitted `tax_rate` fractions, in source order (0.2 === 20%). */
  rates: number[];
  pos: SourcePosition;
}

/** The field keys a `policy { … }` block accepts. */
export type PolicyFieldKey =
  | "label"
  | "description"
  | "applies_to"
  | "forbid_states"
  | "concession_floor"
  | "committed_price"
  | "tax_rates"
  | "assert";

/** One `key value` field inside a `policy { … }` block. */
export interface PolicyField {
  key: PolicyFieldKey;
  /** Present for `label` / `description` (a string literal). */
  text?: string;
  /** Present for `concession_floor` / `committed_price` (a money literal). */
  money?: MoneyLit;
  /** Present for `applies_to` (the referenced profile id). */
  ref?: Ident;
  /** Present for `forbid_states` / `assert` (a comma-separated identifier list). */
  list?: Ident[];
  /** Present for `tax_rates` (a jurisdiction plus its permitted rates). */
  taxRates?: TaxRatesLit;
  pos: SourcePosition;
}

/**
 * `policy <id> { … }` — authors commerce RULES over the model the other
 * declarations describe. Lowers to the model's existing rule structures; it adds
 * no enforcement of its own.
 */
export interface PolicyDecl {
  kind: "policy";
  name: Ident;
  fields: PolicyField[];
  pos: SourcePosition;
}

/** A top-level declaration: a lifecycle, a profile, an auction, or a policy. */
export type Declaration = LifecycleDecl | ProfileDecl | AuctionDecl | PolicyDecl;

/** A parsed `.warp` document — a sequence of declarations. */
export interface Document {
  kind: "document";
  declarations: Declaration[];
}
