"""Shopify -> Warp model mappings. The mapping is mechanical: a Shopify order IS
a Commitment, a cart IS an Intent, a customer IS a Party. Minimal Shopify type
stubs are defined here so the package has no external dependencies.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel

from .._models import Commitment, CommitmentSubject, Fulfillment, Intent, Party, PartyLocale, Value
from ..primitives import (
    commitment_id,
    fulfillment_id,
    individual,
    new_commitment,
    new_fulfillment,
    new_intent,
    party_id,
    value_id,
)
from ..transitions import apply_commitment_path, apply_fulfillment_path

_ADAPTER_ACTOR = party_id("system:shopify-adapter")


class ShopifyCustomer(BaseModel):
    id: str
    email: Optional[str] = None


class ShopifyOrder(BaseModel):
    id: str
    currency: str
    total_price: str                # Shopify sends money as a decimal string
    financial_status: str           # pending | paid | refunded | voided
    fulfillment_status: Optional[str] = None  # unfulfilled | partial | fulfilled | None
    customer: Optional[ShopifyCustomer] = None


class ShopifyCart(BaseModel):
    token: str
    customer: Optional[ShopifyCustomer] = None


class ShopifyProduct(BaseModel):
    id: str
    sku: str
    title: Optional[str] = None


class ShopifyFulfillment(BaseModel):
    id: str
    order_id: str
    status: str                     # pending | open | success | cancelled | failure


def _order_state(order: ShopifyOrder) -> Dict[str, Any]:
    if order.fulfillment_status == "fulfilled":
        return {"type": "Fulfilled"}
    from ..primitives import now

    if order.financial_status == "pending":
        return {"type": "Proposed"}
    if order.financial_status == "paid":
        return {"type": "Accepted"}
    if order.financial_status == "refunded":
        return {"type": "Refunded", "amount": {"amount": float(order.total_price), "currency": order.currency}, "at": now()}
    # voided
    return {"type": "Cancelled", "by": party_id("shopify"), "reason": "voided", "at": now()}


def from_shopify_order(order: ShopifyOrder) -> Commitment:
    buyer = party_id(order.customer.id) if order.customer else party_id("shopify_guest")
    subject = CommitmentSubject.model_validate(
        {
            "offered": [],
            "requested": [
                {
                    "id": value_id(),
                    "form": {"kind": "Money", "money": {"amount": float(order.total_price), "currency": order.currency}},
                    "quantity": 1,
                    "state": {"type": "Available"},
                }
            ],
        }
    )
    draft = new_commitment(buyer, party_id("shopify_store")).model_copy(
        update={"id": commitment_id(order.id), "subject": subject}
    )
    return apply_commitment_path(draft, _order_state(order), _ADAPTER_ACTOR, "shopify-adapter")


def from_shopify_cart(cart: ShopifyCart) -> Intent:
    buyer = party_id(cart.customer.id) if cart.customer else party_id("shopify_guest")
    return new_intent(buyer).model_copy(update={"originated_from": cart.token})


def from_shopify_customer(customer: ShopifyCustomer) -> Party:
    return individual(
        party_id(customer.id),
        PartyLocale(language="en", currency="USD", jurisdiction="US"),
    )


def from_shopify_product(product: ShopifyProduct) -> Value:
    return Value.model_validate(
        {
            "id": value_id(product.id),
            "form": {"kind": "PhysicalGood", "sku": product.sku, "condition": "New"},
            "quantity": 1,
            "state": {"type": "Available"},
        }
    )


def from_shopify_fulfillment(f: ShopifyFulfillment) -> Fulfillment:
    base = new_fulfillment(commitment_id(f.order_id)).model_copy(update={"id": fulfillment_id(f.id)})
    from ..primitives import now

    if f.status == "success":
        target: Dict[str, Any] = {"type": "Completed"}
    elif f.status in ("open", "pending"):
        target = {"type": "InProgress"}
    elif f.status == "failure":
        target = {"type": "Failed", "reason": "shopify failure", "recoverable": True}
    else:  # cancelled
        target = {"type": "Reversed", "reason": "cancelled", "initiated_by": party_id("shopify"), "at": now()}
    return apply_fulfillment_path(base, target, _ADAPTER_ACTOR)


def to_shopify_order_status(state: Any) -> str:
    t = state["type"] if isinstance(state, dict) else state.type
    if t in ("Proposed", "Draft", "Tendered"):
        return "pending"
    if t in ("Accepted", "Active", "Modified", "PartiallyFulfilled"):
        return "paid"
    if t == "Fulfilled":
        return "fulfilled"
    if t == "Refunded":
        return "refunded"
    return "voided"  # Cancelled | Disputed


def to_shopify_line_item(value: Value) -> Dict[str, Any]:
    sku = value.form.sku if value.form.kind == "PhysicalGood" else ""
    return {"sku": sku, "quantity": value.quantity}
