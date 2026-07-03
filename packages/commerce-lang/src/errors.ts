/**
 * Errors carry a precise SOURCE POSITION — line and column, both 1-based — plus,
 * for parse errors, what the parser EXPECTED at that spot. Good positional errors
 * are a core reason to have a language at all: a syntax the author cannot debug is
 * worse than the config it replaced. Every failure below points at exactly one
 * character of `.warp` source and says what belongs there.
 */

/** A 1-based source position (line, column) plus the source file name, if known. */
export interface SourcePosition {
  /** 1-based line number. */
  line: number;
  /** 1-based column number (character offset within the line). */
  column: number;
  /** The file the source came from, if a caller supplied one. */
  file?: string;
}

/**
 * Base class for every error the language raises. Formats as
 * `file:line:col: message` (the ubiquitous compiler convention), so an editor or
 * a terminal can jump straight to the offending character.
 */
export class WarpLangError extends Error {
  readonly line: number;
  readonly column: number;
  readonly file: string | undefined;

  constructor(message: string, pos: SourcePosition) {
    super(message);
    this.name = "WarpLangError";
    this.line = pos.line;
    this.column = pos.column;
    this.file = pos.file;
  }

  /** `file:line:col: message` — click-through form for editors and terminals. */
  format(): string {
    const where = this.file ? `${this.file}:` : "";
    return `${where}${this.line}:${this.column}: ${this.message}`;
  }
}

/**
 * A LEXING or PARSING failure — the source is not well-formed `.warp` syntax.
 * Carries `expected` (a human phrase like "'{'" or "an identifier") so the message
 * can say both what was found and what belonged there.
 */
export class WarpSyntaxError extends WarpLangError {
  /** What the parser was looking for at this position, in human terms. */
  readonly expected: string | undefined;

  constructor(message: string, pos: SourcePosition, expected?: string) {
    super(message, pos);
    this.name = "WarpSyntaxError";
    this.expected = expected;
  }
}

/**
 * A COMPILE (semantic) failure — the source parses, but it does not describe a
 * legal author-time model: an unknown commitment state, a transition referencing
 * an undeclared state, a duplicate declaration, a profile missing a required
 * field. These are the checks that keep the language ANCHORED to the frozen model
 * (you cannot name a state the model does not define). They are NOT the model's
 * runtime invariants — an authored lifecycle that is syntactically fine but
 * UNSOUND (a forbidden transition between two real states) compiles, and is caught
 * downstream by the model's own temporal verifier. The language cannot smuggle an
 * unsound model past the invariants; it only guarantees the model is well-formed.
 */
export class WarpCompileError extends WarpLangError {
  constructor(message: string, pos: SourcePosition) {
    super(message, pos);
    this.name = "WarpCompileError";
  }
}
