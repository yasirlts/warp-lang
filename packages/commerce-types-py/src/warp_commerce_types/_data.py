"""Runtime loaders for the canonical behavior data (transition tables and
invariant definitions).

Both the TypeScript and Python bindings read these same JSON files, so they
agree by construction. In a source checkout we read the canonical files under
``schema/behavior`` directly; an installed wheel reads the build-time mirror
bundled at ``warp_commerce_types/schema_data`` (synced from the canonical files
by ``scripts/generate_from_schema.py``).
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict

_PKG_DIR = Path(__file__).resolve().parent
_BUNDLED = _PKG_DIR / "schema_data"
# In a source checkout: .../warp-lang/packages/commerce-types-py/src/warp_commerce_types
# parents[3] is the repo root that holds the canonical schema/ directory.
_CANONICAL = _PKG_DIR.parents[3] / "schema" / "behavior"


def _read(name: str) -> Dict[str, Any]:
    canonical = _CANONICAL / name
    if canonical.is_file():
        return json.loads(canonical.read_text())
    bundled = _BUNDLED / name
    if bundled.is_file():
        return json.loads(bundled.read_text())
    raise FileNotFoundError(
        "behavior file %r not found (looked in %s and %s); "
        "run scripts/generate_from_schema.py" % (name, _CANONICAL, _BUNDLED)
    )


@lru_cache(maxsize=None)
def transitions() -> Dict[str, Any]:
    """The legal-transition tables (schema/behavior/transitions.json)."""
    return _read("transitions.json")


@lru_cache(maxsize=None)
def invariants() -> Dict[str, Any]:
    """The invariant definitions + money_breakdown_sum / loyalty rules."""
    return _read("invariants.json")
