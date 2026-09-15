/**
 * Rung D — the FORMATTER. AST → canonical `.warp` source.
 *
 * THE ONE GUARANTEE. Formatting never changes meaning: `parse(format(src))`
 * yields an AST equal to `parse(src)` (positions aside). The formatter walks the
 * parser's own AST and prints it; it has no grammar of its own and cannot
 * introduce a construct the parser would read differently. That guarantee is
 * tested, not asserted, in `tests/format.test.ts`, on every `.warp` source in
 * the repo.
 *
 * Also guaranteed: idempotent — `format(format(x)) === format(x)` — and
 * order-preserving. Declarations, fields, states, transitions and legs come out
 * in the order the author wrote them; the formatter fixes layout, never
 * arrangement.
 *
 * COMMENTS ARE KEPT. The lexer discards comments as tokens, but collects them on
 * request (rung D), and the formatter puts each back on the line it was written:
 * a comment on its own line stays a leading comment of whatever follows, and a
 * comment at the end of a line stays a trailing comment of that line. A
 * formatter that silently deleted an author's comments would be unusable.
 *
 * WHAT IT DOES NOT DO. It does not reorder, does not sort, does not rename, does
 * not remove anything the author wrote, and does not compute or check
 * anything — a file with a dangling reference formats fine and then fails
 * `warpc check`, which is the right division. It also does not preserve the
 * author's blank-line choices exactly: one blank line separates top-level
 * declarations and groups inside a block, and that is the canonical form.
 */
import type {
  AuctionDecl,
  AuctionStateDecl,
  CompositionDecl,
  Declaration,
  Document,
  Field,
  FieldValue,
  LegDecl,
  LifecycleDecl,
  MechanismDecl,
  PolicyDecl,
  PolicyField,
  ProfileDecl,
  TenderDecl,
} from "./ast.js";
import type { SourcePosition } from "./errors.js";
import type { Expr } from "./expr.js";
import type { Comment } from "./lexer.js";
import { parse } from "./parser.js";

const INDENT = "  ";

// ---------------------------------------------------------------------------
// Expressions — precedence-aware, so parentheses are kept where they matter
// ---------------------------------------------------------------------------

/** Binding strength: higher binds tighter. */
function precedence(e: Expr): number {
  if (e.kind !== "binary") return 3;
  return e.op === "*" || e.op === "/" ? 2 : 1;
}

/**
 * Print an expression with the minimum parentheses that preserve its tree.
 *
 * `expr.ts`'s `formatExpr` prints no parentheses at all — fine for an error
 * message about `committed * 0.75`, wrong for a formatter, where
 * `(committed - 50 MAD) * 2` must not come out as `committed - 50 MAD * 2`.
 * Left-associativity means a right operand of equal precedence needs parens too
 * (`a - (b - c)` is not `a - b - c`).
 */
export function formatExprCanonical(e: Expr): string {
  switch (e.kind) {
    case "money":
      return `${formatNumber(e.amount)} ${e.currency}`;
    case "number":
      return formatNumber(e.value);
    case "var":
      return e.name;
    case "call":
      return `${e.fn}(${e.args.map(formatExprCanonical).join(", ")})`;
    case "binary": {
      const mine = precedence(e);
      const left =
        precedence(e.left) < mine ? `(${formatExprCanonical(e.left)})` : formatExprCanonical(e.left);
      const rightNeedsParens =
        precedence(e.right) < mine ||
        (precedence(e.right) === mine && e.right.kind === "binary");
      const right = rightNeedsParens ? `(${formatExprCanonical(e.right)})` : formatExprCanonical(e.right);
      return `${left} ${e.op} ${right}`;
    }
  }
}

/** Numbers print as the author would: no exponent, no trailing zeros. */
function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

/** Re-quote a string with the escapes the lexer understands. */
function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

// ---------------------------------------------------------------------------
// Comment placement
// ---------------------------------------------------------------------------

/**
 * Comments in source order, consumed as the printer walks forward through the
 * document. The printer asks for "every comment before line N" (leading) and
 * "the comment on line N" (trailing) and never looks back, so each comment is
 * emitted exactly once, in place.
 */
class Comments {
  private i = 0;
  constructor(private readonly all: Comment[]) {}

  /** All comments strictly before `line`, removed from the queue. */
  leading(line: number): Comment[] {
    const out: Comment[] = [];
    while (this.i < this.all.length && (this.all[this.i] as Comment).pos.line < line) {
      out.push(this.all[this.i] as Comment);
      this.i++;
    }
    return out;
  }

  /** The comment on exactly `line`, if any, removed from the queue. */
  trailing(line: number): Comment | undefined {
    const c = this.all[this.i];
    if (c !== undefined && c.pos.line === line) {
      this.i++;
      return c;
    }
    return undefined;
  }

  /** Whatever is left. */
  rest(): Comment[] {
    const out = this.all.slice(this.i);
    this.i = this.all.length;
    return out;
  }

  /**
   * True if any not-yet-emitted comment lies strictly between two lines. A
   * read-only probe the printer uses to choose inline vs block layout; it does
   * not consume anything.
   */
  peekBetween(from: number, to: number): boolean {
    for (let k = this.i; k < this.all.length; k++) {
      const line = (this.all[k] as Comment).pos.line;
      if (line > from && line < to) return true;
      if (line >= to) break;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// The printer
// ---------------------------------------------------------------------------

class Printer {
  private readonly lines: string[] = [];
  constructor(private readonly comments: Comments) {}

  /** Emit one source line at `depth`, with any leading comments before it and a trailing one after. */
  private line(depth: number, text: string, at: SourcePosition | undefined): void {
    const pad = INDENT.repeat(depth);
    if (at !== undefined) {
      const leading = this.comments.leading(at.line);
      for (const c of leading) this.lines.push(`${pad}# ${c.text}`.trimEnd());
      // A comment block the author separated from what follows with a blank
      // line (a file header, say) keeps that separation; a comment directly
      // above an item stays attached to it.
      const lastComment = leading[leading.length - 1];
      if (lastComment !== undefined && lastComment.pos.line < at.line - 1) this.lines.push("");
    }
    const trailing = at !== undefined ? this.comments.trailing(at.line) : undefined;
    this.lines.push(trailing ? `${pad}${text}  # ${trailing.text}` : `${pad}${text}`);
  }

  /** Close a block at `end`, flushing comments that sit inside it before the brace. */
  private close(depth: number, end: SourcePosition | undefined): void {
    const pad = INDENT.repeat(depth);
    if (end !== undefined) {
      for (const c of this.comments.leading(end.line)) this.lines.push(`${INDENT.repeat(depth + 1)}# ${c.text}`);
    }
    const trailing = end !== undefined ? this.comments.trailing(end.line) : undefined;
    this.lines.push(trailing ? `${pad}}  # ${trailing.text}` : `${pad}}`);
  }

  private blank(): void {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") this.lines.push("");
  }

  document(doc: Document): string {
    doc.declarations.forEach((d, i) => {
      if (i > 0) this.blank();
      this.declaration(d);
    });
    // Comments after the last declaration.
    const rest = this.comments.rest();
    if (rest.length > 0) {
      this.blank();
      for (const c of rest) this.lines.push(`# ${c.text}`);
    }
    return `${this.lines.join("\n").replace(/\n+$/, "")}\n`;
  }

  private declaration(d: Declaration): void {
    switch (d.kind) {
      case "lifecycle":
        return this.lifecycle(d);
      case "profile":
        return this.profile(d);
      case "auction":
        return this.auction(d);
      case "policy":
        return this.policy(d);
      case "composition":
        return this.composition(d);
    }
  }

  // --- lifecycle -----------------------------------------------------------

  private lifecycle(d: LifecycleDecl): void {
    this.line(0, `lifecycle ${d.name.name} {`, d.pos);
    // States and transitions interleave in the author's order: merge by position.
    const items = [...d.states, ...d.transitions].sort(byPos);
    // Canonical layout: states, then a blank line, then transitions — but only
    // when the author wrote them in that grouped order. If they interleaved, keep
    // their order (formatting never rearranges).
    const grouped = items.every((it, i) => i === 0 || (items[i - 1] as typeof it).kind !== "transition" || it.kind === "transition");
    const fromWidth = Math.max(0, ...d.transitions.map((t) => t.from.name.length));
    let lastKind: string | undefined;
    for (const it of items) {
      if (grouped && lastKind === "state" && it.kind === "transition") this.blank();
      if (it.kind === "state") this.line(1, `state ${it.name.name}`, it.pos);
      else this.line(1, `${it.from.name.padEnd(fromWidth)} -> ${it.to.map((t) => t.name).join(", ")}`, it.pos);
      lastKind = it.kind;
    }
    this.close(0, d.end);
  }

  // --- profile -------------------------------------------------------------

  private profile(d: ProfileDecl): void {
    this.line(0, `profile ${d.name.name} {`, d.pos);
    const width = Math.max(0, ...d.fields.map((f) => f.key.length));
    for (const f of d.fields) {
      const key = f.key.padEnd(width);
      if (f.text !== undefined) this.line(1, `${key} ${quote(f.text)}`, f.pos);
      else this.line(1, `${key} ${(f.list ?? []).map((i) => i.name).join(", ")}`, f.pos);
    }
    this.close(0, d.end);
  }

  // --- auction -------------------------------------------------------------

  private fieldValue(v: FieldValue): string {
    switch (v.shape) {
      case "money":
        return `${formatNumber(v.money.amount)} ${v.money.currency}`;
      case "number":
        return formatNumber(v.number);
      case "string":
        return quote(v.text);
      case "bool":
        return v.bool ? "true" : "false";
      case "strings":
        return v.texts.map(quote).join(", ");
      case "ident":
        return v.ident.name;
      case "criterion":
        return `${quote(v.criterion.name)} ${formatNumber(v.criterion.weight)} ${formatNumber(v.criterion.maxPoints)}`;
    }
  }

  private fields(depth: number, fields: Field[]): void {
    const width = Math.max(0, ...fields.map((f) => f.key.name.length));
    for (const f of fields) this.line(depth, `${f.key.name.padEnd(width)} ${this.fieldValue(f.value)}`, f.pos);
  }

  private mechanism(depth: number, m: MechanismDecl): void {
    if (m.fields.length === 0 && m.end === undefined) {
      this.line(depth, `mechanism ${m.mechanismKind.name}`, m.pos);
      return;
    }
    this.line(depth, `mechanism ${m.mechanismKind.name} {`, m.pos);
    this.fields(depth + 1, m.fields);
    this.close(depth, m.end);
  }

  private tender(depth: number, t: TenderDecl): void {
    // A short tender fits on one line, as the examples write it.
    const inline = t.fields.map((f) => `${f.key.name} ${this.fieldValue(f.value)}`).join("  ");
    const hasInnerComments = t.end !== undefined && this.commentsBetween(t.pos.line, t.end.line);
    if (!hasInnerComments && inline.length + depth * 2 + t.id.name.length < 90) {
      this.line(depth, `tender ${quote(t.id.name)} { ${inline} }`, t.pos);
      // consume a trailing comment on the closing line if it is the same line
      return;
    }
    this.line(depth, `tender ${quote(t.id.name)} {`, t.pos);
    this.fields(depth + 1, t.fields);
    this.close(depth, t.end);
  }

  private auctionState(depth: number, s: AuctionStateDecl): void {
    if (s.fields.length === 0 && s.end === undefined) {
      this.line(depth, `state ${s.stateType.name}`, s.pos);
      return;
    }
    this.line(depth, `state ${s.stateType.name} {`, s.pos);
    this.fields(depth + 1, s.fields);
    this.close(depth, s.end);
  }

  private auction(d: AuctionDecl): void {
    this.line(0, `auction ${quote(d.name.name)} {`, d.pos);
    type Item = { pos: SourcePosition; print: () => void; group: string };
    const items: Item[] = [
      ...d.fields.map((f): Item => ({ pos: f.pos, group: "field", print: () => this.fields(1, [f]) })),
      ...(d.mechanism ? [{ pos: d.mechanism.pos, group: "mechanism", print: () => this.mechanism(1, d.mechanism as MechanismDecl) }] : []),
      ...d.tenders.map((t): Item => ({ pos: t.pos, group: "tender", print: () => this.tender(1, t) })),
      ...(d.state ? [{ pos: d.state.pos, group: "state", print: () => this.auctionState(1, d.state as AuctionStateDecl) }] : []),
    ].sort(byPos);
    // Plain fields align as a group; a blank line separates groups of different kinds.
    const plain = d.fields;
    const width = Math.max(0, ...plain.map((f) => f.key.name.length));
    let last: string | undefined;
    for (const it of items) {
      if (last !== undefined && it.group !== last) this.blank();
      if (it.group === "field") {
        const f = plain.find((x) => x.pos === it.pos) as Field;
        this.line(1, `${f.key.name.padEnd(width)} ${this.fieldValue(f.value)}`, f.pos);
      } else it.print();
      last = it.group;
    }
    this.close(0, d.end);
  }

  // --- policy --------------------------------------------------------------

  private policyValue(f: PolicyField): string {
    if (f.text !== undefined) return quote(f.text);
    if (f.ref !== undefined) return f.ref.name;
    if (f.expr !== undefined) return formatExprCanonical(f.expr);
    if (f.taxRates !== undefined) return `${quote(f.taxRates.jurisdiction)} ${f.taxRates.rates.map(formatNumber).join(", ")}`;
    return (f.list ?? []).map((i) => i.name).join(", ");
  }

  private policy(d: PolicyDecl): void {
    this.line(0, `policy ${d.name.name} {`, d.pos);
    const width = Math.max(0, ...d.fields.map((f) => f.key.length));
    // Metadata (label/description), then a blank, then the rules — when grouped that way.
    let lastMeta: boolean | undefined;
    for (const f of d.fields) {
      const meta = f.key === "label" || f.key === "description";
      if (lastMeta === true && !meta) this.blank();
      this.line(1, `${f.key.padEnd(width)} ${this.policyValue(f)}`, f.pos);
      lastMeta = meta;
    }
    this.close(0, d.end);
  }

  // --- composition ---------------------------------------------------------

  private leg(depth: number, l: LegDecl): void {
    const body = l.amount ? `amount ${formatExprCanonical(l.amount)}` : "";
    const hasInnerComments = this.commentsBetween(l.pos.line, l.end.line);
    if (!hasInnerComments) {
      this.line(depth, `leg ${l.name.name} { ${body} }`.replace("{  }", "{ }"), l.pos);
      return;
    }
    this.line(depth, `leg ${l.name.name} {`, l.pos);
    if (l.amount) this.line(depth + 1, body, l.amount.pos);
    this.close(depth, l.end);
  }

  private composition(d: CompositionDecl): void {
    this.line(0, `composition ${d.name.name} {`, d.pos);
    const width = Math.max(0, ...d.fields.map((f) => f.key.length));
    type Item = { pos: SourcePosition; kind: "field" | "leg"; print: () => void };
    const items: Item[] = [
      ...d.fields.map((f): Item => ({ pos: f.pos, kind: "field", print: () => this.line(1, `${f.key.padEnd(width)} ${quote(f.text)}`, f.pos) })),
      ...d.legs.map((l): Item => ({ pos: l.pos, kind: "leg", print: () => this.leg(1, l) })),
    ].sort(byPos);
    // Legs align their names when they are printed inline.
    const legWidth = Math.max(0, ...d.legs.map((l) => l.name.name.length));
    let last: Item["kind"] | undefined;
    for (const it of items) {
      if (last !== undefined && it.kind !== last) this.blank();
      if (it.kind === "leg") {
        const l = d.legs.find((x) => x.pos === it.pos) as LegDecl;
        const body = l.amount ? `amount ${formatExprCanonical(l.amount)}` : "";
        if (!this.commentsBetween(l.pos.line, l.end.line)) {
          this.line(1, `leg ${l.name.name.padEnd(legWidth)} { ${body} }`, l.pos);
        } else this.leg(1, l);
      } else it.print();
      last = it.kind;
    }
    this.close(0, d.end);
  }

  /** True if any not-yet-emitted comment lies strictly between two lines. */
  private commentsBetween(from: number, to: number): boolean {
    return this.comments.peekBetween(from, to);
  }
}

function byPos(a: { pos: SourcePosition }, b: { pos: SourcePosition }): number {
  return a.pos.line - b.pos.line || a.pos.column - b.pos.column;
}

/**
 * Format `.warp` source to its canonical form. Throws the parser's own
 * {@link WarpSyntaxError} on malformed input — a formatter cannot lay out what it
 * cannot parse, and inventing a layout for broken source would hide the error.
 */
export function format(source: string, opts: { file?: string } = {}): string {
  const comments: Comment[] = [];
  const doc = parse(source, { ...opts, comments });
  return new Printer(new Comments(comments)).document(doc);
}
