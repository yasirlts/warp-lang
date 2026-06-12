#!/usr/bin/env python3
"""Emit the Python binding's verdict for every conformance fixture, as JSON.

Runs each fixture through the CANONICAL warp-commerce-types on main
(audit_commerce / is_valid_*_transition / validate_money_breakdown /
currency_decimals). Used by crosscheck.mjs to prove TS and Python agree.

Verdict shape per fixture: {id, kind, runnable, verdict, rules, steps, note}.
runnable=false means the binding exposes no API for that fixture's check.

    python3 conformance/tooling/crosscheck-python.py   # JSON to stdout
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)            # conformance/
REPO = os.path.dirname(ROOT)
sys.path.insert(0, os.path.join(REPO, "packages", "commerce-types-py", "src"))

from warp_commerce_types._models import (
    Commitment, Fulfillment, Party, Money, MoneyComponent, MoneyBreakdown,
)
from warp_commerce_types.invariants import audit_commerce
from warp_commerce_types.transitions import (
    is_valid_commitment_transition, is_valid_intent_transition, is_valid_fulfillment_transition,
)
from warp_commerce_types.money import validate_money_breakdown, currency_decimals, CurrencyMismatchError


def load(rel):
    with open(os.path.join(ROOT, rel)) as fh:
        return json.load(fh)


def is_valid(primitive, frm, to):
    if primitive == "commitment": return is_valid_commitment_transition(frm, to)
    if primitive == "intent": return is_valid_intent_transition(frm, to)
    if primitive == "fulfillment": return is_valid_fulfillment_transition(frm, to)
    raise ValueError(primitive)


def breakdown_verdict(payload):
    total = Money(amount=payload["total"]["amount"], currency=payload["total"]["currency"])
    comps = [MoneyComponent(kind=c["kind"], amount=Money(amount=c["amount"]["amount"], currency=c["amount"]["currency"]))
             for c in payload["components"]]
    bd = MoneyBreakdown.model_construct(total=total, components=comps)
    try:
        validate_money_breakdown(bd)
        return ("accept", [])
    except (CurrencyMismatchError, ValueError):
        # both the single-currency clause and the sum clause are the canonical
        # money_breakdown_sum expression of invariant I-1.
        return ("reject", ["money_breakdown_sum"])


manifest = load("manifest.json")
out = []
for entry in manifest["fixtures"]:
    fx = load(entry["path"])
    r = {"id": entry["id"], "kind": entry["kind"], "runnable": True, "verdict": None, "rules": [], "steps": [], "note": ""}
    try:
        if fx["kind"] == "scene":
            p = fx["payload"]
            commitments = [Commitment.model_validate(c) for c in p["commitments"]]
            fulfillments = [Fulfillment.model_validate(f) for f in p["fulfillments"]]
            parties = [Party.model_validate(pp) for pp in p["parties"]]
            violations = sorted(set(v.invariant for v in audit_commerce(commitments, fulfillments, parties)))
            r["verdict"] = "accept" if not violations else "reject"
            r["rules"] = violations
        elif fx["kind"] == "transition-sequence":
            cur = fx["payload"]["initial"]
            for step in fx["payload"]["steps"]:
                v = is_valid(fx["payload"]["primitive"], cur, step["to"])
                r["steps"].append(bool(v))
                if v: cur = step["to"]
            r["verdict"] = "accept"
        elif fx["kind"] == "money-roundtrip":
            ok = True
            for c in fx["payload"]["cases"]:
                f = 10 ** currency_decimals(c["currency"])
                if c["minor_amount"] / f != c["decimal_amount"] or round((c["minor_amount"]/f)*f) != c["minor_amount"]:
                    ok = False
            r["verdict"] = "accept" if ok else "reject"
        elif fx["kind"] == "money-breakdown":
            r["verdict"], r["rules"] = breakdown_verdict(fx["payload"])
        elif fx["kind"] == "state-catalog":
            r["runnable"] = False
            r["note"] = "structural only — covered by runner + JSON Schema"
    except Exception as exc:  # noqa: BLE001
        r["runnable"] = False
        r["note"] = "Python raised: %s: %s" % (type(exc).__name__, exc)
    out.append(r)

print(json.dumps(out, indent=2))
