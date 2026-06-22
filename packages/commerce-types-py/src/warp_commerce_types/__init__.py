"""warp-commerce-types — the Python twin of @warp-lang/commerce-types.

Formal commerce types generated from the canonical Warp Commerce Model schema
(schema/structure/*.schema.json) v1.0.0:
- the five primitives (Party, Value, Intent, Commitment, Fulfillment),
- currency-safe Money + minor-unit-aware money math and MoneyBreakdown,
- validated state transitions (the 26-transition commitment table), read from
  schema/behavior/transitions.json — the same data the TS binding reads,
- runtime checkers for the six commerce invariants.

Platform mappings (Shopify, Stripe) are available under
``warp_commerce_types.platforms``.
"""
from __future__ import annotations

# Generated data models (objects + discriminated unions) + SCHEMA_VERSION.
from ._models import *  # noqa: F401,F403
from ._models import SCHEMA_VERSION

# Money math.
from .money import (  # noqa: F401
    CurrencyMismatchError,
    ZERO_DECIMAL_CURRENCIES,
    THREE_DECIMAL_CURRENCIES,
    add,
    allocate,
    compare,
    convert,
    currency_decimals,
    format_money,
    minor_unit_factor,
    money_epsilon,
    money_equals,
    subtract,
    validate_money_breakdown,
    zero,
)

# Primitive constructors.
from .primitives import (  # noqa: F401
    commitment_id,
    fulfillment_id,
    individual,
    intent_id,
    new_commitment,
    new_fulfillment,
    new_intent,
    now,
    organization,
    party_id,
    system,
    unverified_capacity,
    value_id,
)

# Transitions.
from .transitions import (  # noqa: F401
    CapacityError,
    InvalidTransitionError,
    Result,
    apply_commitment_path,
    apply_fulfillment_path,
    is_valid_commitment_transition,
    is_valid_fulfillment_transition,
    is_valid_intent_transition,
    transition_commitment,
    transition_fulfillment,
    transition_intent,
    valid_fulfillment_transitions,
    valid_intent_transitions,
    valid_transitions,
)

# Invariants.
from .invariants import (  # noqa: F401
    InvariantViolation,
    LoyaltyLiabilityCheck,
    audit_commerce,
    audit_commerce_code,
    check_i1_value_conservation,
    check_i2_state_monotonicity,
    check_i3_capacity_verification,
    check_i4_temporal_integrity,
    check_i5_identity_permanence,
    check_i6_tree_consistency,
    check_loyalty_liability,
    verify_invariant1,
    verify_invariant2,
    verify_invariant3,
    verify_invariant4,
    verify_invariant5,
    verify_invariant6,
)

# Agent toolkit — guardrail (composes transition + audit), planning oracle
# (valid_transitions + alternatives), session coherence, interop CIR.
from .guard import (  # noqa: F401
    GuardResult,
    GuardViolation,
    ProposedAction,
    TransitionAlternative,
    World,
    check_version,
    commitment_version,
    guard_action,
    guard_object,
)
from .session import Session, create_session  # noqa: F401
from .interop import (  # noqa: F401
    EmitResult,
    UnifyResult,
    UnifySource,
    to_shopify_action,
    to_stripe_action,
    to_woocommerce_action,
    unify,
)

__version__ = SCHEMA_VERSION
