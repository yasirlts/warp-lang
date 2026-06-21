"""Warp as the neutral model between platforms: map each platform IN once, reason
in ONE model, emit a validated platform payload OUT — no auto-reconciliation, no
execution. Python twin of examples/cross-platform.mjs — same verdicts.

    python cross_platform.py
"""
from warp_commerce_types import guard_action, to_stripe_action, unify, ProposedAction, UnifySource
from warp_commerce_types.platforms.shopify import from_shopify_order, ShopifyOrder
from warp_commerce_types.platforms.stripe import from_stripe_payment_intent, StripePaymentIntent

# Two platform objects for the SAME transaction (the app knows they correspond —
# Warp does not discover this). Both 200 MAD.
shopify_order = from_shopify_order(ShopifyOrder(id="order_123", currency="MAD", total_price="200.00", financial_status="paid", fulfillment_status="fulfilled"))
stripe_charge = from_stripe_payment_intent(StripePaymentIntent(id="pi_abc", amount=20000, currency="mad", status="succeeded"))

# INBOUND unification — the caller ASSERTS correspondence by passing them together.
unified = unify([UnifySource("shopify", shopify_order), UnifySource("stripe", stripe_charge)], {"id": "order_123"})
print("unify (200 MAD == 200 MAD) → ok: %s, one commitment '%s' in state %s" % (
    unified.ok, unified.commitment.id if unified.ok else "-", unified.commitment.state.type if unified.ok else "-"))

if unified.ok:
    world = unified.world

    # An agent over-refunds: 500 MAD against a 200 MAD order — caught with guidance.
    over = guard_action(world, ProposedAction(commitment="order_123", to={"type": "Refunded", "amount": {"amount": 500, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor="agent"))
    if not over.ok:
        refund_alt = next((a for a in over.alternatives if a.to == "Refunded"), None)
        print("\nover-refund 500 MAD → BLOCKED [%s]; Refunded bounded: %s" % (over.violations[0].rule, refund_alt.bounded if refund_alt else over.violations[0].fix))

    # A valid refund of 40 MAD: validate, then EMIT the Stripe-shaped descriptor.
    refund = ProposedAction(commitment="order_123", to={"type": "Refunded", "amount": {"amount": 40, "currency": "MAD"}, "at": "2026-02-01T00:00:00.000Z"}, actor="agent")
    verdict = guard_action(world, refund)
    print("\nvalid refund 40 MAD → accepted: %s" % verdict.ok)
    if verdict.ok:
        print("emit (no API call — a descriptor only):", to_stripe_action(refund).descriptor)

# INBOUND mismatch — a Shopify total and a Stripe amount that do NOT conserve.
stripe_short = from_stripe_payment_intent(StripePaymentIntent(id="pi_short", amount=15000, currency="mad", status="succeeded"))
mismatch = unify([UnifySource("shopify", shopify_order), UnifySource("stripe", stripe_short)])
if not mismatch.ok:
    print("\nunify (200 MAD vs 150 MAD) → BLOCKED [%s]: %s" % (mismatch.violations[0].rule, mismatch.violations[0].message))
