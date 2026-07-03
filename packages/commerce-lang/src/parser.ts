/**
 * A hand-written recursive-descent parser: token stream → {@link Document} AST.
 * No parser-generator, no heavyweight compiler infrastructure — the grammar is
 * small enough (two declaration forms) that a direct descent is the clearest and
 * gives the most controllable error messages, which is the point of the exercise.
 *
 * The grammar it accepts (see GRAMMAR.md for the canonical form):
 *
 *   document    := declaration*
 *   declaration := lifecycle | profile
 *   lifecycle   := "lifecycle" IDENT "{" lifecycleItem* "}"
 *   lifecycleItem := "state" IDENT
 *                  | IDENT "->" identList
 *   profile     := "profile" IDENT "{" profileField* "}"
 *   profileField := "label" STRING
 *                 | "description" STRING
 *                 | "states" identList
 *                 | "value_forms" identList
 *   identList   := IDENT ("," IDENT)*
 *
 * Every parse failure is a {@link WarpSyntaxError} carrying the offending token's
 * line/col and a human phrase for what was expected there.
 */

import type {
  Declaration,
  Document,
  Ident,
  LifecycleDecl,
  ProfileDecl,
  ProfileField,
  StateDecl,
  TransitionDecl,
} from "./ast.js";
import { WarpSyntaxError } from "./errors.js";
import { tokenize, type Token, type TokenType } from "./lexer.js";

/** The four keywords legal as a profile field. */
const PROFILE_FIELD_KEYS = ["label", "description", "states", "value_forms"] as const;
type ProfileFieldKey = (typeof PROFILE_FIELD_KEYS)[number];

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
    throw new WarpSyntaxError(
      `Expected a declaration but found ${describe(t)}.`,
      t.pos,
      "'lifecycle' or 'profile'",
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
}

/** A human description of a token, for error messages. */
function describe(t: Token): string {
  if (t.type === "eof") return "end of file";
  if (t.type === "string") return `the string "${t.value}"`;
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
