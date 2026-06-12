"""GENERATED FILE — do not edit by hand.

Pydantic v2 models for the Warp Commerce Model, generated from the CANONICAL
schema spine (schema/structure/*.schema.json, JSON Schema Draft 2020-12) v1.0.0
by scripts/generate_from_schema.py. Edit the schema and regenerate; never edit
this file directly.
"""
from __future__ import annotations

from typing import Annotated, Any, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "1.0.0"


# --- structural models (objects + tagged-union members) ---

class Money(BaseModel):
    """A monetary value. `currency` is required, always — Decimal alone is not valid Money. This makes accidental currency mixing impossible to express."""
    model_config = ConfigDict(populate_by_name=True)
    amount: float
    currency: CurrencyCode


class MoneyComponent(BaseModel):
    """One typed component of a monetary total. A Discount component carries a negative amount (it reduces the total). Tax components may carry a tax_rate and jurisdiction."""
    model_config = ConfigDict(populate_by_name=True)
    kind: MoneyComponentKind
    amount: Money
    label: Optional[str] = None
    tax_rate: Optional[float] = None
    jurisdiction: Optional[str] = None


class MoneyBreakdown(BaseModel):
    """A structured decomposition of a monetary total into typed components (Base / Tax / Discount / Shipping / Surcharge / Tip / Adjustment). CORE from v1. INVARIANT (see behavior/invariants.json, I-1 / rule money_breakdown_sum): the components MUST sum to `total` in the SAME currency (Discounts subtract). All component currencies and the total currency must be identical. This is the structural sum rule that extends Invariant 1 (Value Conservation). Money used anywhere a total may decompose MAY be expressed as plain Money OR as MoneyBreakdown; breakdown is optional so existing plain-Money usage stays valid."""
    model_config = ConfigDict(populate_by_name=True)
    total: Money
    components: List[MoneyComponent] = Field(default_factory=list)
    @model_validator(mode="after")
    def _validate_breakdown_sum(self) -> "MoneyBreakdown":
        from .money import validate_money_breakdown
        validate_money_breakdown(self)
        return self


class PartyLocale(BaseModel):
    """Locale of a Party: language (BCP 47), currency (ISO 4217), jurisdiction (ISO 3166-1 alpha-2)."""
    model_config = ConfigDict(populate_by_name=True)
    language: str
    currency: CurrencyCode
    jurisdiction: str


class PartyCapacity(BaseModel):
    """What a Party is verified able to do (Invariant 3: Capacity Verification). The safe default is everything false until verified."""
    model_config = ConfigDict(populate_by_name=True)
    can_buy: bool
    can_sell: bool
    can_fulfill: bool
    can_guarantee: bool
    verified_at: str


class Party(BaseModel):
    """Primitive 1 — Party."""
    model_config = ConfigDict(populate_by_name=True)
    id: PartyID
    party_type: PartyType
    locale: PartyLocale
    capacity: PartyCapacity


class Quantity(BaseModel):
    """A unit-bearing quantity (model Primitive 2: Value.quantity may carry a unit such as "hours", "kg"). Value.quantity itself stays a bare number for backward compatibility; Quantity is used where the model needs the unit (e.g. wholesale RecurringDelivery)."""
    model_config = ConfigDict(populate_by_name=True)
    amount: float
    unit: Optional[str] = None


class PhysicalGood(BaseModel):
    """ValueForm::PhysicalGood. Discriminated on `kind`."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["PhysicalGood"] = "PhysicalGood"
    sku: str
    condition: Condition
    location: Optional[str] = None


class AccessModelLicense(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["License"] = "License"
    license_type: Literal["Perpetual", "Subscription", "Trial", "OpenSource"]
    seats: int
    transferable: bool


class AccessModelStream(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Stream"] = "Stream"
    simultaneous_streams: int


class AccessModelDownload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Download"] = "Download"
    redownloadable: bool


class AccessModelAPIAccess(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["APIAccess"] = "APIAccess"
    calls_per_period: Optional[int] = None
    endpoint: str


class AccessModelNFT(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["NFT"] = "NFT"
    blockchain: str
    contract_address: str
    token_id: str


class AccessModelEventAccess(BaseModel):
    """v0.3 — perishable event ticket; value expires when the event ends."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["EventAccess"] = "EventAccess"
    event: str
    location: str
    date: str
    entry_window_start: str
    entry_window_end: str
    transferable: bool


class AccessModelDocumentaryCollection(BaseModel):
    """v0.3 — trade finance title documents held by a bank, released on payment. Documents are Exclusive DigitalGoods."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["DocumentaryCollection"] = "DocumentaryCollection"
    held_by: str
    release_condition: str


class AccessModelCarbonCredit(BaseModel):
    """v0.3 — verified environmental instrument; retirable (ValueState::Retired when consumed)."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["CarbonCredit"] = "CarbonCredit"
    standard: str
    vintage: int
    project_id: str
    project_type: str
    location: str
    quantity: float
    retired: bool
    additionality_verified: bool
    verification_body: Optional[str] = None


class DigitalGood(BaseModel):
    """ValueForm::DigitalGood."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["DigitalGood"] = "DigitalGood"
    identifier: str
    exclusivity: Literal["Exclusive", "NonExclusive"]
    access_model: AccessModel


class ServiceDelivery(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    location: Literal["Physical", "Remote", "Either"]
    performer: Optional[PartyID] = None


class ServiceValue(BaseModel):
    """ValueForm::Service."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Service"] = "Service"
    identifier: str
    delivery_model: ServiceDelivery


class MoneyValue(BaseModel):
    """ValueForm::Money — value that is itself a monetary amount. `breakdown` is OPTIONAL: when present it MUST decompose `money` (same currency; components sum to money) per Invariant 1 / the money_breakdown_sum rule. Omitting it keeps existing plain-Money usage valid. This is the site the spec calls out for 'Money MAY be expressed as plain Money OR as MoneyBreakdown' (e.g. a CommitmentSubject requested value)."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Money"] = "Money"
    money: Money
    breakdown: Optional[MoneyBreakdown] = None


class NothingValue(BaseModel):
    """ValueForm::Nothing — explicit zero value (e.g. ContingentValue when the trigger does not fire)."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["Nothing"] = "Nothing"


class ContingentValue(BaseModel):
    """ValueForm::ContingentValue — value that depends on a trigger firing (insurance, prediction markets, options). The model's if_triggered / if_not_triggered are themselves Values; the package carries lightweight descriptions to avoid a recursive type explosion."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ContingentValue"] = "ContingentValue"
    trigger_type: str
    monitoring_period_start: Optional[str] = None
    monitoring_period_end: Optional[str] = None
    monitoring_party: Optional[PartyID] = None
    if_triggered_description: str
    if_not_triggered_description: str


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
    """v0.3 — terminal. Carbon credits after offset use, redeemed gift certificates, used coupons."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Retired"] = "Retired"
    retired_at: str
    retired_by: PartyID
    reason: str
    certificate: Optional[str] = None


class Value(BaseModel):
    """Primitive 2 — a value instance."""
    model_config = ConfigDict(populate_by_name=True)
    id: ValueID
    form: ValueForm
    quantity: float
    state: ValueState


class IntentStateActive(BaseModel):
    """Party is engaged, intent is open."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Active"] = "Active"


class IntentStateAbandoned(BaseModel):
    """Party stopped without committing (a cart abandonment is Active -> Abandoned)."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Abandoned"] = "Abandoned"


class IntentStateConverted(BaseModel):
    """The Intent became a Commitment."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Converted"] = "Converted"
    commitment_id: CommitmentID


class IntentStateExpired(BaseModel):
    """Time limit reached without conversion."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Expired"] = "Expired"


class IntentTransition(BaseModel):
    """An append-only, immutable record of one Intent state transition (Invariant 4)."""
    model_config = ConfigDict(populate_by_name=True)
    from_: IntentState = Field(alias="from")
    to: IntentState
    at: str
    actor: PartyID
    reason: Optional[str] = None


class Intent(BaseModel):
    """Primitive 3 — Intent."""
    model_config = ConfigDict(populate_by_name=True)
    id: IntentID
    party: PartyID
    state: IntentState
    history: List[IntentTransition] = Field(default_factory=list)
    created_at: str
    expires_at: Optional[str] = None
    originated_from: Optional[str] = None


class CommitmentStateDraft(BaseModel):
    """Being assembled, not yet binding."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Draft"] = "Draft"


class CommitmentStateProposed(BaseModel):
    """Presented to counterparty; binding on initiator, not yet on counterparty."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Proposed"] = "Proposed"


class CommitmentStateTendered(BaseModel):
    """Open offer to any qualifying counterparty (auction bid). offer_amount/offer_currency are the offered price; superseded_by is set when outbid."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Tendered"] = "Tendered"
    offer_amount: float
    offer_currency: str
    closes_at: str
    superseded_by: Optional[CommitmentID] = None


class CommitmentStateAccepted(BaseModel):
    """Binding on all parties; all terms agreed, capacity verified (Invariant 3)."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Accepted"] = "Accepted"


class CommitmentStateModified(BaseModel):
    """Terms changed after Accepted; returns to Accepted when all affected parties agree."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Modified"] = "Modified"
    modified_by: PartyID
    reason: str


class CommitmentStatePartiallyFulfilled(BaseModel):
    """Some value transferred, not all."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["PartiallyFulfilled"] = "PartiallyFulfilled"
    fulfilled_item_ids: List[str] = Field(default_factory=list)
    remaining_item_ids: List[str] = Field(default_factory=list)


class CommitmentStateActive(BaseModel):
    """For subscriptions and ongoing services; perpetually in progress, never reaches Fulfilled while active."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Active"] = "Active"


class CommitmentStateFulfilled(BaseModel):
    """All obligations met by all parties."""
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


class CommitmentTransition(BaseModel):
    """An append-only, immutable record of one Commitment state transition (Invariant 4)."""
    model_config = ConfigDict(populate_by_name=True)
    from_: CommitmentState = Field(alias="from")
    to: CommitmentState
    at: str
    actor: PartyID
    reason: Optional[str] = None


class CommitmentParties(BaseModel):
    """The parties to a Commitment. Role is contextual."""
    model_config = ConfigDict(populate_by_name=True)
    initiator: PartyID
    counterparty: PartyID
    intermediaries: List[PartyID] = Field(default_factory=list)


class CommitmentSubject(BaseModel):
    """What is exchanged: `offered` is what the counterparty provides, `requested` is what the initiator provides in return (usually Money, sometimes goods for trade/barter). A requested Money Value MAY carry an optional MoneyBreakdown on its MoneyValue form (see value.schema.json MoneyValue.breakdown)."""
    model_config = ConfigDict(populate_by_name=True)
    offered: List[Value] = Field(default_factory=list)
    requested: List[Value] = Field(default_factory=list)


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
    """v0.3 — payment after fulfillment AND after a post-fulfillment trigger resolves."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["PostFulfillment"] = "PostFulfillment"
    trigger: PostFulfillmentTrigger


class PaymentTimingDocumentsAgainstPayment(BaseModel):
    """v0.3 — trade finance: importer pays the bank to receive title documents."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["DocumentsAgainstPayment"] = "DocumentsAgainstPayment"
    documents_held_by: PartyID
    release_condition: str


class PaymentTimingNet(BaseModel):
    """v0.3 — B2B credit terms: Net30 / Net60 / Net90."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Net"] = "Net"
    days: Literal[30, 60, 90]
    from_: Literal["InvoiceDate", "DeliveryDate", "EndOfMonth"] = Field(alias="from")
    early_payment_discount: Optional[float] = None


class PaymentTimingCommissionSplit(BaseModel):
    """v0.3 — marketplace platforms, single- or double-sided commission."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["CommissionSplit"] = "CommissionSplit"
    structure: CommissionStructure


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
    """v0.3 — real estate, legal ownership transfer."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["TitleTransfer"] = "TitleTransfer"
    mechanism: Literal["NotarialDeed", "WarrantyDeed", "LandRegistration"]
    registry: str
    title_number: Optional[str] = None
    notary: Optional[PartyID] = None


class DeliveryMethodRecurringDeliveryFlexibility(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    min_per_delivery: Quantity
    max_per_delivery: Quantity


class DeliveryMethodRecurringDelivery(BaseModel):
    """v0.3 — wholesale blanket POs, scheduled shipments."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RecurringDelivery"] = "RecurringDelivery"
    schedule: str
    quantity_per_delivery: Quantity
    first_delivery: str
    last_delivery: Optional[str] = None
    flexibility: Optional[DeliveryMethodRecurringDeliveryFlexibility] = None


class DeliveryMethodCustomsRelease(BaseModel):
    """v0.3 — cross-border, government-controlled release."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["CustomsRelease"] = "CustomsRelease"
    customs_reference: str
    cleared_at: str
    duties_paid: Optional[Money] = None
    inspection_required: bool


class DeliveryMethodRegistryRetirement(BaseModel):
    """v0.3 — carbon credits, permanent consumption recording."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RegistryRetirement"] = "RegistryRetirement"
    registry: PartyID
    retirement_reference: str
    retired_on_behalf_of: PartyID
    reason: str


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


class CommitmentConditionRoyaltyDistributionBeneficiariesItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    to: PartyID
    rate: float


class CommitmentConditionRoyaltyDistribution(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RoyaltyDistribution"] = "RoyaltyDistribution"
    beneficiaries: List[CommitmentConditionRoyaltyDistributionBeneficiariesItem] = Field(default_factory=list)


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
    """v0.3 — real estate, conditional on lender approval."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["FinancingContingency"] = "FinancingContingency"
    lender: Optional[PartyID] = None
    amount: Money
    rate_cap: Optional[float] = None
    approval_deadline: str
    if_not_met: CommitmentStateType


class CommitmentConditionInspectionContingency(BaseModel):
    """v0.3 — real estate, property condition gate."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["InspectionContingency"] = "InspectionContingency"
    inspector: Optional[PartyID] = None
    deadline: str
    if_failed: CommitmentStateType


class CommitmentConditionPrescriptionRequiredPrescription(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    reference: str
    issuer: PartyID
    issued_at: str
    valid_until: str
    medication: str
    quantity: str
    refills: float


class CommitmentConditionPrescriptionRequired(BaseModel):
    """v0.3 — healthcare, regulatory requirement."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["PrescriptionRequired"] = "PrescriptionRequired"
    prescription: Optional[CommitmentConditionPrescriptionRequiredPrescription] = None
    verified_by: Optional[PartyID] = None
    must_verify_before: CommitmentStateType


class CommitmentConditionRegistryVerification(BaseModel):
    """v0.3 — carbon credits, title deeds."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RegistryVerification"] = "RegistryVerification"
    registry: PartyID
    must_verify_before: CommitmentStateType
    verifies: List[str] = Field(default_factory=list)


class CommitmentConditionThresholdActivation(BaseModel):
    """v0.3 — group buying, crowdfunding."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ThresholdActivation"] = "ThresholdActivation"
    minimum_participants: float
    maximum_participants: Optional[float] = None
    activation_deadline: str
    if_threshold_not_met: CommitmentStateType
    if_threshold_met: CommitmentStateType


class CommitmentConditionComplianceDocumentation(BaseModel):
    """v0.3 — government procurement."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ComplianceDocumentation"] = "ComplianceDocumentation"
    required_documents: List[str] = Field(default_factory=list)
    submission_deadline: str
    verified_by: PartyID
    if_not_submitted: CommitmentStateType


class CommitmentConditionNoReturnPolicy(BaseModel):
    """v0.3 — healthcare, irreversible services."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["NoReturnPolicy"] = "NoReturnPolicy"
    basis: str
    jurisdiction: str


class CommitmentConditionEventCancellationPolicyIfCancelledAmountPartialRefund(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["PartialRefund"] = "PartialRefund"
    rate: float


class CommitmentConditionEventCancellationPolicyIfCancelled(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    amount: Union[Literal["FullRefund"], CommitmentConditionEventCancellationPolicyIfCancelledAmountPartialRefund]
    deadline_days: float


class CommitmentConditionEventCancellationPolicy(BaseModel):
    """v0.3 — event commerce, force majeure."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["EventCancellationPolicy"] = "EventCancellationPolicy"
    if_cancelled: CommitmentConditionEventCancellationPolicyIfCancelled


class PaymentTermsSplitItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    method: str
    amount: Money
    reference: Optional[str] = None


class PaymentTermsCurrencyConversion(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    from_: CurrencyCode = Field(alias="from")
    to: CurrencyCode
    rate: float
    customer_pays: Money


class PaymentTerms(BaseModel):
    """Wraps the PaymentTiming with method / split / currency conversion."""
    model_config = ConfigDict(populate_by_name=True)
    timing: PaymentTiming
    method: Optional[str] = None
    split: List[PaymentTermsSplitItem] = Field(default_factory=list)
    currency_conversion: Optional[PaymentTermsCurrencyConversion] = None


class DeliveryTermsWindow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    earliest: str
    latest: str


class DeliveryTerms(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    method: DeliveryMethod
    address: Optional[str] = None
    window: Optional[DeliveryTermsWindow] = None
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
    """The terms aggregate the model attaches to a Commitment: delivery, payment, conditions, and the v0.3 term structures. Every field optional so a Commitment may carry as little or as much of its terms as the platform knows. cascade / volume_pricing / loyalty reference auxiliary.schema.json."""
    model_config = ConfigDict(populate_by_name=True)
    delivery: Optional[DeliveryTerms] = None
    payment: Optional[PaymentTerms] = None
    conditions: List[CommitmentCondition] = Field(default_factory=list)
    cascade: Optional[CascadeCancellation] = None
    volume_pricing: Optional[VolumePricing] = None
    loyalty: Optional[LoyaltyEarnTerm] = None
    required_documents: Optional[RequiredDocuments] = None
    jurisdiction: Optional[str] = None
    duration: Optional[CommitmentDuration] = None


class Commitment(BaseModel):
    """Primitive 4 — Commitment."""
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


class FulfillmentStatePlanned(BaseModel):
    """Scheduled, not yet started."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Planned"] = "Planned"


class FulfillmentStateInProgress(BaseModel):
    """Movement or service delivery has begun."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["InProgress"] = "InProgress"


class FulfillmentStateCompleted(BaseModel):
    """Value received by destination, evidence recorded."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Completed"] = "Completed"


class FulfillmentStateFailed(BaseModel):
    """Fulfillment failed. `recoverable` distinguishes a retryable failure (Failed -> Planned valid) from a terminal one."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Failed"] = "Failed"
    reason: str
    recoverable: bool


class FulfillmentStateReversed(BaseModel):
    """Return or refund — value moving back."""
    model_config = ConfigDict(populate_by_name=True)
    type: Literal["Reversed"] = "Reversed"
    reason: str
    initiated_by: PartyID
    at: str


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
    """v0.3 — real estate title registration."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RegistryRecording"] = "RegistryRecording"
    registry: str
    reference: str
    recorded_at: str
    notary: Optional[str] = None


class EvidenceMedicalRecord(BaseModel):
    """v0.3 — healthcare service evidence."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["MedicalRecord"] = "MedicalRecord"
    reference: str
    issued_by: str
    patient: str
    service_date: str


class EvidenceRetirementCertificate(BaseModel):
    """v0.3 — carbon credit retirement proof."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["RetirementCertificate"] = "RetirementCertificate"
    reference: str
    issued_by: str
    quantity: float
    retired_at: str
    project_id: str


class FulfillmentTransition(BaseModel):
    """An append-only, immutable record of one Fulfillment state transition (Invariant 4)."""
    model_config = ConfigDict(populate_by_name=True)
    from_: FulfillmentState = Field(alias="from")
    to: FulfillmentState
    at: str
    actor: PartyID


class Fulfillment(BaseModel):
    """Primitive 5 — Fulfillment."""
    model_config = ConfigDict(populate_by_name=True)
    id: FulfillmentID
    commitment: CommitmentID
    state: FulfillmentState
    history: List[FulfillmentTransition] = Field(default_factory=list)
    planned_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    evidence: List[Evidence] = Field(default_factory=list)


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


class AuctionMechanismScoredSelectionCriteriaItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    name: str
    weight: float
    max_points: float


class AuctionMechanismScoredSelection(BaseModel):
    """v0.3 — government procurement: winner by weighted multi-criteria score, not just price."""
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["ScoredSelection"] = "ScoredSelection"
    criteria: List[AuctionMechanismScoredSelectionCriteriaItem] = Field(default_factory=list)
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
    """Auxiliary coordination record for market-making commerce. Manages the collection of Tendered Commitments and determines the winner when the auction closes. Not a sixth primitive."""
    model_config = ConfigDict(populate_by_name=True)
    id: str
    subject: ValueID
    seller: PartyID
    mechanism: AuctionMechanism
    tendered_commitments: List[CommitmentID] = Field(default_factory=list)
    opens_at: str
    closes_at: str
    state: AuctionState


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
    """Government procurement challenge. Not a Commitment Dispute: it challenges whether the correct Tendered Commitment was selected. References an AuctionProcess by id."""
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


class ResolutionCandidate(BaseModel):
    """A proposed substitute for an unresolved item, with its price delta and delivery-window impact."""
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
    """The substitution / cancellation workflow that opens for each unresolved item when a Commitment reaches PartiallyFulfilled."""
    model_config = ConfigDict(populate_by_name=True)
    id: str
    parent_commitment: CommitmentID
    unresolved_item: ValueID
    original_value: Money
    candidates: List[ResolutionCandidate] = Field(default_factory=list)
    state: ResolutionState
    deadline: str


class EntitlementConsumption(BaseModel):
    """A lightweight per-access measurement record for metered digital services (Primitive 5). A Fulfillment per API call would be architecturally wrong; this links a measured consumption event to its parent Commitment. When total_consumed exceeds the allowance, an overage child Commitment is created at the metered rate."""
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


class RefundPolicyAmountPartialRefund(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    kind: Literal["PartialRefund"] = "PartialRefund"
    rate: float


class RefundPolicy(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    amount: Union[Literal["FullRefund"], RefundPolicyAmountPartialRefund]
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
    """v0.3 — a parent's cancellation propagates to its children (event cancellation, franchise collapse, multi-year contract, force majeure)."""
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
    """v0.3 — wholesale tiered pricing with optional year-end true-up."""
    model_config = ConfigDict(populate_by_name=True)
    tiers: List[VolumeTier] = Field(default_factory=list)
    true_up: Optional[TrueUpPolicy] = None


class LoyaltyEarnTerm(BaseModel):
    """v0.3 — point accrual on purchase (loyalty programs). currency is a CurrencyCode::Custom value such as "PTS"."""
    model_config = ConfigDict(populate_by_name=True)
    program: str
    earn_rate: float
    points_earned: float
    credited_on: Literal["FulfillmentComplete", "PaymentReceived"]
    currency: CurrencyCode


class GroupPriceTier(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    participants: float
    price: Money


class ThresholdActivation(BaseModel):
    """v0.3 — group buying / crowdfunding minimum-viable commitments. (Note: a parallel inline ThresholdActivation also exists as a CommitmentCondition variant in commitment.schema.json.)"""
    model_config = ConfigDict(populate_by_name=True)
    minimum_participants: float
    maximum_participants: Optional[float] = None
    activation_deadline: str
    if_threshold_not_met: CommitmentStateType
    if_threshold_met: CommitmentStateType
    price_tiers: List[GroupPriceTier] = Field(default_factory=list)



# --- branded ids, enums, aliases, and discriminated unions ---

# CurrencyCode is an OPEN string (any ISO 4217 code + Custom denominations like 'PTS').
# Common set for reference: MAD, EUR, USD, GBP, DZD, TND, AED, SAR, EGP, JPY, CAD, AUD, CHF, CNY, INR
CurrencyCode = str
MoneyComponentKind = Literal["Base", "Tax", "Discount", "Shipping", "Surcharge", "Tip", "Adjustment"]
MoneyOrBreakdown = Union[Money, MoneyBreakdown]
PartyID = str  # branded identifier (Invariant 5); brand is documentation only
PartyType = Literal["Individual", "Organization", "System"]
PartyRole = Literal["Initiator", "Counterparty", "Intermediary", "Fulfiller", "Guarantor"]
ValueID = str  # branded identifier (Invariant 5); brand is documentation only
Condition = Literal["New", "Used", "Refurbished", "Damaged", "RequiresInspection"]
AccessModel = Annotated[Union[AccessModelLicense, AccessModelStream, AccessModelDownload, AccessModelAPIAccess, AccessModelNFT, AccessModelEventAccess, AccessModelDocumentaryCollection, AccessModelCarbonCredit], Field(discriminator="kind")]
ValueForm = Annotated[Union[PhysicalGood, DigitalGood, ServiceValue, MoneyValue, NothingValue, ContingentValue], Field(discriminator="kind")]
ReservationBasis = Literal["PhysicalStock", "ProductionCapacity", "TimeSlot", "RecurringTimeSlot", "DriverCapacity", "Speculative"]
ValueState = Annotated[Union[ValueStateAvailable, ValueStateReserved, ValueStateUnderAuction, ValueStateCommitted, ValueStateInTransit, ValueStateTransferred, ValueStateReturned, ValueStateRetired], Field(discriminator="type")]
IntentID = str  # branded identifier (Invariant 5); brand is documentation only
IntentState = Annotated[Union[IntentStateActive, IntentStateAbandoned, IntentStateConverted, IntentStateExpired], Field(discriminator="type")]
CommitmentID = str  # branded identifier (Invariant 5); brand is documentation only
CommitmentStateType = Literal["Draft", "Proposed", "Tendered", "Accepted", "Modified", "PartiallyFulfilled", "Active", "Fulfilled", "Cancelled", "Disputed", "Refunded"]
CommitmentState = Annotated[Union[CommitmentStateDraft, CommitmentStateProposed, CommitmentStateTendered, CommitmentStateAccepted, CommitmentStateModified, CommitmentStatePartiallyFulfilled, CommitmentStateActive, CommitmentStateFulfilled, CommitmentStateCancelled, CommitmentStateDisputed, CommitmentStateRefunded], Field(discriminator="type")]
PostFulfillmentTrigger = Annotated[Union[PostFulfillmentTriggerInsuranceAdjudication, PostFulfillmentTriggerInspectionCompletion, PostFulfillmentTriggerAcceptanceTest], Field(discriminator="type")]
CommissionStructure = Annotated[Union[CommissionStructureSingleSided, CommissionStructureDoubleSided], Field(discriminator="type")]
PaymentTiming = Annotated[Union[PaymentTimingImmediate, PaymentTimingUpfront, PaymentTimingOnDelivery, PaymentTimingOnServiceCompletion, PaymentTimingAfterGoodsReceived, PaymentTimingInstallments, PaymentTimingMilestone, PaymentTimingRecurring, PaymentTimingSimultaneous, PaymentTimingMetered, PaymentTimingPostFulfillment, PaymentTimingDocumentsAgainstPayment, PaymentTimingNet, PaymentTimingCommissionSplit], Field(discriminator="type")]
DeliveryMethod = Annotated[Union[DeliveryMethodPhysicalDelivery, DeliveryMethodInPersonHandover, DeliveryMethodInterStoreTransfer, DeliveryMethodInternalTransfer, DeliveryMethodServicePerformance, DeliveryMethodDigitalDelivery, DeliveryMethodMoneyTransfer, DeliveryMethodContingentDelivery, DeliveryMethodWhiteGlove, DeliveryMethodReturnDelivery, DeliveryMethodTitleTransfer, DeliveryMethodRecurringDelivery, DeliveryMethodCustomsRelease, DeliveryMethodRegistryRetirement], Field(discriminator="kind")]
CommitmentCondition = Annotated[Union[CommitmentConditionQualityInspection, CommitmentConditionAuthenticationVerification, CommitmentConditionDeliverableAcceptance, CommitmentConditionConditionVerification, CommitmentConditionInsuredEventMonitoring, CommitmentConditionGracePeriod, CommitmentConditionRoyaltyDistribution, CommitmentConditionStaffDiscount, CommitmentConditionNoShowPolicy, CommitmentConditionSimultaneousAccessLimit, CommitmentConditionFinancingContingency, CommitmentConditionInspectionContingency, CommitmentConditionPrescriptionRequired, CommitmentConditionRegistryVerification, CommitmentConditionThresholdActivation, CommitmentConditionComplianceDocumentation, CommitmentConditionNoReturnPolicy, CommitmentConditionEventCancellationPolicy], Field(discriminator="kind")]
CommitmentDuration = Annotated[Union[CommitmentDurationFixed, CommitmentDurationOpenEnded], Field(discriminator="kind")]
FulfillmentID = str  # branded identifier (Invariant 5); brand is documentation only
FulfillmentState = Annotated[Union[FulfillmentStatePlanned, FulfillmentStateInProgress, FulfillmentStateCompleted, FulfillmentStateFailed, FulfillmentStateReversed], Field(discriminator="type")]
Evidence = Annotated[Union[EvidenceProofOfDelivery, EvidencePaymentReceipt, EvidenceAccessGrant, EvidenceServiceCompletion, EvidenceWarehouseReceipt, EvidenceBillOfLading, EvidenceCustomsClearance, EvidenceTriggerVerification, EvidenceRegistryRecording, EvidenceMedicalRecord, EvidenceRetirementCertificate], Field(discriminator="kind")]
AuctionMechanism = Annotated[Union[AuctionMechanismEnglish, AuctionMechanismDutch, AuctionMechanismSealedBid, AuctionMechanismVickrey, AuctionMechanismScoredSelection], Field(discriminator="kind")]
AuctionCloseReason = Literal["NormalClose", "ReserveNotMet", "BuyItNowExercised", "SellerCancelled", "AwardProtestUpheld"]
AuctionState = Annotated[Union[AuctionStateScheduled, AuctionStateOpen, AuctionStateClosed], Field(discriminator="type")]
AwardProtestState = Annotated[Union[AwardProtestStateFiled, AwardProtestStateUnderReview, AwardProtestStateUpheld, AwardProtestStateDismissed], Field(discriminator="type")]
CandidateState = Literal["Pending", "Accepted", "Rejected"]
ResolutionState = Annotated[Union[ResolutionStateAwaitingCustomerDecision, ResolutionStateResolved, ResolutionStateExpired], Field(discriminator="type")]
CascadeTrigger = Annotated[Union[CascadeTriggerParentCancelled, CascadeTriggerParentDisputed, CascadeTriggerExternalEvent], Field(discriminator="type")]
CascadeScope = Annotated[Union[CascadeScopeAllChildren, CascadeScopeChildrenInState], Field(discriminator="type")]
CommerceObject = Union[Party, Value, Intent, Commitment, Fulfillment, AuctionProcess, AwardProtest, ResolutionProcess, EntitlementConsumption]
IntentStateType = Literal["Active", "Abandoned", "Converted", "Expired"]
FulfillmentStateType = Literal["Planned", "InProgress", "Completed", "Failed", "Reversed"]
PaymentTimingType = Literal["Immediate", "Upfront", "OnDelivery", "OnServiceCompletion", "AfterGoodsReceived", "Installments", "Milestone", "Recurring", "Simultaneous", "Metered", "PostFulfillment", "DocumentsAgainstPayment", "Net", "CommissionSplit"]


# --- resolve forward references ---
for _model in (Money, MoneyComponent, MoneyBreakdown, PartyLocale, PartyCapacity, Party, Quantity, PhysicalGood, AccessModelLicense, AccessModelStream, AccessModelDownload, AccessModelAPIAccess, AccessModelNFT, AccessModelEventAccess, AccessModelDocumentaryCollection, AccessModelCarbonCredit, DigitalGood, ServiceDelivery, ServiceValue, MoneyValue, NothingValue, ContingentValue, ValueStateAvailable, ValueStateReserved, ValueStateUnderAuction, ValueStateCommitted, ValueStateInTransit, ValueStateTransferred, ValueStateReturned, ValueStateRetired, Value, IntentStateActive, IntentStateAbandoned, IntentStateConverted, IntentStateExpired, IntentTransition, Intent, CommitmentStateDraft, CommitmentStateProposed, CommitmentStateTendered, CommitmentStateAccepted, CommitmentStateModified, CommitmentStatePartiallyFulfilled, CommitmentStateActive, CommitmentStateFulfilled, CommitmentStateCancelled, CommitmentStateDisputed, CommitmentStateRefunded, CommitmentTransition, CommitmentParties, CommitmentSubject, PostFulfillmentTriggerInsuranceAdjudication, PostFulfillmentTriggerInspectionCompletion, PostFulfillmentTriggerAcceptanceTest, CommissionFee, CommissionStructureSingleSided, CommissionStructureDoubleSided, PaymentTimingImmediate, PaymentTimingUpfront, PaymentTimingOnDelivery, PaymentTimingOnServiceCompletion, PaymentTimingAfterGoodsReceived, PaymentTimingInstallments, PaymentTimingMilestone, PaymentTimingRecurring, PaymentTimingSimultaneous, PaymentTimingMetered, PaymentTimingPostFulfillment, PaymentTimingDocumentsAgainstPayment, PaymentTimingNet, PaymentTimingCommissionSplit, DeliveryMethodPhysicalDelivery, DeliveryMethodInPersonHandover, DeliveryMethodInterStoreTransfer, DeliveryMethodInternalTransfer, DeliveryMethodServicePerformance, DeliveryMethodDigitalDelivery, DeliveryMethodMoneyTransfer, DeliveryMethodContingentDelivery, DeliveryMethodWhiteGlove, DeliveryMethodReturnDelivery, DeliveryMethodTitleTransfer, DeliveryMethodRecurringDelivery, DeliveryMethodRecurringDeliveryFlexibility, DeliveryMethodCustomsRelease, DeliveryMethodRegistryRetirement, CommitmentConditionQualityInspection, CommitmentConditionAuthenticationVerification, CommitmentConditionDeliverableAcceptance, CommitmentConditionConditionVerification, CommitmentConditionInsuredEventMonitoring, CommitmentConditionGracePeriod, CommitmentConditionRoyaltyDistribution, CommitmentConditionRoyaltyDistributionBeneficiariesItem, CommitmentConditionStaffDiscount, CommitmentConditionNoShowPolicy, CommitmentConditionSimultaneousAccessLimit, CommitmentConditionFinancingContingency, CommitmentConditionInspectionContingency, CommitmentConditionPrescriptionRequired, CommitmentConditionPrescriptionRequiredPrescription, CommitmentConditionRegistryVerification, CommitmentConditionThresholdActivation, CommitmentConditionComplianceDocumentation, CommitmentConditionNoReturnPolicy, CommitmentConditionEventCancellationPolicy, CommitmentConditionEventCancellationPolicyIfCancelled, CommitmentConditionEventCancellationPolicyIfCancelledAmountPartialRefund, PaymentTerms, PaymentTermsSplitItem, PaymentTermsCurrencyConversion, DeliveryTerms, DeliveryTermsWindow, RequiredDocuments, CommitmentDurationFixed, CommitmentDurationOpenEnded, CommitmentTerms, Commitment, FulfillmentStatePlanned, FulfillmentStateInProgress, FulfillmentStateCompleted, FulfillmentStateFailed, FulfillmentStateReversed, EvidenceProofOfDelivery, EvidencePaymentReceipt, EvidenceAccessGrant, EvidenceServiceCompletion, EvidenceWarehouseReceipt, EvidenceBillOfLading, EvidenceCustomsClearance, EvidenceTriggerVerification, EvidenceRegistryRecording, EvidenceMedicalRecord, EvidenceRetirementCertificate, FulfillmentTransition, Fulfillment, AuctionMechanismEnglish, AuctionMechanismDutch, AuctionMechanismSealedBid, AuctionMechanismVickrey, AuctionMechanismScoredSelection, AuctionMechanismScoredSelectionCriteriaItem, AuctionStateScheduled, AuctionStateOpen, AuctionStateClosed, AuctionProcess, AwardProtestStateFiled, AwardProtestStateUnderReview, AwardProtestStateUpheld, AwardProtestStateDismissed, AwardProtest, ResolutionCandidate, ResolutionStateAwaitingCustomerDecision, ResolutionStateResolved, ResolutionStateExpired, ResolutionProcess, EntitlementConsumption, RefundPolicy, RefundPolicyAmountPartialRefund, CascadeTriggerParentCancelled, CascadeTriggerParentDisputed, CascadeTriggerExternalEvent, CascadeScopeAllChildren, CascadeScopeChildrenInState, CascadeCancellation, VolumeTier, TrueUpPolicy, VolumePricing, LoyaltyEarnTerm, GroupPriceTier, ThresholdActivation,):
    _model.model_rebuild()

__all__ = [
    "CurrencyCode",
    "Money",
    "MoneyComponentKind",
    "MoneyComponent",
    "MoneyBreakdown",
    "MoneyOrBreakdown",
    "PartyID",
    "PartyType",
    "PartyRole",
    "PartyLocale",
    "PartyCapacity",
    "Party",
    "ValueID",
    "Condition",
    "Quantity",
    "PhysicalGood",
    "AccessModel",
    "DigitalGood",
    "ServiceDelivery",
    "ServiceValue",
    "MoneyValue",
    "NothingValue",
    "ContingentValue",
    "ValueForm",
    "ReservationBasis",
    "ValueState",
    "Value",
    "IntentID",
    "IntentState",
    "IntentTransition",
    "Intent",
    "CommitmentID",
    "CommitmentStateType",
    "CommitmentState",
    "CommitmentTransition",
    "CommitmentParties",
    "CommitmentSubject",
    "PostFulfillmentTrigger",
    "CommissionFee",
    "CommissionStructure",
    "PaymentTiming",
    "DeliveryMethod",
    "CommitmentCondition",
    "PaymentTerms",
    "DeliveryTerms",
    "RequiredDocuments",
    "CommitmentDuration",
    "CommitmentTerms",
    "Commitment",
    "FulfillmentID",
    "FulfillmentState",
    "Evidence",
    "FulfillmentTransition",
    "Fulfillment",
    "AuctionMechanism",
    "AuctionCloseReason",
    "AuctionState",
    "AuctionProcess",
    "AwardProtestState",
    "AwardProtest",
    "CandidateState",
    "ResolutionCandidate",
    "ResolutionState",
    "ResolutionProcess",
    "EntitlementConsumption",
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
    "CommerceObject",
    "IntentStateType",
    "FulfillmentStateType",
    "PaymentTimingType",
    "SCHEMA_VERSION",
]
