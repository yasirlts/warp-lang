"""Mirrors the TS bug-fixes.test.ts (the v0.3.1 audit-confirmed fixes), plus the
v1.0.0 MoneyBreakdown sum validator and the loyalty-liability clause.

BUG 1 — three-decimal currencies (TND/BHD/...) must use factor 1000, not 100.
BUG 2 — adapters synthesize valid histories so the package's own audit passes.
BUG 3 — Invariant 6 uses minor-unit tolerance, and allocate() splits exactly.
"""
import pytest

from warp_commerce_types import (
    Money,
    MoneyBreakdown,
    allocate,
    audit_commerce,
    check_i6_tree_consistency,
    check_loyalty_liability,
    minor_unit_factor,
    new_commitment,
    value_id,
)
from warp_commerce_types.money import CurrencyMismatchError
from warp_commerce_types.platforms.shopify import (
    ShopifyOrder,
    from_shopify_customer,
    from_shopify_fulfillment,
    from_shopify_order,
    ShopifyFulfillment,
)
from warp_commerce_types.platforms.stripe import from_stripe_amount, to_stripe_amount


def money_commitment(cid, amount, currency="MAD"):
    c = new_commitment("buyer", "seller")
    data = c.model_dump(by_alias=True)
    data["id"] = cid
    data["subject"] = {
        "offered": [],
        "requested": [money_value(amount, currency)],
    }
    return type(c).model_validate(data)


def money_value(amount, currency):
    return {
        "id": value_id(),
        "form": {"kind": "Money", "money": {"amount": amount, "currency": currency}},
        "quantity": 1,
        "state": {"type": "Available"},
    }


def sum_minor_units(parts, factor):
    return sum(round(p.amount * factor) for p in parts)


# --- BUG 1 -----------------------------------------------------------------

def test_tnd_round_trips_factor_1000():
    assert from_stripe_amount(1500, "TND") == Money(amount=1.5, currency="TND")
    assert to_stripe_amount(Money(amount=1.5, currency="TND"))["amount"] == 1500


def test_jpy_zero_decimal_factor_1():
    assert from_stripe_amount(1500, "JPY") == Money(amount=1500, currency="JPY")
    assert to_stripe_amount(Money(amount=1500, currency="JPY"))["amount"] == 1500


def test_usd_two_decimal_factor_100():
    assert from_stripe_amount(1500, "USD") == Money(amount=15, currency="USD")
    assert to_stripe_amount(Money(amount=15, currency="USD"))["amount"] == 1500


def test_to_stripe_amount_rounds_cleanly():
    assert to_stripe_amount(Money(amount=1.5, currency="BHD"))["amount"] == 1500  # BHD also 3-decimal


def test_no_div_100_bug_factors_are_per_currency():
    assert minor_unit_factor("TND") == 1000
    assert minor_unit_factor("JPY") == 1
    assert minor_unit_factor("USD") == 100


# --- BUG 2 -----------------------------------------------------------------

def test_paid_fulfilled_order_audits_with_zero_violations():
    order = ShopifyOrder(
        id="shopify-order-1", currency="MAD", total_price="100.00",
        financial_status="paid", fulfillment_status="fulfilled", customer={"id": "shopify-cust-1"},
    )
    commitment = from_shopify_order(order)
    fulfillment = from_shopify_fulfillment(
        ShopifyFulfillment(id="ful-1", order_id="shopify-order-1", status="success")
    )
    # A *verified* customer (can_buy) so Invariant 3 is satisfied.
    party = _verified_customer("shopify-cust-1")
    violations = audit_commerce([commitment], [fulfillment], [party])
    assert violations == []


def _verified_customer(cid):
    from warp_commerce_types.platforms.shopify import ShopifyCustomer

    base = from_shopify_customer(ShopifyCustomer(id=cid))
    data = base.model_dump(by_alias=True)
    data["capacity"]["can_buy"] = True
    return type(base).model_validate(data)


def test_synthesized_commitment_has_real_history_reaching_accepted():
    c = from_shopify_order(
        ShopifyOrder(id="o2", currency="MAD", total_price="10.00",
                     financial_status="paid", fulfillment_status="fulfilled", customer={"id": "c2"})
    )
    assert c.state.type == "Fulfilled"
    assert len(c.history) > 0
    assert any(h.to.type == "Accepted" for h in c.history)


# --- BUG 3 -----------------------------------------------------------------

def test_i6_float_tolerance_no_false_positive():
    parent = money_commitment("p", 0.3)
    c1 = money_commitment("c1", 0.1)
    c2 = money_commitment("c2", 0.2)
    assert check_i6_tree_consistency(parent, [c1, c2]) == []


def test_i6_real_discrepancy_still_flagged():
    parent = money_commitment("p", 750)
    c1 = money_commitment("c1", 500)
    c2 = money_commitment("c2", 240)
    assert len(check_i6_tree_consistency(parent, [c1, c2])) == 1


def test_allocate_03_mad_sums_exactly():
    parts = allocate(Money(amount=0.3, currency="MAD"), [1, 2])
    assert [p.amount for p in parts] == [0.1, 0.2]
    assert sum_minor_units(parts, 100) == 30


def test_allocate_100_mad_sums_exactly():
    parts = allocate(Money(amount=100, currency="MAD"), [1, 1, 1])
    assert sum_minor_units(parts, 100) == 10000
    assert len(parts) == 3
    assert sorted((p.amount for p in parts), reverse=True) == [33.34, 33.33, 33.33]


def test_allocate_respects_three_decimal_currency():
    parts = allocate(Money(amount=1, currency="TND"), [1, 1, 1])
    assert sum_minor_units(parts, 1000) == 1000


# --- v1.0.0 MoneyBreakdown sum validator (canonical money_breakdown_sum) -----
# NOTE: the canonical schema types MoneyComponent.kind as the MoneyComponentKind
# enum (Base / Tax / Discount / Shipping / Surcharge / Tip / Adjustment) — not a
# free string as B's bespoke schema had. The enforced canonical rule is exactly
# single-currency + sum-equals-total (Discount carries a negative amount that
# participates in the sum). It does NOT separately reject a positive-amount
# Discount, so B's discount-sign test is replaced by the canonical mixed-currency
# rejection (fixture money_breakdown_mixed_currency_component_is_rejected).

def test_money_breakdown_components_must_sum_to_total():
    # 80 + 30 = 110 != 100 — fails the money_breakdown_sum rule (not the enum).
    with pytest.raises(Exception) as ei:
        MoneyBreakdown.model_validate(
            {
                "components": [
                    {"kind": "Base", "amount": {"amount": 80, "currency": "MAD"}},
                    {"kind": "Tax", "amount": {"amount": 30, "currency": "MAD"}},
                ],
                "total": {"amount": 100, "currency": "MAD"},
            }
        )
    assert "money_breakdown_sum" in str(ei.value)


def test_money_breakdown_accepts_exact_sum_with_negative_discount():
    mb = MoneyBreakdown.model_validate(
        {
            "components": [
                {"kind": "Base", "amount": {"amount": 90, "currency": "MAD"}},
                {"kind": "Discount", "amount": {"amount": -10, "currency": "MAD"}},
                {"kind": "Tax", "amount": {"amount": 20, "currency": "MAD"}},
            ],
            "total": {"amount": 100, "currency": "MAD"},
        }
    )
    assert mb.total.amount == 100


def test_money_breakdown_mixed_currency_component_is_rejected():
    # Every component must share the total's currency (single-currency clause).
    with pytest.raises(Exception) as ei:
        MoneyBreakdown.model_validate(
            {
                "components": [
                    {"kind": "Base", "amount": {"amount": 100, "currency": "MAD"}},
                    {"kind": "Tax", "amount": {"amount": 0, "currency": "USD"}},
                ],
                "total": {"amount": 100, "currency": "MAD"},
            }
        )
    assert "mixed currencies" in str(ei.value)


# --- loyalty liability (Invariant 1, fourth clause) -------------------------

def test_loyalty_liability_unsustainable_and_sustainable():
    check = check_loyalty_liability(
        "merchant", 1_000_000, Money(amount=0.1, currency="MAD"), Money(amount=80_000, currency="MAD")
    )
    assert check.sustainable is False
    ok = check_loyalty_liability(
        "merchant", 100_000, Money(amount=0.1, currency="MAD"), Money(amount=80_000, currency="MAD")
    )
    assert ok.sustainable is True


def test_loyalty_liability_currency_mismatch_raises():
    with pytest.raises(CurrencyMismatchError):
        check_loyalty_liability(
            "merchant", 1000, Money(amount=0.1, currency="MAD"), Money(amount=100, currency="EUR")
        )
