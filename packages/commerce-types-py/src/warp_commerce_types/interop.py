"""Interoperability layer — Warp as the neutral model (a canonical intermediate
representation) between commerce platforms.

A Python port of the TypeScript ``interop.ts``, behaviour-identical. The inbound
adapters (``platforms/*``) already map one platform object into a Warp commitment.
This module adds the two CIR pieces, by COMPOSING those adapters + the validators —
it does not reimplement them:

  A. :func:`unify` — INBOUND unification. Merge several platform objects the CALLER
     asserts represent the same transaction into one coherent Warp commitment, and
     validate that value is conserved across them.
  B. :func:`to_stripe_action` / :func:`to_shopify_action` / :func:`to_woocommerce_action`
     — OUTBOUND emission. Translate a VALIDATED Warp action into a structured,
     platform-shaped descriptor the application can send.

TWO LINES THIS MODULE DOES NOT CROSS:
  1. Unification is a MECHANISM, not DISCOVERY. The correspondence is an INPUT the
     caller asserts by passing the objects together. Warp does NOT auto-reconcile or
     infer which order matches which charge.
  2. Outbound is a DESCRIPTION, not EXECUTION. The emitters return a descriptor only.
     They make NO network calls, hold NO credentials, and execute nothing.

Scope: TypeScript and Python. Note that the Python binding currently ships inbound
mappers for Shopify and Stripe (not WooCommerce); ``unify`` is platform-agnostic
(it takes already-mapped commitments) and the WooCommerce *emitter* is available, so
the only gap is mapping a WooCommerce order INBOUND in Python. Other-language interop
is roadmap.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ._models import Commitment, Money
from .guard import GuardViolation, ProposedAction, World, guard_object
from .money import money_equals
from .platforms.stripe import to_stripe_amount
from .transitions import _type_of


@dataclass
class UnifySource:
    """A platform object ALREADY mapped to a Warp commitment via the inbound adapter.
    Passing several of these to :func:`unify` is how the caller ASSERTS they
    correspond — the correspondence is not discovered."""

    platform: str
    commitment: Commitment


@dataclass
class UnifyResult:
    ok: bool
    commitment: Optional[Commitment] = None
    world: Optional[World] = None
    violations: List[GuardViolation] = field(default_factory=list)


def _committed_money(c: Commitment) -> Optional[Money]:
    monies = [v.form.money for v in c.subject.requested if v.form.kind == "Money"]
    if not monies:
        return None
    currency = monies[0].currency
    if any(m.currency != currency for m in monies):
        return None
    total = monies[0]
    for m in monies[1:]:
        total = Money(amount=total.amount + m.amount, currency=currency)
    return total


def unify(sources: List[UnifySource], opts: Optional[Dict[str, Any]] = None) -> UnifyResult:
    """Merge corresponded platform objects into one validated Warp commitment.

    The first source is the PRIMARY (it carries the lifecycle). Every other source
    must CONSERVE value against it (matching committed amount, same currency, within
    the I-1 tolerance). A disagreement is reported as an I-1 (Value Conservation)
    violation. The merged commitment is then validated by :func:`guard_object`.

    The correspondence is the CALLER'S assertion (passing the sources together);
    ``unify`` does NOT infer which objects correspond.
    """
    if not sources:
        return UnifyResult(
            ok=False,
            violations=[
                GuardViolation(
                    rule="unify-empty",
                    message="unify requires at least one mapped platform source.",
                    fix="Map each platform object with its inbound adapter (e.g. from_shopify_order) "
                    "and pass the corresponding ones together.",
                )
            ],
        )

    primary = sources[0]
    primary_money = _committed_money(primary.commitment)

    violations: List[GuardViolation] = []
    for other in sources[1:]:
        other_money = _committed_money(other.commitment)
        if primary_money is None or other_money is None:
            continue
        if other_money.currency != primary_money.currency or not money_equals(
            other_money.amount, primary_money.amount, primary_money.currency
        ):
            violations.append(
                GuardViolation(
                    rule="I-1",
                    message="Corresponded sources do not conserve value: %s commits %s %s but %s commits "
                    "%s %s. Value is not conserved across the unified transaction."
                    % (primary.platform, _fmt(primary_money.amount), primary_money.currency,
                       other.platform, _fmt(other_money.amount), other_money.currency),
                    fix="Confirm the objects truly correspond and that the amounts (and currency) match; "
                    "a partial capture or fee belongs in its own Value, not a silent mismatch.",
                )
            )
    if violations:
        return UnifyResult(ok=False, violations=violations)

    commitment = primary.commitment
    if opts is not None and opts.get("id") is not None:
        commitment = commitment.model_copy(update={"id": opts["id"]})

    verdict = guard_object([commitment], [], [])
    if not verdict.ok:
        return UnifyResult(ok=False, violations=verdict.violations)
    return UnifyResult(ok=True, commitment=commitment, world=verdict.next)


# ---------------------------------------------------------------------------
# Outbound emission — validated, platform-shaped DESCRIPTORS. No execution.
# ---------------------------------------------------------------------------


@dataclass
class EmitResult:
    """The outcome of emitting a platform payload. On success ``descriptor`` is the
    structured call the app should make (it is NOT sent here). On failure the action
    has no faithful representation on that platform and ``reason`` says so."""

    ok: bool
    platform: str
    descriptor: Optional[Dict[str, Any]] = None
    reason: Optional[str] = None


def _fmt(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else str(x)


def _refund_money(action: ProposedAction) -> Money:
    amt = action.to["amount"] if isinstance(action.to, dict) else action.to.amount
    if isinstance(amt, dict):
        return Money(amount=amt["amount"], currency=amt["currency"])
    return amt


def _not_representable(platform: str, action: ProposedAction) -> EmitResult:
    return EmitResult(
        ok=False,
        platform=platform,
        reason="A '%s' action has no faithful %s equivalent in this layer (covered: Refunded → refund, "
        "Cancelled → cancel). Handle it in the application, or extend the emitter."
        % (_type_of(action.to), platform),
    )


def to_stripe_action(action: ProposedAction) -> EmitResult:
    """Emit a Stripe-shaped descriptor for a VALIDATED action (refund amounts via the
    existing ``to_stripe_amount``). Coverage: Refunded → refund, Cancelled → cancel."""
    t = _type_of(action.to)
    if t == "Refunded":
        amt = to_stripe_amount(_refund_money(action))
        return EmitResult(ok=True, platform="stripe", descriptor={"kind": "stripe.refund", "payment_intent": action.commitment, **amt})
    if t == "Cancelled":
        return EmitResult(ok=True, platform="stripe", descriptor={"kind": "stripe.cancel", "payment_intent": action.commitment})
    return _not_representable("stripe", action)


def to_shopify_action(action: ProposedAction) -> EmitResult:
    """Emit a Shopify-shaped descriptor for a VALIDATED action. Coverage: Refunded →
    refund, Cancelled → cancel."""
    t = _type_of(action.to)
    if t == "Refunded":
        m = _refund_money(action)
        return EmitResult(ok=True, platform="shopify", descriptor={"kind": "shopify.refund", "order_id": action.commitment, "amount": _fmt(m.amount), "currency": m.currency})
    if t == "Cancelled":
        return EmitResult(ok=True, platform="shopify", descriptor={"kind": "shopify.cancel", "order_id": action.commitment})
    return _not_representable("shopify", action)


def to_woocommerce_action(action: ProposedAction) -> EmitResult:
    """Emit a WooCommerce-shaped descriptor for a VALIDATED action. Coverage:
    Refunded → refund, Cancelled → cancel."""
    t = _type_of(action.to)
    if t == "Refunded":
        m = _refund_money(action)
        return EmitResult(ok=True, platform="woocommerce", descriptor={"kind": "woocommerce.refund", "order_id": action.commitment, "amount": _fmt(m.amount), "currency": m.currency})
    if t == "Cancelled":
        return EmitResult(ok=True, platform="woocommerce", descriptor={"kind": "woocommerce.cancel", "order_id": action.commitment})
    return _not_representable("woocommerce", action)
