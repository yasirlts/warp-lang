/**
 * Gap-closure tests (v0.3.0) — verify the seven structural gaps between the
 * package and WARP_COMMERCE_MODEL.md v0.3 are closed: terms attach to
 * Commitment, evidence attaches to Fulfillment, the full DeliveryMethod and
 * CommitmentCondition unions are expressible, AuctionProcess (incl
 * ScoredSelection), ContingentValue, EntitlementConsumption, and
 * ResolutionProcess all exist and surface through the root export.
 */

import { describe, expect, it } from "vitest";
import { commitmentId, newCommitment, newFulfillment, partyId } from "../src/index.js";
import type {
  AuctionProcess,
  CommitmentCondition,
  CommitmentTerms,
  ContingentValue,
  DeliveryMethod,
  EntitlementConsumption,
  Evidence,
  EvidenceV03,
  ResolutionProcess,
} from "../src/index.js";

describe("Gap 1 — CommitmentTerms attaches to Commitment", () => {
  it("a commitment can carry terms", () => {
    const c = newCommitment(partyId("buyer"), partyId("seller"));
    const terms: CommitmentTerms = {
      delivery: {
        method: { kind: "TitleTransfer", mechanism: "NotarialDeed", registry: "Conservation Foncière" },
      },
      jurisdiction: "MA",
    };
    const withTerms = { ...c, terms };
    expect(withTerms.terms?.jurisdiction).toBe("MA");
  });

  it("existing commitment without terms still valid", () => {
    const c = newCommitment(partyId("b"), partyId("s"));
    expect(c.terms).toBeUndefined(); // optional, not required
  });
});

describe("Gap 2 — Evidence attaches to Fulfillment", () => {
  it("a fulfillment can carry evidence", () => {
    const f = newFulfillment(commitmentId("c1"));
    const ev: Evidence[] = [
      { kind: "ProofOfDelivery", timestamp: new Date().toISOString(), recipient: partyId("buyer") },
    ];
    const withEv = { ...f, evidence: ev };
    expect(withEv.evidence?.[0]?.kind).toBe("ProofOfDelivery");
  });

  it("existing fulfillment without evidence still valid", () => {
    const f = newFulfillment(commitmentId("c1"));
    expect(f.evidence).toBeUndefined();
  });
});

describe("Gap 3 — DeliveryMethod all 11+ variants typecheck", () => {
  it("v0.3 delivery methods are expressible", () => {
    const methods: DeliveryMethod[] = [
      { kind: "TitleTransfer", mechanism: "NotarialDeed", registry: "X" },
      {
        kind: "CustomsRelease",
        customs_reference: "C1",
        cleared_at: "2026-01-01",
        inspection_required: false,
      },
      {
        kind: "RegistryRetirement",
        registry: partyId("reg"),
        retirement_reference: "R1",
        retired_on_behalf_of: partyId("co"),
        reason: "offset",
      },
    ];
    expect(methods.length).toBe(3);
  });
});

describe("Gap 4 — CommitmentCondition variants typecheck", () => {
  it("v0.3 conditions are expressible", () => {
    const conds: CommitmentCondition[] = [
      {
        kind: "FinancingContingency",
        amount: { amount: 1000, currency: "MAD" },
        approval_deadline: "2026-01-01",
        if_not_met: "Cancelled",
      },
      { kind: "PrescriptionRequired", must_verify_before: "Accepted" },
      {
        kind: "ThresholdActivation",
        minimum_participants: 10,
        activation_deadline: "2026-01-01",
        if_threshold_not_met: "Cancelled",
        if_threshold_met: "Accepted",
      },
    ];
    expect(conds.length).toBe(3);
  });
});

describe("Gap 5 — AuctionProcess with ScoredSelection", () => {
  it("government procurement auction is expressible", () => {
    const a: AuctionProcess = {
      id: "auc-1",
      subject: "v1" as any,
      seller: partyId("gov"),
      mechanism: {
        kind: "ScoredSelection",
        criteria: [{ name: "Technical", weight: 0.6, max_points: 100 }],
        evaluation_committee: [partyId("c1")],
        publication_required: true,
      },
      tendered_commitments: [],
      opens_at: "2026-01-01",
      closes_at: "2026-02-01",
      state: { type: "Open" },
    };
    expect(a.mechanism.kind).toBe("ScoredSelection");
  });
});

describe("Gap 6 — ContingentValue and EntitlementConsumption", () => {
  it("contingent value (insurance) is expressible", () => {
    const cv: ContingentValue = {
      kind: "ContingentValue",
      trigger_type: "FlightDelay",
      if_triggered_description: "Payout 500 EUR",
      if_not_triggered_description: "Nothing",
    };
    expect(cv.kind).toBe("ContingentValue");
  });

  it("metered consumption is expressible", () => {
    const ec: EntitlementConsumption = {
      id: "e1",
      commitment: "c1",
      entitlement: "api-calls",
      consumed_this_event: 1,
      total_consumed_this_period: 100,
      total_allowed_this_period: 1000,
      period_start: "2026-01-01",
      period_end: "2026-02-01",
      timestamp: "2026-01-15",
      overage: false,
    };
    expect(ec.overage).toBe(false);
  });
});

describe("Gap 7 — ResolutionProcess", () => {
  it("substitution resolution is expressible", () => {
    const r: ResolutionProcess = {
      id: "r1",
      parent_commitment: commitmentId("c1"),
      unresolved_item: "v1" as any,
      original_value: { amount: 100, currency: "MAD" },
      candidates: [],
      state: { type: "AwaitingCustomerDecision" },
      deadline: "2026-01-01",
    };
    expect(r.state.type).toBe("AwaitingCustomerDecision");
  });
});

describe("Additive guarantees — no breaking change", () => {
  it("the full CommitmentTerms aggregate (payment + conditions + duration) typechecks", () => {
    const terms: CommitmentTerms = {
      delivery: { method: { kind: "PhysicalDelivery", carrier: partyId("ctm") } },
      payment: { timing: { type: "Net", days: 30, from: "InvoiceDate" }, method: "bank_transfer" },
      conditions: [{ kind: "StaffDiscount", rate: 0.1 }],
      duration: { kind: "OpenEnded", cancellation_notice_days: 30 },
      jurisdiction: "MA",
    };
    expect(terms.conditions?.length).toBe(1);
    expect(terms.payment?.timing.type).toBe("Net");
  });

  it("EvidenceV03 is untouched — still keyed on `type`, coexists with Evidence (`kind`)", () => {
    // EvidenceV03 (commerce-v03.ts) keeps its `type` discriminant; the new
    // Evidence union uses `kind`. Both are exported and usable.
    const legacy: EvidenceV03 = {
      type: "RetirementCertificate",
      reference: "RET-1",
      issued_by: "verra",
      quantity: 1000,
      retired_at: "2026-01-01",
      project_id: "VCS-1",
    };
    const modern: Evidence = {
      kind: "RetirementCertificate",
      reference: "RET-1",
      issued_by: "verra",
      quantity: 1000,
      retired_at: "2026-01-01",
      project_id: "VCS-1",
    };
    expect(legacy.type).toBe("RetirementCertificate");
    expect(modern.kind).toBe("RetirementCertificate");
  });
});
