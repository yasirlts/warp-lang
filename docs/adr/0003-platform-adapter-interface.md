# ADR-0003: Platform Adapter Interface

Date: 2026-05-22
Status: ACCEPTED
Accepted: 2026-05-22
Deciders: Yasir Ahmad (CTO)

## Context

[CLAUDE.md](../../CLAUDE.md) drafts the `CommerceAdapter` trait:

```rust
trait CommerceAdapter {
    fn platform(&self) -> Platform;
    fn subscribe(&self, event: CommerceEventType) -> EventStream;
    fn emit(&self, action: CommerceAction) -> Result<(), AdapterError>;
    fn health(&self) -> AdapterHealth;
}
```

[CONTRACTS.md](../../CONTRACTS.md) C-04 forbids `warp-core` from
depending on any specific adapter. The trait is the only contract.

This interface must be locked down **before** the Agora adapter is
built in Phase 2. Once N adapters target a trait, changing it is
expensive. ADR-0001 chose Option A (commerce types in `warp-core`)
to move fast; ADR-0003 is the opposite call — slow down here, get
it right.

## Open design questions

1. **Async or sync?** Adapters do network I/O; sync would block the
   executor. Async is the only realistic answer, but: `async_trait`
   crate vs native `async fn in trait` (stable since Rust 1.75).
2. **EventStream lifecycle.** Does the adapter own the connection
   (and yield events), or does `warp-core` poll the adapter? Stream
   ownership affects reconnect logic and backpressure.
3. **Backpressure.** When `warp-core` can't keep up with adapter
   throughput (e.g., Black Friday on Shopify), who buffers?
4. **Polling vs webhook adapters.** OpenCart's REST API has no native
   event bus — OpenCart adapter polls. Shopify has webhooks. Same
   trait must accommodate both without forcing polling-shaped APIs
   on webhook adapters or vice versa.
5. **Degraded health.** Health is not binary. An adapter might
   receive events fine but fail to emit (Meta API down). `AdapterHealth`
   needs to express partial degradation.
6. **Trait versioning.** When we add a method in 6 months (e.g.,
   `fn replay(since: Timestamp)`), how do existing adapters opt in
   without breaking the build?

## Decision

```rust
#[async_trait]
pub trait CommerceAdapter: Send + Sync {
    fn platform(&self) -> Platform;

    async fn subscribe(
        &self,
        event: CommerceEventType,
    ) -> Result<EventStream, AdapterError>;

    async fn emit(
        &self,
        action: CommerceAction,
    ) -> Result<EmitReceipt, AdapterError>;

    fn health(&self) -> AdapterHealth;
}

pub type EventStream = Pin<Box<dyn Stream<Item = CommerceEvent> + Send>>;

pub enum AdapterHealth {
    Healthy,
    Degraded { receiving: bool, emitting: bool, reason: String },
    Down { reason: String, since: Instant },
}
```

**Choices made:**

- `async_trait` crate, not native AFIT — until MSRV pins are
  resolved and the ecosystem's tooling (clippy, rustdoc) handles
  AFIT cleanly. Revisit Phase 3.
- Adapter owns the stream. Polling adapters (OpenCart) wrap their
  poll loop in a stream internally. Webhook adapters (Shopify)
  expose their webhook receiver as a stream. Trait stays uniform.
- Backpressure: stream is bounded by an adapter-defined buffer.
  When the buffer fills, the adapter decides policy — drop oldest,
  drop newest, or block. The trait does not dictate; each adapter
  picks based on its semantics. Drop policies are documented per
  adapter.
- **Drop observability is centralized and non-negotiable.** Every
  adapter that drops a message MUST emit a `warp.backpressure.dropped`
  event to the observability layer, regardless of which drop policy
  it implements. The fields on that event (adapter name, event
  type, drop reason, count since last flush) are defined by
  `warp-core` and shared across all adapters. Drop policy is
  adapter-specific. Drop visibility is universal. Merchants and
  operators see "we lost 47 events from the Shopify adapter in the
  last 5 minutes" with the same shape no matter which adapter
  dropped them.
- `AdapterHealth` has an explicit `Degraded` variant separating
  receiving and emitting capability. The merchant canvas displays
  this state directly when an adapter is partially down.
- Trait versioning: new methods get a default implementation
  (returning `AdapterError::NotImplemented`) so existing adapters
  compile unchanged. Breaking changes require a new trait
  (`CommerceAdapterV2`).

## Consequences

Positive:
- Adapters can be written independently of `warp-core` releases
- Polling and webhook adapters share one trait without one shape
  contorting the other
- Partial degradation surfaces to merchants instead of silent failure

Negative:
- `async_trait` macro overhead is non-zero; measurable in hot paths
- Drop policies vary per adapter — operators must learn each
  adapter's behavior under load
- Default-impl method additions risk silently downgrading capability
  (an adapter that "supports" replay returns `NotImplemented`)

## Outstanding implementation questions

Resolved by acceptance:
- Adapter-defined backpressure policy (not central) — **YES**, with
  the mandatory drop-observability event above as the compensating
  control. The reasoning: Shopify webhook delivery and OpenCart
  polling have fundamentally different failure modes; centralizing
  policy in `warp-core` would force the core to know
  adapter-specific behavior, violating C-04.

Deferred to implementation:
- `EmitReceipt` semantics — does it represent delivery confirmation
  (received and acted upon downstream) or just acknowledgment
  (received by adapter)? Affects whether emit idempotency lives at
  the adapter or runtime layer.
- Trait versioning approach — `CommerceAdapterV2` as a separate
  trait when a breaking change is needed, vs always-default-impl
  extension on a single trait. Decide at the first breaking change,
  not before; default-impl extension is fine for additive changes.

## Enforcement

- The trait lives in `crates/warp-core/src/adapter/mod.rs`. C-04
  prevents `warp-core` from importing any adapter implementation.
- A CI check `grep -r 'use catalog::adapters::' crates/warp-core/`
  must return empty. Any match fails the build.
- Every adapter crate must pass an `adapter_conformance` test
  shared from `warp-core` that exercises subscribe + emit + health.
