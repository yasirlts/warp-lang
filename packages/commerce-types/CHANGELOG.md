# Changelog — @warp-lang/commerce-types

All notable changes to the npm package. The package tracks the canonical
[Warp Commerce Model schema](https://github.com/yasirlts/warp-lang/tree/main/schema),
frozen at v1.0.0.

## 1.3.0

### Added

- **Agent session toolkit — `createSession()`.** A per-session ledger that makes
  an agent's proposals safe to retry and safe to interleave. It composes the
  existing transition + invariant checkers and adds two production-safety
  properties on top:
  - **Idempotency (replay dedup).** An action carrying an `idempotencyKey` (or,
    keyless, a content fingerprint) that has already been applied is recognized
    as a replay and not applied twice — a retried over-the-wire call does not
    double-refund.
  - **Optimistic concurrency (`expectedVersion`).** An action whose
    `expectedVersion` no longer matches the commitment's version is reported as a
    conflict rather than silently overwriting a concurrent change.
- **Interop — `unify()` + outbound descriptors.** Merge caller-corresponded
  platform objects into one validated Warp commitment (inbound), and translate a
  validated Warp action into a platform-shaped **descriptor** (outbound — a
  description of the action, not its execution). Inbound adapters: Shopify,
  Stripe, WooCommerce, and new this release **PayPal** and **Amazon**. A value
  mismatch across corresponded sources is caught as an I-1 conservation
  violation. Salesforce was evaluated and intentionally not included — its
  Opportunity is a sales-pipeline forecast, not a value-conserving commitment, so
  it has no faithful mapping.
- **Multi-agent — invariants over a shared world.** Run multiple agents against
  one world with per-actor attribution: when one agent's action tips the shared
  world into an invariant violation, the rejection names the tipping actor and
  the accumulated context.
- **Multi-object coherence.** Per-tree cumulative conservation across related
  commitments: refunds across a parent order and its line-item children stay
  within the parent's committed total; an over-refund across the tree is caught
  with the remaining-refundable amount.
- **Saga / compensation — `planCompensation` / `validateCompensation`.** Model
  the unwinding of a multi-step flow as an explicit sequence of compensating
  actions (each a legal reversing transition) and validate the sequence for
  coherence by running it through a session. A compensation that would over-refund
  or illegally regress is rejected with bounded guidance. Warp validates the
  compensation; it does not execute or orchestrate rollbacks on external systems.
- **Verifiable fulfillment attestations.** Sign a fulfillment with Ed25519
  (WebCrypto) over a canonical serialization and verify it as a non-schema
  envelope `{ fulfillment, signature, signer }`. Proves the fulfillment was
  signed by the holder of a given key and is untampered since signing; it does
  not bind the key to a real-world party (PKI, out of scope) and is not a
  zero-knowledge proof.
- **Multi-component settlement validation.** Validate that a settlement
  decomposed into typed components (principal / tax / fees / shipping) reconciles
  against the committed total in one currency, and track partial settlements
  cumulatively. Reconciliation only — it does not compute tax rates or
  jurisdictions; component amounts are caller-supplied.
- **Returns / RMA lifecycle profile.** Model a return as a child commitment
  against the parent order, with the RMA stages (requested → … → refunded)
  tracked as a session-layer overlay over the existing committed states. Partial
  returns and over-return safety reuse the per-tree refund cap.

### Notes

- All additive over 1.2.0 — the agent guardrail and the amount-conservation
  clause remain; every name exported by 1.2.0 is still exported with no signature
  change.
- **No schema change.** Every feature is expressed from existing fields of the
  frozen v1.0.0 Commerce Model; the conformance suite (54/54) and the
  TS/Python/Rust/Go cross-check stay green and unchanged.
- The attestation, settlement, returns/RMA features and the PayPal/Amazon
  adapters are part of this TypeScript package; the Python package
  (`warp-commerce-types`) scopes to the shared session layer — see its changelog.

## 1.2.0

### Added

- **Agent guardrail — `guardAction()` / `guardObject()`.** Validate a proposed
  commerce action *before* it executes. `guardAction(world, { commitment, to,
  actor })` applies the transition and audits the resulting world in one step,
  returning `{ ok: true, next }` or `{ ok: false, violations }` where each
  violation carries the invariant `rule`, a `message`, and a `fix`. `guardObject`
  is the thin object-level form over `auditCommerce`. These compose the existing
  transition + invariant logic — not a divergent code path — so a verdict from
  the guard matches a direct `auditCommerce` run exactly. Built for putting an
  AI agent near money: the agent proposes, the guard disposes.

- **I-1 now catches over-refunds (amount conservation).** `auditCommerce` (and
  therefore the guardrail) rejects a same-currency refund whose amount exceeds
  what was committed. The refund amount is read from the commitment's `Refunded`
  state; the committed amount from `subject.requested`. The bound is **refund ≤
  committed, same currency** — a full refund (refund == committed) is accepted as
  the conservation boundary, and a cross-currency refund is out of scope for this
  check (it requires an explicit conversion). This is enforced identically across
  all four language bindings and proven equivalent by the conformance cross-check.

### Notes

- Both additions are additive: every name exported by 1.1.0 is still exported,
  with no signature changes. No schema change — amount conservation is expressed
  entirely from existing fields of the frozen v1.0.0 model.
- The guardrail is a **TypeScript convenience** layered on the shared checkers;
  the amount-conservation clause itself lives in the cross-binding invariant
  layer and holds in the Python, Rust, and Go bindings too.

## 1.1.0

### Added

- **`order()` — the high-level fluent builder, now published.** Compose a
  history-complete, auditable order in a few lines
  (`order().from(b).to(s).item({ price }).paid().fulfilled().build()`), then run
  the headline check via `AuditedOrder.audit()`. It is a convenience over the
  existing primitives — internally it replays the canonical path through
  `applyCommitmentPath` / `applyFulfillmentPath`, so its output passes
  `auditCommerce` exactly as a hand-built object does. `.build()` returns
  `Result<AuditedOrder>`; invalid compositions return `{ ok: false, error }`,
  never a throw or a silently coerced object.

### Changed

- **API surface organized into Core / Advanced tiers** (docs + `index.ts`
  grouping only — no export was added or removed). The ~10 "start here" exports
  are documented under "Core API"; everything else remains exported under
  "Advanced API".
- **Duplicate names deprecated.** Each function now has one canonical name; the
  older duplicate aliases still work but are marked `@deprecated` (editors show a
  strikethrough) and will be removed in a future major. Migrate as follows:

  | Deprecated alias | Use instead |
  |------------------|-------------|
  | `auditCommerceCode` | `auditCommerce` |
  | `verifyInvariant1` | `checkI1ValueConservation` |
  | `verifyInvariant2` | `checkI2StateMonotonicity` |
  | `verifyInvariant3` | `checkI3CapacityVerification` |
  | `verifyInvariant4` | `checkI4TemporalIntegrity` |
  | `verifyInvariant5` | `checkI5IdentityPermanence` |
  | `verifyInvariant6` | `checkI6TreeConsistency` |
  | `verifyMoneyBreakdown` | `checkI1MoneyBreakdownSum` |

### Notes

- `order()` is a **TypeScript convenience**; it is not part of the Python
  package (`warp-commerce-types`), which exposes the same primitives,
  transitions, and invariant checkers. The two bindings remain proven equivalent
  on the shared model by the conformance cross-check.
- No breaking changes: every name exported by 1.0.0 is still exported.

## 1.0.0

### BREAKING

- **`Result<T>` is now a discriminated union.** It changed from the
  non-discriminated interface

  ```ts
  interface Result<T> { ok: boolean; value?: T; error?: string }
  ```

  to

  ```ts
  type Result<T> = { ok: true; value: T } | { ok: false; error: string };
  ```

  **Migration:** check `r.ok` to narrow the type — on the success branch
  `r.value` is present with no non-null assertion, and `r.error` exists only on
  the failure branch.

  ```ts
  const r = transitionCommitment(order, { type: "Accepted" }, partyId("store"));
  // before: r.value!         (non-null assertion required)
  // after:
  if (r.ok) {
    r.value; // Commitment — narrowed, no `!`
  } else {
    r.error; // string
  }
  ```

  This affects `transitionCommitment`, `transitionIntent`, and
  `transitionFulfillment`. Callers that used `r.value!` should switch to an
  `if (r.ok)` narrowing (or `if (r.ok === false) throw new Error(r.error)`).

### Added

- **`convert()` now rejects invalid rates.** A non-positive, `NaN`, or
  non-finite (`Infinity`) conversion rate throws the new typed
  `InvalidRateError` instead of silently producing a meaningless amount.

### Notes

- Types and transition tables are generated from the canonical schema spine
  (`schema/structure/*.schema.json` + `schema/behavior/transitions.json`) and
  proven equivalent to the Python package by the conformance cross-check.
