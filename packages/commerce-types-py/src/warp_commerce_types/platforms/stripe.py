"""Stripe -> Warp model mappings. Stripe represents money in the smallest
currency unit (cents for USD, no decimals for JPY, millimes x1000 for TND); the
mapping converts to and from Warp's decimal ``Money`` correctly per currency,
reusing the minor-unit logic in ``money`` (factor = 10 ** decimals, never /100).
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel

from .._models import Commitment, CommitmentSubject, Money, Party, PartyLocale, Value
from ..money import minor_unit_factor
from ..primitives import commitment_id, individual, new_commitment, party_id, value_id
from ..transitions import apply_commitment_path

# The synthetic party recorded as the actor of adapter-built history entries.
_ADAPTER_ACTOR = party_id("system:stripe-adapter")


class StripePaymentIntent(BaseModel):
    id: str
    amount: int            # smallest currency unit
    currency: str          # lowercase ISO code
    status: str            # requires_payment_method | requires_confirmation | processing | succeeded | canceled
    customer: Optional[str] = None


class StripeCustomer(BaseModel):
    id: str
    email: Optional[str] = None


class StripePrice(BaseModel):
    id: str
    unit_amount: int       # smallest currency unit
    currency: str


def from_stripe_amount(amount: int, currency: str) -> Money:
    """Convert a Stripe minor-unit amount into Warp ``Money``."""
    return Money(amount=amount / minor_unit_factor(currency), currency=currency.upper())


def to_stripe_amount(money: Money) -> Dict[str, Any]:
    """Convert Warp ``Money`` into a Stripe ``{amount, currency}``. Rounds to an
    integer after scaling so ``1.5 * 1000`` is exactly ``1500``, never ``1499.9999``."""
    return {
        "amount": round(money.amount * minor_unit_factor(money.currency)),
        "currency": money.currency.lower(),
    }


def _intent_state(pi: StripePaymentIntent) -> Dict[str, Any]:
    if pi.status in ("requires_payment_method", "requires_confirmation", "processing"):
        return {"type": "Proposed"}
    if pi.status == "succeeded":
        return {"type": "Accepted"}
    # canceled
    from ..primitives import now

    return {"type": "Cancelled", "by": party_id("stripe"), "reason": "canceled", "at": now()}


def from_stripe_payment_intent(pi: StripePaymentIntent) -> Commitment:
    buyer = party_id(pi.customer) if pi.customer else party_id("stripe_guest")
    subject = CommitmentSubject.model_validate(
        {
            "offered": [],
            "requested": [
                {
                    "id": value_id(),
                    "form": {"kind": "Money", "money": from_stripe_amount(pi.amount, pi.currency)},
                    "quantity": 1,
                    "state": {"type": "Available"},
                }
            ],
        }
    )
    draft = new_commitment(buyer, party_id("stripe_merchant")).model_copy(
        update={"id": commitment_id(pi.id), "subject": subject}
    )
    return apply_commitment_path(draft, _intent_state(pi), _ADAPTER_ACTOR, "stripe-adapter")


def from_stripe_customer(customer: StripeCustomer) -> Party:
    return individual(
        party_id(customer.id),
        PartyLocale(language="en", currency="USD", jurisdiction="US"),
    )


def from_stripe_price(price: StripePrice) -> Value:
    return Value.model_validate(
        {
            "id": value_id(price.id),
            "form": {"kind": "Money", "money": from_stripe_amount(price.unit_amount, price.currency)},
            "quantity": 1,
            "state": {"type": "Available"},
        }
    )
