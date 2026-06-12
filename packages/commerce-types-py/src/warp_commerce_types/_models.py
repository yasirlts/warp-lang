"""GENERATED FILE — do not edit by hand.

Pydantic v2 models for the Warp Commerce Model, generated from the canonical
schema (schema/structure/*.schema.json) v1.0.0 by
scripts/generate_from_schema.py. Edit the schema and regenerate; never edit
this file directly.
"""
from __future__ import annotations

from typing import Annotated, Any, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "1.0.0"


# --- structural models (objects + tagged-union members) ---

class ScoredCriterion(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    name: str
    weight: float
    max_points: float


class AuctionMechanismEnglish(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["English"] = "English"
    reserve_price: Optional[Money] = None
    increment: Optional[Money] = None


class AuctionMechanismDutch(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Dutch"] = "Dutch"
    start_price: Money
    decrement: Money
    interval_seconds: float


class AuctionMechanismSealedBid(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["SealedBid"] = "SealedBid"
    reserve_price: Optional[Money] = None
    reveal_at: str


class AuctionMechanismVickrey(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Vickrey"] = "Vickrey"
    reserve_price: Optional[Money] = None


class AuctionMechanismScoredSelection(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ScoredSelection"] = "ScoredSelection"
    criteria: List[ScoredCriterion] = Field(default_factory=list)
    minimum_threshold: Optional[float] = None
    evaluation_committee: List[PartyID] = Field(default_factory=list)
    publication_required: bool


class AuctionStateScheduled(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Scheduled"] = "Scheduled"


class AuctionStateOpen(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Open"] = "Open"


class AuctionStateClosed(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Closed"] = "Closed"
    winning_commitment: Optional[CommitmentID] = None
    winning_price: Optional[Money] = None
    reason: AuctionCloseReason


class AuctionProcess(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    subject: ValueID
    seller: PartyID
    mechanism: AuctionMechanism
    tendered_commitments: List[CommitmentID] = Field(default_factory=list)
    opens_at: str
    closes_at: str
    state: AuctionState


class PartialRefund(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["PartialRefund"] = "PartialRefund"
    rate: float


class RefundPolicy(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    amount: RefundAmount
    deadline_days: Optional[float] = None


class CascadeTriggerParentCancelled(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["ParentCancelled"] = "ParentCancelled"


class CascadeTriggerParentDisputed(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["ParentDisputed"] = "ParentDisputed"


class CascadeTriggerExternalEvent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["ExternalEvent"] = "ExternalEvent"
    event_type: str


class CascadeScopeAllChildren(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["AllChildren"] = "AllChildren"


class CascadeScopeChildrenInState(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["ChildrenInState"] = "ChildrenInState"
    states: List[CommitmentStateType] = Field(default_factory=list)


class CascadeCancellation(BaseModel):
    """A parent's cancellation propagates to its children."""
    model_config = ConfigDict(populate_by_name=True)
    trigger: CascadeTrigger
    applies_to: CascadeScope
    child_transition: CommitmentState
    auto_refund: Optional[RefundPolicy] = None


class VolumeTier(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    min: float
    max: Optional[float] = None
    price_per_unit: Money


class TrueUpPolicy(BaseModel):
    """Year-end reconciliation when a buyer crosses into a cheaper tier."""
    model_config = ConfigDict(populate_by_name=True)
    reconcile_at: str
    applies_to_prior_units: bool


class VolumePricing(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    tiers: List[VolumeTier] = Field(default_factory=list)
    true_up: Optional[TrueUpPolicy] = None


class LoyaltyEarnTerm(BaseModel):
    """Point accrual on purchase. `currency` is a CurrencyCode::Custom value (e.g. 'PTS')."""
    model_config = ConfigDict(populate_by_name=True)
    program: str
    earn_rate: float
    points_earned: float
    credited_on: Literal["FulfillmentComplete", "PaymentReceived"]
    currency: str


class GroupPriceTier(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    participants: float
    price: Money


class ThresholdActivation(BaseModel):
    """Group buying / crowdfunding minimum-viable commitments."""
    model_config = ConfigDict(populate_by_name=True)
    minimum_participants: float
    maximum_participants: Optional[float] = None
    activation_deadline: str
    if_threshold_not_met: CommitmentStateType
    if_threshold_met: CommitmentStateType
    price_tiers: Optional[List[GroupPriceTier]] = None


class AwardProtestStateFiled(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Filed"] = "Filed"


class AwardProtestStateUnderReview(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["UnderReview"] = "UnderReview"
    reviewer: str


class AwardProtestStateUpheld(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Upheld"] = "Upheld"
    remedy: Literal["ReEvaluation", "AwardToProtestant", "Cancellation"]


class AwardProtestStateDismissed(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Dismissed"] = "Dismissed"


class AwardProtest(BaseModel):
    """Government procurement challenge (auxiliary record). Challenges whether the correct Tendered Commitment was selected, before the award is final."""
    model_config = ConfigDict(populate_by_name=True)
    id: str
    filed_by: str
    against: str
    auction_process: str
    grounds: List[str] = Field(default_factory=list)
    filed_at: str
    deadline_for_response: str
    reviewing_body: Optional[str] = None
    state: AwardProtestState


class RegistryRecording(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["RegistryRecording"] = "RegistryRecording"
    registry: str
    reference: str
    recorded_at: str
    notary: Optional[str] = None


class MedicalRecord(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["MedicalRecord"] = "MedicalRecord"
    reference: str
    issued_by: str
    patient: str
    service_date: str


class RetirementCertificate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["RetirementCertificate"] = "RetirementCertificate"
    reference: str
    issued_by: str
    quantity: float
    retired_at: str
    project_id: str


class EntitlementConsumption(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    commitment: str
    entitlement: str
    consumed_this_event: float
    total_consumed_this_period: float
    total_allowed_this_period: float
    period_start: str
    period_end: str
    timestamp: str
    overage: bool


class Money(BaseModel):
    """A monetary value. `currency` is required - always."""
    model_config = ConfigDict(populate_by_name=True)
    amount: float
    currency: CurrencyCode


class MoneyComponent(BaseModel):
    """One labelled line of a MoneyBreakdown. Discount components carry a negative amount."""
    model_config = ConfigDict(populate_by_name=True)
    kind: str
    amount: Money


class MoneyBreakdown(BaseModel):
    """A total decomposed into components (subtotal, tax, shipping, discount, ...). The component amounts must sum to `total` within the currency's minor-unit tolerance; discounts are negative; all share one currency."""
    model_config = ConfigDict(populate_by_name=True)
    components: List[MoneyComponent] = Field(default_factory=list)
    total: Money
    @model_validator(mode="after")
    def _validate_breakdown_sum(self) -> "MoneyBreakdown":
        from .money import validate_money_breakdown
        validate_money_breakdown(self)
        return self


class PartyLocale(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    language: str
    currency: CurrencyCode
    jurisdiction: str


class PartyCapacity(BaseModel):
    """What a party is verified to do. The safe default is everything false (Invariant 3)."""
    model_config = ConfigDict(populate_by_name=True)
    can_buy: bool
    can_sell: bool
    can_fulfill: bool
    can_guarantee: bool
    verified_at: str


class Party(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: PartyID
    party_type: PartyType
    locale: PartyLocale
    capacity: PartyCapacity


class ServiceDelivery(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    location: Literal["Physical", "Remote", "Either"]
    performer: Optional[PartyID] = None


class AccessModelLicense(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["License"] = "License"
    license_type: Literal["Perpetual", "Subscription", "Trial", "OpenSource"]
    seats: float
    transferable: bool


class AccessModelStream(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Stream"] = "Stream"
    simultaneous_streams: float


class AccessModelDownload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Download"] = "Download"
    redownloadable: bool


class AccessModelAPIAccess(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["APIAccess"] = "APIAccess"
    calls_per_period: Optional[float] = None
    endpoint: str


class AccessModelNFT(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["NFT"] = "NFT"
    blockchain: str
    contract_address: str
    token_id: str


class AccessModelEventAccess(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["EventAccess"] = "EventAccess"
    event: str
    location: str
    date: str
    entry_window_start: str
    entry_window_end: str
    transferable: bool


class AccessModelDocumentaryCollection(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["DocumentaryCollection"] = "DocumentaryCollection"
    held_by: str
    release_condition: str


class AccessModelCarbonCredit(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["CarbonCredit"] = "CarbonCredit"
    standard: str
    vintage: float
    project_id: str
    project_type: str
    location: str
    quantity: float
    retired: bool
    additionality_verified: bool
    verification_body: Optional[str] = None


class ValueFormPhysicalGood(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["PhysicalGood"] = "PhysicalGood"
    sku: str
    condition: Condition
    location: Optional[str] = None


class ValueFormDigitalGood(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["DigitalGood"] = "DigitalGood"
    identifier: str
    exclusivity: Literal["Exclusive", "NonExclusive"]
    access_model: AccessModel


class ValueFormService(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Service"] = "Service"
    identifier: str
    delivery_model: ServiceDelivery


class ValueFormMoney(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Money"] = "Money"
    money: Money


class ValueFormNothing(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Nothing"] = "Nothing"


class ValueFormContingentValue(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ContingentValue"] = "ContingentValue"
    trigger_type: str
    monitoring_period_start: Optional[str] = None
    monitoring_period_end: Optional[str] = None
    monitoring_party: Optional[PartyID] = None
    if_triggered_description: str
    if_not_triggered_description: str


class Quantity(BaseModel):
    """A unit-bearing quantity (Primitive 2: Value.quantity carries a unit)."""
    model_config = ConfigDict(populate_by_name=True)
    amount: float
    unit: Optional[str] = None


class ValueStateAvailable(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Available"] = "Available"


class ValueStateReserved(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Reserved"] = "Reserved"
    commitment_id: CommitmentID
    basis: ReservationBasis


class ValueStateUnderAuction(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["UnderAuction"] = "UnderAuction"
    auction_process_id: str
    closes_at: str


class ValueStateCommitted(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Committed"] = "Committed"
    commitment_id: CommitmentID


class ValueStateInTransit(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["InTransit"] = "InTransit"
    fulfillment_id: FulfillmentID


class ValueStateTransferred(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Transferred"] = "Transferred"
    to: PartyID
    at: str


class ValueStateReturned(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Returned"] = "Returned"
    from_: PartyID = Field(alias="from")
    initiated_at: str


class ValueStateRetired(BaseModel):
    """v0.3 - terminal state for permanently consumed exclusive goods. No transition out of Retired is valid."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Retired"] = "Retired"
    retired_at: str
    retired_by: PartyID
    reason: str
    certificate: Optional[str] = None


class Value(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: ValueID
    form: ValueForm
    quantity: float
    state: ValueState


class IntentTransition(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    from_: IntentState = Field(alias="from")
    to: IntentState
    at: str
    actor: PartyID
    reason: Optional[str] = None


class Intent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: IntentID
    party: PartyID
    state: IntentState
    history: List[IntentTransition] = Field(default_factory=list)
    created_at: str
    expires_at: Optional[str] = None
    originated_from: Optional[str] = None


class CommitmentParties(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    initiator: PartyID
    counterparty: PartyID
    intermediaries: List[PartyID] = Field(default_factory=list)


class CommitmentSubject(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    offered: List[Value] = Field(default_factory=list)
    requested: List[Value] = Field(default_factory=list)


class CommitmentTransition(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    from_: CommitmentState = Field(alias="from")
    to: CommitmentState
    at: str
    actor: PartyID
    reason: Optional[str] = None


class Commitment(BaseModel):
    """Primitive 4 - the central primitive."""
    model_config = ConfigDict(populate_by_name=True)
    id: CommitmentID
    parties: CommitmentParties
    subject: CommitmentSubject
    state: CommitmentState
    history: List[CommitmentTransition] = Field(default_factory=list)
    parent: Optional[CommitmentID] = None
    children: List[CommitmentID] = Field(default_factory=list)
    originated_from: Optional[IntentID] = None
    created_at: str
    expires_at: Optional[str] = None
    terms: Optional[CommitmentTerms] = None


class FulfillmentTransition(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    from_: FulfillmentState = Field(alias="from")
    to: FulfillmentState
    at: str
    actor: PartyID


class Fulfillment(BaseModel):
    """Primitive 5."""
    model_config = ConfigDict(populate_by_name=True)
    id: FulfillmentID
    commitment: CommitmentID
    state: FulfillmentState
    history: List[FulfillmentTransition] = Field(default_factory=list)
    planned_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    evidence: Optional[List[Evidence]] = None


class ResolutionCandidate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    proposed_by: PartyID
    substitute_description: str
    fulfilling_party: Optional[PartyID] = None
    price_delta: Money
    new_total: Money
    original_window: str
    new_window: str
    state: CandidateState


class ResolutionStateAwaitingCustomerDecision(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["AwaitingCustomerDecision"] = "AwaitingCustomerDecision"


class ResolutionStateResolved(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Resolved"] = "Resolved"
    outcome: Literal["SubstituteAccepted", "ItemCancelled"]
    candidate_id: Optional[str] = None


class ResolutionStateExpired(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Expired"] = "Expired"


class ResolutionProcess(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    parent_commitment: CommitmentID
    unresolved_item: ValueID
    original_value: Money
    candidates: List[ResolutionCandidate] = Field(default_factory=list)
    state: ResolutionState
    deadline: str


class IntentStateActive(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Active"] = "Active"


class IntentStateAbandoned(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Abandoned"] = "Abandoned"


class IntentStateConverted(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Converted"] = "Converted"
    commitment_id: CommitmentID


class IntentStateExpired(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Expired"] = "Expired"


class CommitmentStateDraft(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Draft"] = "Draft"


class CommitmentStateProposed(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Proposed"] = "Proposed"


class CommitmentStateTendered(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Tendered"] = "Tendered"
    offer_amount: float
    offer_currency: str
    closes_at: str
    superseded_by: Optional[CommitmentID] = None


class CommitmentStateAccepted(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Accepted"] = "Accepted"


class CommitmentStateModified(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Modified"] = "Modified"
    modified_by: PartyID
    reason: str


class CommitmentStatePartiallyFulfilled(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["PartiallyFulfilled"] = "PartiallyFulfilled"
    fulfilled_item_ids: List[str] = Field(default_factory=list)
    remaining_item_ids: List[str] = Field(default_factory=list)


class CommitmentStateActive(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Active"] = "Active"


class CommitmentStateFulfilled(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Fulfilled"] = "Fulfilled"


class CommitmentStateCancelled(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Cancelled"] = "Cancelled"
    by: PartyID
    reason: str
    at: str


class CommitmentStateDisputed(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Disputed"] = "Disputed"
    by: PartyID
    reason: str
    opened_at: str


class CommitmentStateRefunded(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Refunded"] = "Refunded"
    amount: Money
    at: str


class FulfillmentStatePlanned(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Planned"] = "Planned"


class FulfillmentStateInProgress(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["InProgress"] = "InProgress"


class FulfillmentStateCompleted(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Completed"] = "Completed"


class FulfillmentStateFailed(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Failed"] = "Failed"
    reason: str
    recoverable: bool


class FulfillmentStateReversed(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Reversed"] = "Reversed"
    reason: str
    initiated_by: PartyID
    at: str


class CommissionFee(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    rate: float
    paid_to: PartyID


class CommissionStructureSingleSided(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["SingleSided"] = "SingleSided"
    rate: float
    paid_by: str
    paid_to: PartyID


class CommissionStructureDoubleSided(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["DoubleSided"] = "DoubleSided"
    buyer_fee: CommissionFee
    seller_fee: CommissionFee


class PostFulfillmentTriggerInsuranceAdjudication(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["InsuranceAdjudication"] = "InsuranceAdjudication"
    adjudicator: PartyID
    claim_reference: Optional[str] = None
    deadline: Optional[str] = None


class PostFulfillmentTriggerInspectionCompletion(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["InspectionCompletion"] = "InspectionCompletion"
    inspector: PartyID
    standard: Optional[str] = None


class PostFulfillmentTriggerAcceptanceTest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["AcceptanceTest"] = "AcceptanceTest"
    tester: PartyID
    criteria: str


class PaymentTimingImmediate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Immediate"] = "Immediate"


class PaymentTimingUpfront(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Upfront"] = "Upfront"


class PaymentTimingOnDelivery(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["OnDelivery"] = "OnDelivery"


class PaymentTimingOnServiceCompletion(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["OnServiceCompletion"] = "OnServiceCompletion"


class PaymentTimingAfterGoodsReceived(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["AfterGoodsReceived"] = "AfterGoodsReceived"


class PaymentTimingInstallments(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Installments"] = "Installments"


class PaymentTimingMilestone(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Milestone"] = "Milestone"


class PaymentTimingRecurring(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Recurring"] = "Recurring"


class PaymentTimingSimultaneous(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Simultaneous"] = "Simultaneous"


class PaymentTimingMetered(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Metered"] = "Metered"


class PaymentTimingPostFulfillment(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["PostFulfillment"] = "PostFulfillment"
    trigger: PostFulfillmentTrigger


class PaymentTimingDocumentsAgainstPayment(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["DocumentsAgainstPayment"] = "DocumentsAgainstPayment"
    documents_held_by: PartyID
    release_condition: str


class PaymentTimingNet(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Net"] = "Net"
    days: Literal[30, 60, 90]
    from_: Literal["InvoiceDate", "DeliveryDate", "EndOfMonth"] = Field(alias="from")
    early_payment_discount: Optional[float] = None


class PaymentTimingCommissionSplit(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["CommissionSplit"] = "CommissionSplit"
    structure: CommissionStructure


class EvidenceProofOfDelivery(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ProofOfDelivery"] = "ProofOfDelivery"
    photo_uri: Optional[str] = None
    signature: Optional[str] = None
    timestamp: str
    recipient: PartyID


class EvidencePaymentReceipt(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["PaymentReceipt"] = "PaymentReceipt"
    reference: str
    amount: Money
    timestamp: str
    mechanism: str


class EvidenceAccessGrant(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["AccessGrant"] = "AccessGrant"
    token: str
    granted_at: str
    expires_at: Optional[str] = None


class EvidenceServiceCompletion(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ServiceCompletion"] = "ServiceCompletion"
    confirmed_by: PartyID
    timestamp: str
    notes: Optional[str] = None


class EvidenceWarehouseReceipt(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["WarehouseReceipt"] = "WarehouseReceipt"
    location: str
    received_at: str


class EvidenceBillOfLading(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["BillOfLading"] = "BillOfLading"
    reference: str
    issued_by: PartyID
    origin_port: str
    destination_port: str
    issued_at: str


class EvidenceCustomsClearance(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["CustomsClearance"] = "CustomsClearance"
    reference: str
    cleared_at: str
    jurisdiction: str


class EvidenceTriggerVerification(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["TriggerVerification"] = "TriggerVerification"
    trigger_type: str
    timestamp: str


class EvidenceRegistryRecording(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RegistryRecording"] = "RegistryRecording"
    registry: str
    reference: str
    recorded_at: str
    notary: Optional[str] = None


class EvidenceMedicalRecord(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["MedicalRecord"] = "MedicalRecord"
    reference: str
    issued_by: str
    patient: str
    service_date: str


class EvidenceRetirementCertificate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RetirementCertificate"] = "RetirementCertificate"
    reference: str
    issued_by: str
    quantity: float
    retired_at: str
    project_id: str


class DeliveryFlexibility(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    min_per_delivery: Quantity
    max_per_delivery: Quantity


class DeliveryMethodPhysicalDelivery(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["PhysicalDelivery"] = "PhysicalDelivery"
    carrier: Optional[PartyID] = None
    tracking: Optional[str] = None


class DeliveryMethodInPersonHandover(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["InPersonHandover"] = "InPersonHandover"
    location: str
    staff_id: Optional[PartyID] = None


class DeliveryMethodInterStoreTransfer(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["InterStoreTransfer"] = "InterStoreTransfer"
    from_: str = Field(alias="from")
    to: str
    customer_pickup: bool


class DeliveryMethodInternalTransfer(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["InternalTransfer"] = "InternalTransfer"
    from_: str = Field(alias="from")
    to: str


class DeliveryMethodServicePerformance(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ServicePerformance"] = "ServicePerformance"
    performer: PartyID
    location: str
    scheduled_at: str
    duration_minutes: Optional[float] = None


class DeliveryMethodDigitalDelivery(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["DigitalDelivery"] = "DigitalDelivery"
    mechanism: str
    delivered_at: Optional[str] = None
    access_token: Optional[str] = None


class DeliveryMethodMoneyTransfer(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["MoneyTransfer"] = "MoneyTransfer"
    mechanism: str
    reference: Optional[str] = None
    cleared_at: Optional[str] = None


class DeliveryMethodContingentDelivery(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ContingentDelivery"] = "ContingentDelivery"
    trigger: str


class DeliveryMethodWhiteGlove(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["WhiteGlove"] = "WhiteGlove"
    carrier: PartyID


class DeliveryMethodReturnDelivery(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ReturnDelivery"] = "ReturnDelivery"
    pickup_address: Optional[str] = None
    dropoff_address: Optional[str] = None


class DeliveryMethodTitleTransfer(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["TitleTransfer"] = "TitleTransfer"
    mechanism: Literal["NotarialDeed", "WarrantyDeed", "LandRegistration"]
    registry: str
    title_number: Optional[str] = None
    notary: Optional[PartyID] = None


class DeliveryMethodRecurringDelivery(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RecurringDelivery"] = "RecurringDelivery"
    schedule: str
    quantity_per_delivery: Quantity
    first_delivery: str
    last_delivery: Optional[str] = None
    flexibility: Optional[DeliveryFlexibility] = None


class DeliveryMethodCustomsRelease(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["CustomsRelease"] = "CustomsRelease"
    customs_reference: str
    cleared_at: str
    duties_paid: Optional[Money] = None
    inspection_required: bool


class DeliveryMethodRegistryRetirement(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RegistryRetirement"] = "RegistryRetirement"
    registry: PartyID
    retirement_reference: str
    retired_on_behalf_of: PartyID
    reason: str


class RoyaltyBeneficiary(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    to: PartyID
    rate: float


class Prescription(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    reference: str
    issuer: PartyID
    issued_at: str
    valid_until: str
    medication: str
    quantity: str
    refills: float


class EventCancellationTerms(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    amount: RefundAmount
    deadline_days: float


class CommitmentConditionQualityInspection(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["QualityInspection"] = "QualityInspection"
    inspector: PartyID
    standard: str
    must_complete_before: CommitmentStateType
    if_fail: CommitmentStateType


class CommitmentConditionAuthenticationVerification(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["AuthenticationVerification"] = "AuthenticationVerification"
    verifier: PartyID
    must_complete_before: CommitmentStateType


class CommitmentConditionDeliverableAcceptance(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["DeliverableAcceptance"] = "DeliverableAcceptance"
    deliverable_id: str
    accepted_by: PartyID
    acceptance_window_days: float
    if_rejected: CommitmentStateType


class CommitmentConditionConditionVerification(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ConditionVerification"] = "ConditionVerification"
    required_condition: str
    inspector: PartyID
    if_not_met: CommitmentStateType


class CommitmentConditionInsuredEventMonitoring(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["InsuredEventMonitoring"] = "InsuredEventMonitoring"
    event_type: str
    monitoring_party: Optional[PartyID] = None


class CommitmentConditionGracePeriod(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["GracePeriod"] = "GracePeriod"
    duration_days: float
    if_not_restored: CommitmentStateType


class CommitmentConditionRoyaltyDistribution(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RoyaltyDistribution"] = "RoyaltyDistribution"
    beneficiaries: List[RoyaltyBeneficiary] = Field(default_factory=list)


class CommitmentConditionStaffDiscount(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["StaffDiscount"] = "StaffDiscount"
    rate: float


class CommitmentConditionNoShowPolicy(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["NoShowPolicy"] = "NoShowPolicy"
    grace_minutes: float
    fee: Money


class CommitmentConditionSimultaneousAccessLimit(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["SimultaneousAccessLimit"] = "SimultaneousAccessLimit"
    max_concurrent: float


class CommitmentConditionFinancingContingency(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["FinancingContingency"] = "FinancingContingency"
    lender: Optional[PartyID] = None
    amount: Money
    rate_cap: Optional[float] = None
    approval_deadline: str
    if_not_met: CommitmentStateType


class CommitmentConditionInspectionContingency(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["InspectionContingency"] = "InspectionContingency"
    inspector: Optional[PartyID] = None
    deadline: str
    if_failed: CommitmentStateType


class CommitmentConditionPrescriptionRequired(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["PrescriptionRequired"] = "PrescriptionRequired"
    prescription: Optional[Prescription] = None
    verified_by: Optional[PartyID] = None
    must_verify_before: CommitmentStateType


class CommitmentConditionRegistryVerification(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RegistryVerification"] = "RegistryVerification"
    registry: PartyID
    must_verify_before: CommitmentStateType
    verifies: List[str] = Field(default_factory=list)


class CommitmentConditionThresholdActivation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ThresholdActivation"] = "ThresholdActivation"
    minimum_participants: float
    maximum_participants: Optional[float] = None
    activation_deadline: str
    if_threshold_not_met: CommitmentStateType
    if_threshold_met: CommitmentStateType


class CommitmentConditionComplianceDocumentation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ComplianceDocumentation"] = "ComplianceDocumentation"
    required_documents: List[str] = Field(default_factory=list)
    submission_deadline: str
    verified_by: PartyID
    if_not_submitted: CommitmentStateType


class CommitmentConditionNoReturnPolicy(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["NoReturnPolicy"] = "NoReturnPolicy"
    basis: str
    jurisdiction: str


class CommitmentConditionEventCancellationPolicy(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["EventCancellationPolicy"] = "EventCancellationPolicy"
    if_cancelled: EventCancellationTerms


class PaymentSplitEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    method: str
    amount: Money
    reference: Optional[str] = None


class CurrencyConversion(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    from_: CurrencyCode = Field(alias="from")
    to: CurrencyCode
    rate: float
    customer_pays: Money


class PaymentTerms(BaseModel):
    """Wraps the PaymentTiming with method / split / conversion."""
    model_config = ConfigDict(populate_by_name=True)
    timing: PaymentTiming
    method: Optional[str] = None
    split: Optional[List[PaymentSplitEntry]] = None
    currency_conversion: Optional[CurrencyConversion] = None


class DeliveryWindow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    earliest: str
    latest: str


class DeliveryTerms(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    method: DeliveryMethod
    address: Optional[str] = None
    window: Optional[DeliveryWindow] = None
    incoterm: Optional[str] = None


class RequiredDocuments(BaseModel):
    """Trade-finance documentary requirements."""
    model_config = ConfigDict(populate_by_name=True)
    bill_of_lading: Optional[bool] = None
    commercial_invoice: Optional[bool] = None
    packing_list: Optional[bool] = None
    certificate_of_origin: Optional[bool] = None
    insurance_certificate: Optional[bool] = None
    customs_declaration: Optional[bool] = None


class CommitmentDurationFixed(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Fixed"] = "Fixed"
    ends_at: str


class CommitmentDurationOpenEnded(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["OpenEnded"] = "OpenEnded"
    minimum_term_days: Optional[float] = None
    cancellation_notice_days: float


class CommitmentTerms(BaseModel):
    """The aggregate. Every field optional so a Commitment may carry as little or as much of its terms as the platform knows."""
    model_config = ConfigDict(populate_by_name=True)
    delivery: Optional[DeliveryTerms] = None
    payment: Optional[PaymentTerms] = None
    conditions: Optional[List[CommitmentCondition]] = None
    cascade: Optional[CascadeCancellation] = None
    volume_pricing: Optional[VolumePricing] = None
    loyalty: Optional[LoyaltyEarnTerm] = None
    required_documents: Optional[RequiredDocuments] = None
    jurisdiction: Optional[str] = None
    duration: Optional[CommitmentDuration] = None



# --- aliases, enums, branded ids, and discriminated unions ---

AuctionMechanism = Annotated[Union[AuctionMechanismEnglish, AuctionMechanismDutch, AuctionMechanismSealedBid, AuctionMechanismVickrey, AuctionMechanismScoredSelection], Field(discriminator="kind")]
AuctionCloseReason = Literal["NormalClose", "ReserveNotMet", "BuyItNowExercised", "SellerCancelled", "AwardProtestUpheld"]
AuctionState = Annotated[Union[AuctionStateScheduled, AuctionStateOpen, AuctionStateClosed], Field(discriminator="type")]
RefundAmount = Union[Literal["FullRefund"], PartialRefund]
CascadeTrigger = Annotated[Union[CascadeTriggerParentCancelled, CascadeTriggerParentDisputed, CascadeTriggerExternalEvent], Field(discriminator="type")]
CascadeScope = Annotated[Union[CascadeScopeAllChildren, CascadeScopeChildrenInState], Field(discriminator="type")]
AwardProtestState = Annotated[Union[AwardProtestStateFiled, AwardProtestStateUnderReview, AwardProtestStateUpheld, AwardProtestStateDismissed], Field(discriminator="type")]
EvidenceV03 = Annotated[Union[RegistryRecording, MedicalRecord, RetirementCertificate], Field(discriminator="type")]
CurrencyCode = str # ISO 4217 currency code (open set; also admits CurrencyCode::Custom loyalty/credit denominations like 'PTS').
PartyID = str # Globally unique, immutable party identifier (Invariant 5).
IntentID = str
CommitmentID = str
FulfillmentID = str
ValueID = str
PartyType = Literal["Individual", "Organization", "System"]
PartyRole = Literal["Initiator", "Counterparty", "Intermediary", "Fulfiller", "Guarantor"]
Condition = Literal["New", "Used", "Refurbished", "Damaged", "RequiresInspection"]
AccessModel = Annotated[Union[AccessModelLicense, AccessModelStream, AccessModelDownload, AccessModelAPIAccess, AccessModelNFT, AccessModelEventAccess, AccessModelDocumentaryCollection, AccessModelCarbonCredit], Field(discriminator="kind")]
ValueForm = Annotated[Union[ValueFormPhysicalGood, ValueFormDigitalGood, ValueFormService, ValueFormMoney, ValueFormNothing, ValueFormContingentValue], Field(discriminator="kind")]
ReservationBasis = Literal["PhysicalStock", "ProductionCapacity", "TimeSlot", "RecurringTimeSlot", "DriverCapacity", "Speculative"]
ValueState = Annotated[Union[ValueStateAvailable, ValueStateReserved, ValueStateUnderAuction, ValueStateCommitted, ValueStateInTransit, ValueStateTransferred, ValueStateReturned, ValueStateRetired], Field(discriminator="type")]
CandidateState = Literal["Pending", "Accepted", "Rejected"]
ResolutionState = Annotated[Union[ResolutionStateAwaitingCustomerDecision, ResolutionStateResolved, ResolutionStateExpired], Field(discriminator="type")]
IntentState = Annotated[Union[IntentStateActive, IntentStateAbandoned, IntentStateConverted, IntentStateExpired], Field(discriminator="type")]
CommitmentState = Annotated[Union[CommitmentStateDraft, CommitmentStateProposed, CommitmentStateTendered, CommitmentStateAccepted, CommitmentStateModified, CommitmentStatePartiallyFulfilled, CommitmentStateActive, CommitmentStateFulfilled, CommitmentStateCancelled, CommitmentStateDisputed, CommitmentStateRefunded], Field(discriminator="type")]
FulfillmentState = Annotated[Union[FulfillmentStatePlanned, FulfillmentStateInProgress, FulfillmentStateCompleted, FulfillmentStateFailed, FulfillmentStateReversed], Field(discriminator="type")]
CommissionStructure = Annotated[Union[CommissionStructureSingleSided, CommissionStructureDoubleSided], Field(discriminator="type")]
PostFulfillmentTrigger = Annotated[Union[PostFulfillmentTriggerInsuranceAdjudication, PostFulfillmentTriggerInspectionCompletion, PostFulfillmentTriggerAcceptanceTest], Field(discriminator="type")]
PaymentTiming = Annotated[Union[PaymentTimingImmediate, PaymentTimingUpfront, PaymentTimingOnDelivery, PaymentTimingOnServiceCompletion, PaymentTimingAfterGoodsReceived, PaymentTimingInstallments, PaymentTimingMilestone, PaymentTimingRecurring, PaymentTimingSimultaneous, PaymentTimingMetered, PaymentTimingPostFulfillment, PaymentTimingDocumentsAgainstPayment, PaymentTimingNet, PaymentTimingCommissionSplit], Field(discriminator="type")]
Evidence = Annotated[Union[EvidenceProofOfDelivery, EvidencePaymentReceipt, EvidenceAccessGrant, EvidenceServiceCompletion, EvidenceWarehouseReceipt, EvidenceBillOfLading, EvidenceCustomsClearance, EvidenceTriggerVerification, EvidenceRegistryRecording, EvidenceMedicalRecord, EvidenceRetirementCertificate], Field(discriminator="kind")]
CommitmentStateType = Literal["Draft", "Proposed", "Tendered", "Accepted", "Modified", "PartiallyFulfilled", "Active", "Fulfilled", "Cancelled", "Disputed", "Refunded"]
DeliveryMethod = Annotated[Union[DeliveryMethodPhysicalDelivery, DeliveryMethodInPersonHandover, DeliveryMethodInterStoreTransfer, DeliveryMethodInternalTransfer, DeliveryMethodServicePerformance, DeliveryMethodDigitalDelivery, DeliveryMethodMoneyTransfer, DeliveryMethodContingentDelivery, DeliveryMethodWhiteGlove, DeliveryMethodReturnDelivery, DeliveryMethodTitleTransfer, DeliveryMethodRecurringDelivery, DeliveryMethodCustomsRelease, DeliveryMethodRegistryRetirement], Field(discriminator="kind")]
CommitmentCondition = Annotated[Union[CommitmentConditionQualityInspection, CommitmentConditionAuthenticationVerification, CommitmentConditionDeliverableAcceptance, CommitmentConditionConditionVerification, CommitmentConditionInsuredEventMonitoring, CommitmentConditionGracePeriod, CommitmentConditionRoyaltyDistribution, CommitmentConditionStaffDiscount, CommitmentConditionNoShowPolicy, CommitmentConditionSimultaneousAccessLimit, CommitmentConditionFinancingContingency, CommitmentConditionInspectionContingency, CommitmentConditionPrescriptionRequired, CommitmentConditionRegistryVerification, CommitmentConditionThresholdActivation, CommitmentConditionComplianceDocumentation, CommitmentConditionNoReturnPolicy, CommitmentConditionEventCancellationPolicy], Field(discriminator="kind")]
CommitmentDuration = Annotated[Union[CommitmentDurationFixed, CommitmentDurationOpenEnded], Field(discriminator="kind")]


# --- resolve forward references ---
for _model in (ScoredCriterion, AuctionMechanismEnglish, AuctionMechanismDutch, AuctionMechanismSealedBid, AuctionMechanismVickrey, AuctionMechanismScoredSelection, AuctionStateScheduled, AuctionStateOpen, AuctionStateClosed, AuctionProcess, PartialRefund, RefundPolicy, CascadeTriggerParentCancelled, CascadeTriggerParentDisputed, CascadeTriggerExternalEvent, CascadeScopeAllChildren, CascadeScopeChildrenInState, CascadeCancellation, VolumeTier, TrueUpPolicy, VolumePricing, LoyaltyEarnTerm, GroupPriceTier, ThresholdActivation, AwardProtestStateFiled, AwardProtestStateUnderReview, AwardProtestStateUpheld, AwardProtestStateDismissed, AwardProtest, RegistryRecording, MedicalRecord, RetirementCertificate, EntitlementConsumption, Money, MoneyComponent, MoneyBreakdown, PartyLocale, PartyCapacity, Party, ServiceDelivery, AccessModelLicense, AccessModelStream, AccessModelDownload, AccessModelAPIAccess, AccessModelNFT, AccessModelEventAccess, AccessModelDocumentaryCollection, AccessModelCarbonCredit, ValueFormPhysicalGood, ValueFormDigitalGood, ValueFormService, ValueFormMoney, ValueFormNothing, ValueFormContingentValue, Quantity, ValueStateAvailable, ValueStateReserved, ValueStateUnderAuction, ValueStateCommitted, ValueStateInTransit, ValueStateTransferred, ValueStateReturned, ValueStateRetired, Value, IntentTransition, Intent, CommitmentParties, CommitmentSubject, CommitmentTransition, Commitment, FulfillmentTransition, Fulfillment, ResolutionCandidate, ResolutionStateAwaitingCustomerDecision, ResolutionStateResolved, ResolutionStateExpired, ResolutionProcess, IntentStateActive, IntentStateAbandoned, IntentStateConverted, IntentStateExpired, CommitmentStateDraft, CommitmentStateProposed, CommitmentStateTendered, CommitmentStateAccepted, CommitmentStateModified, CommitmentStatePartiallyFulfilled, CommitmentStateActive, CommitmentStateFulfilled, CommitmentStateCancelled, CommitmentStateDisputed, CommitmentStateRefunded, FulfillmentStatePlanned, FulfillmentStateInProgress, FulfillmentStateCompleted, FulfillmentStateFailed, FulfillmentStateReversed, CommissionFee, CommissionStructureSingleSided, CommissionStructureDoubleSided, PostFulfillmentTriggerInsuranceAdjudication, PostFulfillmentTriggerInspectionCompletion, PostFulfillmentTriggerAcceptanceTest, PaymentTimingImmediate, PaymentTimingUpfront, PaymentTimingOnDelivery, PaymentTimingOnServiceCompletion, PaymentTimingAfterGoodsReceived, PaymentTimingInstallments, PaymentTimingMilestone, PaymentTimingRecurring, PaymentTimingSimultaneous, PaymentTimingMetered, PaymentTimingPostFulfillment, PaymentTimingDocumentsAgainstPayment, PaymentTimingNet, PaymentTimingCommissionSplit, EvidenceProofOfDelivery, EvidencePaymentReceipt, EvidenceAccessGrant, EvidenceServiceCompletion, EvidenceWarehouseReceipt, EvidenceBillOfLading, EvidenceCustomsClearance, EvidenceTriggerVerification, EvidenceRegistryRecording, EvidenceMedicalRecord, EvidenceRetirementCertificate, DeliveryFlexibility, DeliveryMethodPhysicalDelivery, DeliveryMethodInPersonHandover, DeliveryMethodInterStoreTransfer, DeliveryMethodInternalTransfer, DeliveryMethodServicePerformance, DeliveryMethodDigitalDelivery, DeliveryMethodMoneyTransfer, DeliveryMethodContingentDelivery, DeliveryMethodWhiteGlove, DeliveryMethodReturnDelivery, DeliveryMethodTitleTransfer, DeliveryMethodRecurringDelivery, DeliveryMethodCustomsRelease, DeliveryMethodRegistryRetirement, RoyaltyBeneficiary, Prescription, EventCancellationTerms, CommitmentConditionQualityInspection, CommitmentConditionAuthenticationVerification, CommitmentConditionDeliverableAcceptance, CommitmentConditionConditionVerification, CommitmentConditionInsuredEventMonitoring, CommitmentConditionGracePeriod, CommitmentConditionRoyaltyDistribution, CommitmentConditionStaffDiscount, CommitmentConditionNoShowPolicy, CommitmentConditionSimultaneousAccessLimit, CommitmentConditionFinancingContingency, CommitmentConditionInspectionContingency, CommitmentConditionPrescriptionRequired, CommitmentConditionRegistryVerification, CommitmentConditionThresholdActivation, CommitmentConditionComplianceDocumentation, CommitmentConditionNoReturnPolicy, CommitmentConditionEventCancellationPolicy, PaymentSplitEntry, CurrencyConversion, PaymentTerms, DeliveryWindow, DeliveryTerms, RequiredDocuments, CommitmentDurationFixed, CommitmentDurationOpenEnded, CommitmentTerms,):
    _model.model_rebuild()

__all__ = [
    "ScoredCriterion",
    "AuctionMechanism",
    "AuctionCloseReason",
    "AuctionState",
    "AuctionProcess",
    "PartialRefund",
    "RefundAmount",
    "RefundPolicy",
    "CascadeTrigger",
    "CascadeScope",
    "CascadeCancellation",
    "VolumeTier",
    "TrueUpPolicy",
    "VolumePricing",
    "LoyaltyEarnTerm",
    "GroupPriceTier",
    "ThresholdActivation",
    "AwardProtestState",
    "AwardProtest",
    "RegistryRecording",
    "MedicalRecord",
    "RetirementCertificate",
    "EvidenceV03",
    "EntitlementConsumption",
    "CurrencyCode",
    "Money",
    "MoneyComponent",
    "MoneyBreakdown",
    "PartyID",
    "IntentID",
    "CommitmentID",
    "FulfillmentID",
    "ValueID",
    "PartyType",
    "PartyRole",
    "PartyLocale",
    "PartyCapacity",
    "Party",
    "Condition",
    "ServiceDelivery",
    "AccessModel",
    "ValueForm",
    "Quantity",
    "ReservationBasis",
    "ValueState",
    "Value",
    "IntentTransition",
    "Intent",
    "CommitmentParties",
    "CommitmentSubject",
    "CommitmentTransition",
    "Commitment",
    "FulfillmentTransition",
    "Fulfillment",
    "CandidateState",
    "ResolutionCandidate",
    "ResolutionState",
    "ResolutionProcess",
    "IntentState",
    "CommitmentState",
    "FulfillmentState",
    "CommissionFee",
    "CommissionStructure",
    "PostFulfillmentTrigger",
    "PaymentTiming",
    "Evidence",
    "CommitmentStateType",
    "DeliveryFlexibility",
    "DeliveryMethod",
    "RoyaltyBeneficiary",
    "Prescription",
    "EventCancellationTerms",
    "CommitmentCondition",
    "PaymentSplitEntry",
    "CurrencyConversion",
    "PaymentTerms",
    "DeliveryWindow",
    "DeliveryTerms",
    "RequiredDocuments",
    "CommitmentDuration",
    "CommitmentTerms",
    "SCHEMA_VERSION",
]
