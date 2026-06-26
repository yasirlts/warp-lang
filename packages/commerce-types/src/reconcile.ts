/**
 * Cross-platform reconciliation verdict (write-time).
 *
 * {@link unify} answers a binary question: do the corresponded sources merge
 * into one coherent commitment, yes or no? It stops at the first source that
 * fails to conserve value and returns a single I-1 violation. That is the right
 * shape for a gate, but it does not tell an operator the WHOLE story when three
 * or more systems are supposed to agree: which sources are coherent, which one
 * drifted, and by how much.
 *
 * {@link reconcile} fills that gap. Given N caller-corresponded sources, it
 * returns a STRUCTURED coherence verdict across ALL of them — a per-source line
 * comparing each source's committed amount against the unified (primary) amount,
 * with any drift surfaced as an I-1 (Value Conservation) finding carrying the
 * offending platform and the signed delta.
 *
 * This is a WRITE-TIME check meant to run before a multi-source write commits,
 * NOT a nightly batch job. It is a COMPOSITION:
 *
 *   - the overall pass/fail and the merged commitment come from {@link unify}
 *     (which itself composes guardObject + the I-1 conservation check);
 *   - each per-source drift verdict is obtained by asking {@link unify} the same
 *     pairwise question it already answers (primary vs. that one source), so the
 *     conservation DECISION is never re-derived here;
 *   - the delta reported alongside a drift is plain arithmetic on the committed
 *     amounts the sources carry — it is attribution detail, not a second copy of
 *     the invariant.
 *
 * The same two lines `unify` does not cross hold here: correspondence is the
 * caller's assertion (passing the sources together), not discovery; and nothing
 * is executed — the verdict is a description.
 */

import { unify, type UnifySource } from "./interop.js";
import type { Money } from "./money.js";
import type { Commitment } from "./primitives.js";
import type { GuardViolation, World } from "./guard.js";

/**
 * One source's standing relative to the unified (primary) amount. `conserves`
 * is true when the source agrees with the primary within the model's minor-unit
 * tolerance (the same equality {@link unify} uses). When it drifts, `delta` is
 * the signed difference `source − unified` in the unified currency, and
 * `violation` is the I-1 finding attributing the drift to this source.
 *
 * `amount` / `currency` may be null when a source commits no money to compare
 * (e.g. a non-monetary commitment); such a source is treated as conserving,
 * exactly as {@link unify} skips it.
 */
export interface SourceVerdict {
  /** The platform label the caller tagged this source with. */
  platform: UnifySource["platform"];
  /** This source's committed amount, or null when it carries no money. */
  amount: number | null;
  /** This source's committed currency, or null when it carries no money. */
  currency: string | null;
  /** True when this source conserves value against the unified amount. */
  conserves: boolean;
  /** Signed `source − unified` in the unified currency; present only on drift. */
  delta?: number;
  /** The I-1 finding for this source's drift; present only on drift. */
  violation?: GuardViolation;
}

/**
 * The reconciliation verdict over all corresponded sources.
 *
 * `ok` is true only when every source conserves value AND the merged view is a
 * valid commitment (the full {@link unify} verdict). `sources` always lists one
 * {@link SourceVerdict} per input source (the primary included, always
 * conserving against itself) so an operator can read the whole picture, coherent
 * lines and drifted lines alike. On success `commitment` / `world` carry the
 * merged view; on failure `violations` aggregates every I-1 drift finding (and
 * any structural violation `unify` raised on the merged view).
 */
export type ReconcileResult =
  | { ok: true; unifiedAmount: Money | null; sources: SourceVerdict[]; commitment: Commitment; world: World }
  | { ok: false; unifiedAmount: Money | null; sources: SourceVerdict[]; violations: GuardViolation[] };

/** Sum the Money committed by a commitment (its `requested` values), or null. */
function committedMoney(c: Commitment): Money | null {
  const monies: Money[] = [];
  for (const v of c.subject.requested) {
    if (v.form.kind === "Money") monies.push(v.form.money);
  }
  const first = monies[0];
  if (first === undefined) return null;
  const currency = first.currency;
  if (monies.some((m) => m.currency !== currency)) return null; // mixed: nothing single to compare
  return monies.reduce((acc, m) => ({ amount: acc.amount + m.amount, currency }));
}

/**
 * Reconcile N caller-corresponded sources into a structured coherence verdict.
 *
 * The first source is the PRIMARY; its committed amount is the unified amount
 * every other source is measured against (the same primary convention
 * {@link unify} uses). Each non-primary source is checked by handing the pair
 * `[primary, source]` to {@link unify}: if `unify` reports an I-1, this source
 * drifts and its verdict carries that finding plus the signed delta. The overall
 * `ok` and the merged commitment come from a single `unify` over all sources, so
 * reconcile adds attribution WITHOUT re-deciding conservation.
 *
 * Use it write-time, before a multi-source write commits, to get the whole
 * picture in one call rather than a first-failure gate.
 */
export function reconcile(sources: UnifySource[], opts?: { id?: string }): ReconcileResult {
  // Degenerate inputs: defer entirely to unify's own messaging (empty set, etc.)
  if (sources.length === 0) {
    const u = unify(sources, opts);
    // unify rejects an empty set; mirror that as a no-source verdict.
    return { ok: false, unifiedAmount: null, sources: [], violations: u.ok ? [] : u.violations };
  }

  const primary = sources[0] as UnifySource;
  const unifiedMoney = committedMoney(primary.commitment);

  // Per-source verdicts. The primary always conserves against itself. Each other
  // source's conservation DECISION comes from unify (the pairwise I-1 check); the
  // delta is arithmetic on the committed amounts for attribution only.
  const sourceVerdicts: SourceVerdict[] = [];
  const violations: GuardViolation[] = [];

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i] as UnifySource;
    const srcMoney = committedMoney(src.commitment);
    const base: SourceVerdict = {
      platform: src.platform,
      amount: srcMoney === null ? null : srcMoney.amount,
      currency: srcMoney === null ? null : srcMoney.currency,
      conserves: true,
    };

    if (i === 0) {
      sourceVerdicts.push(base);
      continue;
    }

    // Ask unify the pairwise question it already answers: does this one source
    // conserve against the primary? Any I-1 it returns is THE conservation
    // verdict — reconcile does not re-derive it.
    const pair = unify([primary, src]);
    if (pair.ok === false) {
      const i1 = pair.violations.find((v) => v.rule === "I-1") ?? pair.violations[0];
      const delta = unifiedMoney !== null && srcMoney !== null ? srcMoney.amount - unifiedMoney.amount : undefined;
      const verdict: SourceVerdict = {
        ...base,
        conserves: false,
        ...(delta !== undefined ? { delta } : {}),
        ...(i1 !== undefined ? { violation: i1 } : {}),
      };
      sourceVerdicts.push(verdict);
      if (i1 !== undefined) violations.push(i1);
    } else {
      sourceVerdicts.push(base);
    }
  }

  // Overall verdict + merged view: a single unify over all sources. This also
  // surfaces any structural violation on the merged commitment (beyond drift).
  const overall = unify(sources, opts);
  if (overall.ok) {
    return { ok: true, unifiedAmount: unifiedMoney, sources: sourceVerdicts, commitment: overall.commitment, world: overall.world };
  }

  // Fold in any non-I-1 (structural) violations unify raised that the pairwise
  // drift scan did not already capture, so nothing is dropped from the verdict.
  for (const v of overall.violations) {
    if (!violations.some((existing) => existing.rule === v.rule && existing.message === v.message)) {
      violations.push(v);
    }
  }
  return { ok: false, unifiedAmount: unifiedMoney, sources: sourceVerdicts, violations };
}
