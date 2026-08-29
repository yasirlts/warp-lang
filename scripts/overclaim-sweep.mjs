#!/usr/bin/env node
/**
 * Overclaim sweep — a mechanical check on how the protocol-integrity surface
 * describes Warp's relationship to the agentic-commerce protocols.
 *
 * WHY THIS EXISTS. Warp's position beneath these protocols is only credible if it
 * is stated precisely every time. "Complementary to, and beneath" is a claim we
 * can support. "Replaces", "competes with", "sits on top of", "adopted by",
 * "endorsed by" are claims we cannot — and a single careless sentence in a README
 * undoes the care taken everywhere else. This script makes that failure loud
 * instead of leaving it to a reviewer's attention span.
 *
 * THE ONE SUBTLETY. The banned words must remain usable in DISCLAIMERS — the
 * honest position requires sentences like "no protocol has adopted or endorsed
 * Warp", which necessarily contain "adopted" and "endorsed". A sweep that banned
 * the substrings outright would force the disclaimers out of the documentation,
 * making the writing less honest rather than more.
 *
 * So each hit is classified by the sentence it sits in:
 *
 *   - CLAIM   — a banned term with no negation in its sentence. This FAILS the
 *               sweep (exit 1) and must be rewritten.
 *   - NEGATED — a banned term inside an explicit denial. Allowed, but PRINTED IN
 *               FULL on every run so a human reads the actual sentence and can
 *               judge it. It is deliberately not silent: the allowance is
 *               visible, auditable, and small enough to eyeball.
 *
 * This is a linguistic check on a scoped set of files, not a proof of honesty.
 * It catches the phrasings we know to be wrong; it cannot catch a claim made in
 * words nobody thought to ban. Read the prose too.
 *
 *   node scripts/overclaim-sweep.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The protocol-integrity surface: the files that describe where Warp sits.
 * Scoped deliberately — this is not a repo-wide claim, and saying so is part of
 * being accurate about what the check covers.
 */
const TARGETS = [
  "docs/protocol-integrity.md",
  "packages/commerce-mcp/README.md",
  "packages/commerce-mcp/CHANGELOG.md",
  "packages/commerce-mcp/src",
  "packages/commerce-mcp/test",
  "packages/commerce-mcp/examples",
];

const SCANNED_EXTENSIONS = new Set([".md", ".ts", ".mjs", ".js"]);

/**
 * Phrasings that overstate Warp's position. Each is matched case-insensitively
 * against sentence text. `why` is printed on a failure so the fix is obvious.
 */
const BANNED = [
  { re: /\breplaces?\b|\breplacement\b/i, why: "Warp does not replace these protocols — it runs beneath them and is complementary." },
  { re: /\bon top of\b/i, why: "Warp sits BENEATH these protocols, not on top of them." },
  { re: /\bcompet(e|es|ing|itor|ition)\b|\brivals?\b/i, why: "These protocols are different layers, not competitors." },
  { re: /\badopt(ed|ion|s)\b/i, why: "No protocol has adopted Warp. Describe a capability on Warp's side only." },
  { re: /\bendorse(d|ment|s)?\b/i, why: "No protocol or organization has endorsed Warp." },
  { re: /\bpartner(ship|ed|ing)\b/i, why: "There is no partnership with any protocol or organization." },
  { re: /\bofficial(ly)?\s+(support|supported|integration|integrated|endorsed|adopted|partner|blessed|recognized|sanctioned)\b/i, why: "Nothing here is officially supported or blessed by any protocol." },
  { re: /\bcertified\b/i, why: "Nothing here is certified by any protocol or body." },
  { re: /\bsupersedes?\b|\bobsoletes?\b/i, why: "Warp makes nothing obsolete; it answers a different question." },
];

/** Words that turn a sentence into a denial rather than an assertion. */
const NEGATION = /\b(no|not|never|nor|neither|nothing|none|without|cannot|can't|doesn't|does not|don't|isn't|is not|aren't|are not|makes no|implies no|asserts no|free of)\b/i;

function walk(path) {
  const abs = join(repoRoot, path);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return SCANNED_EXTENSIONS.has(extname(abs)) ? [abs] : [];
  return readdirSync(abs).flatMap((entry) => walk(join(path, entry)));
}

/**
 * Split a file into sentence-sized units for classification.
 *
 * Getting this granularity right is the whole correctness of the sweep:
 *
 *  - TOO COARSE (whole file) and one disclaimer at the top would excuse every
 *    claim below it.
 *  - TOO FINE (per line) and a disclaimer that WRAPS across two lines loses the
 *    negation that makes it a disclaimer — the sweep then fails the very
 *    sentences that state the honest position, which is the wrong direction to
 *    be wrong in.
 *
 * So: prose is unwrapped into paragraphs and then split on sentence punctuation,
 * while markdown table rows, headings and list items — which carry a complete
 * thought per LINE with no terminal punctuation — are each their own unit. In
 * source files, comment markers are stripped first so a JSDoc sentence spanning
 * several `*` lines reads as one sentence.
 */
function units(text, isCode) {
  const rows = text.split("\n").map((raw, i) => {
    const stripped = isCode ? raw.replace(/^\s*(\/\*\*|\*\/|\*|\/\/)\s?/, "") : raw;
    return { line: i + 1, text: stripped.trim() };
  });

  const blocks = [];
  let buffer = null;
  const flush = () => {
    if (buffer && buffer.text) blocks.push(buffer);
    buffer = null;
  };

  for (const { line, text: t } of rows) {
    if (t === "") {
      flush();
      continue;
    }
    // A complete thought per line — never joined to its neighbours.
    if (/^\|/.test(t) || /^#{1,6}\s/.test(t) || /^[-*+]\s/.test(t) || /^\d+\.\s/.test(t)) {
      flush();
      blocks.push({ line, text: t });
      continue;
    }
    if (buffer) buffer.text += " " + t;
    else buffer = { line, text: t };
  }
  flush();

  return blocks.flatMap((b) =>
    b.text
      .split(/(?<=[.!?])\s+/)
      .map((piece) => piece.trim())
      .filter(Boolean)
      .map((piece) => ({ line: b.line, text: piece })),
  );
}

const claims = [];
const negated = [];

for (const file of TARGETS.flatMap(walk)) {
  const rel = relative(repoRoot, file);
  const isCode = extname(file) !== ".md";
  for (const unit of units(readFileSync(file, "utf8"), isCode)) {
    for (const banned of BANNED) {
      if (!banned.re.test(unit.text)) continue;
      const bucket = NEGATION.test(unit.text) ? negated : claims;
      bucket.push({ rel, ...unit, why: banned.why, term: unit.text.match(banned.re)[0] });
      break; // one report per unit is enough to act on
    }
  }
}

const scanned = TARGETS.flatMap(walk).length;
console.log(`overclaim sweep — ${scanned} files across the protocol-integrity surface\n`);

if (negated.length > 0) {
  console.log(`${negated.length} negated mention(s) — allowed, shown so they can be read:\n`);
  for (const n of negated) console.log(`  ${n.rel}:${n.line}  "${n.term}"\n    ${n.text}`);
  console.log();
}

if (claims.length > 0) {
  console.error(`FAIL — ${claims.length} overclaim(s):\n`);
  for (const c of claims) {
    console.error(`  ${c.rel}:${c.line}  "${c.term}"`);
    console.error(`    ${c.text}`);
    console.error(`    -> ${c.why}\n`);
  }
  process.exit(1);
}

console.log(`PASS — 0 overclaims.`);
