"""Constructors and identifier helpers for the five primitives (Party, Value,
Intent, Commitment, Fulfillment).

The data shapes themselves are generated from the schema (see ``_models``); this
module adds the ergonomic constructors and the branded-id factories that the TS
binding exposes from ``primitives.ts``.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from ._models import (
    Commitment,
    CommitmentParties,
    CommitmentSubject,
    Fulfillment,
    Intent,
    Party,
    PartyCapacity,
    PartyLocale,
)


def now() -> str:
    """Current instant as an ISO-8601 string (UTC)."""
    return datetime.now(timezone.utc).isoformat()


def _uuid() -> str:
    return str(uuid.uuid4())


# --- branded identifiers (Invariant 5: globally unique, immutable) ----------

def party_id(value: str) -> str:
    """Construct a PartyID. Validates non-empty, max 256 chars (any format)."""
    if len(value) == 0:
        raise ValueError("PartyID cannot be empty")
    if len(value) > 256:
        raise ValueError("PartyID exceeds 256 characters")
    return value


def intent_id(value: Optional[str] = None) -> str:
    """Construct an IntentID — generates a UUID v4 when no value is given."""
    v = value if value is not None else _uuid()
    if len(v) == 0:
        raise ValueError("IntentID cannot be empty")
    return v


def commitment_id(value: Optional[str] = None) -> str:
    """Construct a CommitmentID — generates a UUID v4 when no value is given."""
    v = value if value is not None else _uuid()
    if len(v) == 0:
        raise ValueError("CommitmentID cannot be empty")
    return v


def fulfillment_id(value: Optional[str] = None) -> str:
    """Construct a FulfillmentID — generates a UUID v4 when no value is given."""
    v = value if value is not None else _uuid()
    if len(v) == 0:
        raise ValueError("FulfillmentID cannot be empty")
    return v


def value_id(value: Optional[str] = None) -> str:
    """Construct a ValueID — generates a UUID v4 when no value is given."""
    v = value if value is not None else _uuid()
    if len(v) == 0:
        raise ValueError("ValueID cannot be empty")
    return v


# --- Party ------------------------------------------------------------------

def unverified_capacity() -> PartyCapacity:
    """Capacity with nothing verified yet — the safe default (Invariant 3)."""
    return PartyCapacity(
        can_buy=False,
        can_sell=False,
        can_fulfill=False,
        can_guarantee=False,
        verified_at=now(),
    )


def individual(id: str, locale: PartyLocale) -> Party:
    return Party(id=id, party_type="Individual", locale=locale, capacity=unverified_capacity())


def organization(id: str, locale: PartyLocale) -> Party:
    return Party(id=id, party_type="Organization", locale=locale, capacity=unverified_capacity())


def system(id: str) -> Party:
    return Party(
        id=id,
        party_type="System",
        locale=PartyLocale(language="en", currency="USD", jurisdiction="MA"),
        capacity=unverified_capacity(),
    )


# --- Intent / Commitment / Fulfillment --------------------------------------

def new_intent(party: str) -> Intent:
    return Intent(id=intent_id(), party=party, state={"type": "Active"}, history=[], created_at=now())


def new_commitment(
    initiator: str,
    counterparty: str,
    subject: Optional[CommitmentSubject] = None,
) -> Commitment:
    return Commitment(
        id=commitment_id(),
        parties=CommitmentParties(initiator=initiator, counterparty=counterparty, intermediaries=[]),
        subject=subject if subject is not None else CommitmentSubject(offered=[], requested=[]),
        state={"type": "Draft"},
        history=[],
        children=[],
        created_at=now(),
    )


def new_fulfillment(commitment: str) -> Fulfillment:
    return Fulfillment(
        id=fulfillment_id(),
        commitment=commitment,
        state={"type": "Planned"},
        history=[],
        planned_at=now(),
    )
