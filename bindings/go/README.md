# warp-lang — Go binding

A conformance-focused Go binding for the Warp Commerce Model: it deserializes scenes,
audits them against the six invariants (`runtime.go` / `AuditScene`), reads the generated
transition table, and exposes an agent `toolkit.go` that composes those primitives into a
guardrail, planning oracle, session, and cross-platform interop layer.

The binding does **not** re-derive invariant or transition logic — everything in
`toolkit.go` (and the `multi_agent` / `saga` modules) is a composition over `runtime.go`
plus the generated table. The schema is frozen; nothing here changes it.

## Session features (F3–F7)

`Session` (and the multi-agent / saga wrappers) carry the cross-step session features,
each a composition — no schema change, no re-derived invariant or transition logic:

- **F3 optimistic-conflict** — `CommitmentVersion` / `ProposedAction.ExpectedVersion`: an
  action planned against a stale version is rejected as a CONFLICT (distinct from an
  invariant violation), so the caller re-reads and re-plans. This is optimistic
  concurrency over the caller's view — not a lock, consensus, or distributed transaction
  manager; Warp does not serialize concurrent writers.
- **F4 idempotency / replay-safety** — a caller `IdempotencyKey` (or a derived
  fingerprint) dedups a retried action as a replay, so a retried refund does not refund
  twice. Scope is per-session and in-memory; durable cross-session idempotency would need
  a persistent store and is not provided here.
- **F5 multi-agent** — `multi_agent.go`: `CreateMultiAgentSession`, a thin wrapper over
  `Session` adding a who-did-what `Log()`, an `ActorsSummary()`, and per-actor
  `Attribution` on a rejection (which actor's action tipped the shared world over, against
  the prior actors). It composes the same actor-agnostic session — it does not fork or
  re-derive any check.
- **F6 multi-object coherence** — `Session` carries a per-TREE refund ledger keyed by the
  tree ROOT id, ADDITIVE to the per-commitment cap: refunds spread across a parent and its
  children cannot cumulatively exceed the parent's committed amount. Standalone commitments
  are never tree members, so single-commitment behaviour is unchanged.
- **F7 saga / compensation** — `saga.go`: `PlanCompensation` / `ValidateCompensation` /
  `Compensate` / `CompensateSession`, composing `ValidTransitions` + `Session`. Default
  mapping: Fulfilled → Refunded (for the committed amount); committed-but-undelivered
  (Accepted / Active / Modified / PartiallyFulfilled) → Cancelled. A per-step
  `CompensateWith` override is still bounded by the transition table and the invariants, so
  an illegal or invariant-violating override is rejected with guidance.

These mirror the TypeScript / Python / Rust modules behaviourally; the cross-check in
`conformance/tooling/crosscheck.mjs` exercises all four bindings on every fixture.

### Documented per-binding wording / shape gaps

- **F6 tree-consistency shape gap.** The TypeScript and Python bindings expose a standalone
  tree-consistency check (`checkI6TreeConsistency` / `check_i6_tree_consistency`) that their
  session calls directly. The Go runtime has **no** such standalone function — I-6 is
  computed INLINE inside `AuditScene` (see `runtime.go`). Rather than re-derive the tree-sum
  rule (which the project's contracts forbid), the Go `Session` composes the SAME canonical
  auditor by running JUST the root + its children subset through `AuditScene` and looking for
  the `"I-6"` id it raises (see the `treeIsConsistent` helper in `toolkit.go`). The VERDICT
  (whether the tree reconciles) is identical to the other bindings; only the call shape
  differs. This mirrors what the Rust port did.
- **Invariant message wording.** `AuditScene` returns invariant *ids* (e.g. `"I-1"`), not
  per-violation descriptions, so the guard messages — including the F6 tree-violation
  message — are this binding's standard per-invariant text. The VERDICT (which invariant
  fires) matches the other bindings exactly; the message wording is binding-specific.
- **F5 attribution wording.** The `Attribution` string is this binding's own phrasing. It
  conveys the same facts as the other bindings (the tipping actor, the prior actors as
  accumulated context, and whether the cause was a conflict or an invariant violation) but
  is not a byte-for-byte copy. Tests assert the facts, not the exact sentence.

### Scope notes (honest)

- F5 attribution is "which single action tipped the shared world into violation" — the
  proposing actor of the failing step. It is NOT collusion, conspiracy, or multi-party
  intent detection: Warp does not infer that several actors coordinated.
- F7 compensation VALIDATES that an unwind sequence is coherent (each compensation is a
  legal reversing transition and the net effect conserves value). It does NOT execute or
  orchestrate rollbacks on external systems — a plan is a sequence of validated
  descriptors, not a distributed-transaction coordinator.

## Examples

The `examples/*` are runnable twins of the TS / Python / Rust examples, with matching
verdicts:

```bash
go run ./examples/multi_agent
go run ./examples/multi_object
go run ./examples/saga
go run ./examples/toolkit
```

## Tests

```bash
go test ./...
go vet ./...
gofmt -l .
```
