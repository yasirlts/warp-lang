/**
 * The lexer — turns `.warp` source text into a flat token stream, tracking the
 * 1-based line and column of every token's FIRST character. Those positions are
 * what make the parser's and compiler's errors point at a real spot in the file.
 *
 * The token set is tiny by design (this is a focused authoring syntax, not a
 * general language): punctuation (`{ } , ->`), double-quoted strings, and bare
 * identifiers. Keywords (`lifecycle`, `profile`, `state`, `label`, `description`,
 * `states`, `value_forms`) are not a distinct token class — they lex as ordinary
 * identifiers and the parser gives them meaning by position. Line comments start
 * with `//` or `#` and run to end of line. Whitespace is insignificant.
 */

import { WarpSyntaxError, type SourcePosition } from "./errors.js";

/** The kinds of token the lexer emits. */
export type TokenType =
  | "ident"
  | "string"
  | "lbrace"
  | "rbrace"
  | "comma"
  | "arrow"
  | "eof";

/** One lexed token: its kind, its text value, and where it began. */
export interface Token {
  type: TokenType;
  /** The token's text. For strings this is the DECODED value (no quotes). */
  value: string;
  pos: SourcePosition;
}

/** True for the first character of an identifier: a letter or underscore. */
function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

/** True for a subsequent identifier character: letter, digit, or underscore. */
function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/**
 * Tokenize `source` into a list of {@link Token}s ending in a single `eof` token.
 * `file` (optional) is attached to every position so errors can print
 * `file:line:col`. Throws {@link WarpSyntaxError} on an unterminated string or a
 * stray character — the earliest lexical failures a language should catch.
 */
export function tokenize(source: string, file?: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const n = source.length;

  const posHere = (): SourcePosition => ({ line, column, ...(file ? { file } : {}) });

  /** Advance one character, keeping line/column in sync (handles newlines). */
  const advance = (): string => {
    const ch = source[i] as string;
    i += 1;
    if (ch === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return ch;
  };

  while (i < n) {
    const ch = source[i] as string;

    // Whitespace.
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance();
      continue;
    }

    // Line comments: `//…` or `#…` to end of line.
    if (ch === "#" || (ch === "/" && source[i + 1] === "/")) {
      while (i < n && source[i] !== "\n") advance();
      continue;
    }

    const start = posHere();

    // Punctuation.
    if (ch === "{") {
      advance();
      tokens.push({ type: "lbrace", value: "{", pos: start });
      continue;
    }
    if (ch === "}") {
      advance();
      tokens.push({ type: "rbrace", value: "}", pos: start });
      continue;
    }
    if (ch === ",") {
      advance();
      tokens.push({ type: "comma", value: ",", pos: start });
      continue;
    }

    // Arrow `->`.
    if (ch === "-") {
      if (source[i + 1] === ">") {
        advance();
        advance();
        tokens.push({ type: "arrow", value: "->", pos: start });
        continue;
      }
      throw new WarpSyntaxError(
        `Unexpected '-'. Did you mean '->' (a transition arrow)?`,
        start,
        "'->'",
      );
    }

    // Double-quoted string with \\ \" \n \t escapes.
    if (ch === '"') {
      advance(); // opening quote
      let value = "";
      let closed = false;
      while (i < n) {
        const c = advance();
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === "\n") {
          throw new WarpSyntaxError(
            `Unterminated string literal (newline before closing '"').`,
            start,
            "a closing '\"'",
          );
        }
        if (c === "\\") {
          const esc = advance();
          value +=
            esc === "n" ? "\n" : esc === "t" ? "\t" : esc === '"' ? '"' : esc === "\\" ? "\\" : esc;
          continue;
        }
        value += c;
      }
      if (!closed) {
        throw new WarpSyntaxError(
          `Unterminated string literal (reached end of file).`,
          start,
          "a closing '\"'",
        );
      }
      tokens.push({ type: "string", value, pos: start });
      continue;
    }

    // Identifier / keyword.
    if (isIdentStart(ch)) {
      let value = "";
      while (i < n && isIdentPart(source[i] as string)) value += advance();
      tokens.push({ type: "ident", value, pos: start });
      continue;
    }

    throw new WarpSyntaxError(
      `Unexpected character '${ch}'.`,
      start,
      "a declaration, identifier, string, or one of { } , ->",
    );
  }

  tokens.push({ type: "eof", value: "<eof>", pos: posHere() });
  return tokens;
}
