/**
 * Platform Auditor — Tier 2 (data audit).
 *
 * Scan a store's ACTUAL order/refund/settlement records and find commerce-integrity
 * violations that ALREADY HAPPENED: real orders where a refund exceeded what was
 * captured (I-1), settlements that don't reconcile or mix currencies (I-1), illegal
 * transitions in the recorded history (I-2), value non-conservation. The "here are
 * the N orders where you leaked money" report.
 *
 * SCOPE — the user SUPPLIES the records (an exported order dump / API-response JSON).
 * This build does NOT connect to a live store, hold credentials, or make network
 * calls — the user brings the data, Warp audits it. It finds commerce-INTEGRITY
 * violations only (per the invariants); it does NOT find fraud intent, UI bugs,
 * tax-rate correctness, security holes, or performance. It reports what the DATA
 * shows.
 *
 * It COMPOSES the invariant predicates (checkI1ValueConservation,
 * checkI2StateMonotonicity, checkI1MoneyBreakdownSum) and — for platform-native
 * records — the inbound mappers (fromShopifyOrder, …). It reimplements none.
 *
 * Honest about mapping: a record that cannot be cleanly mapped to a Warp Commitment
 * is reported as UNAUDITABLE (listed, with why) — NEVER silently skipped and NEVER
 * counted as clean.
 */
import type { Commitment } from "./primitives.js";
import { newCommitment, partyId, valueId } from "./primitives.js";
import type { CommitmentState } from "./states.js";
import type { MoneyBreakdown } from "./money.js";
import type { InvariantViolation } from "./invariants.js";
import { checkI1ValueConservation, checkI2StateMonotonicity, checkI1MoneyBreakdownSum } from "./invariants.js";

/** A monetary amount as it appears in a raw order record. */
export interface RecordMoney {
  amount: number;
  currency: string;
}

/**
 * A normalized order record to audit. The adopter maps their export to this shape
 * (or supplies a platform-native record + an inbound mapper — see {@link auditPlatformData}).
 */
export interface OrderRecord {
  /** The order id, for the report. */
  id: string;
  /** What was captured / committed (becomes the commitment's requested value). */
  committed: RecordMoney;
  /** The order's final state (defaults to "Fulfilled"). Field-free states only; a
   *  refund is expressed via `refund` (which sets the Refunded state). */
  finalState?: "Draft" | "Proposed" | "Accepted" | "Active" | "Fulfilled";
  /** If refunded, the amount returned — checked against `committed` (I-1). */
  refund?: RecordMoney;
  /** The recorded state history, as declared by the platform (checked for legality, I-2). */
  history?: { from: CommitmentState["type"]; to: CommitmentState["type"]; at?: string }[];
  /** An optional settlement breakdown to reconcile (I-1 sum + single-currency). */
  settlement?: MoneyBreakdown;
}

/** One integrity violation found on a specific record. */
export interface RecordViolation {
  recordId: string;
  /** The invariant that fired (I-1 / I-2). */
  rule: string;
  /** The specific, actionable problem (e.g. "refunded 250 MAD but only 200 was captured"). */
  detail: string;
}

/** A record that could not be mapped to a Warp Commitment — never counted clean. */
export interface Unauditable {
  recordId: string;
  why: string;
}

export interface DataAuditResult<R> {
  platform: string;
  /** Records that mapped and were checked (clean + violating). Excludes unauditable. */
  recordsAudited: number;
  /** Records that mapped and had NO violation. */
  clean: number;
  /** Every violation found, per record. */
  violations: RecordViolation[];
  /** Records that failed to map — listed, never folded into `clean`. */
  unauditable: Unauditable[];
  /** total = recordsAudited + unauditable.length; recordsAudited = clean + (records with ≥1 violation). */
  summary: { total: number; recordsAudited: number; clean: number; withViolations: number; unauditable: number };
}

/** Run the applicable integrity invariants over one mapped commitment. Composes the predicates. */
export function auditCommitment(commitment: Commitment): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  out.push(...checkI1ValueConservation([commitment]));
  out.push(...checkI2StateMonotonicity(commitment));
  // Any Money value carrying a settlement breakdown is reconciled (I-1 sum + currency).
  for (const v of [...commitment.subject.offered, ...commitment.subject.requested]) {
    if (v.form.kind === "Money" && v.form.breakdown !== undefined) {
      out.push(...checkI1MoneyBreakdownSum(v.form.breakdown));
    }
  }
  return out;
}

/** The default mapper: a normalized {@link OrderRecord} → a Warp Commitment. */
export function orderRecordToCommitment(record: OrderRecord): Commitment {
  if (record.committed === undefined || typeof record.committed.amount !== "number" || !record.committed.currency) {
    throw new Error("record has no committed amount/currency to map to a Warp commitment");
  }
  const money = { amount: record.committed.amount, currency: record.committed.currency };
  const form =
    record.settlement !== undefined
      ? ({ kind: "Money", money, breakdown: record.settlement } as const)
      : ({ kind: "Money", money } as const);
  const base = newCommitment(partyId("buyer"), partyId("seller"), {
    offered: [],
    requested: [{ id: valueId("pay"), form, quantity: 1, state: { type: "Available" } }],
  });
  const state: CommitmentState = record.refund
    ? { type: "Refunded", amount: { amount: record.refund.amount, currency: record.refund.currency }, at: "2026-12-31T00:00:00.000Z" }
    : { type: record.finalState ?? "Fulfilled" };
  const history = (record.history ?? []).map((h, i) => ({
    from: { type: h.from } as CommitmentState,
    to: { type: h.to } as CommitmentState,
    at: h.at ?? `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    actor: partyId("seller"),
  }));
  return { ...base, state, history };
}

export interface DataAuditInput<R> {
  platform: string;
  records: R[];
  /** Map a record → a Warp Commitment. Defaults to {@link orderRecordToCommitment}. Pass an
   *  inbound mapper (e.g. fromShopifyOrder) for platform-native records. May throw → unauditable. */
  toCommitment?: (record: R) => Commitment;
  /** Extract the record id (for the report + unauditable listing). Defaults to `r => r.id`. */
  getId?: (record: R) => string;
}

/**
 * Audit supplied order records for commerce-integrity violations that already
 * happened. Maps each record to a Warp Commitment and runs the invariants; a record
 * that fails to map is UNAUDITABLE (listed, never counted clean). Pure; never throws.
 */
export function auditPlatformData<R = OrderRecord>(input: DataAuditInput<R>): DataAuditResult<R> {
  const toCommitment = input.toCommitment ?? (orderRecordToCommitment as unknown as (r: R) => Commitment);
  const getId = input.getId ?? ((r: R) => String((r as { id?: unknown }).id ?? "(unknown)"));

  const violations: RecordViolation[] = [];
  const unauditable: Unauditable[] = [];
  let recordsAudited = 0;
  let withViolations = 0;

  for (const record of input.records) {
    const recordId = getId(record);
    let commitment: Commitment;
    try {
      commitment = toCommitment(record);
    } catch (e) {
      unauditable.push({ recordId, why: e instanceof Error ? e.message : String(e) });
      continue;
    }
    recordsAudited++;
    const found = auditCommitment(commitment);
    if (found.length > 0) {
      withViolations++;
      for (const v of found) violations.push({ recordId, rule: v.invariant, detail: v.description });
    }
  }

  const clean = recordsAudited - withViolations;
  return {
    platform: input.platform,
    recordsAudited,
    clean,
    violations,
    unauditable,
    summary: { total: input.records.length, recordsAudited, clean, withViolations, unauditable: unauditable.length },
  };
}

/**
 * Render a {@link DataAuditResult} as a human-readable report. The header states the
 * honest scope; the body gives the clean count, each violating order with its rule +
 * specific detail, and the unauditable records separately.
 */
export function formatDataAuditReport<R>(result: DataAuditResult<R>): string {
  const s = result.summary;
  const L: string[] = [];
  L.push(`Order data integrity audit — Tier 2 (data): ${result.platform}`);
  L.push("Scope: audits the order records you SUPPLIED for commerce-integrity violations");
  L.push("(per record, per invariant). Not live-connected — you bring the data. Not a");
  L.push("fraud, UI, tax-rate, or security scanner. It reports what the data shows.");
  L.push("");
  L.push(`Audited ${s.recordsAudited} order(s). Clean: ${s.clean}. With violations: ${s.withViolations}. Unauditable: ${s.unauditable}.`);
  L.push("");
  if (result.violations.length === 0) {
    L.push("No integrity violations found in the audited records.");
  } else {
    L.push("Violations:");
    for (const v of result.violations) L.push(`  • order ${v.recordId} [${v.rule}]: ${v.detail}`);
  }
  if (result.unauditable.length > 0) {
    L.push("");
    L.push("Unauditable (could not be mapped — NOT counted clean):");
    for (const u of result.unauditable) L.push(`  • order ${u.recordId}: ${u.why}`);
  }
  return L.join("\n");
}
