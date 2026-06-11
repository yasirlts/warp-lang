# WARP COMMERCE MODEL
## The Formal Specification of Commerce
### Version 0.3 — Full Commerce Vocabulary

---

## Status

This document is the authoritative specification of the Warp Commerce Model.
It defines what commerce is with sufficient precision that two independent
implementations produce compatible results.

This is not a technical specification for any particular system.
It contains no implementation code, no platform references, no tooling
decisions. It answers one question: what is commerce, stated formally.

**Stability:** The five primitives are stable. The six invariants
are stable (with one refined clause in Invariant 1). Extensions
validated through adversarial testing across 40+ commerce domains.

**v0.3 changes from v0.2:** Ten additional commerce domains tested —
real estate, healthcare, government procurement, wholesale/distribution,
marketplace platforms, cross-border trade finance, event commerce,
loyalty programs, social/group commerce, and environmental markets.
The five primitives held across all domains. See Changelog for
full extension list.

---

## Preamble

Every commerce platform in existence today — SAP, Shopify, Odoo, Magento,
WooCommerce, Amazon, Alibaba — has its own model of commerce. SAP calls
an order a SalesOrder. Shopify calls it an Order. Odoo calls it a
sale.order. These are the same concept expressed in incompatible vocabularies.

This incompatibility is not accidental. Each platform modeled commerce
to serve its own implementation needs. None modeled commerce to serve
commerce itself.

The result: every integration between platforms requires custom mapping
work. Every AI system that touches commerce must learn each platform's
vocabulary independently. Every developer who moves between platforms
must relearn the same concepts expressed differently.

The Warp Commerce Model exists to end this.

It defines what an order is — not what Shopify thinks an order is, not
what SAP thinks a SalesOrder is, but what an order formally is, stated
precisely enough that any platform's representation of an order can be
mechanically mapped to the model and back.

When two systems share this model, commerce data can move between them
without custom integration. When an AI agent reasons against this model,
its commerce reasoning is formally grounded rather than probabilistic.
When a compiler enforces this model, commerce mistakes are impossible
to express rather than merely likely to be caught.

This is what SQL did for data. SQL did not describe how MySQL stores
data or how PostgreSQL stores data. It described what data is —
tables, rows, columns, relationships — stated precisely enough that
every database vendor could implement it independently and produce
compatible results.

The Warp Commerce Model does the same for commerce.

---

## Foundational Axioms

These are not design decisions. They are observations about what commerce
is, verified across every commerce system that has ever existed in any
culture at any scale.

**Axiom 1 — Commerce requires at least two parties.**

Every commerce operation involves at minimum one party offering value
and one party receiving it. Single-party operations — a person moving
their own goods from one place to another — are not commerce. Commerce
begins when a second party enters.

**Axiom 2 — Commerce transfers or grants access to value.**

Value is what moves in commerce. It takes multiple forms — physical
goods, digital goods, services, money — but in every commerce operation
something of value changes hands or access to something of value is
granted. Commerce without value exchange is not commerce.

**Axiom 3 — Commerce operates through states with valid transitions.**

Every commerce operation exists in a defined state at every moment.
Transitions between states follow rules. An operation is valid if and
only if its state transitions follow those rules without violating the
invariants of the system.

**Axiom 4 — Commerce state is fully determined by its history.**

The current state of any commerce operation can be determined entirely
from its history of state transitions. No state is hidden, ambiguous,
or requires external judgment to determine. This axiom is what makes
the model useful for AI systems — a system with access to the full
history of a commerce object can determine its current state and valid
next transitions without human input.

---

## The Five Primitives

Everything in commerce derives from five primitives. No commerce operation
anywhere in the world requires a concept outside these five. This claim
has been tested adversarially across 40+ commerce domains: physical goods
commerce (Amazon, Alibaba, Temu, Shein, Net-a-Porter), multi-recipient
gifting with returns, physical retail POS including multi-store chains and
franchise models, services commerce including appointments, subscriptions,
gig economy, and professional services with milestones, financial commerce
including BNPL, loans, insurance, escrow, and currency exchange, digital
commerce including software licensing, streaming, API access, and NFTs,
market-making commerce including auctions, prediction markets, derivatives,
two-sided matching, and collateral lending, real estate including title
transfer and financing contingencies, healthcare including insurance
adjudication and prescription requirements, government procurement including
scored selection and award protests, wholesale and distribution including
blanket POs and volume pricing, marketplace platforms with double-sided
commission structures, cross-border trade finance including documentary
collections and customs release, event commerce including cascade
cancellation, loyalty programs including point creation and redemption,
social and group commerce with threshold-activated commitments, and
environmental markets including carbon credit verification and retirement.

The five primitives hold across all tested domains. Extensions to these
primitives are required for specific domains. No sixth primitive has been
found necessary.

**On the "pricing is outside the model" boundary:**

This is a deliberate design decision with a known consequence. The model
does not represent how prices are determined — only the Money values
that result from price determination. This means dynamic pricing, auction
price discovery, and negotiated B2B pricing are pre-model processes whose
outputs enter the model as Money values.

The consequence: the model cannot represent the price discovery process
itself as a commerce operation. It can represent the Commitment that
price discovery produces. This is the correct boundary for a model of
commerce state. A model that includes pricing strategy is an opinionated
system, not a formal model. The AuctionProcess auxiliary record below
represents the coordination mechanism that produces Tendered Commitments —
it does not represent the pricing algorithm.

---

### Primitive 1: Party

A Party is any entity that can participate in commerce. Parties hold
value, make commitments, fulfill obligations, and act as intermediaries
or guarantors.

```
Party {
  id: PartyID                    // globally unique, immutable, never reused
  type: PartyType
  locale: Locale {
    language: LanguageCode       // BCP 47 (e.g. "fr-MA", "ar-MA", "zgh-MA")
    currency: CurrencyCode       // ISO 4217 (e.g. "MAD", "EUR", "USD")
    jurisdiction: JurisdictionCode  // ISO 3166-1 alpha-2 (e.g. "MA", "FR")
  }
  capacity: Capacity {
    can_buy: bool
    can_sell: bool
    can_fulfill: bool
    can_guarantee: bool
    verified_at: Timestamp
  }
}

PartyType {
  Individual                     // a natural person
  Organization                   // a legal entity: company, NGO, government
  System                         // an AI agent or automated system acting
                                 // on behalf of a principal party
}
```

**Roles a Party plays in a Commitment:**

A Party does not have a fixed role. The same Party can be a buyer in one
Commitment and a seller in another. Role is contextual, not intrinsic.

```
PartyRole {
  Initiator      // proposes the Commitment, typically the buyer
  Counterparty   // accepts the Commitment, typically the seller
  Intermediary   // facilitates without owning the value being exchanged
                 // (marketplace, agent, freight forwarder, platform)
  Fulfiller      // executes the physical or digital transfer of value
  Guarantor      // backs the Commitment with their own capacity
                 // (bank in a Letter of Credit, escrow service)
}
```

**On AI agents as parties:**

When an AI agent takes a commerce action on behalf of a human, the
Commitment records both — the human as the principal party and the
AI system as the acting intermediary with PartyType::System. This
makes AI-mediated commerce fully auditable. The model does not treat
AI agents differently from human agents at the structural level. It
records them with precision.

**On franchise and multi-entity structures:**

The legal entity that holds the counterparty role is the party legally
responsible for the Commitment. In franchise commerce the franchise
owner is the counterparty, not the franchisor. The franchisor is an
intermediary providing brand and systems. This distinction matters for
dispute resolution, returns, and legal jurisdiction.

---

### Primitive 2: Value

Value is what moves between parties in every commerce operation. It
takes multiple forms but in every case represents something that has
worth to the receiving party.

```
Value {
  id: ValueID                    // globally unique instance identifier
  form: ValueForm
  quantity: Quantity
  state: ValueState
}
```

**ValueForm — the forms value takes:**

```
ValueForm {

  PhysicalGood {
    sku: SKU                     // what the good is
    condition: Condition {
      New | Used | Refurbished | Damaged | RequiresInspection
    }
    location: Location           // where it physically exists
    attributes: Map<String, String>  // color, size, material, etc.
    provenance: Option<Provenance> {
      manufacturer: PartyID
      chain_of_custody: Vec<CustodyRecord> {
        from: PartyID
        to: PartyID
        at: Timestamp
        evidence: Evidence
      }
      authentication: Vec<AuthenticationRecord> {
        issuer: PartyID
        standard: String         // "Chanel-Auth", "GIA", "ISO-9001"
        certificate_id: String
        verified_at: Timestamp
      }
    }
  }

  DigitalGood {
    identifier: String           // product ID, token ID, license key
    exclusivity: DigitalExclusivity {
      Exclusive    // one party holds it at a time (NFT, unique certificate)
                   // transfer means originator loses it
      NonExclusive // multiple parties can hold simultaneously
                   // granting does not reduce provider's capacity
                   // (software license, streaming, API access)
    }
    access_model: AccessModel {
      License {
        type: LicenseType { Perpetual | Subscription | Trial | OpenSource }
        seats: u32
        transferable: bool
        territory: Option<Vec<JurisdictionCode>>
        expiry: Option<Timestamp>
        use_restriction: Option<UseRestriction> {
          PersonalOnly | CommercialAllowed | EnterpriseOnly
        }
      }
      Stream {
        catalog: Option<CatalogReference>
        simultaneous_streams: u32
        offline_downloads: Option<u32>
        plays_allowed: Option<u32>
      }
      Download {
        redownloadable: bool
        download_limit: Option<u32>
        delivery_url: Option<String>
      }
      APIAccess {
        calls_per_period: Option<u32>
        period: Duration
        rate_limit: Option<RateLimit>
        endpoint: String
        features: Vec<String>
      }
      NFTOwnership {
        blockchain: String
        contract_address: String
        token_id: String
        transferable: bool
        royalty: Option<RoyaltyTerm> {
          rate: Decimal           // 0.0 to 1.0
          beneficiary: PartyID
          applies_to: Vec<TransactionType>
        }
      }
      EventAccess {                // v0.3 — perishable event tickets
        event: String              // event identifier
        location: String
        date: Date
        entry_window: TimeWindow
        transferable: bool
        expiry: EventEnd           // value expires when event ends
                                   // EventEnd is a FinalizationTrigger variant
      }
      DocumentaryCollection {     // v0.3 — trade finance title documents
        held_by: PartyID           // bank holding the documents
        release_condition: ReleaseCondition
                                   // documents are Exclusive DigitalGoods
                                   // only one party holds them at a time
                                   // released on payment confirmation
      }
      CarbonCredit {               // v0.3 — verified environmental instrument
        standard: String           // "Verra VCS", "Gold Standard", etc.
        vintage: u32               // year credits were generated
        project_id: String
        project_type: String       // "Reforestation", "Solar", etc.
        location: String
        quantity: Quantity
        retired: bool              // true = permanently consumed, ValueState::Retired
        additionality_verified: bool
        verification_body: Option<String>
      }
    }
  }

  Service {
    identifier: ServiceID
    delivery_model: ServiceDelivery {
      location: ServiceLocation {
        Physical { address: Address }
        Remote   { mechanism: String }  // video call, phone, online
        Either
      }
      schedule: ServiceSchedule {
        Scheduled { at: Timestamp, duration: Duration }
        Recurring {
          frequency: Frequency
          anchor: Option<ScheduleAnchor>
          instances: Option<u32>
          window: Option<DateRange>
        }
        Continuous // always available, not session-based
        OnDemand   // available when requested, timing not predetermined
      }
      performer: Option<PartyID>    // null = any available provider
      effort: Option<Effort> {      // for time-and-materials services
        rate: Money                 // per hour, per day, per unit
        estimated_units: Decimal
        unit: String               // "hours", "days", "words"
      }
      deliverables: Vec<Deliverable> {
        id: String
        description: String
        due: Timestamp
        acceptance_criteria: Option<String>
      }
    }
  }

  Money {
    amount: MoneyAmount {
      Exact { amount: Decimal }
      Estimated {
        amount: Decimal          // best estimate at Commitment time
        basis: EstimationBasis { Metered | Distance | Time | Fixed }
        final_at: FinalizationTrigger
        cap: Option<Decimal>     // maximum the party will pay
      }
    }
    currency: CurrencyCode       // ISO 4217, always present, never implicit
                                 // includes custom: CurrencyCode::Custom(String)
                                 // for loyalty points, internal credits
  }

  ContingentValue {
    trigger: ContingentTrigger {
      type: TriggerType
      parameters: Map<String, String>
      monitoring_period: DateRange
      monitoring_party: Option<PartyID>
    }
    if_triggered: Value
    if_not_triggered: Value      // often Value::Nothing
  }

  Nothing                        // explicit zero value
                                 // used in ContingentValue when trigger
                                 // does not fire (insurance with no claim)
}
```

**ValueState — the lifecycle of a value instance:**

```
// For physical goods and money:
ValueState {
  Available                      // no constraints, can be committed
  Reserved {
    commitment: CommitmentID
    basis: ReservationBasis {
      PhysicalStock              // item exists in a warehouse or store
      ProductionCapacity         // item will be produced, capacity confirmed
      TimeSlot {                 // a performer's time held for a service
        slot: TimeWindow
        capacity_unit: String    // "barber-time", "driver-availability"
      }
      RecurringTimeSlot {        // multiple future slots held
        slots: Vec<TimeWindow>
      }
      DriverCapacity             // gig economy: specific driver allocated
      Speculative                // no formal verification, risk accepted
                                 // used in dropshipping, made-to-order
                                 // where availability is claimed not confirmed
    }
  }
  UnderAuction {                 // value is subject to an active auction
    auction_process: AuctionProcessID
    current_high_commitment: Option<CommitmentID>  // current winning bid
    current_high_offer: Option<Money>              // current winning price
    closes_at: Timestamp
    // Value cannot be Reserved or Committed to any party
    // while UnderAuction — the auction process controls allocation
  }
  Committed { commitment: CommitmentID }  // allocated, transfer imminent
  InTransit { fulfillment: FulfillmentID }
  Transferred { to: PartyID, at: Timestamp }
  Returned { from: PartyID, initiated_at: Timestamp }
}

// For digital goods (non-exclusive):
ValueState {
  AccessGranted {
    to: PartyID
    granted_at: Timestamp
    expires_at: Option<Timestamp>
  }
  AccessSuspended {
    reason: SuspensionReason
    suspended_at: Timestamp
    restore_condition: RestoreCondition
  }
  AccessRevoked {
    reason: RevocationReason
    revoked_at: Timestamp
  }
  AccessExpired {
    expired_at: Timestamp
  }
}

// For exclusive digital goods (NFTs, unique certificates,
// carbon credits, one-time use instruments):
// Uses the same physical goods ValueState (Available → Transferred)
// because exclusivity means transfer follows the same conservation rule.
// Additionally gains one terminal state:

// Terminal state for permanently consumed exclusive goods
Retired {
  retired_at: Timestamp
  retired_by: PartyID
  reason: String
  certificate: Option<String>
  // Applies to: carbon credits after offset use,
  // gift certificates after redemption,
  // consumed API credits, used coupons
  // NO transition out of Retired is valid — it is terminal
}
```

**Critical constraint on Money:**

Money always carries its currency. There is no amount without a currency
in this model. Decimal alone is not a valid Money value. This eliminates
the entire class of currency confusion errors — accidental MAD-EUR mixing,
incorrect price comparisons across currencies — by making them impossible
to express.

---

### Primitive 3: Intent

An Intent is a party's expressed desire to engage in commerce. It exists
before any Commitment. It captures what the party wants, under what
constraints, and in what context.

Intent is a first-class primitive — not a precursor to be ignored but
a formal record of what the party desired before the Commitment formed.
This makes cart abandonment a formal state transition rather than an
afterthought webhook. It makes gift commerce expressible with recipient
and occasion context that persists through the Commitment.

```
Intent {
  id: IntentID                   // globally unique, immutable
  party: PartyID                 // who wants something
  desire: Desire {
    value_form: ValueForm        // what form of value (may be underspecified)
                                 // a party may want "a gift around 500 MAD"
                                 // without specifying the exact good
    constraints: Constraints {
      budget: Option<Money>
      timing: Option<TimingConstraint> {
        needed_by: Option<Timestamp>
        preferred_window: Option<TimeWindow>
        urgency: Urgency { Low | Normal | High | Critical }
      }
      quantity: Option<QuantityConstraint>
      preferences: Vec<Preference>  // ordered, weighted attributes
                                    // "prefers local vendors"
                                    // "prefers eco-certified"
    }
    context: IntentContext {
      occasion: Option<Occasion> {
        Birthday | Anniversary | Eid | Ramadan | MothersDay |
        ValentinesDay | WeddingAnniversary | Corporate | Custom(String)
      }
      recipient: Option<PartyID>   // who the value is for (gift commerce)
                                   // distinct from the initiating party
      channel: Channel {           // how the party is engaging
        Web | Mobile | Physical | Voice | Agent
      }
      urgency: Urgency
    }
  }
  state: IntentState
  history: Vec<IntentTransition>  // append-only, immutable
  created_at: Timestamp
  expires_at: Option<Timestamp>
}

IntentState {
  Active                          // party is engaged, intent is open
  Abandoned                       // party stopped without committing
                                  // a cart abandonment is Active → Abandoned
  Converted {
    commitment_id: CommitmentID   // the Commitment this Intent became
  }
  Expired                         // time limit reached without conversion
}

IntentTransition {
  from: IntentState
  to: IntentState
  at: Timestamp
  actor: PartyID                  // who caused this transition
  reason: Option<String>
}
```

**On multi-recipient intent:**

When a party intends to send gifts to multiple recipients — a customer
ordering for their mother, daughter, and son — the Intent carries
multiple recipients. Each recipient produces a separate child Commitment
but they all originate from one Intent. This preserves the single
customer journey while allowing independent fulfillment per recipient.

```
Intent.desire.recipients: Vec<Recipient> {
  party: PartyID
  address: Address
  items_desired: Vec<ValueForm>
}
```

---

### Primitive 4: Commitment

A Commitment is a formal agreement between two or more parties to
exchange value under specified terms. It is the central primitive of
the commerce model.

Every commerce operation either leads to a Commitment, is recorded
as a Commitment, or is the execution of a Commitment. Everything else
in the model exists to create, describe, or fulfill Commitments.

```
Commitment {
  id: CommitmentID               // globally unique, immutable, never reused
  
  parties: {
    initiator: PartyID           // who proposed the Commitment
    counterparty: PartyID        // who accepted it
    intermediaries: Vec<PartyID> // platforms, agents, fulfillment partners
                                 // may change as Commitment evolves
                                 // (new vendor joining a multi-vendor order)
  }
  
  subject: {
    offered: Vec<Value>          // what the counterparty provides
    requested: Vec<Value>        // what the initiator provides in return
                                 // usually Money, sometimes also goods
                                 // (trade, barter, exchange)
  }
  
  terms: CommitmentTerms {
    delivery: DeliveryTerms {
      method: DeliveryMethod {
        PhysicalDelivery {
          carrier: Option<PartyID>
          tracking: Option<String>
          route: Option<Route>
        }
        InPersonHandover {       // POS: goods handed over at counter
          location: StoreLocation
          staff_id: Option<PartyID>
        }
        InterStoreTransfer {     // retail chain: store to store
          from: StoreLocation
          to: StoreLocation
          customer_pickup: bool
          pickup_window: TimeWindow
        }
        InternalTransfer {       // warehouse to warehouse, internal
          from: Location
          to: Location
          vehicle: Option<PartyID>
        }
        ServicePerformance {     // service delivery
          performer: PartyID
          location: ServiceLocation
          scheduled_at: Timestamp
          duration: Duration
        }
        DigitalDelivery {        // license key, download, access grant
          mechanism: DeliveryMechanism
          delivered_at: Option<Timestamp>
          access_token: Option<String>
        }
        MoneyTransfer {          // payment, refund, loan disbursement
          mechanism: PaymentMechanism
          reference: Option<String>
          cleared_at: Option<Timestamp>
        }
        ContingentDelivery {     // insurance: deliver only if event fires
          trigger: ContingentTrigger
          if_triggered: DeliveryMethod
        }
        WhiteGlove {             // luxury: appointment, named recipient
          packaging: PackagingSpec
          delivery_experience: ExperienceSpec
          carrier: PartyID
        }
        ReturnDelivery {         // for return Commitments
          pickup_address: Address
          dropoff_address: Address
          pickup_window: TimeWindow
          condition_required: Option<Condition>
        }
        TitleTransfer {          // v0.3 — real estate, legal ownership transfer
          mechanism: TitleMechanism {
            NotarialDeed         // Morocco, France, civil law systems
            WarrantyDeed         // US common law
            LandRegistration     // UK, Torrens systems
          }
          registry: String       // "Conservation Foncière Casablanca", etc.
          title_number: Option<String>
          notary: Option<PartyID>
        }
        RecurringDelivery {      // v0.3 — wholesale blanket POs
          schedule: Frequency
          quantity_per_delivery: Quantity
          first_delivery: Timestamp
          last_delivery: Option<Timestamp>
          flexibility: Option<QuantityFlexibility> {
            min_per_delivery: Quantity
            max_per_delivery: Quantity
          }
        }
        CustomsRelease {         // v0.3 — cross-border, government-controlled release
          customs_reference: String
          cleared_at: Timestamp
          duties_paid: Option<Money>
          inspection_required: bool
        }
        RegistryRetirement {     // v0.3 — carbon credits, permanent consumption recording
          registry: PartyID
          retirement_reference: String
          retired_on_behalf_of: PartyID
          reason: String
        }
      }
      address: Option<Address>
      window: Option<DeliveryWindow> {
        earliest: Timestamp
        latest: Timestamp
      }
      incoterm: Option<Incoterm>   // for international B2B: FOB, CIF, DDP
    }
    
    payment: PaymentTerms {
      method: PaymentMethod
      timing: PaymentTiming {
        Immediate                // payment at or before delivery
        Upfront                  // payment before delivery begins
        OnDelivery               // payment when goods received
        OnServiceCompletion      // payment when service performed
        AfterGoodsReceived       // escrow release condition
        Installments {
          schedule: Vec<Installment> {
            due: Timestamp
            amount: Money
            sequence: u32
          }
          principal: Money
          interest: Money
          rate: Option<InterestRate> {
            annual: Decimal
            type: RateType { Fixed | Variable }
            compounding: CompoundingFrequency
          }
        }
        Milestone {
          schedule: Vec<MilestonePayment> {
            trigger: MilestoneTrigger
            amount: Money
            sequence: u32
          }
        }
        Recurring {
          frequency: Frequency
          anchor: BillingAnchor
          auto_renew: bool
        }
        Simultaneous              // both sides exchange at same instant
                                  // currency exchange, atomic swap
        Metered {                 // usage-based, finalized at period end
          rate: Money             // per unit
          unit: String
          period: Duration
          cap: Option<Money>
        }
        PostFulfillment {         // v0.3 — payment after fulfillment AND after a
                                  // post-fulfillment trigger resolves
                                  // healthcare: insurer adjudicates after the visit
                                  // construction: inspection after completion
          trigger: PostFulfillmentTrigger {
            InsuranceAdjudication {
              adjudicator: PartyID
              claim_reference: Option<String>
              deadline: Option<Timestamp>
            }
            InspectionCompletion {
              inspector: PartyID
              standard: Option<String>
            }
            AcceptanceTest {      // IT projects, custom manufacturing
              tester: PartyID
              criteria: String
            }
          }
        }
        DocumentsAgainstPayment { // v0.3 — trade finance
                                  // importer pays bank to receive title documents
          documents_held_by: PartyID
          release_condition: ReleaseCondition
        }
        Net {                     // v0.3 — B2B credit terms: Net30, Net60, Net90
          days: u32
          from: NetTermsAnchor {
            InvoiceDate
            DeliveryDate
            EndOfMonth
          }
          early_payment_discount: Option<Decimal>
        }
        CommissionSplit {         // v0.3 — marketplace platforms
          structure: CommissionStructure {
            SingleSided {
              rate: Decimal
              paid_by: PartyRole
              paid_to: PartyID    // the platform
            }
            DoubleSided {
              buyer_fee: CommissionFee {
                rate: Decimal
                paid_to: PartyID
                added_to: BuyerTotal
              }
              seller_fee: CommissionFee {
                rate: Decimal
                paid_to: PartyID
                deducted_from: SellerPayout
              }
            }
          }
        }
      }
      split: Option<Vec<PaymentPart>> {  // split payment (POS loyalty + card + cash)
        method: PaymentMethod
        amount: Money
        reference: Option<String>
      }
      currency_conversion: Option<CurrencyConversion> {
        from: CurrencyCode
        to: CurrencyCode
        rate: ExchangeRate {
          rate: Decimal
          valid_until: Timestamp
          source: String
        }
        customer_pays: Money     // in their currency
      }
    }
    
    conditions: Vec<CommitmentCondition> {
      // Prerequisites that must be satisfied for specific transitions
      
      QualityInspection {
        inspector: PartyID
        standard: String
        must_complete_before: CommitmentStateTransition
        if_fail: CommitmentState
      }
      AuthenticationVerification {
        verifier: PartyID
        must_complete_before: CommitmentStateTransition
      }
      DeliverableAcceptance {
        deliverable_id: String
        accepted_by: PartyID
        acceptance_window: Duration
        if_rejected: CommitmentState
      }
      ConditionVerification {    // return condition check
        required_condition: Condition
        inspector: PartyID
        if_not_met: CommitmentState
      }
      InsuredEventMonitoring {
        event_type: TriggerType
        monitoring_period: DateRange
        monitoring_party: Option<PartyID>
      }
      GracePeriod {
        duration: Duration
        trigger: GraceTrigger    // what activates the grace period
        restore_condition: RestoreCondition
        if_not_restored: CommitmentState
      }
      RoyaltyDistribution {     // on resale of exclusive digital goods
        beneficiaries: Vec<RoyaltyPayment> {
          to: PartyID
          rate: Decimal
        }
      }
      StaffDiscount {
        applies_to: Vec<ValueID>
        rate: Decimal
        requires: EmployeeVerification
      }
      NoShowPolicy {
        grace_minutes: u32
        fee: Money
        triggers: CommitmentState  // what state the no-show fee creates
      }
      SimultaneousAccessLimit {  // for digital goods
        max_concurrent: u32
        enforcement: EnforcementParty
      }
      FinancingContingency {     // v0.3 — real estate, conditional on lender approval
        lender: Option<PartyID>
        amount: Money
        rate_cap: Option<Decimal>
        approval_deadline: Timestamp
        if_not_met: CommitmentState
      }
      InspectionContingency {    // v0.3 — real estate, property condition gate
        inspector: Option<PartyID>
        deadline: Timestamp
        if_failed: CommitmentState
      }
      PrescriptionRequired {     // v0.3 — healthcare, regulatory requirement
        prescription: Option<PrescriptionDocument> {
          reference: String
          issuer: PartyID
          issued_at: Timestamp
          valid_until: Timestamp
          medication: String
          quantity: String
          refills: u32
        }
        verified_by: Option<PartyID>
        must_verify_before: CommitmentStateTransition
      }
      RegistryVerification {     // v0.3 — carbon credits, title deeds
        registry: PartyID
        must_verify_before: CommitmentStateTransition
        verifies: Vec<String>
      }
      ThresholdActivation {      // v0.3 — group buying, crowdfunding
        minimum_participants: u32
        maximum_participants: Option<u32>
        activation_deadline: Timestamp
        if_threshold_not_met: CommitmentState
        if_threshold_met: CommitmentState
        price_tiers: Option<Vec<GroupPriceTier>> {
          participants: u32
          price: Money
        }
      }
      ComplianceDocumentation {  // v0.3 — government procurement
        required_documents: Vec<String>
        submission_deadline: Timestamp
        verified_by: PartyID
        if_not_submitted: CommitmentState
      }
      NoReturnPolicy {           // v0.3 — healthcare, irreversible services
        basis: String
        jurisdiction: JurisdictionCode
      }
      EventCancellationPolicy {  // v0.3 — event commerce, force majeure
        if_cancelled: AutoRefund {
          amount: RefundAmount { FullRefund | PartialRefund { rate: Decimal } }
          deadline: Duration
        }
        if_postponed: CustomerChoice {
          options: Vec<PostponementOption>
          decision_window: Duration
        }
      }
    }

    // v0.3 — additional CommitmentTerms
    cascade: Option<CascadeCancellation> {
      // when parent Commitment is Cancelled, all children automatically
      // transition to child_transition state (event commerce, franchise,
      // multi-year contracts, force majeure)
      trigger: CascadeTrigger {
        ParentCancelled
        ParentDisputed
        ExternalEvent { event_type: String }
      }
      applies_to: CascadeScope {
        AllChildren
        ChildrenInState { states: Vec<CommitmentState> }
      }
      child_transition: CommitmentState
      auto_refund: Option<RefundPolicy>
    }

    volume_pricing: Option<VolumePricing> {  // v0.3 — wholesale, tiered pricing
      tiers: Vec<VolumeTier> {
        min: u32
        max: Option<u32>
        price_per_unit: Money
      }
      true_up: Option<TrueUpPolicy>  // year-end reconciliation if tier crossed
    }

    loyalty: Option<LoyaltyEarnTerm> {  // v0.3 — loyalty programs
      program: String
      earn_rate: Decimal             // points per unit of currency spent
      points_earned: Quantity
      credited_on: LoyaltyCreditTrigger {
        FulfillmentComplete
        PaymentReceived
      }
      currency: CurrencyCode         // CurrencyCode::Custom for loyalty points
    }

    required_documents: Option<RequiredDocuments> {  // v0.3 — trade finance
      BillOfLading: bool
      CommercialInvoice: bool
      PackingList: bool
      CertificateOfOrigin: bool
      InsuranceCertificate: bool
      CustomsDeclaration: bool
    }

    jurisdiction: JurisdictionCode   // governing law
    duration: Option<CommitmentDuration> {
      Fixed { ends_at: Timestamp }
      OpenEnded {
        minimum_term: Option<Duration>
        cancellation_notice: Duration
      }
    }
  }
  
  state: CommitmentState
  history: Vec<CommitmentTransition>   // append-only, immutable
  
  // Structural relationships
  originated_from: Option<IntentID>    // the Intent that created this
  parent: Option<CommitmentID>         // for child Commitments
  children: Vec<CommitmentID>          // for parent Commitments
  
  created_at: Timestamp
  expires_at: Option<Timestamp>
}
```

**CommitmentState — the lifecycle:**

```
CommitmentState {
  Draft                          // being assembled, not yet binding
                                 // parties may be unknown, terms incomplete
  Proposed                       // presented to counterparty
                                 // binding on initiator, not yet on counterparty
  Tendered {                     // open offer to any qualifying counterparty
    offer: Money                 // the offered price (bid amount in an auction)
    valid_condition: TenderCondition {
      HighestBidAtClose          // English auction: highest bid at close wins
      FirstAccept                // Dutch auction: first to accept wins
      HighestAboveReserve        // sealed bid: highest above reserve wins
    }
    closes_at: Timestamp         // when the tender window closes
    superseded_by: Option<CommitmentID>  // set when outbid by a higher Tendered
    auction_process: Option<AuctionProcessID>  // the process coordinating this
  }                              // Tendered → Accepted when auction closes
                                 // and this is the winning Commitment
                                 // Tendered → Cancelled when outbid and
                                 // superseded_by is set
  Accepted                       // binding on all parties
                                 // all terms agreed, capacity verified
  Modified {
    previous_terms: CommitmentTerms
    modification_by: PartyID
    reason: String
  }                              // terms changed after Accepted
                                 // returns to Accepted when all affected
                                 // parties agree to the modified terms
  PartiallyFulfilled {
    fulfilled_items: Vec<ValueID>
    remaining_items: Vec<ValueID>
  }                              // some value transferred, not all
  Active                         // for subscriptions and ongoing services
                                 // perpetually in progress
                                 // never reaches Fulfilled while active
  Fulfilled                      // all obligations met by all parties
  Cancelled {
    by: PartyID
    reason: String
    at: Timestamp
    fee: Option<Money>           // cancellation fee if applicable
  }
  Disputed {
    by: PartyID
    reason: String
    evidence: Vec<Evidence>
    opened_at: Timestamp
  }
  Refunded {
    amount: Money
    method: PaymentMethod
    at: Timestamp
  }
}
```

**Valid state transitions — the complete list:**

Only these transitions are valid. Any other transition is a model violation.

```
Draft       → Proposed          requires: parties identified, terms complete
Draft       → Tendered          requires: subject value identified,
                                          offer price stated,
                                          auction process referenced
Draft       → Cancelled         requires: initiator action before proposal

Proposed    → Accepted          requires: counterparty action,
                                          capacity verified for all parties
Proposed    → Cancelled         requires: initiator action, or
                                          counterparty rejection, or
                                          expiry timestamp reached
Proposed    → Modified          requires: counterparty counter-proposal

Tendered    → Accepted          requires: auction closes AND this Commitment
                                          is the winning bid
                                          (highest bid, first accept, or
                                          highest above reserve per mechanism)
Tendered    → Cancelled         requires: outbid (superseded_by is set), or
                                          auction cancelled, or
                                          reserve price not met at close

Accepted    → Modified          requires: agreement by affected parties
Accepted    → PartiallyFulfilled requires: at least one Fulfillment Completed,
                                           at least one Fulfillment not yet Complete
Accepted    → Active            requires: Commitment is subscription or
                                          ongoing service type
Accepted    → Cancelled         requires: before any Fulfillment starts,
                                          reason stated, fee applied if applicable
Accepted    → Disputed          requires: party claim with evidence

Modified    → Accepted          requires: all affected parties agree to
                                          the modified terms
Modified    → Cancelled         requires: parties cannot reach agreement
                                          on modified terms

PartiallyFulfilled → Fulfilled  requires: all Fulfillments Completed
PartiallyFulfilled → Modified   requires: substitution accepted for
                                          unresolved items
PartiallyFulfilled → Cancelled  requires: parties agree to cancel remaining
                                          items with appropriate refunds

Active      → Modified          requires: both parties agree to new terms
Active      → Cancelled         requires: notice period respected,
                                          minimum term satisfied
Active      → Disputed          requires: party claim with evidence

Fulfilled   → Disputed          requires: party claim within dispute window
Fulfilled   → Refunded          requires: initiator request within return policy

Disputed    → Fulfilled         requires: dispute resolved in counterparty's favor
Disputed    → Refunded          requires: dispute resolved in initiator's favor
Disputed    → Cancelled         requires: mutual agreement to abandon
```

**No other transitions are valid. This list is exhaustive.**

**The Resolution Process — for PartiallyFulfilled Commitments:**

When a Commitment reaches PartiallyFulfilled because a value cannot
be provided, a Resolution Process opens for each unresolved item.

```
ResolutionProcess {
  id: ResolutionProcessID
  parent_commitment: CommitmentID
  unresolved_item: ValueID
  original_value: Money          // the monetary value of the unresolved item
  
  candidates: Vec<ResolutionCandidate> {
    id: ResolutionCandidateID
    proposed_by: PartyID
    substitute_value: Value
    fulfilling_party: Option<PartyID>  // if different from original
    price_delta: Money           // positive = customer pays more
    new_total: Money             // new Commitment total if accepted
    delivery_impact: DeliveryImpact {
      original_window: Timestamp
      new_window: Timestamp
      order_delivery_window: Timestamp  // slowest item across all children
    }
    state: CandidateState { Pending | Accepted | Rejected }
  }
  
  also_available: Option<CancelItem>
  
  state: ResolutionState {
    AwaitingCustomerDecision
    Resolved { outcome: ResolutionOutcome }
    Expired
  }
  
  deadline: Timestamp
}

ResolutionOutcome {
  SubstituteAccepted { candidate_id: ResolutionCandidateID }
  ItemCancelled
}
```

**The AuctionProcess — auxiliary coordination record for market-making:**

An AuctionProcess is not a sixth primitive. It is a coordination record
built from existing primitives that manages the collection of Tendered
Commitments and determines the winning Commitment when the auction closes.

The AuctionProcess operates on the Value being auctioned
(held in ValueState::UnderAuction) and produces Tendered Commitments
from bidders. When the auction closes it transitions one Tendered
Commitment to Accepted and the rest to Cancelled.

```
AuctionProcess {
  id: AuctionProcessID
  
  subject: ValueID               // the Value being auctioned
                                 // must be in ValueState::UnderAuction
  seller: PartyID
  
  mechanism: AuctionMechanism {
    English {                    // ascending price, open bids
      reserve_price: Option<Money>   // minimum acceptable price
      increment: Option<Money>       // minimum bid increment
      extension_window: Option<Duration>  // extend if bid in final minutes
    }
    Dutch {                      // descending price, first accept wins
      start_price: Money
      decrement: Money
      interval: Duration
    }
    SealedBid {                  // private bids submitted, highest wins
      reserve_price: Option<Money>
      reveal_at: Timestamp
    }
    Vickrey {                    // sealed bid, winner pays second-highest price
      reserve_price: Option<Money>
    }
    ScoredSelection {            // v0.3 — government procurement
                                 // winner determined by weighted multi-criteria
                                 // scoring, not just price
      criteria: Vec<ScoringCriterion> {
        name: String
        weight: Decimal          // weights must sum to 1.0
        max_points: u32
      }
      minimum_threshold: Option<u32>  // minimum score to qualify
      evaluation_committee: Vec<PartyID>
      publication_required: bool  // must results be published?
    }
  }
  
  tendered_commitments: Vec<CommitmentID>  // all bids submitted
                                           // each in Tendered state
  
  opens_at: Timestamp
  closes_at: Timestamp
  
  state: AuctionState {
    Scheduled                    // not yet open
    Open                         // accepting bids
    Closed {                     // bidding ended
      winning_commitment: Option<CommitmentID>
      winning_price: Option<Money>
      reason: AuctionCloseReason {
        NormalClose              // time expired
        ReserveNotMet            // highest bid below reserve
        BuyItNowExercised        // seller accepted an early offer
        SellerCancelled
        AwardProtestUpheld       // v0.3: protest reversed the award
      }
    }
  }
}
```

**The AwardProtest — auxiliary record for government procurement challenges:**

When a Tendered Commitment is awarded in a government procurement
and a losing party challenges the decision, an AwardProtest is filed.
This is not a Commitment Dispute. An AwardProtest challenges whether
the correct Tendered Commitment was selected.

```
AwardProtest {
  id: ProtestID
  filed_by: PartyID              // the challenging party
  against: CommitmentID          // the awarded Commitment
  auction_process: AuctionProcessID
  grounds: Vec<String>           // stated legal grounds for the challenge
  filed_at: Timestamp
  deadline_for_response: Timestamp
  reviewing_body: Option<PartyID>

  state: ProtestState {
    Filed
    UnderReview { reviewer: PartyID }
    Upheld {
      remedy: ProtestRemedy {
        ReEvaluation             // scoring redone
        AwardToProtestant        // award switched to challenger
        Cancellation             // entire procurement cancelled
      }
    }
    Dismissed                   // protest fails, original award stands
  }
}
```

If a protest is Upheld with ReEvaluation or Cancellation:
- The awarded Tendered Commitment transitions: Accepted → Cancelled
- A new AuctionProcess may be opened or all Tendered Commitments
  revert for re-evaluation
- The AwardProtest state is the authoritative record of why

**How auction commerce flows through the model:**

```
1. Seller places item for auction
   Value(SKU-PAINTING).state: Available → UnderAuction {
     auction_process: AUC-001
     current_high_commitment: None
     closes_at: T+7days
   }

2. Bidder A places bid of 10,000 MAD
   Commitment(C-BID-A) {
     initiator: BidderA
     counterparty: Seller        // counterparty known (the seller)
     subject.requested: Money(10000, MAD)
     state: Tendered {
       offer: Money(10000, MAD)
       valid_condition: HighestBidAtClose
       closes_at: T+7days
       auction_process: AUC-001
     }
   }
   AuctionProcess(AUC-001).current_high_commitment: C-BID-A

3. Bidder B outbids at 12,000 MAD
   Commitment(C-BID-B) { state: Tendered { offer: 12,000 } }
   Commitment(C-BID-A) { state: Tendered { superseded_by: C-BID-B } }
   AuctionProcess(AUC-001).current_high_commitment: C-BID-B

4. Auction closes. Bidder B wins.
   Commitment(C-BID-B): Tendered → Accepted
   Commitment(C-BID-A): Tendered → Cancelled { reason: "Outbid" }
   Value(SKU-PAINTING).state: UnderAuction → Reserved {
     commitment: C-BID-B
     basis: PhysicalStock
   }
   AuctionProcess(AUC-001).state: Closed {
     winning_commitment: C-BID-B
     winning_price: Money(12000, MAD)
   }

5. Normal fulfillment proceeds
   Fulfillment(F-001): payment 12,000 MAD
   Fulfillment(F-002): painting delivered
   Commitment(C-BID-B): Fulfilled
```

---

### Primitive 5: Fulfillment

A Fulfillment is the execution of a Commitment — the actual movement
of value from one party to another, or the grant of access to digital
value.

A Commitment describes what will happen. A Fulfillment records what
did happen. The relationship between Commitments and Fulfillments is
one-to-many: one Commitment produces multiple Fulfillments as its
various obligations are executed.

```
Fulfillment {
  id: FulfillmentID              // globally unique, immutable
  commitment: CommitmentID       // which Commitment this executes
  
  items: Vec<FulfillmentItem> {
    value: ValueID               // which value is moving
    from: PartyID
    to: PartyID
    quantity: Quantity
  }
  
  method: FulfillmentMethod      // how the value moves (see DeliveryMethod)
  
  state: FulfillmentState
  evidence: Vec<Evidence>        // proof of completion
  history: Vec<FulfillmentTransition>  // append-only, immutable
  
  // For service Fulfillments
  period: Option<DateRange>      // the period this Fulfillment covers
                                 // (month of subscription service)
  
  // For contingent Fulfillments
  trigger_result: Option<TriggerResult> {
    TriggerFired { at: Timestamp, verified_by: Option<PartyID> }
    TriggerDidNotFire { window_closed_at: Timestamp }
  }
  
  planned_at: Timestamp
  started_at: Option<Timestamp>
  completed_at: Option<Timestamp>
}

FulfillmentState {
  Planned                        // scheduled, not yet started
  InProgress                     // movement or service delivery has begun
  Completed                      // value received by destination,
                                 // evidence recorded
  Failed {
    reason: FailureReason
    at: Timestamp
    recoverable: bool            // can retry vs terminal failure
  }
  Reversed {                     // return or refund — value moving back
    reason: String
    initiated_by: PartyID
    at: Timestamp
  }
}
```

**Evidence — proof that Fulfillment occurred:**

```
Evidence {
  ProofOfDelivery {
    photo: Option<Uri>
    signature: Option<Signature>
    timestamp: Timestamp
    location: Option<Coordinates>
    recipient: PartyID
  }
  PaymentReceipt {
    reference: String
    amount: Money
    timestamp: Timestamp
    mechanism: PaymentMechanism
  }
  AccessGrant {
    token: String
    granted_at: Timestamp
    expires_at: Option<Timestamp>
  }
  ServiceCompletion {
    confirmed_by: PartyID
    timestamp: Timestamp
    duration_actual: Option<Duration>
    notes: Option<String>
  }
  WarehouseReceipt {
    location: Location
    received_at: Timestamp
    quantity_verified: Quantity
  }
  BillOfLading {
    reference: String
    issued_by: PartyID
    goods_description: String
    origin_port: String
    destination_port: String
    issued_at: Timestamp
  }
  CustomsClearance {
    reference: String
    cleared_at: Timestamp
    jurisdiction: JurisdictionCode
  }
  TriggerVerification {           // for contingent Fulfillments
    trigger_type: TriggerType
    result: TriggerResult
    verified_by: Option<PartyID>
    timestamp: Timestamp
  }
  RegistryRecording {             // v0.3 — real estate title registration
    registry: String
    reference: String
    recorded_at: Timestamp
    notary: Option<PartyID>
  }
  MedicalRecord {                 // v0.3 — healthcare service evidence
    reference: String
    issued_by: PartyID
    patient: PartyID
    service_date: Timestamp
  }
  RetirementCertificate {         // v0.3 — carbon credit retirement proof
    reference: String
    issued_by: PartyID            // the carbon registry
    quantity: Quantity
    retired_at: Timestamp
    project_id: String
  }
}
```

**EntitlementConsumption — for metered digital services:**

When a digital service is accessed on a metered basis every access is
recorded as EntitlementConsumption rather than as a Fulfillment. Creating
a Fulfillment per API call would be architecturally incorrect and
computationally prohibitive. EntitlementConsumption is a lightweight
measurement record that links to its parent Commitment.

```
EntitlementConsumption {
  id: ConsumptionID
  commitment: CommitmentID
  entitlement: String            // "executions-per-month", "api-calls"
  consumed_this_event: u32
  total_consumed_this_period: u32
  total_allowed_this_period: u32
  period: DateRange
  timestamp: Timestamp
  overage: bool
}
```

When total_consumed exceeds total_allowed an overage child Commitment
is created automatically, priced at the metered rate.

---

## The Six Invariants

These hold at all times across all Commitments in any system that
implements the Warp Commerce Model. Violation of any invariant indicates
either a data integrity error or a bug in the implementing system.
An AI agent can verify these invariants at any point against the
formal objects.

**Invariant 1 — Value Conservation:**

For physical goods and money:
Value is never created or destroyed by a commerce operation. It transfers.
The originating party no longer holds the transferred value.

For non-exclusive digital goods (software licenses, streaming, API access):
Access rights are granted or revoked. The provider retains their copy.
Conservation applies to access rights, not to the goods themselves.
A provider cannot grant more access rights than their license permits
them to sub-license.

For exclusive digital goods (NFTs, unique digital certificates,
carbon credits before retirement):
Ownership transfers. The originating party loses the token.
The original transfer conservation rule applies without modification.
When an exclusive digital good is retired (ValueState::Retired),
it is permanently consumed. No transfer occurs — the value is
extinguished by mutual agreement and recorded as such.

For loyalty points and merchant-issued currency
(CurrencyCode::Custom, rewards points, store credits):
This is the only ValueForm where value creation, not transfer,
is the primary operation. The issuing party creates points as a
commerce obligation — a liability to accept points in future
transactions. Conservation applies to the issuer's total liability
pool: points outstanding must not exceed the issuer's capacity to
honor them. A merchant cannot issue more points than their business
can sustain as redeemable value. Points earned by a customer are
created by the issuer (not transferred from a pool) and credited
as a new Value with CurrencyCode::Custom. When redeemed, they
transfer normally (customer → merchant) and are extinguished.

**Invariant 2 — State Monotonicity:**

CommitmentState and FulfillmentState transitions follow directed paths.
A Fulfilled Commitment cannot return to Accepted. A Cancelled Commitment
cannot become Fulfilled. The only apparent reversal — returning goods
or money — is expressed as a new forward-moving Commitment where parties
exchange roles, not as a state change on the original.

**Invariant 3 — Capacity Verification:**

A Commitment cannot reach Accepted state unless the capacity of all
parties for their roles has been verified.

For physical goods: inventory must be Available or Reserved with
verified basis (PhysicalStock or ProductionCapacity, not Speculative).
For services: time slot must be confirmed available with the performer.
For digital goods: license entitlement must be verified with the issuer.
For financial commitments: creditworthiness or guarantee must be confirmed.

Note on Speculative reservation: A Commitment may reach Accepted with
Speculative reservation but the Commitment must record the reservation
basis explicitly. Systems consuming the model can calculate capacity
risk from the basis. This is the honest representation of dropshipping
and made-to-order commerce.

**Invariant 4 — Temporal Integrity:**

Every state transition is recorded with a timestamp. No transition can
have a timestamp earlier than any previous transition on the same object.
History is append-only and immutable. Corrections to history are recorded
as new entries that supersede previous entries, not as modifications to
existing entries.

**Invariant 5 — Identity Permanence:**

CommitmentID, FulfillmentID, IntentID, PartyID, and ValueID are globally
unique and are never reused. A platform's native order ID maps to exactly
one CommitmentID. The mapping is established at Commitment creation and
never changes.

**Invariant 6 — Commitment Tree Consistency:**

For parent-child Commitment structures the sum of all child Commitment
subject.requested values (in their base currency) must equal the parent
Commitment subject.requested value at all times. When a child Commitment
is Modified (substitution, cancellation) the parent recalculates
immediately. The parent's state reflects the aggregate state of its
children.

---

## The Commerce Lifecycle

Every commerce operation follows this lifecycle. No exceptions.

```
                     ┌─────────────────┐
                     │  INTENT PHASE   │
                     └────────┬────────┘
                              │
                     Intent(Active)
                              │
           ┌──────────────────┼──────────────────┐
           │                  │                  │
  Intent(Abandoned)  Intent(Converted)   Intent(Expired)
  [cart abandonment]          │
                              │
                     ┌────────▼────────┐
                     │ COMMITMENT PHASE│
                     └────────┬────────┘
                              │
                   Commitment(Draft)
                              │
              ┌───────────────┼───────────────┐
              │               │               │
    Commitment(Proposed) Commitment(Tendered) │
              │               │               │
              │    [auction closes,            │
              │     winning bid]               │
              │               │               │
              └───────────────┘               │
                      │                       │
            Commitment(Accepted) ◄────────────┘
                      │    ▲
                      │    │ [all parties
                      │    │  agree to terms]
                      ▼    │
            Commitment(Modified) ──► Commitment(Cancelled)
                      │
           ┌──────────┼──────────────────┐
           │          │                  │
  Commitment   Commitment(PartiallyFulfilled)  Commitment(Active)
  (Cancelled)         │                  │     [subscriptions]
                      │                  │
              ResolutionProcess          │ [recurring
                      │                  │  Fulfillments]
           ┌──────────┴──────────┐       │
           │                     │       │
    Substitute Accepted    Item Cancelled │
           │                     │       │
           └──────────┬──────────┘       │
                      │                  │
                      ▼                  │
             ┌────────────────┐          │
             │FULFILLMENT PHASE│         │
             └───────┬────────┘          │
                     │                   │
          Fulfillment(Planned)            │
                     │                   │
          Fulfillment(InProgress)         │
                     │                   │
        ┌────────────┼────────────────┐  │
        │            │                │  │
Fulfillment   Fulfillment(Completed)  │  │
(Failed)              │         Fulfillment(Reversed)
        │             ▼                │
  [retry or]  Commitment(Fulfilled)    │
  [cancel]             │         [return logistics]
                ┌──────┴──────┐        │
                │             │        │
          [end state] Commitment(Refunded) ◄──┘

Note: Commitment(Disputed) can be entered from Accepted,
Active, PartiallyFulfilled, or Fulfilled. It resolves to
Fulfilled, Refunded, or Cancelled depending on outcome.
Not shown above to preserve diagram clarity.
```

---

## Platform Mapping

The model does not require existing platforms to change their data
structures. Each platform implements a Warp adapter that translates
its native representation to the model. The mapping is mechanical —
given a platform's native data there is exactly one correct Warp
model mapping.

**Shopify:**
```
Cart                    → Intent(Active)
Abandoned Checkout      → Intent(Abandoned)
Order(pending)          → Commitment(Proposed)
Order(paid)             → Commitment(Accepted)
Order(fulfilled)        → Commitment(Fulfilled)
Order(refunded)         → Commitment(Refunded)
Fulfillment             → Fulfillment entity
Refund                  → new Commitment(parties reversed) + Fulfillment(Reversed)
Customer                → Party(Individual)
Product variant         → Value(PhysicalGood) with SKU
```

**SAP S/4HANA:**
```
Quotation               → Commitment(Draft → Proposed)
SalesOrder              → Commitment(Accepted)
DeliveryOrder           → Fulfillment(Planned)
GoodsIssue              → Fulfillment(InProgress)
GoodsReceipt            → Fulfillment(Completed)
CustomerReturn          → new Commitment(parties reversed)
FIDocument (payment)    → Fulfillment(MoneyTransfer)
BusinessPartner         → Party
Material                → Value(PhysicalGood)
Letter of Credit        → Party(Guarantor) with Capacity
```

**Odoo:**
```
sale.order(draft)       → Commitment(Draft)
sale.order(sent)        → Commitment(Proposed)
sale.order(sale)        → Commitment(Accepted)
sale.order(done)        → Commitment(Fulfilled)
stock.picking           → Fulfillment entity
account.move(invoice)   → Fulfillment(MoneyTransfer)
res.partner             → Party
product.product         → Value(PhysicalGood)
```

**WooCommerce:**
```
Cart                    → Intent(Active)
Order(pending)          → Commitment(Proposed)
Order(processing)       → Commitment(Accepted)
Order(completed)        → Commitment(Fulfilled)
Order(refunded)         → Commitment(Refunded)
Shipment                → Fulfillment(InProgress → Completed)
Customer                → Party(Individual)
Product                 → Value(PhysicalGood)
```

**Agora (Warp-native):**
```
Agora emits typed Warp model events natively.
No adapter required.
Every Agora commerce mutation emits directly to the Warp event bus.
cart.abandoned.v1       → Intent(Active → Abandoned)
order.placed.v1         → Commitment(Accepted)
fulfillment.shipped.v1  → Fulfillment(InProgress)
fulfillment.delivered.v1 → Fulfillment(Completed)
```

---

## The AI Contract

This section is addressed specifically to AI systems using the Warp
Commerce Model. It defines the formal boundary between what an AI agent
can determine from the model alone and what requires external judgment.

### What an AI agent CAN determine from the model alone:

- The precise current state of any commerce object
- The complete set of valid next state transitions
- Whether a proposed action violates any invariant
- The complete immutable history of any commerce object
- Which parties have which obligations at any point in time
- Whether a Commitment is at risk (delivery window approaching, payment overdue)
- The monetary implications of any Resolution Process candidate
- Whether a return Commitment satisfies the condition requirements
- The total value flowing across any Commitment tree
- Whether Invariant 1 (value conservation) holds across the system

### What an AI agent CANNOT determine from the model alone:

- The market price of any good (pricing is outside the model)
- Whether a party is trustworthy beyond their recorded capacity
- Whether a product is appropriate for a specific recipient
- Which Resolution Process candidate is best for the customer
- Whether a service was performed to satisfactory quality
- What the best next action is (strategy is outside the model)

The model provides state. Strategy is built on top of state.
An AI agent uses the model for state verification and uses its
own reasoning for strategy decisions. This separation is intentional.
A model that includes strategy is not a model — it is an opinionated system.

### The AI Verification Protocol:

Before taking any commerce action, an AI agent MUST:

1. Load the current state of all relevant commerce objects
2. Identify the proposed state transition
3. Verify the transition appears in the valid transitions list
4. Verify all CommitmentConditions for this transition are satisfied
5. Verify no invariant is violated by the transition
6. Record the transition with the AI system as actor (PartyType::System)

If any step fails the action is not taken. The failure reason is
returned to the human principal. This protocol makes AI commerce
actions auditable, debuggable, and formally correct by construction.

### Commerce mistakes that become impossible with the model:

- Fulfilling a Cancelled Commitment
  (Cancelled → any state is not in the valid transitions list)

- Cancelling a Fulfilled Commitment
  (Fulfilled → Cancelled is not in the valid transitions list)

- Adding MAD and EUR without conversion
  (Money always carries currency, mixed-currency operations require
  explicit CurrencyConversion in CommitmentTerms)

- Sending WhatsApp to an unvalidated phone
  (PhoneNumber is a distinct type from String in the Warp type system
  derived from this model; the compiler catches this)

- Creating a Commitment for a customer in Disputed state
  (Capacity.can_buy is false while an active Dispute exists)

- Accepting a Commitment when inventory is Speculative
  without recording the basis
  (ReservationBasis is a required field on Reserved ValueState)

---

## Formal Sufficiency Test

The model is sufficient if for any commerce operation O that has ever
occurred on any platform in any country:

1. O can be expressed as a sequence of valid state transitions
2. The mapping from O to model states is unique and mechanical
3. The six invariants hold throughout the sequence
4. No concept outside the five primitives is required to represent O

**Test results to date:**

The following domains have been tested adversarially. All passed.

```
Physical goods e-commerce:
  ✓ Amazon (1P, 3P FBA, 3P FBM, mixed order)
  ✓ Alibaba (B2B, Letter of Credit, multi-party trade finance)
  ✓ Temu/Shein (dropshipping, speculative inventory, made-to-order)
  ✓ Net-a-Porter (luxury, authentication, provenance, white glove)
  
Multi-recipient commerce:
  ✓ Multi-recipient gifting with three addresses
  ✓ Stock failure with platform and vendor substitutes
  ✓ Price changes affecting total order value
  ✓ Returns at different locations from delivery locations
  
Physical retail POS:
  ✓ Simple cash transaction
  ✓ Multi-store chain with inventory transfer
  ✓ Franchise model with different legal entities
  ✓ Split payment (loyalty points + card + cash)
  ✓ Staff discount
  ✓ Same-visit return with partial refund routing
  ✓ Multi-currency (MAD, DZD, TND)
  ✓ Unified commerce (online intent → in-store purchase → partner pickup return)
  
Services:
  ✓ Simple appointment with no-show policy
  ✓ Multi-session service package
  ✓ Subscription with failed payment grace period
  ✓ Gig economy with surge pricing (estimated money)
  ✓ B2B consulting with milestone deliverables and acceptance
  
Financial commerce:
  ✓ BNPL with installment schedule
  ✓ Interest-bearing loan (money-to-money Commitment)
  ✓ Insurance (contingent value, trigger-based delivery)
  ✓ Escrow (three-party, release condition)
  ✓ Currency exchange (simultaneous payment)
  
Digital commerce:
  ✓ Software license (perpetual, seat-limited)
  ✓ Streaming subscription with access suspension
  ✓ API access with metered billing and overage
  ✓ NFT ownership and resale with artist royalty
  ✓ Open source dual-license (personal vs commercial)

Market-making commerce:
  ✓ English auction (ascending bids, reserve price, outbid supersession)
  ✓ Dutch auction (descending price, first-accept)
  ✓ Sealed bid auction (Vickrey pricing)
  ✓ Prediction markets (contingent value, probability-based payout)
  ✓ Two-sided marketplace matching (matching is infrastructure,
      Commitment is the model's entry point)
  ✓ Derivatives — forward contracts (future delivery at fixed price)
  ✓ Derivatives — options (contingent value, exercisable right)
  ✓ Tradeable derivatives (exclusive digital good representing the right)
  ✓ Collateral lending chains (collateral as CommitmentCondition,
      securitization as Commitment with DigitalGood subject)

Real estate commerce:
  ✓ Standard residential purchase with financing contingency
  ✓ Financing contingency failure — deposit return
  ✓ Full closing with simultaneous three-party money flows
  ✓ Title transfer via notarial deed and land registry
  ✓ Property inspection contingency with repair negotiation

Healthcare commerce:
  ✓ Insured medical visit — post-fulfillment insurance adjudication
  ✓ Split payment (patient copay + insurer payment)
  ✓ Price finalization after service delivery (not before)
  ✓ Prescription pharmaceutical with regulatory gate
  ✓ No-return policy for medical goods

Government and public procurement:
  ✓ Scored selection with weighted criteria (not just price)
  ✓ Minimum technical threshold — disqualification
  ✓ Award protest mechanism — upheld and dismissed
  ✓ Compliance documentation requirements
  ✓ Publication requirements for results

Wholesale and distribution:
  ✓ Blanket purchase order — Active parent, recurring child Commitments
  ✓ Volume pricing with year-end true-up
  ✓ Net 30/60/90 credit terms
  ✓ Quantity flexibility — call-off within agreed range
  ✓ Recurring physical delivery schedule

Marketplace platforms with commission:
  ✓ Double-sided commission (fee from buyer AND seller)
  ✓ Platform holds funds, disburses after service delivery
  ✓ Value conservation verified: guest paid = host received + platform fee
  ✓ Single-sided commission variant

Cross-border trade finance:
  ✓ Documentary collection — bank holds title documents
  ✓ Documents-against-payment timing
  ✓ Customs clearance as government intermediary release
  ✓ Required documents as CommitmentTerm
  ✓ Title documents as Exclusive DigitalGood with escrow pattern

Event and entertainment commerce:
  ✓ Perishable ticket — EventAccess with expiry at EventEnd
  ✓ Non-transferable ticket restriction
  ✓ Event cancellation with cascade to all child Commitments
  ✓ Force majeure — simultaneous mass cancellation + refund
  ✓ Postponement with customer choice

Loyalty and rewards programs:
  ✓ Points earned on purchase — LoyaltyEarnTerm
  ✓ Points creation as controlled value creation (Invariant 1 fourth clause)
  ✓ Points redemption as standard Money transfer (CurrencyCode::Custom)
  ✓ Points expiry — ValueState::AccessExpired applies
  ✓ Split payment: cash + loyalty points

Social and group commerce:
  ✓ Group buying deal — ThresholdActivation
  ✓ Price tiers as group size increases
  ✓ Threshold not met — all pledges cancel
  ✓ Threshold met — all Tendered Commitments activate simultaneously

Environmental markets:
  ✓ Carbon credit purchase with registry verification
  ✓ Credit retirement — ValueState::Retired (terminal)
  ✓ Additionality verification as CommitmentCondition
  ✓ RetirementCertificate as Evidence type
  ✓ CarbonCredit as AccessModel variant
```

**Result: No test has required a sixth primitive.**

Across 40+ domains spanning every major category of human commercial
activity, the five primitives — Party, Value, Intent, Commitment,
Fulfillment — have been sufficient to represent every commerce operation
tested. All additions have been extensions to existing primitive
structures: new CommitmentConditions, new CommitmentTerms, new
DeliveryMethods, new PaymentTimings, new AccessModel variants,
new Evidence types, and new ValueStates. No new fundamental commerce
concept has been found that requires a sixth primitive.

The claim is evidence-based, not asserted: "no sixth primitive has
been found necessary across any tested domain."

---

## Changelog

### v0.3 (2026-06-11) — Full commerce vocabulary

Ten additional domains tested. All held. No sixth primitive found.
40+ domains total across all major categories of human commerce.

New DeliveryMethod variants:
  TitleTransfer (real estate, legal ownership via notarial deed)
  RecurringDelivery (wholesale blanket POs, scheduled shipments)
  CustomsRelease (cross-border, government-controlled release)
  RegistryRetirement (carbon credits, permanent consumption)

New AccessModel variants on DigitalGood:
  EventAccess (perishable tickets, entry window, expiry at EventEnd)
  DocumentaryCollection (trade finance, bank-held title documents)
  CarbonCredit (verified environmental instrument, retirable)

New PaymentTiming variants:
  PostFulfillment (healthcare insurance adjudication after service)
  DocumentsAgainstPayment (trade finance, document release on payment)
  Net (B2B credit terms: Net30/Net60/Net90)
  CommissionSplit (marketplace platforms, single and double-sided)

New CommitmentCondition variants:
  FinancingContingency (real estate, conditional on lender)
  InspectionContingency (real estate, property condition gate)
  PrescriptionRequired (healthcare, regulatory requirement)
  RegistryVerification (carbon credits, title deeds)
  ThresholdActivation (group buying, crowdfunding)
  ComplianceDocumentation (government procurement)
  NoReturnPolicy (healthcare, irreversible services)
  EventCancellationPolicy (event commerce, force majeure)

New CommitmentTerms:
  CascadeCancellation (event cancellation propagates to children)
  VolumePricing (wholesale, tiered pricing with year-end true-up)
  LoyaltyEarnTerm (loyalty programs, point accrual on purchase)
  RequiredDocuments (trade finance, documentary requirements)

New ValueState:
  Retired — terminal state for permanently consumed exclusive goods

New Evidence types:
  RegistryRecording (real estate, land registry recording)
  MedicalRecord (healthcare, service delivery evidence)
  RetirementCertificate (carbon credits, permanent retirement proof)

New AuctionMechanism variant:
  ScoredSelection (government procurement, weighted multi-criteria)

New auxiliary record:
  AwardProtest (government procurement challenge mechanism)

Invariant 1 — fourth clause added:
  Loyalty points and merchant-issued currency are the only ValueForm
  where value creation (not transfer) is the primary operation.
  Conservation applies to the issuer's total outstanding liability.

### v0.2 (2026-05-29) — Market-making commerce incorporated

- Added CommitmentState::Tendered for open-offer Commitments
  where counterparty is determined by a mechanism (auction)
  rather than by direct negotiation
- Added CommitmentState::Tendered transitions to valid transitions table
- Added ValueState::UnderAuction for values subject to active
  auction processes — prevents simultaneous reservation
- Added AuctionProcess auxiliary coordination record with four
  mechanism variants: English, Dutch, SealedBid, Vickrey
- Added full auction flow example showing Value, Commitment,
  and AuctionProcess interactions
- Fixed lifecycle diagram: Added Modified → Accepted loop
  (was in transitions table but missing from diagram)
- Fixed lifecycle diagram: Added Tendered state and its transitions
- Updated Five Primitives section: explicit statement that
  market-making commerce holds within five primitives
- Added "pricing outside the model" boundary note with honest
  explanation of consequence for auctions and dynamic pricing
- Updated Formal Sufficiency Test: added market-making domain
  results including all auction types, prediction markets,
  derivatives, two-sided matching, and collateral lending
- Weakened sufficiency claim from absolute to evidence-based:
  "no sixth primitive has been found necessary" rather than
  "no sixth primitive is needed"

### v0.1 (2026-05-29) — First complete draft

- Five primitives defined: Party, Value, Intent, Commitment, Fulfillment
- Six invariants stated
- Commerce lifecycle state machine
- Platform mappings: Shopify, SAP, Odoo, WooCommerce, Agora
- AI contract with verification protocol and impossible mistakes list
- Formal sufficiency test with complete domain test results
- All extensions from adversarial testing incorporated

---

## What Is Not In This Model

These exclusions are deliberate. Not oversights.

**Pricing and discount calculation** — how a seller determines the Money
they request. The model sees only the final Money value, not how it
was calculated.

**Inventory management** — how a seller tracks Value across all their
Commitments. The model sees ValueState for specific items, not the
seller's inventory system.

**Fraud detection** — whether a party's claimed capacity is truthful.
The model assumes parties accurately represent capacity. Fraud detection
validates those representations before they enter the model.

**Marketing and demand generation** — how Intents are created. The model
sees the Intent once it exists, not what caused it.

**Tax and compliance** — jurisdiction-specific additional obligations.
Tax is an additional Value transfer to a Guarantor party (government)
that follows the same model primitives but is governed by external rules.

**Recommendation and personalization** — which goods to offer to which
customers. This is strategy built on top of the model's state.

**Search and discovery** — how parties find goods and services.
Pre-commerce. The model activates when Intent forms.

A model that includes everything models nothing precisely.
These boundaries are where the model ends and the systems built
on top of it begin.

---

*This document is maintained by Lamar Tech Solutions.*
*Built in Casablanca, Morocco. 2026.*
*The commerce language.*
