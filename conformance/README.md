# Warp Commerce Model — Conformance Suite (schema v1.0.0)

Language-neutral fixtures that **prove** any implementation of the Warp Commerce
Model agrees with every other. Every fixture is validated against the **canonical
schema** ([`schema/`](../schema) — `structure/*.schema.json` + `behavior/`), and
cross-checked through four bindings:
[`@warp-lang/commerce-types`](../packages/commerce-types) (TS),
[`warp-commerce-types`](../packages/commerce-types-py) (Python),
[`warp-commerce-types`](../crates/warp-commerce-types) (Rust), and
[`bindings/go`](../bindings/go) (Go). All four are generated from the one schema;
this suite is what proves they actually agree.

This suite is the cross-check that the TS package, the Python package, the Rust
crate, the Go module, and anything that calls itself "Warp-compatible" all
conform to the same schema.

---

## The compatibility contract

An implementation is **Warp-compatible at schema v1.0.0** if and only if it:

1. **validates every fixture in [`valid/`](valid/)** — each is structurally
   well-formed *and* passes the full invariant audit with **zero violations**;
2. **rejects every fixture in [`invalid/`](invalid/)** — and rejects it via the
   **exact rule** named in its `.expected.json` sidecar (e.g. `I-1`), not merely
   "some error";
3. **matches every step in [`transitions/`](transitions/)** — each transition
   attempt is accepted or rejected exactly as the sequence declares;
4. **reproduces the money round-trips** — minor-unit ↔ decimal conversion at each
   currency's real precision (TND/BHD = 3 decimals, JPY = 0, USD/MAD = 2).

That is the whole contract. Pass all fixtures → conformant. Miss one → not.

There is no partial credit and no private extension that changes a verdict: a
conformant implementation may *add* fields, but it may never accept what the
suite rejects or reject what the suite accepts.

---

## What's in here

The suite validates against the canonical schema at the repo root — it carries
**no schema copy of its own** (the bespoke `conformance/schema/` from the first
draft was dropped when the suite was re-pointed at canonical):

```
conformance/
├── VERSION                  # 1.0.0
├── manifest.json            # every fixture + its expected outcome (the runner's input)
├── valid/                   # MUST validate against canonical schema + audit clean
├── invalid/                 # MUST be rejected; each has a .expected.json naming the rule
├── transitions/             # transition sequences with per-step accept/reject
├── runner/
│   └── run.mjs              # zero-dep runner: validates fixtures vs ../schema (2020-12) + behavior
└── tooling/
    ├── build.mjs              # regenerates fixtures; cross-checks them against the canonical TS package
    ├── crosscheck-ts.mjs      # emits the TS binding's verdict per fixture (JSON)
    ├── crosscheck-python.py   # emits the Python binding's verdict per fixture (JSON)
    │                          # (the Rust binding's verdict comes from the
    │                          #  crosscheck-rust binary in crates/warp-commerce-types;
    │                          #  the Go binding's verdict from the crosscheck-go
    │                          #  command in bindings/go/cmd/crosscheck-go)
    └── crosscheck.mjs         # THE CROSS-CHECK: prints the TS/Python/Rust/Go agreement table
```

The canonical schema consumed by the runner: [`../schema/structure/`](../schema/structure)
(`party`, `value`, `money`, `intent`, `commitment`, `fulfillment`, `auxiliary`,
`index`) and [`../schema/behavior/transitions.json`](../schema/behavior/transitions.json).

### Fixture envelope

Every fixture is a JSON object with this shape:

```jsonc
{
  "fixture": "i1-currency-mixed",
  "schema": "1.0.0",
  "kind": "scene",          // scene | state-catalog | transition-sequence | money-breakdown | money-roundtrip
  "expect": "reject",       // accept | reject
  "rule": "I-1",            // invalid only — the rejecting invariant / rule id
  "title": "...",
  "doc": "...",
  "payload": { /* kind-specific */ }
}
```

The five `kind`s:

| kind | payload | conformance question |
|------|---------|----------------------|
| `scene` | `{ parties, commitments, fulfillments }` | structurally valid **and** `auditCommerce` returns the expected violations? |
| `state-catalog` | `{ primitive, instances[] }` | is every state/form variant structurally valid? (covers *every* primitive state) |
| `transition-sequence` | `{ primitive, initial, steps[] }` | is each transition accepted/rejected per the table? |
| `money-breakdown` | `{ total, components[] }` | do the components sum to the total in one currency (the `money_breakdown_sum` rule)? |
| `money-roundtrip` | `{ cases[] }` | does minor-unit conversion use the currency's real precision? |

### Invalid sidecars

Each `invalid/<id>.json` has a sibling `invalid/<id>.expected.json`:

```json
{ "fixture": "i6-children-exceed-parent", "expect": "reject", "rule": "I-6",
  "rule_name": "Commitment Tree Consistency", "because": "..." }
```

The `rule` is one of the six invariants **or** the `money_breakdown_sum`
structural rule. A conformant implementation must reject the fixture **because of
that rule** — naming the wrong one is a conformance failure.

---

## The six invariants

| id | name | a fixture proving it rejects |
|----|------|------------------------------|
| `I-1` | Value Conservation | [`invalid/i1-currency-mixed`](invalid/i1-currency-mixed.json) — MAD + EUR in one subject |
| `I-2` | State Monotonicity | [`invalid/i2-backward-transition`](invalid/i2-backward-transition.json) — `Fulfilled → Accepted` in history |
| `I-3` | Capacity Verification | [`invalid/i3-accept-without-capacity`](invalid/i3-accept-without-capacity.json) — `Accepted` with `can_buy = false` |
| `I-4` | Temporal Integrity | [`invalid/i4-fulfillment-before-commitment`](invalid/i4-fulfillment-before-commitment.json) — fulfillment executes before acceptance |
| `I-5` | Identity Permanence | [`invalid/i5-duplicate-id`](invalid/i5-duplicate-id.json) — two commitments share an id |
| `I-6` | Commitment Tree Consistency | [`invalid/i6-children-exceed-parent`](invalid/i6-children-exceed-parent.json) — children sum ≠ parent |

The 26-transition commitment table, the intent table, and the fulfillment table
(including the recoverable-only `Failed → Planned` retry) are exercised by
`transitions/`.

Beyond the six, the **`money_breakdown_sum`** rule — canonically an **expression
of invariant I-1** ([`schema/behavior/invariants.json`](../schema/behavior/invariants.json)
→ `I-1` → `rule.expressions[money_breakdown_sum]`) — governs the `MoneyBreakdown`
type: every component shares the total's currency and the components sum to the
total within minor-unit tolerance. `MoneyComponent.kind` is the canonical enum
(`Base / Tax / Discount / Shipping / Surcharge / Tip / Adjustment`). It is proven
by [`valid/money-breakdown-sums-correctly`](valid/money-breakdown-sums-correctly.json),
[`invalid/money-breakdown-currency-mixed`](invalid/money-breakdown-currency-mixed.json), and
[`invalid/money-breakdown-sum-mismatch`](invalid/money-breakdown-sum-mismatch.json)
(both rejected as `money_breakdown_sum`).

> **Binding parity note.** All four bindings implement `money_breakdown_sum` —
> Python as `validate_money_breakdown`, TS as `validateMoneyBreakdown`, Rust as
> `runtime::breakdown_is_valid`, and Go as `BreakdownIsValid` — so the four
> money-breakdown fixtures now run in **all four** (B-1, once a TS gap surfaced by
> this very suite, is resolved — see
> [`../schema/BACKLOG-v1.1.md`](../schema/BACKLOG-v1.1.md)). The only fixtures n/a
> to a binding are the six structural state-catalogs, which the schema runner
> validates directly.

---

## Regression fixtures — the three original audit bugs

These are **permanent** guards. They encode bugs found in the v0.3.1 audit so no
implementation can reintroduce them and still claim conformance.

| bug | what broke | fixtures that lock it out |
|-----|-----------|---------------------------|
| **BUG 1 — TND 10×** | three-decimal currencies (TND/BHD/KWD/OMR/JOD) were treated as two-decimal, making every amount 10× wrong | [`valid/money-roundtrip-minor-units`](valid/money-roundtrip-minor-units.json) — `1500 millimes = 1.5 TND`, not `15` |
| **BUG 2 — adapter empty history** | adapters emitted final-state objects with empty histories, which *falsely* failed the auditor (and conversely let un-accepted "fulfilled" orders through) | [`valid/order-paid-fulfilled`](valid/order-paid-fulfilled.json) — synthesized history audits clean; [`invalid/i4-empty-history-fulfilled`](invalid/i4-empty-history-fulfilled.json) — empty history is still caught by I-4 |
| **BUG 3 — I-6 float equality** | tree consistency used exact float equality, so `0.1 + 0.2` children falsely failed against a `0.3` parent | [`valid/tree-float-0.1-plus-0.2`](valid/tree-float-0.1-plus-0.2.json) — must **not** flag; [`invalid/i6-children-exceed-parent`](invalid/i6-children-exceed-parent.json) — a real `120 ≠ 100` discrepancy still flags |

An implementation that fails any of these is, by definition, not conformant — the
old bug is back.

---

## Running the suite

### Reference runner (zero dependencies)

```bash
node conformance/runner/run.mjs            # all fixtures, summary
node conformance/runner/run.mjs --verbose  # one line per fixture
```

Exit code `0` = every fixture matched its expected outcome (`CONFORMANT ✓`);
`1` = at least one mismatch (the offending fixtures are listed).

The runner is **the normative validator**, and it reads the **canonical schema**:
structural validation walks `../schema/structure/*.schema.json` (a self-contained
JSON Schema 2020-12 validator, since `ajv` is not vendored), transition checks read
`../schema/behavior/transitions.json`, and the six invariants + `money_breakdown_sum`
are implemented per the reference impls named in `../schema/behavior/invariants.json`.
Shape alone is not conformance — the runner enforces behavior too.

### The cross-check — prove TS, Python, Rust, and Go agree

The point of the whole suite: run every fixture through **all four** bindings
and confirm identical verdicts.

```bash
node conformance/tooling/crosscheck.mjs   # prints the agreement table; exits 1 on any disagreement
```

It runs `crosscheck-ts.mjs` (canonical `@warp-lang/commerce-types`:
`auditCommerce` / `isValid*Transition` / `currencyDecimals`),
`crosscheck-python.py` (canonical `warp-commerce-types`: `audit_commerce` /
`is_valid_*_transition` / `validate_money_breakdown` / `currency_decimals`),
the Rust `crosscheck-rust` binary (canonical `crates/warp-commerce-types`:
schema-generated types + the `runtime` port of `run.mjs` — `audit_scene` /
`is_valid_transition` / `breakdown_is_valid` / `currency_decimals`), invoked via
`cargo run -p warp-commerce-types --bin crosscheck-rust`, and the Go
`crosscheck-go` command (canonical `bindings/go`: schema-generated types + the
`runtime.go` port of `run.mjs` — `AuditScene` / `IsValidTransition` /
`BreakdownIsValid` / `CurrencyDecimals`), invoked via `go run ./cmd/crosscheck-go`
with `WARP_CONFORMANCE_DIR` pointed at this directory. It then prints
`fixture | expected | TS | Python | Rust | Go | agree?`. Every fixture **runnable
in all four** must get the same verdict (and match the manifest). Fixtures no
behavioral binding can run (the structural-only state-catalogs) are marked `n/a`
and reported, not counted as disagreements.

Latest result: **45/45 fixtures runnable in all four (TS, Python, Rust, Go) agree;
0 disagreements** (6 n/a — the structural state-catalogs `catalog-commitment-states`,
`catalog-fulfillment-states`, `catalog-intent-states`, `catalog-value-states`,
`catalog-value-forms`, `catalog-party-types`, covered by the runner + JSON
Schema). The Rust types are regenerated from the schema by
`crates/warp-commerce-types/scripts/generate-rust.mjs` and the Go types by
`bindings/go/generate-go.mjs` (each with a `--check` drift gate in CI), exactly as
the TS/Python generators work.

### Writing a runner in another language

1. Read `manifest.json` — it lists every fixture, its `kind`, its `expect`, and
   (for invalid) its `rule` and sidecar path.
2. For each fixture, load `payload` and apply the check for its `kind`.
3. Compare your verdict to `expect` (and, for invalid scenes, confirm your
   rejection names the same `rule`).
4. Report pass/fail. Port `runner/run.mjs` directly — it is intentionally small
   and dependency-free for exactly this purpose.

Or, without porting the whole runner: have your binding **emit per-fixture
verdicts** in the documented adapter format and score them with
[`tooling/score-adapter.mjs`](tooling/score-adapter.mjs) — it applies the same
agreement check as the four-way TS↔Python↔Rust↔Go cross-check and reports `X/Y`. The worked
example (the TS binding scored through it) is
[`tooling/test-score-adapter.mjs`](tooling/test-score-adapter.mjs):

```bash
node conformance/tooling/crosscheck-ts.mjs | node conformance/tooling/score-adapter.mjs -
```

See **[`../docs/CONFORMANCE.md`](../docs/CONFORMANCE.md)** for the full
step-by-step guide — generate types → implement the checks → run the fixtures →
claim the badge — including what a pass does and does **not** prove.

If your implementation and this suite agree on all fixtures, you are
Warp-compatible at v1.0.0. Add a badge, ship it.

---

## Provenance — how the fixtures are derived

`tooling/build.mjs` defines every fixture as data drawn straight from the model
(the five primitives, the 26-transition table, the six invariants, currency-safe
Money) and then **asserts the canonical reference implementation agrees** before
writing anything: it runs the real `auditCommerce`, `isValid*Transition`, and
`currencyDecimals` from `@warp-lang/commerce-types` against each declared
outcome. If the package and a fixture ever disagree, the build aborts.

So each fixture is validated multiple ways:

- **canonical schema** — the zero-dep runner validates every fixture against
  `../schema` (`runner/run.mjs`) — the normative check;
- **TS binding** — the canonical TS package agrees (`tooling/crosscheck-ts.mjs`);
- **Python binding** — the canonical Python package agrees (`tooling/crosscheck-python.py`);
- **Rust binding** — the canonical Rust crate agrees (the `crosscheck-rust`
  binary in `crates/warp-commerce-types`, invoked by `tooling/crosscheck.mjs`);
- **Go binding** — the canonical Go module agrees (the `crosscheck-go` command in
  `bindings/go/cmd/crosscheck-go`, invoked by `tooling/crosscheck.mjs`);
- **manifest** — all of them match the declared `expect`/`rule`.

Where a binding lacks an API for a check, the suite is what surfaces it — that is
the point of a conformance suite. The one historical case, TS's missing
`MoneyBreakdown` checker, was caught exactly this way and has since been resolved
(B-1 in [`../schema/BACKLOG-v1.1.md`](../schema/BACKLOG-v1.1.md); TS now ships
`validateMoneyBreakdown`), so the money-breakdown fixtures run in all four bindings.
The suite is the gate every binding must pass, and the place divergences become
visible.

To regenerate / re-verify (requires the TS package built in
`packages/commerce-types/dist`, the Python package importable, a Rust toolchain so
`cargo run -p warp-commerce-types` can build the Rust binding, and a Go toolchain
so `go run ./cmd/crosscheck-go` can build the Go binding):

```bash
node conformance/tooling/build.mjs       # rewrites fixtures + manifest, cross-checks the TS canonical package
node conformance/runner/run.mjs          # validates every fixture against ../schema (normative, zero-dep)
node conformance/tooling/crosscheck.mjs  # prints the TS/Python/Rust/Go agreement table
```

---

## Versioning

The suite is versioned in [`VERSION`](VERSION) and in every fixture's `schema`
field. **v1.0.0** is the first stable conformance contract. Fixtures are only
*added* within a major version; changing or removing a fixture — anything that
could change a verdict — requires a major bump, because it redefines what
"Warp-compatible" means.
