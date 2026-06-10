/**
 * The five primitives of the Warp Commerce Model: Party, Value, Intent,
 * Commitment, Fulfillment — plus their branded identifiers and constructors.
 *
 * Derived from WARP_COMMERCE_MODEL.md v0.2. The state machines live in
 * `states.ts`; the transition rules live in `transitions.ts`.
 */

import type { CurrencyCode, Money } from "./money.js";
import type { CommitmentState, FulfillmentState, IntentState } from "./states.js";

// ---------------------------------------------------------------------------
// Branded identifiers — globally unique, immutable (Invariant 5).
// ---------------------------------------------------------------------------

export type PartyID = string & { readonly __brand: "PartyID" };
export type IntentID = string & { readonly __brand: "IntentID" };
export type CommitmentID = string & { readonly __brand: "CommitmentID" };
export type FulfillmentID = string & { readonly __brand: "FulfillmentID" };
export type ValueID = string & { readonly __brand: "ValueID" };

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for runtimes without crypto.randomUUID (ids are identifiers,
  // not security tokens, so a Math.random RFC-4122-shaped value suffices).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Current instant as an ISO 8601 string (UTC). */
export function now(): string {
  return new Date().toISOString();
}

/** Construct a PartyID. Validates non-empty, max 256 chars (any format). */
export function partyId(value: string): PartyID {
  if (value.length === 0) throw new Error("PartyID cannot be empty");
  if (value.length > 256) throw new Error("PartyID exceeds 256 characters");
  return value as PartyID;
}

/** Construct an IntentID — generates a UUID v4 when no value is given. */
export function intentId(value?: string): IntentID {
  const v = value ?? uuid();
  if (v.length === 0) throw new Error("IntentID cannot be empty");
  return v as IntentID;
}

/** Construct a CommitmentID — generates a UUID v4 when no value is given. */
export function commitmentId(value?: string): CommitmentID {
  const v = value ?? uuid();
  if (v.length === 0) throw new Error("CommitmentID cannot be empty");
  return v as CommitmentID;
}

/** Construct a FulfillmentID — generates a UUID v4 when no value is given. */
export function fulfillmentId(value?: string): FulfillmentID {
  const v = value ?? uuid();
  if (v.length === 0) throw new Error("FulfillmentID cannot be empty");
  return v as FulfillmentID;
}

/** Construct a ValueID — generates a UUID v4 when no value is given. */
export function valueId(value?: string): ValueID {
  const v = value ?? uuid();
  if (v.length === 0) throw new Error("ValueID cannot be empty");
  return v as ValueID;
}

// ---------------------------------------------------------------------------
// Primitive 1 — Party
// ---------------------------------------------------------------------------

export type PartyType = "Individual" | "Organization" | "System";

export type PartyRole = "Initiator" | "Counterparty" | "Intermediary" | "Fulfiller" | "Guarantor";

export interface PartyLocale {
  language: string; // BCP 47, e.g. "fr-MA"
  currency: CurrencyCode; // ISO 4217
  jurisdiction: string; // ISO 3166-1 alpha-2, e.g. "MA"
}

export interface PartyCapacity {
  can_buy: boolean;
  can_sell: boolean;
  can_fulfill: boolean;
  can_guarantee: boolean;
  verified_at: string;
}

export interface Party {
  id: PartyID;
  party_type: PartyType;
  locale: PartyLocale;
  capacity: PartyCapacity;
}

/** Capacity with nothing verified yet — the safe default (Invariant 3). */
export function unverifiedCapacity(): PartyCapacity {
  return {
    can_buy: false,
    can_sell: false,
    can_fulfill: false,
    can_guarantee: false,
    verified_at: now(),
  };
}

export function individual(id: PartyID, locale: PartyLocale): Party {
  return { id, party_type: "Individual", locale, capacity: unverifiedCapacity() };
}

export function organization(id: PartyID, locale: PartyLocale): Party {
  return { id, party_type: "Organization", locale, capacity: unverifiedCapacity() };
}

export function system(id: PartyID): Party {
  return {
    id,
    party_type: "System",
    locale: { language: "en", currency: "USD", jurisdiction: "MA" },
    capacity: unverifiedCapacity(),
  };
}

// ---------------------------------------------------------------------------
// Primitive 2 — Value
// ---------------------------------------------------------------------------

export type Condition = "New" | "Used" | "Refurbished" | "Damaged" | "RequiresInspection";

export interface PhysicalGood {
  kind: "PhysicalGood";
  sku: string;
  condition: Condition;
  location?: string;
}

export type AccessModel =
  | { kind: "License"; license_type: "Perpetual" | "Subscription" | "Trial" | "OpenSource"; seats: number; transferable: boolean }
  | { kind: "Stream"; simultaneous_streams: number }
  | { kind: "Download"; redownloadable: boolean }
  | { kind: "APIAccess"; calls_per_period?: number; endpoint: string }
  | { kind: "NFT"; blockchain: string; contract_address: string; token_id: string };

export interface DigitalGood {
  kind: "DigitalGood";
  identifier: string;
  exclusivity: "Exclusive" | "NonExclusive";
  access_model: AccessModel;
}

export interface ServiceDelivery {
  location: "Physical" | "Remote" | "Either";
  performer?: PartyID;
}

export interface ServiceValue {
  kind: "Service";
  identifier: string;
  delivery_model: ServiceDelivery;
}

export interface MoneyValue {
  kind: "Money";
  money: Money;
}

export interface NothingValue {
  kind: "Nothing";
}

export type ValueForm = PhysicalGood | DigitalGood | ServiceValue | MoneyValue | NothingValue;

export type ReservationBasis =
  | "PhysicalStock"
  | "ProductionCapacity"
  | "TimeSlot"
  | "RecurringTimeSlot"
  | "DriverCapacity"
  | "Speculative";

export type ValueState =
  | { type: "Available" }
  | { type: "Reserved"; commitment_id: CommitmentID; basis: ReservationBasis }
  | { type: "UnderAuction"; auction_process_id: string; closes_at: string }
  | { type: "Committed"; commitment_id: CommitmentID }
  | { type: "InTransit"; fulfillment_id: FulfillmentID }
  | { type: "Transferred"; to: PartyID; at: string }
  | { type: "Returned"; from: PartyID; initiated_at: string };

export interface Value {
  id: ValueID;
  form: ValueForm;
  quantity: number;
  state: ValueState;
}

// ---------------------------------------------------------------------------
// Primitive 3 — Intent
// ---------------------------------------------------------------------------

export interface IntentTransition {
  from: IntentState;
  to: IntentState;
  at: string;
  actor: PartyID;
  reason?: string;
}

export interface Intent {
  id: IntentID;
  party: PartyID;
  state: IntentState;
  history: IntentTransition[];
  created_at: string;
  expires_at?: string;
  originated_from?: string;
}

export function newIntent(party: PartyID): Intent {
  return { id: intentId(), party, state: { type: "Active" }, history: [], created_at: now() };
}

// ---------------------------------------------------------------------------
// Primitive 4 — Commitment
// ---------------------------------------------------------------------------

export interface CommitmentParties {
  initiator: PartyID;
  counterparty: PartyID;
  intermediaries: PartyID[];
}

export interface CommitmentSubject {
  offered: Value[];
  requested: Value[];
}

export interface CommitmentTransition {
  from: CommitmentState;
  to: CommitmentState;
  at: string;
  actor: PartyID;
  reason?: string;
}

export interface Commitment {
  id: CommitmentID;
  parties: CommitmentParties;
  subject: CommitmentSubject;
  state: CommitmentState;
  history: CommitmentTransition[];
  parent?: CommitmentID;
  children: CommitmentID[];
  originated_from?: IntentID;
  created_at: string;
  expires_at?: string;
}

export function newCommitment(
  initiator: PartyID,
  counterparty: PartyID,
  subject?: CommitmentSubject,
): Commitment {
  return {
    id: commitmentId(),
    parties: { initiator, counterparty, intermediaries: [] },
    subject: subject ?? { offered: [], requested: [] },
    state: { type: "Draft" },
    history: [],
    children: [],
    created_at: now(),
  };
}

// ---------------------------------------------------------------------------
// Primitive 5 — Fulfillment
// ---------------------------------------------------------------------------

export interface FulfillmentTransition {
  from: FulfillmentState;
  to: FulfillmentState;
  at: string;
  actor: PartyID;
}

export interface Fulfillment {
  id: FulfillmentID;
  commitment: CommitmentID;
  state: FulfillmentState;
  history: FulfillmentTransition[];
  planned_at: string;
  started_at?: string;
  completed_at?: string;
}

export function newFulfillment(commitment: CommitmentID): Fulfillment {
  return {
    id: fulfillmentId(),
    commitment,
    state: { type: "Planned" },
    history: [],
    planned_at: now(),
  };
}
