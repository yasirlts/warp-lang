/**
 * The five primitives of the Warp Commerce Model: Party, Value, Intent,
 * Commitment, Fulfillment — plus their branded identifiers and constructors.
 *
 * The TYPES are generated from the canonical schema
 * (`schema/structure/party|value|intent|commitment|fulfillment.schema.json`) —
 * see `./generated/types.generated.ts`. This module re-exports them under the
 * names the package has always used and keeps the hand-written constructors and
 * id helpers, which the schema deliberately does not carry. The state machines
 * live in `states.ts`; the transition rules live in `transitions.ts`.
 */

import type {
  Commitment,
  CommitmentID,
  CommitmentSubject,
  Fulfillment,
  FulfillmentID,
  Intent,
  IntentID,
  Party,
  PartyCapacity,
  PartyID,
  PartyLocale,
  ValueID,
} from "./generated/types.generated.js";

// Re-export every primitive type the package exposes — generated from schema,
// branded ids re-applied by the generator (Invariant 5).
export type {
  // Branded identifiers — globally unique, immutable (Invariant 5).
  PartyID,
  IntentID,
  CommitmentID,
  FulfillmentID,
  ValueID,
  // Primitive 1 — Party
  PartyType,
  PartyRole,
  PartyLocale,
  PartyCapacity,
  Party,
  // Primitive 2 — Value
  Condition,
  PhysicalGood,
  AccessModel,
  DigitalGood,
  ServiceDelivery,
  ServiceValue,
  MoneyValue,
  NothingValue,
  ContingentValue,
  ValueForm,
  Quantity,
  ReservationBasis,
  ValueState,
  Value,
  // Primitive 3 — Intent
  IntentTransition,
  Intent,
  // Primitive 4 — Commitment
  CommitmentParties,
  CommitmentSubject,
  CommitmentTransition,
  Commitment,
  // Primitive 5 — Fulfillment
  FulfillmentTransition,
  Fulfillment,
} from "./generated/types.generated.js";

// ---------------------------------------------------------------------------
// Branded-identifier constructors — globally unique, immutable (Invariant 5).
// ---------------------------------------------------------------------------

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
// Primitive 1 — Party constructors
// ---------------------------------------------------------------------------

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
// Primitive 3 — Intent constructor
// ---------------------------------------------------------------------------

export function newIntent(party: PartyID): Intent {
  return { id: intentId(), party, state: { type: "Active" }, history: [], created_at: now() };
}

// ---------------------------------------------------------------------------
// Primitive 4 — Commitment constructor
// ---------------------------------------------------------------------------

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
// Primitive 5 — Fulfillment constructor
// ---------------------------------------------------------------------------

export function newFulfillment(commitment: CommitmentID): Fulfillment {
  return {
    id: fulfillmentId(),
    commitment,
    state: { type: "Planned" },
    history: [],
    planned_at: now(),
  };
}
