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
- `src/multi_agent.rs` — **multi-agent verification (F5)**: `create_multi_agent_session`,
  a thin wrapper over `toolkit::Session` adding a who-did-what `log`, an `actors_summary`,
  and per-actor `attribution` on a rejection (which actor's action tipped the shared
  world over, against the prior actors). It composes the same actor-agnostic session —
  it does not fork or re-derive any check. Mirrors the TypeScript / Python multi-agent
  modules behaviourally (same verdict fields; the attribution STRING wording is this
  binding's own — see the module docs).
- `src/saga.rs` — **saga / compensation (F7)**: `plan_compensation` /
  `validate_compensation` / `compensate` / `compensate_session`, composing
  `valid_transitions` + `toolkit::Session`. Default mapping: Fulfilled → Refunded (for
  the committed amount), committed-but-undelivered (Accepted / Active / Modified /
  PartiallyFulfilled) → Cancelled; a per-step `compensate_with` override is still bounded
  by the transition table and the invariants. Mirrors the TypeScript / Python saga
  modules behaviourally.
- `src/bin/crosscheck-rust.rs` — the `crosscheck-rust` binary: emits per-fixture
  verdicts in the shared JSON shape for the three-way cross-check.

## Session features (F3–F7)

`toolkit::Session` (and the `multi_agent` / `saga` wrappers) carry the cross-step
session features, each a composition over `runtime.rs` + the generated table — no schema
change, no re-derived invariant or transition logic:

- **F3 optimistic-conflict** — `commitment_version` / `expected_version`: an action
  planned against a stale version is rejected as a CONFLICT (distinct from an invariant
  violation), so the caller re-reads and re-plans. Not a lock or distributed transaction.
- **F4 idempotency / replay-safety** — a caller `idempotency_key` (or a derived
  fingerprint) dedups a retried action as a replay (no double-refund). Per-session,
  in-memory; durable cross-session idempotency is not provided.
- **F5 multi-agent** — `src/multi_agent.rs` (above).
- **F6 multi-object coherence** — the `Session` carries a per-TREE refund ledger keyed
  by the tree ROOT id, ADDITIVE to the per-commitment cap: refunds spread across a parent
  and its children cannot cumulatively exceed the parent's committed amount. Standalone
  commitments are never tree members, so single-commitment behaviour is unchanged.
- **F7 saga / compensation** — `src/saga.rs` (above).

### Documented per-binding shape gaps (F6)

The TypeScript and Python bindings expose a standalone tree-consistency check
(`checkI6TreeConsistency` / `check_i6_tree_consistency`) that their session calls
directly. The Rust runtime has **no** such standalone function — I-6 is computed INLINE
inside `runtime::audit_scene`. Rather than re-derive the tree-sum rule (which the
project's contracts forbid), the Rust `Session` composes the SAME canonical auditor by
running JUST the root + its children subset through `audit_scene` and looking for the
`"I-6"` id it raises. The VERDICT (whether the tree reconciles) is identical to the other
bindings; only the call shape differs. This is documented at the `tree_is_consistent`
helper in `toolkit.rs`.

Other already-documented binding notes still apply: `audit_scene` returns invariant
*ids*, so guard messages (and the F6 tree-violation message) are this binding's standard
per-invariant text — the verdict id is what matches across bindings. The attribution
string in `multi_agent` is likewise this binding's own wording.

### Examples

The `examples/*.rs` are runnable twins of the TS / Python examples, with matching
verdicts:

```bash
cargo run -p warp-commerce-types --example multi_agent
cargo run -p warp-commerce-types --example multi_object
cargo run -p warp-commerce-types --example saga
```

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
