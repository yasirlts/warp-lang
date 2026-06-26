# Build a Warp-compatible binding

The Warp conformance suite lets you prove that *your* commerce code — in any
language — agrees with the Warp Commerce Model. You generate types from the
canonical schema, implement the model's checks, run the **same fixtures** the
reference bindings run, and get a pass/fail: *X/Y fixtures agree (schema vN)*.

This is the difference between "a library you like" and "a model you can verify
against." The suite is language-neutral data plus a tiny, dependency-free runner;
nothing here is specific to TypeScript or Python.

- **Schema (the source of truth):** [`../schema/`](../schema/) — `structure/*.schema.json`
  (JSON Schema 2020-12) + `behavior/` (transition table, invariants). Current
  version: **v1.0.0** ([`../schema/VERSION`](../schema/VERSION)).
- **Fixtures + contract:** [`../conformance/`](../conformance/) — see
  [`conformance/README.md`](../conformance/README.md) for the full envelope spec.
- **The suite today:** **58 fixtures**, all passing against the canonical schema;
  the TypeScript, Python, Rust, and Go bindings agree on **52/52** fixtures
  runnable in all four (the other 6 are structural state-catalogs, validated by
  the schema runner and so n/a for every behavioral binding). The corpus includes
  a [generality demonstration](case-studies/README.md#generality-beyond-commerce-f18-20)
  on three non-commerce domains (insurance, healthcare, procurement), each with a
  violation fixture caught by an invariant. Go is the newest
  reference binding ([`../bindings/go/`](../bindings/go/)); it joins TS
  ([`../packages/commerce-types/`](../packages/commerce-types/)), Python
  ([`../packages/commerce-types-py/`](../packages/commerce-types-py/)), and Rust
  ([`../crates/warp-commerce-types/`](../crates/warp-commerce-types/)).

---

## Step 1 — Generate (or hand-write) your types from the schema

The canonical types live in [`../schema/structure/`](../schema/structure/):
`party`, `value`, `money`, `intent`, `commitment`, `fulfillment`, `auxiliary`,
`index`. They are plain JSON Schema 2020-12. Generate types for your language
from those files (most ecosystems have a JSON-Schema-to-types generator), or
hand-write them. Pin the schema version you target — **v1.0.0** today; a fixture
that could change a verdict only changes on a major bump.

Money is the one thing to get exactly right up front: an amount **always** carries
its `currency`, and minor-unit precision is per-currency (TND/BHD/KWD/OMR/JOD = 3
decimals, JPY/KRW/etc. = 0, most others = 2).

## Step 2 — Implement the checks

Your binding must reproduce, over the fixtures, the model's verdicts:

- **Structure** — every object validates against the schema for its primitive.
- **The six invariants** (the behavioral core):

  | id | name | what it forbids |
  |----|------|-----------------|
  | I-1 | Value Conservation | mixing currencies in one subject without explicit conversion; a `Refunded` commitment refunding more than was committed, same currency (over-refund) |
  | I-2 | State Monotonicity | a transition not in the table (e.g. `Fulfilled → Accepted`); backdated history |
  | I-3 | Capacity Verification | reaching `Accepted` when the initiator's `can_buy` is false |
  | I-4 | Temporal Integrity | a fulfillment executing before its commitment was accepted |
  | I-5 | Identity Permanence | two objects sharing an id |
  | I-6 | Commitment Tree Consistency | child commitment values not summing to the parent (within minor-unit tolerance) |

  Plus **`money_breakdown_sum`** — the canonical *expression of I-1* for the
  `MoneyBreakdown` type: components share the total's currency and sum to it
  within tolerance.
- **Transitions** — accept/reject each transition exactly as the table in
  [`../schema/behavior/transitions.json`](../schema/behavior/transitions.json)
  dictates (including the recoverable-only `Failed → Planned` retry).

The reference implementations are named in
[`../schema/behavior/invariants.json`](../schema/behavior/invariants.json), and the
zero-dependency [`../conformance/runner/run.mjs`](../conformance/runner/run.mjs) is a
complete, readable implementation you can port directly.

## Step 3 — Run the fixtures against your implementation

There are two ways to plug your binding in. Both use the same fixtures.

### Path A — port the runner (full, normative)

[`run.mjs`](../conformance/runner/run.mjs) is intentionally small and
dependency-free. Port it to your language: load `manifest.json`, and for each
fixture apply the check for its `kind`, then compare your verdict to the
fixture's `expect` (and, for an invalid fixture, confirm your rejection names the
same `rule`). This covers all 58 fixtures, structural and behavioral, and is the
normative path.

### Path B — emit verdicts, score with the harness (quick start)

You don't have to port the whole runner to get a score. Have your binding emit a
JSON array of per-fixture verdicts in this format, then feed it to the
language-neutral scorer:

```jsonc
[
  {
    "id": "i1-currency-mixed",      // fixture id, exactly as in manifest.json
    "kind": "scene",                 // scene | transition-sequence | money-roundtrip | money-breakdown | state-catalog
    "runnable": true,                // false = your binding has no API for this check yet
    "verdict": "reject",             // "accept" | "reject" | null (null when runnable:false)
    "rules": ["I-1"],                // for a reject: the rule id(s) you fired — always [] when none, never null
    "steps": [],                     // for transition-sequence: per-step validity [true,false,...] — always [], never null
    "note": ""                       // optional, free text. Every reference emitter includes it; the
                                     // scorer ignores it. By convention: the structural-only reason for a
                                     // state-catalog fixture, or "<lang> raised: <msg>" when a fixture failed
                                     // to deserialize/process (which also sets runnable:false).
  }
  // ... one object per fixture
]
```

`rules` and `steps` are **always arrays** — emit `[]`, never `null` (in Go,
initialise the slices to `[]string{}` / `[]bool{}`). `verdict` is `null` only for
`runnable:false` fixtures; otherwise `"accept"`/`"reject"`. The four reference
emitters ([`crosscheck-ts.mjs`](../conformance/tooling/crosscheck-ts.mjs),
[`crosscheck-python.py`](../conformance/tooling/crosscheck-python.py),
`crosscheck-rust`, and [`crosscheck-go`](../bindings/go/cmd/crosscheck-go/)) all
emit exactly this shape including `note`.

```bash
your-binding --emit-verdicts > verdicts.json
node conformance/tooling/score-adapter.mjs verdicts.json
#   or: your-binding --emit-verdicts | node conformance/tooling/score-adapter.mjs
```

The scorer applies the **same agreement check** the internal four-way
TS↔Python↔Rust↔Go cross-check uses, and prints `X/Y` with a per-fixture table. It exits `0` only if
every runnable fixture agrees. Fixtures you mark `runnable: false` are reported as
n/a (not failures) — they just mark checks you haven't implemented yet.

### Worked example (a real binding passing)

The TypeScript binding is the worked reference. Run it through the harness from a
fresh clone with one command — it builds the local TS binding if needed, runs its
adapter, scores the output, and asserts a clean pass:

```bash
node conformance/tooling/test-score-adapter.mjs
# → test-score-adapter: PASS — worked example (TS binding) scores 52/52 via the harness, 0 disagreements.
```

That command is self-contained (no prior build step) and is what CI runs, so the
worked example can't silently rot. Under the hood it is just an "emit verdicts →
score" pipeline — the TS adapter
([`crosscheck-ts.mjs`](../conformance/tooling/crosscheck-ts.mjs)) emits the verdict
format above, and the scorer grades it:

```bash
# the underlying flow (requires the TS binding built first:
#   cd packages/commerce-types && npm ci && npm run build
# — test-score-adapter.mjs does that for you):
node conformance/tooling/crosscheck-ts.mjs | node conformance/tooling/score-adapter.mjs -
# → ✓ Your binding agrees with the Warp Commerce Model on 52/52 runnable fixtures (schema v1.0.0). 6 not yet implemented.
```

Your own binding needs no build of ours: emit your verdicts and score them
directly with `score-adapter.mjs` (Path B above) — that step depends only on the
fixtures, not on our compiled package.

## Step 4 — Interpret X/Y honestly

A clean pass means one specific, valuable thing — and not more.

**What a pass proves:** your implementation **agrees with the Warp Commerce Model,
on these fixtures, at this schema version.** It accepts what the model accepts and
rejects what the model rejects — including the named rule for each rejection.

**What a pass does NOT prove:**

- It does **not** prove your code is bug-free or correct in general — only that it
  agrees with the model on the cases the suite covers.
- It does **not** cover inputs no fixture exercises. The suite is a finite,
  curated set; passing it is necessary for compatibility, not a proof of total
  correctness.
- `runnable: false` fixtures are checks you have **not** implemented; a score of
  `52/52` with `6` n/a means "agrees on everything it implements," not "implements
  everything."

Size the claim to exactly this: *"agrees with the Warp Commerce Model on N/N
fixtures (schema vX)"* — true and verifiable. Avoid "guarantees correct commerce
code," which the suite does not establish.

---

## The three locked regression bugs

Three real bugs from the v0.3.1 audit are permanently encoded as fixtures, so no
implementation can reintroduce them and still claim conformance:

| bug | what broke | locked by |
|-----|-----------|-----------|
| **TND 10×** | three-decimal currencies treated as two-decimal (every amount 10× wrong) | `valid/money-roundtrip-minor-units` — `1500 millimes = 1.5 TND` |
| **adapter empty history** | final-state objects with empty histories that falsely passed/failed the auditor | `valid/order-paid-fulfilled` (audits clean) + `invalid/i4-empty-history-fulfilled` (still caught) |
| **I-6 float equality** | tree consistency using exact float equality (`0.1 + 0.2 ≠ 0.3`) | `valid/tree-float-0.1-plus-0.2` (must not flag) + `invalid/i6-children-exceed-parent` (real discrepancy still flags) |

If your binding fails any of these, the old bug is back — by definition not
conformant.

---

## Claim compatibility — the badge

When your binding passes **all current fixtures against schema vX** (Path A green,
or Path B with every fixture `runnable` and agreeing), you may display the
compatibility badge. It is a **static** [shields.io](https://shields.io) badge —
no service, no account, no infra — and it is tied to a schema version, so the
claim is verifiable by anyone who re-runs the suite at that version.

```markdown
[![Warp Commerce Model](https://img.shields.io/badge/Warp%20Commerce%20Model-compatible%20(schema%20v1.0.0)-success)](https://github.com/yasirlts/warp-lang/tree/main/conformance)
```

Renders as a badge reading **Warp Commerce Model — compatible (schema v1.0.0)**.

**The rule to earn it (honest and checkable):**

1. Your binding generates its types from `schema/` at the version you claim.
2. It passes **every** fixture in the suite at that version — accepting all
   `valid/`, rejecting all `invalid/` by the named rule, matching all
   `transitions/` steps, and reproducing the money round-trips.
3. The badge names that schema version. If the suite gains fixtures in a later
   version, your badge claims the version you actually pass — not a newer one.

The claim is exactly "compatible at schema vX," verifiable by re-running the
suite. It is not a statement that your product is bug-free.

---

## Reference

- [`conformance/README.md`](../conformance/README.md) — fixture envelope, the full
  contract, the kinds, the invalid sidecars, versioning.
- [`schema/`](../schema/) — the canonical structure + behavior the fixtures derive from.
- [`AGENTS.md`](../AGENTS.md) — guidance for agents emitting Warp commerce objects.
