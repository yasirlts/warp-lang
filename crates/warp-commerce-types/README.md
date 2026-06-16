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
