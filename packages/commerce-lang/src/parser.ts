/**
 * A hand-written recursive-descent parser: token stream → {@link Document} AST.
 * No parser-generator, no heavyweight compiler infrastructure — the grammar is
 * small enough (four declaration forms) that a direct descent is the clearest and
 * gives the most controllable error messages, which is the point of the exercise.
 *
 * The grammar it accepts (see GRAMMAR.md for the canonical form):
 *
 *   document    := declaration*
 *   declaration := lifecycle | profile | auction | policy
 *   lifecycle   := "lifecycle" IDENT "{" lifecycleItem* "}"
 *   lifecycleItem := "state" IDENT
 *                  | IDENT "->" identList
 *   profile     := "profile" IDENT "{" profileField* "}"
 *   profileField := "label" STRING
 *                 | "description" STRING
 *                 | "states" identList
 *                 | "value_forms" identList
 *   auction     := "auction" STRING "{" auctionItem* "}"
 *   auctionItem := ("subject" | "seller" | "opens_at" | "closes_at") STRING
 *                | "mechanism" IDENT [ "{" field* "}" ]
 *                | "tender" STRING "{" field* "}"
 *                | "state" IDENT [ "{" field* "}" ]
 *   policy      := "policy" IDENT "{" policyField* "}"
 *   policyField := ("label" | "description") STRING
 *                | "applies_to" IDENT
 *                | ("forbid_states" | "assert") identList
 *                | ("concession_floor" | "committed_price") expr
 *                | "tax_rates" STRING numberList
 *   expr        := term { ("+" | "-") term }
 *   term        := factor { ("*" | "/") factor }
 *   factor      := money | NUMBER | IDENT | "(" expr ")"
 *                | ("min" | "max") "(" expr { "," expr } ")"
 *   identList   := IDENT ("," IDENT)*
 *   numberList  := NUMBER ("," NUMBER)*
 *   money       := NUMBER IDENT                        (* 1050000 MAD *)
 *
 * A `field` is `key value`, where the KEY fixes the value's shape (money, number,
 * string, bool, string list, identifier, or a `criterion NAME WEIGHT MAX`). The
 * per-block key tables are right below, so a wrong key names the legal ones.
 *
 * Every parse failure is a {@link WarpSyntaxError} carrying the offending token's
 * line/col and a human phrase for what was expected there.
 */

import type {
  AuctionDecl,
  AuctionItem,
  AuctionStateDecl,
  CriterionLit,
  Declaration,
  Document,
  Field,
  FieldValue,
  Ident,
  LifecycleDecl,
  MechanismDecl,
  MoneyLit,
  PolicyDecl,
  PolicyField,
  PolicyFieldKey,
  ProfileDecl,
  ProfileField,
  StateDecl,
  TenderDecl,
  TransitionDecl,
} from "./ast.js";
import { WarpSyntaxError } from "./errors.js";
import { tokenize, type Token, type TokenType } from "./lexer.js";
import { EXPR_FUNCTIONS, type Expr } from "./expr.js";

/** The four keywords legal as a profile field. */
const PROFILE_FIELD_KEYS = ["label", "description", "states", "value_forms"] as const;
type ProfileFieldKey = (typeof PROFILE_FIELD_KEYS)[number];

/**
 * The keys a `policy { … }` block accepts, in the order the error message lists
 * them. Each one lowers to a rule structure the model already enforces; see
 * {@link PolicyDecl}.
 */
const POLICY_FIELD_KEYS = [
  "label",
  "description",
  "applies_to",
  "forbid_states",
  "concession_floor",
  "committed_price",
  "tax_rates",
  "assert",
] as const;

/** The value shape a field key takes — what the parser reads after the key. */
type Shape = FieldValue["shape"];

/** A block's legal field keys, each mapped to the value shape it takes. */
type FieldTable = Readonly<Record<string, Shape>>;

/**
 * Plain fields of an `auction` block. `mechanism`, `tender` and `state` are NOT
 * here — they open sub-blocks and are handled structurally.
 */
const AUCTION_FIELDS: FieldTable = {
  subject: "string",
  seller: "string",
  opens_at: "string",
  closes_at: "string",
};

/**
 * Every field any `AuctionMechanism` variant can carry. The parser accepts the
 * union (so a misplaced field still parses and gets a precise, variant-aware
 * COMPILE error naming the mechanism it does not belong to); the compiler is what
 * enforces which fields belong to which variant.
 */
const MECHANISM_FIELDS: FieldTable = {
  reserve_price: "money",
  increment: "money",
  start_price: "money",
  decrement: "money",
  interval_seconds: "number",
  reveal_at: "string",
  criterion: "criterion",
  minimum_threshold: "number",
  committee: "strings",
  publication_required: "bool",
};

/** Fields of a `tender` block — an open offer, lowering to the `Tendered` state. */
const TENDER_FIELDS: FieldTable = {
  offer: "money",
  closes_at: "string",
  superseded_by: "string",
};

/** Fields of an auction `state Closed { … }` block. */
const AUCTION_STATE_FIELDS: FieldTable = {
  reason: "ident",
  winner: "string",
  winning_price: "money",
};

/** `'a', 'b', or 'c'` — the legal keys of a block, for an error message. */
function keyList(table: FieldTable): string {
  const keys = Object.keys(table).map((k) => `'${k}'`);
  if (keys.length <= 1) return keys.join("");
  return `${keys.slice(0, -1).join(", ")}, or ${keys[keys.length - 1] as string}`;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  /** The current token without consuming it. */
  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  /** Consume and return the current token. */
  private next(): Token {
    const t = this.tokens[this.index] as Token;
    if (t.type !== "eof") this.index += 1;
    return t;
  }

  /** True if the current token is `type` (and, for idents, matches `value`). */
  private at(type: TokenType, value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }

  /**
   * Consume a token of `type` or throw a positioned error naming what was
   * expected. `expected` is the human phrase used in the message.
   */
  private expect(type: TokenType, expected: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new WarpSyntaxError(
        `Expected ${expected} but found ${describe(t)}.`,
        t.pos,
        expected,
      );
    }
    return this.next();
  }

  /** Parse a bare identifier into an {@link Ident} (name + position). */
  private ident(expected: string): Ident {
    const t = this.expect("ident", expected);
    return { name: t.value, pos: t.pos };
  }

  /** identList := IDENT ("," IDENT)* — one or more comma-separated identifiers. */
  private identList(expected: string): Ident[] {
    const list: Ident[] = [this.ident(expected)];
    while (this.at("comma")) {
      this.next(); // consume ','
      list.push(this.ident(expected));
    }
    return list;
  }

  /** numberList := NUMBER ("," NUMBER)* — one or more comma-separated numbers. */
  private numberList(expected: string): number[] {
    const list: number[] = [Number(this.expect("number", expected).value)];
    while (this.at("comma")) {
      this.next(); // consume ','
      list.push(Number(this.expect("number", expected).value));
    }
    return list;
  }

  /** document := declaration* */
  parseDocument(): Document {
    const declarations: Declaration[] = [];
    while (!this.at("eof")) {
      declarations.push(this.parseDeclaration());
    }
    return { kind: "document", declarations };
  }

  private parseDeclaration(): Declaration {
    const t = this.peek();
    if (t.type === "ident" && t.value === "lifecycle") return this.parseLifecycle();
    if (t.type === "ident" && t.value === "profile") return this.parseProfile();
    if (t.type === "ident" && t.value === "auction") return this.parseAuction();
    if (t.type === "ident" && t.value === "policy") return this.parsePolicy();
    throw new WarpSyntaxError(
      `Expected a declaration but found ${describe(t)}.`,
      t.pos,
      "'lifecycle', 'profile', 'auction', or 'policy'",
    );
  }

  /** lifecycle := "lifecycle" IDENT "{" lifecycleItem* "}" */
  private parseLifecycle(): LifecycleDecl {
    const kw = this.next(); // 'lifecycle'
    const name = this.ident("a lifecycle name");
    this.expect("lbrace", "'{'");
    const states: StateDecl[] = [];
    const transitions: TransitionDecl[] = [];
    while (!this.at("rbrace") && !this.at("eof")) {
      const item = this.parseLifecycleItem();
      if (item.kind === "state") states.push(item);
      else transitions.push(item);
    }
    this.expect("rbrace", "'}' to close the lifecycle block");
    return { kind: "lifecycle", name, states, transitions, pos: kw.pos };
  }

  /** lifecycleItem := "state" IDENT | IDENT "->" identList */
  private parseLifecycleItem(): StateDecl | TransitionDecl {
    const t = this.peek();
    if (t.type === "ident" && t.value === "state") {
      const kw = this.next(); // 'state'
      const name = this.ident("a state name after 'state'");
      return { kind: "state", name, pos: kw.pos };
    }
    // Otherwise a transition: IDENT "->" identList.
    if (t.type !== "ident") {
      throw new WarpSyntaxError(
        `Expected 'state' or a transition (like 'Draft -> Proposed') but found ${describe(t)}.`,
        t.pos,
        "'state' or a state name",
      );
    }
    const from = this.ident("a source state");
    this.expect("arrow", "'->' after the source state");
    const to = this.identList("a target state");
    return { kind: "transition", from, to, pos: from.pos };
  }

  // -------------------------------------------------------------------------
  // Auction forms — every one lowers to a structure the model already defines.
  // -------------------------------------------------------------------------

  /** Read a STRING token as an {@link Ident} (a model id is authored as a string). */
  private stringAsIdent(expected: string): Ident {
    const t = this.expect("string", expected);
    return { name: t.value, pos: t.pos };
  }

  /** money := NUMBER IDENT — `1050000 MAD`. */
  private money(key: string): MoneyLit {
    const amount = this.expect("number", `an amount after '${key}' (like '1500 MAD')`);
    const currency = this.expect("ident", `a currency code after the amount in '${key}' (like 'MAD')`);
    return { amount: Number(amount.value), currency: currency.value, pos: amount.pos };
  }

  /** criterion := STRING NUMBER NUMBER — `criterion "price" 0.6 100`. */
  private criterion(): CriterionLit {
    const name = this.expect("string", "a criterion name (like \"price\")");
    const weight = this.expect("number", "a criterion weight (like 0.6)");
    const maxPoints = this.expect("number", "a criterion max_points (like 100)");
    return {
      name: name.value,
      weight: Number(weight.value),
      maxPoints: Number(maxPoints.value),
      pos: name.pos,
    };
  }

  /** stringList := STRING ("," STRING)* */
  private stringList(expected: string): string[] {
    const list: string[] = [this.expect("string", expected).value];
    while (this.at("comma")) {
      this.next(); // consume ','
      list.push(this.expect("string", expected).value);
    }
    return list;
  }

  /**
   * field := KEY value — where `table` fixes both the legal keys and, per key, the
   * shape of the value that follows. An unknown key names every legal key here.
   */
  private parseField(table: FieldTable, blockLabel: string): Field {
    const t = this.peek();
    if (t.type !== "ident" || !(t.value in table)) {
      throw new WarpSyntaxError(
        `Expected a ${blockLabel} field but found ${describe(t)}.`,
        t.pos,
        `one of ${keyList(table)}`,
      );
    }
    const key: Ident = { name: this.next().value, pos: t.pos };
    const shape = table[key.name] as Shape;
    let value: FieldValue;
    switch (shape) {
      case "money":
        value = { shape: "money", money: this.money(key.name) };
        break;
      case "number":
        value = {
          shape: "number",
          number: Number(this.expect("number", `a number after '${key.name}'`).value),
        };
        break;
      case "string":
        value = { shape: "string", text: this.expect("string", `a string after '${key.name}'`).value };
        break;
      case "bool": {
        const b = this.expect("ident", `'true' or 'false' after '${key.name}'`);
        if (b.value !== "true" && b.value !== "false") {
          throw new WarpSyntaxError(
            `Expected 'true' or 'false' after '${key.name}' but found '${b.value}'.`,
            b.pos,
            "'true' or 'false'",
          );
        }
        value = { shape: "bool", bool: b.value === "true" };
        break;
      }
      case "strings":
        value = { shape: "strings", texts: this.stringList(`a string list after '${key.name}'`) };
        break;
      case "ident":
        value = { shape: "ident", ident: this.ident(`an identifier after '${key.name}'`) };
        break;
      case "criterion":
        value = { shape: "criterion", criterion: this.criterion() };
        break;
    }
    return { kind: "field", key, value, pos: t.pos };
  }

  /** Read `{ field* }` against `table`, or nothing when the block is optional and absent. */
  private fieldBlock(table: FieldTable, blockLabel: string, required: boolean): Field[] {
    if (!this.at("lbrace")) {
      if (required) this.expect("lbrace", `'{' to open the ${blockLabel} block`);
      return [];
    }
    this.next(); // '{'
    const fields: Field[] = [];
    while (!this.at("rbrace") && !this.at("eof")) fields.push(this.parseField(table, blockLabel));
    this.expect("rbrace", `'}' to close the ${blockLabel} block`);
    return fields;
  }

  /** mechanism := "mechanism" IDENT [ "{" field* "}" ] */
  private parseMechanism(): MechanismDecl {
    const kw = this.next(); // 'mechanism'
    const mechanismKind = this.ident("a mechanism kind after 'mechanism' (like 'English')");
    const fields = this.fieldBlock(MECHANISM_FIELDS, "mechanism", false);
    return { kind: "mechanism", mechanismKind, fields, pos: kw.pos };
  }

  /** tender := "tender" STRING "{" field* "}" */
  private parseTender(): TenderDecl {
    const kw = this.next(); // 'tender'
    const id = this.stringAsIdent("a tendered commitment id after 'tender' (a quoted string)");
    const fields = this.fieldBlock(TENDER_FIELDS, "tender", true);
    return { kind: "tender", id, fields, pos: kw.pos };
  }

  /** auctionState := "state" IDENT [ "{" field* "}" ] */
  private parseAuctionState(): AuctionStateDecl {
    const kw = this.next(); // 'state'
    const stateType = this.ident("an auction state after 'state' (like 'Open')");
    const fields = this.fieldBlock(AUCTION_STATE_FIELDS, "auction state", false);
    return { kind: "auctionState", stateType, fields, pos: kw.pos };
  }

  /** auction := "auction" STRING "{" auctionItem* "}" */
  private parseAuction(): AuctionDecl {
    const kw = this.next(); // 'auction'
    const name = this.stringAsIdent("an auction id after 'auction' (a quoted string)");
    this.expect("lbrace", "'{'");
    const fields: Field[] = [];
    const tenders: TenderDecl[] = [];
    let mechanism: MechanismDecl | undefined;
    let state: AuctionStateDecl | undefined;
    while (!this.at("rbrace") && !this.at("eof")) {
      const item = this.parseAuctionItem();
      if (item.kind === "mechanism") {
        if (mechanism !== undefined) {
          throw new WarpSyntaxError(
            `Auction '${name.name}' already declares a mechanism; an auction has exactly one.`,
            item.pos,
            "at most one 'mechanism'",
          );
        }
        mechanism = item;
      } else if (item.kind === "auctionState") {
        if (state !== undefined) {
          throw new WarpSyntaxError(
            `Auction '${name.name}' already declares a state; an auction has exactly one.`,
            item.pos,
            "at most one 'state'",
          );
        }
        state = item;
      } else if (item.kind === "tender") {
        tenders.push(item);
      } else {
        fields.push(item);
      }
    }
    this.expect("rbrace", "'}' to close the auction block");
    return { kind: "auction", name, fields, mechanism, state, tenders, pos: kw.pos };
  }

  /** auctionItem := field | mechanism | tender | auctionState */
  private parseAuctionItem(): AuctionItem {
    const t = this.peek();
    if (t.type === "ident" && t.value === "mechanism") return this.parseMechanism();
    if (t.type === "ident" && t.value === "tender") return this.parseTender();
    if (t.type === "ident" && t.value === "state") return this.parseAuctionState();
    if (t.type !== "ident" || !(t.value in AUCTION_FIELDS)) {
      throw new WarpSyntaxError(
        `Expected an auction field but found ${describe(t)}.`,
        t.pos,
        `one of ${keyList(AUCTION_FIELDS)}, 'mechanism', 'tender', or 'state'`,
      );
    }
    return this.parseField(AUCTION_FIELDS, "auction");
  }

  /** profile := "profile" IDENT "{" profileField* "}" */
  private parseProfile(): ProfileDecl {
    const kw = this.next(); // 'profile'
    const name = this.ident("a profile id");
    this.expect("lbrace", "'{'");
    const fields: ProfileField[] = [];
    while (!this.at("rbrace") && !this.at("eof")) {
      fields.push(this.parseProfileField());
    }
    this.expect("rbrace", "'}' to close the profile block");
    return { kind: "profile", name, fields, pos: kw.pos };
  }

  /**
   * profileField := "label" STRING | "description" STRING
   *              | "states" identList | "value_forms" identList
   */
  private parseProfileField(): ProfileField {
    const t = this.peek();
    if (t.type !== "ident" || !PROFILE_FIELD_KEYS.includes(t.value as ProfileFieldKey)) {
      throw new WarpSyntaxError(
        `Expected a profile field but found ${describe(t)}.`,
        t.pos,
        "one of 'label', 'description', 'states', 'value_forms'",
      );
    }
    const key = this.next().value as ProfileFieldKey;
    if (key === "label" || key === "description") {
      const str = this.expect("string", `a string after '${key}'`);
      return { key, text: str.value, pos: t.pos };
    }
    // states | value_forms
    const list = this.identList(`an identifier list after '${key}'`);
    return { key, list, pos: t.pos };
  }

  /**
   * expr := term { ("+" | "-") term }
   *
   * A policy VALUE position accepts an expression (rung 5A). A bare money literal
   * is just the trivial expression, so every pre-5A policy still parses exactly as
   * it did. Left-associative, with `*` and `/` binding tighter than `+` and `-`.
   */
  private parseExpr(what: string): Expr {
    let left = this.parseTerm(what);
    while (this.at("plus") || this.at("minus")) {
      const opTok = this.next();
      const right = this.parseTerm(what);
      left = {
        kind: "binary",
        op: opTok.type === "plus" ? "+" : "-",
        left,
        right,
        pos: opTok.pos,
      };
    }
    return left;
  }

  /** term := factor { ("*" | "/") factor } */
  private parseTerm(what: string): Expr {
    let left = this.parseFactor(what);
    while (this.at("star") || this.at("slash")) {
      const opTok = this.next();
      const right = this.parseFactor(what);
      left = {
        kind: "binary",
        op: opTok.type === "star" ? "*" : "/",
        left,
        right,
        pos: opTok.pos,
      };
    }
    return left;
  }

  /**
   * factor := money | NUMBER | IDENT | "(" expr ")" | ("min"|"max") "(" args ")"
   *
   * `NUMBER IDENT` is a money literal (`1500 MAD`); a bare NUMBER is a plain
   * number (`0.75`). The distinction is resolved by lookahead, so `committed *
   * 0.75` and `150 MAD` both read naturally.
   */
  private parseFactor(what: string): Expr {
    const t = this.peek();

    if (this.at("lparen")) {
      this.next();
      const inner = this.parseExpr(what);
      this.expect("rparen", "')' to close the group");
      return inner;
    }

    if (t.type === "number") {
      this.next();
      const amount = Number(t.value);
      // `1500 MAD` — an ISO-SHAPED code directly after the amount makes it money.
      //
      // The shape test is what keeps the grammar unambiguous now that a value
      // position holds an expression. In `concession_floor committed * 2` followed
      // by the field `committed_price 200 MAD`, a bare "number then identifier"
      // rule would read `2 committed_price` as an amount and a currency and then
      // choke on the 200. Currency codes are uppercase (ISO 4217: MAD, EUR, JPY)
      // and field keys are lower_snake_case, so the two never collide.
      if (this.at("ident") && isCurrencyCode(this.peek().value)) {
        const cur = this.next();
        return { kind: "money", amount, currency: cur.value, pos: t.pos };
      }
      return { kind: "number", value: amount, pos: t.pos };
    }

    if (t.type === "ident") {
      if (EXPR_FUNCTIONS.includes(t.value as (typeof EXPR_FUNCTIONS)[number])) {
        const fnTok = this.next();
        this.expect("lparen", `'(' after '${fnTok.value}'`);
        const args: Expr[] = [this.parseExpr(what)];
        while (this.at("comma")) {
          this.next();
          args.push(this.parseExpr(what));
        }
        this.expect("rparen", `')' to close ${fnTok.value}(...)`);
        return { kind: "call", fn: fnTok.value as "min" | "max", args, pos: fnTok.pos };
      }
      const name = this.next();
      return { kind: "var", name: name.value, pos: name.pos };
    }

    throw new WarpSyntaxError(
      `Expected ${what} but found ${describe(t)}.`,
      t.pos,
      what,
    );
  }

  /** policy := "policy" IDENT "{" policyField* "}" */
  private parsePolicy(): PolicyDecl {
    const kw = this.next(); // 'policy'
    const name = this.ident("a policy id");
    this.expect("lbrace", "'{'");
    const fields: PolicyField[] = [];
    while (!this.at("rbrace") && !this.at("eof")) {
      fields.push(this.parsePolicyField());
    }
    this.expect("rbrace", "'}' to close the policy block");
    return { kind: "policy", name, fields, pos: kw.pos };
  }

  /**
   * policyField := ("label" | "description") STRING
   *              | "applies_to" IDENT
   *              | ("forbid_states" | "assert") identList
   *              | ("concession_floor" | "committed_price") money
   *              | "tax_rates" STRING numberList
   *
   * The KEY fixes the value's shape, so a missing value is reported by name.
   */
  private parsePolicyField(): PolicyField {
    const t = this.peek();
    if (t.type !== "ident" || !POLICY_FIELD_KEYS.includes(t.value as PolicyFieldKey)) {
      throw new WarpSyntaxError(
        `Expected a policy field but found ${describe(t)}.`,
        t.pos,
        `one of ${POLICY_FIELD_KEYS.map((k) => `'${k}'`).join(", ")}`,
      );
    }
    const key = this.next().value as PolicyFieldKey;

    if (key === "label" || key === "description") {
      const str = this.expect("string", `a string after '${key}'`);
      return { key, text: str.value, pos: t.pos };
    }
    if (key === "applies_to") {
      const ref = this.ident("a profile id after 'applies_to'");
      return { key, ref, pos: t.pos };
    }
    if (key === "concession_floor" || key === "committed_price") {
      // An EXPRESSION, of which a bare money literal is the trivial case — so
      // `concession_floor 150 MAD` parses exactly as it did before rung 5A.
      const expr = this.parseExpr(
        `a money amount or expression after '${key}' (like '150 MAD' or 'committed * 0.75')`,
      );
      return { key, expr, pos: t.pos };
    }
    if (key === "tax_rates") {
      const j = this.expect("string", "a jurisdiction code after 'tax_rates' (like \"MA\")");
      const rates = this.numberList(
        `a rate after the jurisdiction in 'tax_rates' (a fraction, like 0.2 for 20%)`,
      );
      return { key, taxRates: { jurisdiction: j.value, rates, pos: j.pos }, pos: t.pos };
    }
    // forbid_states | assert
    const list = this.identList(`an identifier list after '${key}'`);
    return { key, list, pos: t.pos };
  }
}

/**
 * True for an identifier shaped like a currency code: three or more UPPERCASE
 * letters (ISO 4217 — MAD, EUR, JPY). This is a syntactic test for the money
 * literal `1500 MAD`, and the reason `committed * 2` followed by the field
 * `committed_price` is read correctly: field keys are lower_snake_case, so they
 * can never be mistaken for a currency.
 *
 * A lowercase code (`150 mad`) is therefore NOT money — the number stands alone
 * and the compiler says a floor must be a money amount, which points at the real
 * mistake.
 */
function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3,}$/.test(value);
}

/** A human description of a token, for error messages. */
function describe(t: Token): string {
  if (t.type === "eof") return "end of file";
  if (t.type === "string") return `the string "${t.value}"`;
  if (t.type === "number") return `the number ${t.value}`;
  return `'${t.value}'`;
}

/**
 * Parse `.warp` source into a {@link Document} AST. `file` (optional) is threaded
 * into every error position so messages print `file:line:col`. Throws
 * {@link WarpSyntaxError} on the first malformed token.
 */
export function parse(source: string, opts: { file?: string } = {}): Document {
  const tokens = tokenize(source, opts.file);
  return new Parser(tokens).parseDocument();
}
