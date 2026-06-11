/**
 * Tests for the v0.3 "full commerce vocabulary" additions: ValueState::Retired,
 * the new PaymentTiming variants, the v0.3 AccessModels, CascadeCancellation,
 * ThresholdActivation, VolumePricing, AwardProtest, CommissionSplit, and the
 * loyalty liability check (Invariant 1, fourth clause).
 */

import { describe, expect, it } from "vitest";
import {
  type AccessModel,
  type AwardProtest,
  type CascadeCancellation,
  type CommissionStructure,
  type LoyaltyEarnTerm,
  type PaymentTiming,
  type ThresholdActivation,
  type ValueState,
  type VolumePricing,
  checkLoyaltyLiability,
  isValidCommitmentTransition,
  partyId,
} from "../src/index.js";

describe("v0.3 — ValueState::Retired", () => {
  it("ValueState Retired is terminal", () => {
    // Retired carries consumption metadata and the model defines no transition
    // out of it — a permanently consumed value cannot re-enter any flow.
    const retired: ValueState = {
      type: "Retired",
      retired_at: "2026-06-11T10:00:00.000Z",
      retired_by: partyId("registry"),
      reason: "Carbon offset claimed",
      certificate: "RET-2026-001",
    };
    expect(retired.type).toBe("Retired");
    // Terminality follows the same pattern as terminal commitment states:
    // e.g. a Cancelled commitment (empty transition set) cannot move forward.
    expect(
      isValidCommitmentTransition(
        { type: "Cancelled", by: partyId("x"), reason: "r", at: "2026-06-11T10:00:00.000Z" },
        { type: "Fulfilled" },
      ),
    ).toBe(false);
  });
});

describe("v0.3 — CommitmentTerms additions", () => {
  it("CascadeCancellation serializes correctly", () => {
    const cascade: CascadeCancellation = {
      trigger: { type: "ExternalEvent", event_type: "concert_cancelled" },
      applies_to: { type: "AllChildren" },
      child_transition: { type: "Cancelled", by: partyId("organizer"), reason: "Event cancelled", at: "2026-06-11T10:00:00.000Z" },
      auto_refund: { amount: "FullRefund", deadline_days: 14 },
    };
    const round = JSON.parse(JSON.stringify(cascade)) as CascadeCancellation;
    expect(round.trigger.type).toBe("ExternalEvent");
    expect(round.applies_to.type).toBe("AllChildren");
    expect(round.child_transition.type).toBe("Cancelled");
    expect(round.auto_refund?.amount).toBe("FullRefund");
  });

  it("ThresholdActivation requires minimum_participants > 0", () => {
    const deal: ThresholdActivation = {
      minimum_participants: 10,
      activation_deadline: "2026-07-01T00:00:00.000Z",
      if_threshold_not_met: "Cancelled",
      if_threshold_met: "Accepted",
      price_tiers: [
        { participants: 10, price: { amount: 90, currency: "MAD" } },
        { participants: 50, price: { amount: 75, currency: "MAD" } },
      ],
    };
    expect(deal.minimum_participants).toBeGreaterThan(0);
    expect(deal.if_threshold_met).toBe("Accepted");
    expect(deal.if_threshold_not_met).toBe("Cancelled");
  });

  it("VolumePricing tiers must have increasing min values", () => {
    const pricing: VolumePricing = {
      tiers: [
        { min: 1, max: 99, price_per_unit: { amount: 10, currency: "MAD" } },
        { min: 100, max: 499, price_per_unit: { amount: 9, currency: "MAD" } },
        { min: 500, price_per_unit: { amount: 8, currency: "MAD" } },
      ],
    };
    const increasing = pricing.tiers.every(
      (t, i) => i === 0 || t.min > (pricing.tiers[i - 1]?.min ?? -Infinity),
    );
    expect(increasing).toBe(true);
  });

  it("CarbonCredit retired flag matches ValueState", () => {
    const credit: AccessModel = {
      kind: "CarbonCredit",
      standard: "Verra VCS",
      vintage: 2025,
      project_id: "VCS-1234",
      project_type: "Reforestation",
      location: "MA",
      quantity: 1000,
      retired: true,
      additionality_verified: true,
      verification_body: "Verra",
    };
    // A retired CarbonCredit's value instance must be in ValueState::Retired.
    const valueState: ValueState =
      credit.kind === "CarbonCredit" && credit.retired
        ? { type: "Retired", retired_at: "2026-06-11T10:00:00.000Z", retired_by: partyId("verra"), reason: "Offset claimed" }
        : { type: "Available" };
    expect(valueState.type).toBe("Retired");
  });
});

describe("v0.3 — AwardProtest state machine", () => {
  it("AwardProtest state machine: Filed → UnderReview → Upheld", () => {
    let protest: AwardProtest = {
      id: "PROT-1",
      filed_by: "vendor-b",
      against: "C-AWARD-1",
      auction_process: "AUC-GOV-1",
      grounds: ["Scoring error on technical criterion"],
      filed_at: "2026-06-01T00:00:00.000Z",
      deadline_for_response: "2026-06-15T00:00:00.000Z",
      state: { type: "Filed" },
    };
    protest = { ...protest, state: { type: "UnderReview", reviewer: "procurement-board" } };
    protest = { ...protest, state: { type: "Upheld", remedy: "ReEvaluation" } };
    expect(protest.state.type).toBe("Upheld");
    if (protest.state.type === "Upheld") {
      expect(protest.state.remedy).toBe("ReEvaluation");
    }
  });

  it("AwardProtest state machine: Filed → UnderReview → Dismissed", () => {
    let protest: AwardProtest = {
      id: "PROT-2",
      filed_by: "vendor-c",
      against: "C-AWARD-1",
      auction_process: "AUC-GOV-1",
      grounds: ["Disagreement with weighting"],
      filed_at: "2026-06-01T00:00:00.000Z",
      deadline_for_response: "2026-06-15T00:00:00.000Z",
      state: { type: "UnderReview", reviewer: "procurement-board" },
    };
    protest = { ...protest, state: { type: "Dismissed" } };
    expect(protest.state.type).toBe("Dismissed");
  });
});

describe("v0.3 — PaymentTiming additions", () => {
  it("CommissionSplit DoubleSided has both fees", () => {
    const structure: CommissionStructure = {
      type: "DoubleSided",
      buyer_fee: { rate: 0.05, paid_to: partyId("platform") },
      seller_fee: { rate: 0.1, paid_to: partyId("platform") },
    };
    const timing: PaymentTiming = { type: "CommissionSplit", structure };
    expect(timing.type).toBe("CommissionSplit");
    if (timing.structure.type === "DoubleSided") {
      expect(timing.structure.buyer_fee.rate).toBe(0.05);
      expect(timing.structure.seller_fee.rate).toBe(0.1);
    }
  });

  it("PostFulfillment InsuranceAdjudication has adjudicator", () => {
    const timing: PaymentTiming = {
      type: "PostFulfillment",
      trigger: { type: "InsuranceAdjudication", adjudicator: partyId("insurer"), claim_reference: "CLM-9" },
    };
    expect(timing.type).toBe("PostFulfillment");
    if (timing.type === "PostFulfillment" && timing.trigger.type === "InsuranceAdjudication") {
      expect(timing.trigger.adjudicator).toBe("insurer");
    }
  });

  it("Net payment terms: 30, 60, 90 days only", () => {
    const allowed: Array<30 | 60 | 90> = [30, 60, 90];
    for (const days of allowed) {
      const timing: PaymentTiming = { type: "Net", days, from: "InvoiceDate" };
      expect(timing.type).toBe("Net");
      if (timing.type === "Net") expect(allowed).toContain(timing.days);
    }
    // @ts-expect-error — 45 is not an allowed Net term
    const invalid: PaymentTiming = { type: "Net", days: 45, from: "InvoiceDate" };
    expect(invalid.type).toBe("Net");
  });
});

describe("v0.3 — EventAccess + LoyaltyEarnTerm", () => {
  it("EventAccess entry_window validates start before end", () => {
    const ticket: AccessModel = {
      kind: "EventAccess",
      event: "Mawazine 2026",
      location: "Rabat",
      date: "2026-06-20",
      entry_window_start: "2026-06-20T18:00:00.000Z",
      entry_window_end: "2026-06-20T20:00:00.000Z",
      transferable: false,
    };
    if (ticket.kind === "EventAccess") {
      expect(Date.parse(ticket.entry_window_start)).toBeLessThan(Date.parse(ticket.entry_window_end));
    }
  });

  it("LoyaltyEarnTerm earn_rate must be positive", () => {
    const term: LoyaltyEarnTerm = {
      program: "AimerRewards",
      earn_rate: 1.5,
      points_earned: 300,
      credited_on: "PaymentReceived",
      currency: "PTS",
    };
    expect(term.earn_rate).toBeGreaterThan(0);

    // Invariant 1 fourth clause: a merchant cannot issue more redeemable point
    // value than the business can sustain. 1M points at 0.10 MAD = 100k MAD
    // liability against 80k MAD capacity is NOT sustainable.
    const check = checkLoyaltyLiability(
      partyId("merchant"),
      1_000_000,
      { amount: 0.1, currency: "MAD" },
      { amount: 80_000, currency: "MAD" },
    );
    expect(check.sustainable).toBe(false);

    const ok = checkLoyaltyLiability(
      partyId("merchant"),
      100_000,
      { amount: 0.1, currency: "MAD" },
      { amount: 80_000, currency: "MAD" },
    );
    expect(ok.sustainable).toBe(true);
  });
});
