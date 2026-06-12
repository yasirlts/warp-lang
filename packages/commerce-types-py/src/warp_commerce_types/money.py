"""Money — the typed monetary value of the Warp Commerce Model (Primitive 2:
Value -> ValueForm -> Money). Money ALWAYS carries its currency; there is no
amount without a denomination, so accidental currency mixing is caught rather
than silently allowed: you cannot add MAD to EUR.

Minor-unit-aware arithmetic is the substrate for exact money math (it avoids the
``0.1 + 0.2 != 0.3`` class of float bug). Currencies are 0-, 2-, or 3-decimal;
the factor between a whole unit and its minor unit is ``10 ** decimals`` — NOT a
hardcoded ``/ 100`` (that was the bug that made every TND amount 10x wrong).
"""
from __future__ import annotations

from typing import List

from ._data import invariants as _invariants
from ._models import Money, MoneyBreakdown

# Currencies with no minor unit — the amount is already the whole unit.
ZERO_DECIMAL_CURRENCIES = frozenset(
    {"JPY", "KRW", "VND", "CLP", "ISK", "XAF", "XOF", "XPF", "BIF", "DJF",
     "GNF", "KMF", "MGA", "PYG", "RWF", "UGX", "VUV"}
)
# Currencies with THREE minor digits (millimes/fils): whole unit x 1000, not x100.
THREE_DECIMAL_CURRENCIES = frozenset({"TND", "BHD", "KWD", "OMR", "JOD"})


class CurrencyMismatchError(Exception):
    """Raised when an operation would combine two different currencies."""

    def __init__(self, left: str, right: str) -> None:
        self.left = left
        self.right = right
        super().__init__(
            "Cannot operate on mixed currencies: %s and %s. "
            "Use convert() first (Invariant 1: Value Conservation)." % (left, right)
        )


def currency_decimals(currency: str) -> int:
    """Number of minor-unit digits for a currency: 0, 3, or the default 2."""
    c = currency.upper()
    if c in ZERO_DECIMAL_CURRENCIES:
        return 0
    if c in THREE_DECIMAL_CURRENCIES:
        return 3
    return 2


def minor_unit_factor(currency: str) -> int:
    """The integer factor between a currency's whole unit and its minor unit:
    1 (zero-decimal), 1000 (three-decimal), or 100 (default two-decimal)."""
    return 10 ** currency_decimals(currency)


def money_epsilon(currency: str) -> float:
    """Half the smallest minor unit of ``currency`` — the tolerance for equality.
    For USD (2 decimals) this is 0.005; any difference smaller than half a cent is
    float noise, not a real discrepancy."""
    return 0.5 * (10 ** -currency_decimals(currency))


def money_equals(a: float, b: float, currency: str) -> bool:
    """True if ``a`` and ``b`` are equal within ``currency``'s minor-unit tolerance."""
    return abs(a - b) < money_epsilon(currency)


def zero(currency: str) -> Money:
    """A zero amount in ``currency``."""
    return Money(amount=0.0, currency=currency)


def add(a: Money, b: Money) -> Money:
    """Add two amounts of the same currency. Raises on mismatch — never silent."""
    if a.currency != b.currency:
        raise CurrencyMismatchError(a.currency, b.currency)
    return Money(amount=a.amount + b.amount, currency=a.currency)


def subtract(a: Money, b: Money) -> Money:
    """Subtract ``b`` from ``a`` (same currency). Raises on mismatch."""
    if a.currency != b.currency:
        raise CurrencyMismatchError(a.currency, b.currency)
    return Money(amount=a.amount - b.amount, currency=a.currency)


def convert(amount: Money, to: str, rate: float) -> Money:
    """Convert ``amount`` into ``to`` at an explicit ``rate`` (units of ``to`` per
    one unit of ``amount.currency``). Conversion is always explicit — there is no
    implicit FX in the model."""
    return Money(amount=amount.amount * rate, currency=to)


def compare(a: Money, b: Money) -> int:
    """Compare two amounts of the same currency (-1 / 0 / 1). Raises on mismatch."""
    if a.currency != b.currency:
        raise CurrencyMismatchError(a.currency, b.currency)
    if a.amount < b.amount:
        return -1
    if a.amount > b.amount:
        return 1
    return 0


def allocate(total: Money, weights: List[float]) -> List[Money]:
    """Split ``total`` into parts proportional to ``weights``, guaranteeing the
    parts sum **exactly** to ``total`` (in minor units). Largest-remainder method:
    floor each ideal share to whole minor units, then hand the leftover minor units
    one-by-one to the parts with the largest fractional remainders. This is how a
    parent commitment is split into children without violating Invariant 6 — naive
    ``total * w / sum`` rounding loses or gains a cent.

    Raises on an empty ``weights`` list or a non-positive weight sum.
    """
    if not weights:
        raise ValueError("allocate: weights must be non-empty")
    sum_w = sum(weights)
    if sum_w <= 0:
        raise ValueError("allocate: weights must sum to a positive number")

    factor = minor_unit_factor(total.currency)
    total_minor = round(total.amount * factor)

    ideal = [(total_minor * w) / sum_w for w in weights]
    minor = [int(x // 1) for x in ideal]  # floor toward zero for non-negative shares
    remainder = total_minor - sum(minor)

    by_fraction = sorted(
        range(len(ideal)), key=lambda i: ideal[i] - (ideal[i] // 1), reverse=True
    )
    k = 0
    while remainder > 0 and k < len(by_fraction):
        minor[by_fraction[k]] += 1
        remainder -= 1
        k += 1

    return [Money(amount=m / factor, currency=total.currency) for m in minor]


def format_money(amount: Money) -> str:
    """Human-readable rendering, e.g. ``"150.00 MAD"`` (minor-unit aware)."""
    decimals = currency_decimals(amount.currency)
    return "%.*f %s" % (decimals, amount.amount, amount.currency)


def validate_money_breakdown(breakdown: "MoneyBreakdown") -> None:
    """Enforce the ``money_breakdown_sum`` rule from schema/behavior/invariants.json:
    the component amounts sum to ``total`` within the currency's minor-unit
    tolerance; all components share the total's currency; discount components carry
    a negative amount. Raises ``ValueError`` on violation."""
    rule = _invariants()["money_breakdown_sum"]
    currency = breakdown.total.currency

    if rule.get("single_currency", True):
        for c in breakdown.components:
            if c.amount.currency != currency:
                raise CurrencyMismatchError(c.amount.currency, currency)

    if rule.get("discounts_negative", True):
        for c in breakdown.components:
            if "discount" in c.kind.lower() and c.amount.amount > 0:
                raise ValueError(
                    "MoneyBreakdown discount component '%s' must be negative, got %s"
                    % (c.kind, c.amount.amount)
                )

    component_sum = sum(c.amount.amount for c in breakdown.components)
    if not money_equals(component_sum, breakdown.total.amount, currency):
        raise ValueError(
            "MoneyBreakdown components sum to %s %s but total is %s %s "
            "(money_breakdown_sum)" % (component_sum, currency, breakdown.total.amount, currency)
        )
