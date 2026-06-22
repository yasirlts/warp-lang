# warp-commerce-types (Rust binding)

The Rust binding for the **Warp Commerce Model**. Like the TypeScript
(`@warp-lang/commerce-types`) and Python (`warp-commerce-types`) bindings, the
structural types are **generated from the canonical schema spine**
(`schema/structure/*.schema.json`) — the language-neutral source of truth — and
the binding is proven to agree with the other two via the conformance
cross-check.

## Layout

- `src/generated/types.rs` — every schema `$def` as a serde-derived Rust type.
  **Generated. Do not edit by hand.**
- `src/generated/transitions.rs` — the commitment / intent / fulfillment
  transition tables, verbatim from `schema/behavior/transitions.json`.
  **Generated. Do not edit by hand.**
- `src/runtime.rs` — the hand-written behavioral layer, a faithful port of the
  normative runner `conformance/runner/run.mjs`: `currency_decimals`,
  `money_equals`, `is_valid_transition` (incl. the fulfillment
  `Failed -> Planned` recoverable-only special case), the six-invariant
  `audit_scene`, and `breakdown_is_valid` (`money_breakdown_sum`).
- `src/toolkit.rs` — the **agent toolkit**: the planning oracle
  (`valid_transitions`), guardrail (`guard_action` / `guard_object`), session
  coherence (`create_session`, incl. **idempotency / replay-safety** via
  `idempotency_key` and **optimistic-conflict** via `expected_version` /
  `commitment_version`), and interop (`unify` + `to_*_action` emitters). A
  composition over `runtime.rs` + the generated table, behaviour-equivalent to the
  TypeScript / Python / Go toolkits (same verdicts on the same scenarios; the
  `examples/*.rs` run them). Honest binding notes, documented in the module:
  `audit_scene` returns invariant *ids*, so guard messages are standard
  per-invariant text; the conformance-focused runtime ships no platform inbound
  mappers, so `unify` is platform-agnostic (callers map platform objects via serde);
  and because that runtime advances state without re-appending history, the
  optimistic-concurrency version moves via the state fingerprint (`"0:Accepted"` →
  `"0:Active"`) rather than the history length — the conflict verdict is identical.
- `src/bin/crosscheck-rust.rs` — the `crosscheck-rust` binary: emits per-fixture
  verdicts in the shared JSON shape for the three-way cross-check.

## Regenerating from the schema

The generator is a Node script (mirroring the TS/Python generators), run from
the repo root:

```bash
# Write the generated Rust (rustfmt-formatted so it stays cargo-fmt-clean):
node crates/warp-commerce-types/scripts/generate-rust.mjs

# Drift gate (CI): exit 1 if the committed generated Rust differs from schema/:
node crates/warp-commerce-types/scripts/generate-rust.mjs --check
```

The generator mirrors the seams of the other two generators exactly:
`STRUCTURE_FILES` order `[money, party, value, intent, commitment, fulfillment,
auxiliary, index]`; `BRANDS = {PartyID, IntentID, CommitmentID, FulfillmentID,
ValueID}` become `pub type X = String`; `CurrencyCode` is an OPEN
`pub type CurrencyCode = String`; transitions are synced verbatim from
`schema/behavior/transitions.json`; bare passthrough alias `$defs` (index
aggregation) are skipped.

## Running the cross-check

```bash
# From the repo root — runs TS, Python, AND Rust and prints the agreement table:
node conformance/tooling/crosscheck.mjs

# Just the Rust verdicts as JSON:
cargo run -q -p warp-commerce-types --bin crosscheck-rust
```
