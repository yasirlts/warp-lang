"""Interop CIR tests — mirror of the TypeScript interop suite."""
from warp_commerce_types import (
    to_shopify_action,
    to_stripe_action,
    to_woocommerce_action,
    unify,
    ProposedAction,
    UnifySource,
)
from warp_commerce_types.platforms.shopify import from_shopify_order, ShopifyOrder
from warp_commerce_types.platforms.stripe import from_stripe_payment_intent, StripePaymentIntent

shopify200 = from_shopify_order(ShopifyOrder(id="order_123", currency="MAD", total_price="200.00", financial_status="paid", fulfillment_status="fulfilled"))
stripe200 = from_stripe_payment_intent(StripePaymentIntent(id="pi_abc", amount=20000, currency="mad", status="succeeded"))


def refund(amount):
    return ProposedAction(commitment="order_123", to={"type": "Refunded", "amount": {"amount": amount, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor="agent")


# --- unify: mechanism, not discovery -----------------------------------------

def test_unify_merges_corresponded_sources_into_one_validated_commitment():
    u = unify([UnifySource("shopify", shopify200), UnifySource("stripe", stripe200)], {"id": "order_123"})
    assert u.ok is True
    assert u.commitment.id == "order_123"
    assert u.commitment.state.type == "Fulfilled"
    assert len(u.world.commitments) == 1


def test_unify_rejects_non_conserving_sources_i1():
    stripe150 = from_stripe_payment_intent(StripePaymentIntent(id="pi_bad", amount=15000, currency="mad", status="succeeded"))
    u = unify([UnifySource("shopify", shopify200), UnifySource("stripe", stripe150)])
    assert u.ok is False
    assert u.violations[0].rule == "I-1"
    assert "200" in u.violations[0].message and "150" in u.violations[0].message


def test_unify_does_not_auto_reconcile_a_mismatch():
    stripe999 = from_stripe_payment_intent(StripePaymentIntent(id="pi_x", amount=99900, currency="mad", status="succeeded"))
    u = unify([UnifySource("shopify", shopify200), UnifySource("stripe", stripe999)])
    assert u.ok is False  # surfaced, never silently reconciled


def test_correspondence_is_a_required_input_no_discovery():
    u = unify([UnifySource("shopify", shopify200)])
    assert u.ok is True
    assert len(u.world.commitments) == 1


def test_unify_rejects_empty():
    u = unify([])
    assert u.ok is False
    assert u.violations[0].rule == "unify-empty"


# --- outbound emission: validated descriptors, no execution ------------------

def test_stripe_refund_descriptor_minor_units():
    e = to_stripe_action(refund(40))
    assert e.ok is True
    assert e.descriptor == {"kind": "stripe.refund", "payment_intent": "order_123", "amount": 4000, "currency": "mad"}


def test_shopify_refund_descriptor_decimal():
    e = to_shopify_action(refund(40))
    assert e.ok is True
    assert e.descriptor == {"kind": "shopify.refund", "order_id": "order_123", "amount": "40", "currency": "MAD"}


def test_woocommerce_refund_descriptor():
    e = to_woocommerce_action(refund(40))
    assert e.ok is True
    assert e.descriptor["kind"] == "woocommerce.refund"


def test_cancel_descriptor():
    cancel = ProposedAction(commitment="order_123", to={"type": "Cancelled", "by": "agent", "reason": "x", "at": "2026-03-01T00:00:00.000Z"}, actor="agent")
    e = to_stripe_action(cancel)
    assert e.ok is True
    assert e.descriptor == {"kind": "stripe.cancel", "payment_intent": "order_123"}


def test_not_representable_returns_honest_result():
    accept = ProposedAction(commitment="order_123", to={"type": "Accepted"}, actor="agent")
    e = to_stripe_action(accept)
    assert e.ok is False
    assert "no faithful stripe equivalent" in e.reason
    assert "Accepted" in e.reason


def test_emitter_returns_plain_data_no_execution():
    # The descriptor is plain data (a dict) — no callables, nothing executed.
    e = to_woocommerce_action(refund(10))
    assert isinstance(e.descriptor, dict)
    assert not any(callable(v) for v in e.descriptor.values())
