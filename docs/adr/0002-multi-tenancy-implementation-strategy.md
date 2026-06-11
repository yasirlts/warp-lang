# ADR-0002: Multi-Tenancy Implementation Strategy

Date: 2026-05-22
Status: ACCEPTED
Accepted: 2026-05-22
Deciders: Yasir Ahmad (CTO)

## Context

[CONTRACTS.md](../../CONTRACTS.md) C-03 requires `tenant_id` on every
execution, every workflow, every node config, every storage row,
every log line. No single-tenant shortcuts.

Three SaaS tenancy patterns can satisfy this:

- **Pool (row-level):** shared tables; `tenant_id` column on every row;
  isolation by query predicate + Postgres Row-Level Security.
- **Bridge (schema-per-tenant):** one schema per tenant in the same
  database. Stronger isolation, more ops overhead (migrations across
  N schemas).
- **Silo (database-per-tenant):** one database per tenant. Maximum
  isolation. Expensive at scale, useful for enterprise / regulated.

The decision affects every storage query and every test we write
from Phase 0 onward. Getting this wrong is the multi-tenant retrofit
debt C-03 was written to prevent.

## Options

| Pattern | Pros | Cons |
|---------|------|------|
| Pool | Cheapest, scales horizontally, fewest moving parts | Bugs leak across tenants if app-level scoping fails |
| Bridge | Migration cost per tenant; harder to reason about | Some isolation gain, still single DB blast radius |
| Silo | Strongest isolation; backup-per-tenant trivial | High cost; cross-tenant analytics impossible without ETL |

## Decision

**Pool model, with two enforcement layers:**

1. **App-level:** every storage query passes through a
   `TenantScopedConnection` that injects `tenant_id` into every
   query. Raw query construction is forbidden at the type level —
   you cannot get a connection without a `TenantContext`.

2. **DB-level:** Postgres Row-Level Security policies on every
   tenant-scoped table as defense-in-depth. If app-level scoping
   ever has a bug, RLS prevents the leak from reaching the wire.

This matches the model Agora already runs on, so the operational
playbook is shared.

### The C-03 contract test

A single test is the contract for C-03 compliance:

- Fixture creates Tenant A and Tenant B with overlapping primary
  keys (same `customer_id`, same `order_id`).
- The test exercises every read path in the catalog, including
  paths reached through application code that has been intentionally
  bugged (e.g., a query builder that forgets to scope).
- The test passes only if zero rows from Tenant B are ever returned
  to Tenant A, even when the application layer is broken.

If this test passes, C-03 holds. If it ever fails, C-03 is broken
and the build is broken. There is no third state. This test runs on
every PR touching `warp-storage`.

**Enterprise / Silo deferral:** customers requiring true database
isolation are a Phase 4+ concern. We design the storage layer so
that Silo is achievable by changing the connection pool, not by
rewriting queries.

## Consequences

Positive:
- Cheapest path to Phase 1
- Two independent failure layers (app + RLS) means one bug doesn't leak data
- Migration path to Silo is preserved by the `TenantScopedConnection` abstraction

Negative:
- RLS adds query planning overhead — measure and accept the cost
- Cross-tenant aggregation (e.g., Lamar Tech analytics) needs a privileged code path that explicitly opts out of `TenantScopedConnection` — that path is a security review checkpoint
- Backup-per-tenant requires logical export, not pg_dump

## Outstanding implementation questions

Resolved by acceptance:
- Pool model commitment for first 1,000 merchants with Silo path
  reserved for Phase 4+ enterprise tier — **YES**.

Deferred to implementation:
- Should logs carry `tenant_id` as a structured field or a tag?
  (Affects log aggregation cost and ease of redaction.)
- Is RLS overhead acceptable on hot paths like `WhatsAppSend`
  delivery receipts? Measure before deciding to bypass for that
  table specifically. If a bypass is needed, it MUST come through
  a security review checkpoint, not a one-off engineering call.

## Enforcement

- CI: a `cargo check` lint denies raw `sqlx::query!` calls outside
  `TenantScopedConnection`.
- CI: the cross-tenant leak test described above.
- Code review: any PR that introduces a new tenant-scoped table must
  add the RLS policy in the same migration.
