/**
 * The static coverage audit.
 *
 * For each declared money-sink call site, decide whether a Warp guard entry runs
 * before it on its control-flow path. The path analysis is deliberately
 * CONSERVATIVE: a guard counts only when it unconditionally precedes the sink in
 * the sink's block or an enclosing block. A guard buried in a branch the sink is
 * not in does NOT count. Anything we cannot resolve statically (a sink referenced
 * indirectly / via dynamic dispatch) is classified UNANALYZABLE and is never
 * counted as covered.
 *
 * "Covered" is a STRUCTURAL signal that a guard is on the path — not a proof the
 * guard validated this particular write correctly.
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import type { CoverageConfig, GuardPattern, LoadedConfig, SinkPattern } from "./config.js";

export type Classification = "COVERED" | "UNGUARDED" | "UNANALYZABLE";

export interface Finding {
  file: string; // relative to baseDir
  line: number; // 1-based
  column: number; // 1-based
  sink: string; // matched declared sink name
  kind: "direct" | "indirect";
  classification: Classification;
  reason: string;
  guardedBy?: string; // guard entry name, when COVERED
  indeterminate?: boolean; // UNGUARDED via an unresolved-reachability lean
  allowlisted?: boolean; // an accepted, reasoned exception (still counted uncovered)
  allowReason?: string; // why it was accepted (from the allow-list entry)
}

export interface AuditResult {
  findings: Finding[];
  filesScanned: number;
}

// --- file discovery ---------------------------------------------------------

function discoverFiles(roots: string[], extensions: string[], exclude: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (p: string) => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        if (e.isDirectory() && exclude.includes(e.name)) continue;
        walk(join(p, e.name));
      }
    } else if (st.isFile() && extensions.includes(extname(p)) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

// --- name + import matching -------------------------------------------------

/** local imported name -> module specifier (named & default imports). */
function importMap(sf: ts.SourceFile): Map<string, string> {
  const m = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const mod = stmt.moduleSpecifier.text;
    const b = stmt.importClause?.namedBindings;
    if (stmt.importClause?.name) m.set(stmt.importClause.name.text, mod); // default import
    if (b && ts.isNamedImports(b)) for (const el of b.elements) m.set(el.name.text, mod);
    if (b && ts.isNamespaceImport(b)) m.set(b.name.text, mod); // import * as ns
  }
  return m;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text; // x.foo(...)
  return undefined; // element access obj[expr](...) -> dynamic, unresolved
}

/** Does a call to `name` (with `imports`) match a declared pattern? */
function matchPattern(name: string, imports: Map<string, string>, pats: { name: string; module?: string }[]):
  | { name: string; module?: string }
  | undefined {
  for (const p of pats) {
    if (p.name !== name) continue;
    if (p.module === undefined) return p; // name-only match
    if (imports.get(name) === p.module) return p; // module-narrowed match
  }
  return undefined;
}

// --- block / dominance helpers ----------------------------------------------

function hasStatements(n: ts.Node): n is ts.Node & { statements: ts.NodeArray<ts.Statement> } {
  return (
    ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)
  );
}

/** For block B, the index of the top-level statement that transitively contains `node`, else -1. */
function topLevelIndexOf(block: ts.Node & { statements: ts.NodeArray<ts.Statement> }, node: ts.Node): number {
  for (let i = 0; i < block.statements.length; i++) {
    const s = block.statements[i]!;
    if (node.getStart() >= s.getStart() && node.getEnd() <= s.getEnd()) return i;
  }
  return -1;
}

/** Blocks (statement-lists) that transitively contain `node`, innermost first. */
function ancestorBlocks(node: ts.Node): (ts.Node & { statements: ts.NodeArray<ts.Statement> })[] {
  const out: (ts.Node & { statements: ts.NodeArray<ts.Statement> })[] = [];
  let p = node.parent;
  while (p) {
    if (hasStatements(p)) out.push(p);
    p = p.parent;
  }
  return out;
}

/** Is `guardCall` a DIRECT (unconditional) statement of `block`? Returns its index, else -1. */
function directStatementIndex(
  block: ts.Node & { statements: ts.NodeArray<ts.Statement> },
  guardCall: ts.Node,
): number {
  // climb from the guard to the node whose parent is exactly `block`
  let n: ts.Node = guardCall;
  while (n.parent && n.parent !== block) n = n.parent;
  if (n.parent !== block) return -1;
  for (let i = 0; i < block.statements.length; i++) if (block.statements[i] === n) return i;
  return -1;
}

// --- per-file analysis ------------------------------------------------------

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let p = node.parent;
  while (p) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isConstructorDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)
    ) {
      return p;
    }
    p = p.parent;
  }
  return undefined;
}

function analyzeFile(
  absPath: string,
  relPath: string,
  cfg: CoverageConfig,
  guardEntries: GuardPattern[],
): Finding[] {
  const text = readFileSync(absPath, "utf8");
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX);
  const imports = importMap(sf);
  const findings: Finding[] = [];

  // gather all guard-entry call nodes in the file
  const guardCalls: { node: ts.CallExpression; name: string }[] = [];
  const visitGuards = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const cn = calleeName(n);
      if (cn) {
        const g = matchPattern(cn, imports, guardEntries);
        if (g) guardCalls.push({ node: n, name: cn });
      }
    }
    ts.forEachChild(n, visitGuards);
  };
  visitGuards(sf);

  const pos = (n: ts.Node) => {
    const lc = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return { line: lc.line + 1, column: lc.character + 1 };
  };

  const visit = (n: ts.Node) => {
    // (1) direct sink calls
    if (ts.isCallExpression(n)) {
      const cn = calleeName(n);
      if (cn) {
        const s = matchPattern(cn, imports, cfg.moneySinks);
        if (s) {
          findings.push(classifyDirect(n, cn, sf, guardCalls, pos, relPath));
        }
      }
    }
    // (2) indirect references to a declared sink name (aliased / passed / dynamic)
    if (ts.isIdentifier(n) && isIndirectSinkReference(n, cfg.moneySinks, imports)) {
      const p = pos(n);
      findings.push({
        file: relPath,
        line: p.line,
        column: p.column,
        sink: n.text,
        kind: "indirect",
        classification: "UNANALYZABLE",
        reason:
          "declared sink referenced indirectly (aliased, passed as a value, or dynamically dispatched); its guard path cannot be determined statically",
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return findings;
}

function classifyDirect(
  call: ts.CallExpression,
  sinkName: string,
  sf: ts.SourceFile,
  guardCalls: { node: ts.CallExpression; name: string }[],
  pos: (n: ts.Node) => { line: number; column: number },
  relPath: string,
): Finding {
  const p = pos(call);
  const base: Finding = {
    file: relPath,
    line: p.line,
    column: p.column,
    sink: sinkName,
    kind: "direct",
    classification: "UNGUARDED",
    reason: "",
  };

  const fn = enclosingFunction(call);
  // only consider guards inside the same enclosing function (or module scope if none)
  const inScope = (g: ts.Node): boolean => {
    if (!fn) return enclosingFunction(g) === undefined; // both at module scope
    return enclosingFunction(g) === fn;
  };

  const blocks = ancestorBlocks(call);
  for (const b of blocks) {
    const sIdx = topLevelIndexOf(b, call);
    if (sIdx < 0) continue;
    for (const g of guardCalls) {
      if (!inScope(g.node)) continue;
      const gIdx = directStatementIndex(b, g.node);
      if (gIdx !== -1 && gIdx < sIdx) {
        return {
          ...base,
          classification: "COVERED",
          guardedBy: g.name,
          reason: `Warp '${g.name}' runs unconditionally before this sink in the same path (line ${pos(g.node).line})`,
        };
      }
    }
  }

  // a guard exists in the function but not on an unconditional path before the sink
  const guardInFn = guardCalls.some((g) => inScope(g.node));
  if (guardInFn) {
    return {
      ...base,
      indeterminate: true,
      reason:
        "a Warp guard is present in this function but not on an unconditional path before this sink (it is in a branch, or after the sink); reachability is indeterminate, so this is counted as NOT covered",
    };
  }
  return { ...base, reason: "no Warp guard entry runs before this sink on its path" };
}

/** An identifier equal to a declared sink name, used as a value (not a direct callee / import / declaration). */
function isIndirectSinkReference(
  id: ts.Identifier,
  sinks: SinkPattern[],
  imports: Map<string, string>,
): boolean {
  if (!matchPattern(id.text, imports, sinks)) return false;
  const parent = id.parent;
  if (!parent) return false;
  // exclude: the callee of a direct call  foo(...)  or  x.foo(...)
  if (ts.isCallExpression(parent) && parent.expression === id) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  // exclude: import/export specifiers and declaration names
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent)) &&
    (parent as any).name === id
  ) {
    return false;
  }
  // exclude property *keys*: { postLedger: ... }  (a shorthand value IS a reference, keep it)
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  return true;
}

// --- public entry -----------------------------------------------------------

export function runAudit(loaded: LoadedConfig): AuditResult {
  const { config, absoluteRoots, baseDir } = loaded;
  const files = discoverFiles(absoluteRoots, config.extensions, config.exclude);
  const guardEntries = config.guardEntries;

  const findings: Finding[] = [];
  for (const abs of files) {
    const rel = relative(baseDir, abs);
    findings.push(...analyzeFile(abs, rel, config, guardEntries));
  }

  // Flag accepted, reasoned exceptions. An allow-list entry matches by `file` or
  // `file:line`. Matched sinks are NOT removed or hidden — they stay in the
  // findings (still counted uncovered in the audit %), flagged with their reason
  // so the enforcer can list them and pass them as deliberate exceptions.
  const allow = config.allowList ?? [];
  for (const f of findings) {
    const hit = allow.find((a) => a.target === f.file || a.target === `${f.file}:${f.line}`);
    if (hit) {
      f.allowlisted = true;
      f.allowReason = hit.reason;
    }
  }

  // stable order
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { findings, filesScanned: files.length };
}
