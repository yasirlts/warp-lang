# Authoring a new language binding

This is the concrete path an outsider follows to add a new language binding for
the Warp Commerce Model and prove it agrees with the existing ones. It is the
hands-on companion to [`docs/CONFORMANCE.md`](CONFORMANCE.md) (the contract) and
[`conformance/README.md`](../conformance/README.md) (the fixture spec).

The goal is a binding that returns the **same verdict** as the TypeScript,
Python, Rust, and Go reference bindings on every fixture the suite runs. When it
does, you are Warp-compatible at the schema version you target.

The four reference bindings all took this path. Use them as worked examples:

- **TypeScript** — [`packages/commerce-types/`](../packages/commerce-types/)
- **Python** — [`packages/commerce-types-py/`](../packages/commerce-types-py/)
- **Rust** — [`crates/warp-commerce-types/`](../crates/warp-commerce-types/)
- **Go** — [`bindings/go/`](../bindings/go/)

---

## Step 0 — Read the schema

Everything is generated from [`schema/`](../schema/). Read it before writing any
code. It has two layers:

- **Structure** — [`schema/structure/*.schema.json`](../schema/structure/), plain
  JSON Schema 2020-12, one file per primitive group: `party`, `value`, `money`,
  `intent`, `commitment`, `fulfillment`, `auxiliary`, `index`. These are the
  *shapes*.
- **Behavior** — [`schema/behavior/`](../schema/behavior/): `transitions.json`
  (the exact commitment / intent / fulfillment state-transition tables) and
  `invariants.json` (the six invariants, each naming its reference
  implementation).

The version you target is in [`schema/VERSION`](../schema/VERSION) — **v1.0.0**,
frozen. Pin it. A fixture that could change a verdict only changes on a major
bump.

One thing to internalize early: **Money always carries its currency**, and
minor-unit precision is per-currency (TND/BHD/KWD/OMR/JOD = 3 decimals,
JPY/KRW/etc. = 0, most others = 2). Getting this wrong is the first historical
bug the suite locks out.

---

## Step 1 — Generate or hand-write your types

The structure files are plain JSON Schema 2020-12, so most ecosystems can run a
JSON-Schema-to-types generator over them. The reference bindings each ship a
small generator script, and these are your templates:

| Binding | Generator |
|---------|-----------|
| TypeScript | [`packages/commerce-types/scripts/generate-from-schema.mjs`](../packages/commerce-types/scripts/generate-from-schema.mjs) |
| Python | [`packages/commerce-types-py/scripts/generate_from_schema.py`](../packages/commerce-types-py/scripts/generate_from_schema.py) |
| Rust | [`crates/warp-commerce-types/scripts/generate-rust.mjs`](../crates/warp-commerce-types/scripts/generate-rust.mjs) |
| Go | [`bindings/go/generate-go.mjs`](../bindings/go/generate-go.mjs) |

Each reads the canonical schema and emits types in its language. Each also
supports a `--check` mode used in CI as a **drift gate** — it regenerates and
fails if the checked-in types no longer match the schema. Build the same gate
into your binding so your types cannot silently diverge.

Brand types (`PartyID`, `CommitmentID`, …) are plain strings in JSON Schema; the
reference generators re-apply branding where the language supports it (e.g. TS
emits `string & { __brand: 'PartyID' }`). This is optional for conformance but
good practice.

You can also hand-write the types. The suite does not care how the types are
produced — only that your binding agrees on the fixtures.

---

## Step 2 — Implement the checks

Your binding has to reproduce three families of verdict. The reference
implementation to port is the zero-dependency runner
[`conformance/runner/run.mjs`](../conformance/runner/run.mjs) — it is small and
deliberately readable for exactly this purpose, and `invariants.json` names the
reference impl for each rule.

**1. Structure.** Every object validates against the schema for its primitive.

**2. The six invariants** (the behavioral core):

| id | name | what it forbids |
|----|------|-----------------|
| I-1 | Value Conservation | mixing currencies in one subject without explicit conversion; over-refund in the same currency |
| I-2 | State Monotonicity | a transition not in the table (e.g. `Fulfilled → Accepted`); backdated history |
| I-3 | Capacity Verification | reaching `Accepted` when the initiator's `can_buy` is false |
| I-4 | Temporal Integrity | a fulfillment executing before its commitment was accepted |
| I-5 | Identity Permanence | two objects sharing an id |
| I-6 | Commitment Tree Consistency | child commitment values not summing to the parent (within minor-unit tolerance) |

Plus **`money_breakdown_sum`** — the canonical expression of I-1 for the
`MoneyBreakdown` type: components share the total's currency and sum to it within
tolerance. The four bindings implement it as `validateMoneyBreakdown` (TS),
`validate_money_breakdown` (Python), `runtime::breakdown_is_valid` (Rust), and
`BreakdownIsValid` (Go).

**3. Transitions.** Accept or reject each transition exactly as
[`schema/behavior/transitions.json`](../schema/behavior/transitions.json)
dictates — the commitment table (26 edges across 11 states), the intent table,
and the fulfillment table, including the recoverable-only `Failed → Planned`
retry.

Watch the three locked regression bugs as you implement (they are permanent
fixtures): three-decimal currency precision, empty-history auditing, and I-6
float tolerance (`0.1 + 0.2` must not falsely fail a `0.3` parent). See
[`docs/CONFORMANCE.md`](CONFORMANCE.md) for the table.

---

## Step 3 — Run the fixtures and the cross-check

The fixtures live in [`conformance/`](../conformance/) with
[`conformance/manifest.json`](../conformance/manifest.json) listing every
fixture, its `kind`, its `expect`, and (for invalid) its `rule`. There are two
ways to plug your binding in.

### Path A — port the runner (full, normative)

Port [`run.mjs`](../conformance/runner/run.mjs) to your language: load the
manifest, apply the check for each fixture's `kind`, compare your verdict to
`expect`, and for invalid fixtures confirm your rejection names the same `rule`.
This covers every fixture, structural and behavioral. This is what the Rust and
Go bindings did — their `runtime` modules are direct ports of `run.mjs`.

### Path B — emit verdicts, score with the harness (quick start)

You do not have to port the whole runner to get a score. Have your binding emit a
JSON array of per-fixture verdicts in the documented format (`id`, `kind`,
`runnable`, `verdict`, `rules`, `steps`, `note` — full spec in
[`docs/CONFORMANCE.md`](CONFORMANCE.md) Step 3), then feed it to the
language-neutral scorer:

```bash
your-binding --emit-verdicts > verdicts.json
node conformance/tooling/score-adapter.mjs verdicts.json
#   or: your-binding --emit-verdicts | node conformance/tooling/score-adapter.mjs -
```

`rules` and `steps` are **always arrays** (emit `[]`, never `null`); `verdict` is
`null` only when `runnable:false`. The scorer applies the **same agreement check**
the internal four-way cross-check uses and prints `X/Y`. It exits `0` only if
every runnable fixture agrees; fixtures you mark `runnable:false` are reported as
n/a, not failures — they just flag checks you have not implemented yet.

The four reference emitters are your format templates:
[`crosscheck-ts.mjs`](../conformance/tooling/crosscheck-ts.mjs),
[`crosscheck-python.py`](../conformance/tooling/crosscheck-python.py), the Rust
`crosscheck-rust` binary in
[`crates/warp-commerce-types`](../crates/warp-commerce-types/), and the Go
`crosscheck-go` command in
[`bindings/go/cmd/crosscheck-go`](../bindings/go/cmd/crosscheck-go/).

### The four-way cross-check harness

The harness that proves the existing bindings agree is
[`conformance/tooling/crosscheck.mjs`](../conformance/tooling/crosscheck.mjs). It
runs each binding's emitter and prints the agreement table:

```bash
node conformance/tooling/crosscheck.mjs
# → fixture | expected | TS | Python | Rust | Go | agree?
```

Under the hood it invokes `crosscheck-ts.mjs`, `crosscheck-python.py`,
`cargo run -p warp-commerce-types --bin crosscheck-rust`, and
`go run ./cmd/crosscheck-go` (with `WARP_CONFORMANCE_DIR` set). Adding a fifth
column for a new binding follows the same pattern these four use; until then,
`score-adapter.mjs` (Path B) gives you an independent X/Y against the same
fixtures without modifying the harness.

A worked, self-contained example of a binding passing through the harness is
[`conformance/tooling/test-score-adapter.mjs`](../conformance/tooling/test-score-adapter.mjs)
(it builds the TS binding, runs its adapter, scores the output, asserts a clean
pass) — read it to see the full emit-then-score pipeline end to end.

---

## Step 4 — The parity bar

You are Warp-compatible at the schema version you target when your binding:

1. **generates its types from `schema/`** at that version (with a drift gate);
2. **accepts every `valid/` fixture** — structurally well-formed and audit-clean
   with zero violations;
3. **rejects every `invalid/` fixture by the named rule** in its
   `.expected.json` sidecar — naming the wrong rule is a failure, not a pass;
4. **matches every step** in the `transitions/` sequences; and
5. **reproduces the money round-trips** at each currency's real precision.

There is no partial credit. A binding may *add* fields, but it may never accept
what the suite rejects or reject what the suite accepts. A `runnable:false` on a
check is honest — it means "not implemented yet," and it is reported as n/a, not
counted as agreement.

When you pass, size the claim to exactly what it proves: *"agrees with the Warp
Commerce Model on N/N fixtures (schema vX)."* That is true and re-verifiable by
anyone who runs the suite. It does not mean your code is correct in general — the
suite is a finite, curated set, and passing it is necessary for compatibility,
not a proof of total correctness. The compatibility badge and its honest wording
are in [`docs/CONFORMANCE.md`](CONFORMANCE.md).

---

## Where the existing bindings show the way

| You are doing | Read |
|---------------|------|
| Generating types | the four generator scripts in Step 1 |
| Implementing invariants + transitions | [`conformance/runner/run.mjs`](../conformance/runner/run.mjs) and the `runtime` ports in the Rust crate / Go module |
| Emitting verdicts | the four `crosscheck-*` emitters |
| Scoring without porting the runner | [`conformance/tooling/score-adapter.mjs`](../conformance/tooling/score-adapter.mjs) + the worked [`test-score-adapter.mjs`](../conformance/tooling/test-score-adapter.mjs) |
| Understanding the contract | [`conformance/README.md`](../conformance/README.md) and [`docs/CONFORMANCE.md`](CONFORMANCE.md) |

If your binding and the suite agree on every runnable fixture, open a PR — a new
reference binding is a welcome contribution. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for what the PR needs and
[`GOVERNANCE.md`](../GOVERNANCE.md) for how a binding becomes a *reference*
binding wired into the cross-check.
