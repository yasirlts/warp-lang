"""Runtime checkers for the six invariants of the Warp Commerce Model. Each
returns a list of violations (empty = clean) rather than a boolean, so the caller
— a developer, a CI step, or an AI coding agent — gets actionable detail per
violation. The invariant id/name come from the CANONICAL
``schema/behavior/invariants.json`` (the same source the TS binding uses); the
per-invariant `fix` hints are a documented binding-level CONFIG below — the
canonical schema carries `description` / `prose_spec` / `fixtures`, not a short
fix string, so (like the TS generator's BRAND seam) we re-apply the hints here.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from ._data import invariants as _invariants
from ._models import Commitment, Fulfillment, Money, Party, PartyCapacity, Value
from .money import CurrencyMismatchError, money_equals
from .transitions import is_valid_commitment_transition, _parse

# Canonical invariants.json carries `invariants` as a LIST of objects (id, name,
# description, enforcement_kind, rule, prose_spec, fixtures). Index by id for the
# `name` shown on a violation.
_META: Dict[str, dict] = {inv["id"]: inv for inv in _invariants()["invariants"]}

# Short, actionable fix hints — not carried by the canonical schema; re-applied
# here by the Python binding (documented seam).
_FIX_HINTS: Dict[str, str] = {
    "I-1": "Convert all monetary values to one currency with convert(), or record an explicit CurrencyConversion in the terms.",
    "I-2": "Only the model's valid transitions are allowed; a reversal must be a new Commitment with parties exchanged.",
    "I-3": "Verify party capacity (can_buy) before transitioning to Accepted.",
    "I-4": "Commitments form before Fulfillments execute - accept the commitment first.",
    "I-5": "IDs are globally unique and never reused; generate a fresh id.",
    "I-6": "Child commitment values must sum to the parent; recalculate after any substitution or cancellation (use allocate() for exact splits).",
}


@dataclass
class InvariantViolation:
    invariant: str
    name: str
    description: str
    fix: str
    location: Optional[str] = None


def _violation(inv_id: str, description: str) -> InvariantViolation:
    return InvariantViolation(
        invariant=inv_id,
        name=_META[inv_id]["name"],
        description=description,
        fix=_FIX_HINTS[inv_id],
    )


# --- helpers ---------------------------------------------------------------

def _money_of(value: Value) -> Optional[Money]:
    return value.form.money if value.form.kind == "Money" else None


def _sum_money(values: List[Value]) -> Tuple[Optional[Money], bool, List[str]]:
    """Sum the Money values in a list; flags if more than one currency appears."""
    currencies: List[str] = []
    amount = 0.0
    for v in values:
        m = _money_of(v)
        if m is not None:
            if m.currency not in currencies:
                currencies.append(m.currency)
            amount += m.amount
    if not currencies:
        return None, False, currencies
    return Money(amount=amount, currency=currencies[0]), len(currencies) > 1, currencies


_ACCEPTED_OR_LATER = {
    "Accepted", "Active", "Modified", "PartiallyFulfilled", "Fulfilled", "Disputed", "Refunded",
}


def _reached_accepted(c: Commitment) -> bool:
    if c.state.type in _ACCEPTED_OR_LATER:
        return True
    return any(h.to.type == "Accepted" for h in c.history)


def _accepted_at(c: Commitment) -> Optional[str]:
    for h in c.history:
        if h.to.type == "Accepted":
            return h.at
    return None


# --- I-1: Value Conservation ------------------------------------------------

def check_i1_value_conservation(commitments: List[Commitment]) -> List[InvariantViolation]:
    out: List[InvariantViolation] = []
    for c in commitments:
        _, mixed, currencies = _sum_money([*c.subject.offered, *c.subject.requested])
        if mixed:
            out.append(
                _violation(
                    "I-1",
                    "Commitment %s mixes currencies (%s) in its subject without explicit "
                    "conversion." % (c.id, ", ".join(currencies)),
                )
            )
        # Amount conservation (over-refund): a refund cannot exceed what was
        # committed, in the same currency. Same-currency only — a cross-currency
        # refund is a separate concern and is not flagged here.
        if c.state.type == "Refunded":
            refund = c.state.amount
            orig, _, _ = _sum_money(c.subject.requested)
            if (
                orig is not None
                and refund.currency == orig.currency
                and refund.amount > orig.amount
                and not money_equals(refund.amount, orig.amount, refund.currency)
            ):
                out.append(
                    _violation(
                        "I-1",
                        "Commitment %s refunds %s %s but only %s %s was committed — a refund "
                        "cannot exceed what was captured."
                        % (c.id, refund.amount, refund.currency, orig.amount, orig.currency),
                    )
                )
    return out


@dataclass
class LoyaltyLiabilityCheck:
    issuer: str
    total_points_outstanding: float
    points_per_currency_unit: float
    redemption_rate: Money
    sustainable: bool


def check_loyalty_liability(
    issuer: str,
    outstanding_points: float,
    redemption_value_per_point: Money,
    issuer_revenue_capacity: Money,
) -> LoyaltyLiabilityCheck:
    """I-1, fourth clause (v0.3): loyalty-point creation. A merchant must not issue
    more redeemable point value than the business can sustain. Liability and
    capacity must share a currency."""
    if redemption_value_per_point.currency != issuer_revenue_capacity.currency:
        raise CurrencyMismatchError(
            redemption_value_per_point.currency, issuer_revenue_capacity.currency
        )
    total_liability = outstanding_points * redemption_value_per_point.amount
    return LoyaltyLiabilityCheck(
        issuer=issuer,
        total_points_outstanding=outstanding_points,
        points_per_currency_unit=(
            0.0 if redemption_value_per_point.amount == 0 else 1 / redemption_value_per_point.amount
        ),
        redemption_rate=redemption_value_per_point,
        sustainable=total_liability <= issuer_revenue_capacity.amount,
    )


# --- I-2: State Monotonicity ------------------------------------------------

def check_i2_state_monotonicity(commitment: Commitment) -> List[InvariantViolation]:
    out: List[InvariantViolation] = []
    for h in commitment.history:
        if not is_valid_commitment_transition(h.from_, h.to):
            out.append(
                _violation(
                    "I-2",
                    "Commitment %s recorded an invalid transition %s -> %s."
                    % (commitment.id, h.from_.type, h.to.type),
                )
            )
    for i in range(1, len(commitment.history)):
        prev, cur = commitment.history[i - 1], commitment.history[i]
        p, c = _parse(prev.at), _parse(cur.at)
        if p is not None and c is not None and c < p:
            out.append(
                _violation(
                    "I-2",
                    "Commitment %s has a transition dated before the previous one (%s < %s)."
                    % (commitment.id, cur.at, prev.at),
                )
            )
    return out


# --- I-3: Capacity Verification ---------------------------------------------

def check_i3_capacity_verification(
    commitment: Commitment, capacity: PartyCapacity
) -> List[InvariantViolation]:
    if _reached_accepted(commitment) and not capacity.can_buy:
        return [
            _violation(
                "I-3",
                "Commitment %s reached Accepted but the initiator's capacity does not "
                "permit buying (can_buy=false)." % commitment.id,
            )
        ]
    return []


# --- I-4: Temporal Integrity ------------------------------------------------

def check_i4_temporal_integrity(
    commitment: Commitment, fulfillments: List[Fulfillment]
) -> List[InvariantViolation]:
    out: List[InvariantViolation] = []
    accepted = _accepted_at(commitment)
    for f in [f for f in fulfillments if f.commitment == commitment.id]:
        started = f.started_at
        executed = f.state.type in ("InProgress", "Completed")
        if executed and accepted is None:
            out.append(
                _violation(
                    "I-4",
                    "Fulfillment %s is executing but its Commitment %s never reached Accepted."
                    % (f.id, commitment.id),
                )
            )
        elif started and accepted:
            ps, pa = _parse(started), _parse(accepted)
            if ps is not None and pa is not None and ps < pa:
                out.append(
                    _violation(
                        "I-4",
                        "Fulfillment %s started (%s) before its Commitment was Accepted (%s)."
                        % (f.id, started, accepted),
                    )
                )
    return out


# --- I-5: Identity Permanence -----------------------------------------------

def check_i5_identity_permanence(ids: List[str]) -> List[InvariantViolation]:
    seen: set = set()
    dupes: List[str] = []
    for i in ids:
        if i in seen and i not in dupes:
            dupes.append(i)
        seen.add(i)
    return [_violation("I-5", "Identifier '%s' appears more than once." % i) for i in dupes]


# --- I-6: Commitment Tree Consistency ---------------------------------------

def check_i6_tree_consistency(
    parent: Commitment, children: List[Commitment]
) -> List[InvariantViolation]:
    parent_total, _, _ = _sum_money(parent.subject.requested)
    if parent_total is None:
        return []
    child_amount = 0.0
    currencies = {parent_total.currency}
    for child in children:
        total, _, _ = _sum_money(child.subject.requested)
        if total is not None:
            currencies.add(total.currency)
            child_amount += total.amount
    if len(currencies) > 1:
        return [
            _violation(
                "I-6",
                "Parent %s and its children use mixed currencies (%s); convert to a base "
                "currency before summing." % (parent.id, ", ".join(sorted(currencies))),
            )
        ]
    if not money_equals(child_amount, parent_total.amount, parent_total.currency):
        return [
            _violation(
                "I-6",
                "Children of %s sum to %s %s but the parent requests %s %s."
                % (parent.id, child_amount, parent_total.currency,
                   parent_total.amount, parent_total.currency),
            )
        ]
    return []


# --- audit ------------------------------------------------------------------

def audit_commerce(
    commitments: List[Commitment],
    fulfillments: List[Fulfillment],
    parties: List[Party],
) -> List[InvariantViolation]:
    """Run every applicable invariant check across a set of commerce objects and
    return all violations."""
    out: List[InvariantViolation] = []
    capacity_by_party = {p.id: p.capacity for p in parties}
    commitment_by_id = {c.id: c for c in commitments}

    out += check_i1_value_conservation(commitments)

    for c in commitments:
        out += check_i2_state_monotonicity(c)
        cap = capacity_by_party.get(c.parties.initiator)
        if cap is not None:
            out += check_i3_capacity_verification(c, cap)
        out += check_i4_temporal_integrity(c, fulfillments)
        if c.children:
            kids = [commitment_by_id[i] for i in c.children if i in commitment_by_id]
            if kids:
                out += check_i6_tree_consistency(c, kids)

    all_ids: List[str] = (
        [c.id for c in commitments] + [f.id for f in fulfillments] + [p.id for p in parties]
    )
    out += check_i5_identity_permanence(all_ids)
    return out


# --- aliases (mirror the TS verifyInvariantN / auditCommerceCode names) ------

verify_invariant1 = check_i1_value_conservation
verify_invariant2 = check_i2_state_monotonicity
verify_invariant3 = check_i3_capacity_verification
verify_invariant4 = check_i4_temporal_integrity
verify_invariant5 = check_i5_identity_permanence
verify_invariant6 = check_i6_tree_consistency
audit_commerce_code = audit_commerce
