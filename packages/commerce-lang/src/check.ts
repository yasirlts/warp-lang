/**
 * Rung D — `warpc check`: every diagnostic the real parser and compiler produce
 * for a file, collected, with positions, and without emitting an artifact.
 *
 * NOTHING HERE IS A LINTER. Every diagnostic is one the parser or the compiler
 * already raises; this module only runs them and gathers the results. A file
 * that passes `check` compiles; a file that fails it fails for exactly the
 * reason `warpc` would refuse it. There is no second opinion to drift from the
 * first.
 *
 * HOW MUCH IS COLLECTED, HONESTLY.
 *   - Syntax: the FIRST error only. The parser stops at the first malformed
 *     token, and giving it error recovery is a parser change, which this rung
 *     does not make. One precise syntax error at a time is what you get.
 *   - Compile: COLLECTED. Declarations are compiled one at a time, so a file
 *     with a bad lifecycle and a bad policy reports both. Cross-declaration
 *     checks (a policy applying to a missing profile, an ambiguous base profile)
 *     run once the individual declarations are clean.
 *   - Deployability: a rung-5A computed value is reported as a WARNING — the
 *     file compiles and runs in-process, but `warpc` will refuse to serialize
 *     it, and an author should learn that here rather than at deploy time.
 */
import type { Declaration, Document } from "./ast.js";
import { compileDocument } from "./compile.js";
import { WarpCompileError, WarpLangError, WarpSyntaxError } from "./errors.js";
import { parse } from "./parser.js";
import { systemFromDocument } from "./system.js";
import { undeployableValues } from "./artifact.js";

/** One finding. `line`/`column` are 1-based, as everywhere in the language. */
export interface Diagnostic {
  severity: "error" | "warning";
  /** A stable code an editor can key on. */
  code: "syntax" | "compile" | "undeployable";
  message: string;
  file?: string;
  line: number;
  column: number;
}

function fromError(e: WarpLangError, code: Diagnostic["code"]): Diagnostic {
  return {
    severity: "error",
    code,
    message: e.message,
    ...(e.file !== undefined ? { file: e.file } : {}),
    line: e.line,
    column: e.column,
  };
}

/** A single-declaration document, so one declaration can be compiled on its own. */
function only(decls: Declaration[]): Document {
  return { kind: "document", declarations: decls };
}

/**
 * Check a `.warp` source. Returns every diagnostic found, in source order,
 * errors before warnings at the same position. An empty array means the file
 * compiles and can be deployed as a static artifact.
 */
export function check(source: string, opts: { file?: string } = {}): Diagnostic[] {
  const out: Diagnostic[] = [];

  // 1. Syntax — first error only (see the module header).
  let doc: Document;
  try {
    doc = parse(source, opts);
  } catch (e) {
    if (e instanceof WarpSyntaxError) return [fromError(e, "syntax")];
    throw e;
  }

  // 2. Compile, per declaration, so independent failures are all reported.
  //    A policy is compiled together with every profile so `applies_to` can
  //    resolve — a missing profile is then reported once, from the policy.
  const profiles = doc.declarations.filter((d) => d.kind === "profile");
  let anyDeclError = false;
  for (const decl of doc.declarations) {
    try {
      compileDocument(only(decl.kind === "policy" ? [...profiles, decl] : [decl]));
    } catch (e) {
      if (e instanceof WarpCompileError) {
        // A profile error would be reported once by the profile itself; do not
        // repeat it for every policy that happened to be compiled alongside it.
        const isRepeatedProfileError =
          decl.kind === "policy" && profiles.some((p) => e.line === p.pos.line && e.message.includes(`'${p.name.name}'`));
        if (!isRepeatedProfileError) {
          out.push(fromError(e, "compile"));
          anyDeclError = true;
        }
      } else throw e;
    }
  }

  // 3. Cross-declaration checks, only once the parts are individually sound —
  //    otherwise a broken profile would also surface as "policy applies to a
  //    missing profile", which is the same problem reported twice.
  if (!anyDeclError) {
    try {
      const compiled = compileDocument(doc);
      const system = systemFromDocument(doc, compiled);
      // 4. Deployability — a warning, because the file is valid; it just cannot
      //    become a static artifact as written.
      for (const v of undeployableValues(system)) {
        const policy = doc.declarations.find((d) => d.kind === "policy" && d.name.name === v.policy);
        const field = policy?.kind === "policy" ? policy.fields.find((f) => f.key === v.field) : undefined;
        const at = field?.pos ?? policy?.pos ?? { line: 1, column: 1 };
        out.push({
          severity: "warning",
          code: "undeployable",
          message:
            `Policy '${v.policy}': ${v.field} is computed (${v.source}), so this file cannot be ` +
            `compiled to a static model.json — warpc will refuse it. It runs in-process via ` +
            `resolveForCommitment; use a constant if the value does not vary.`,
          ...(opts.file !== undefined ? { file: opts.file } : {}),
          line: at.line,
          column: at.column,
        });
      }
    } catch (e) {
      if (e instanceof WarpCompileError) out.push(fromError(e, "compile"));
      else throw e;
    }
  }

  return out.sort((a, b) => a.line - b.line || a.column - b.column || (a.severity === "error" ? -1 : 1));
}

/** Render diagnostics the way a compiler does: `file:line:col: severity: message`. */
export function formatDiagnostics(diags: Diagnostic[]): string {
  return diags
    .map((d) => `${d.file !== undefined ? `${d.file}:` : ""}${d.line}:${d.column}: ${d.severity}: ${d.message}`)
    .join("\n");
}
