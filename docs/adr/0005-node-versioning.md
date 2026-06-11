# ADR-0005: Node Versioning

Date: 2026-05-22
Status: ACCEPTED
Accepted: 2026-05-22
Deciders: Yasir Ahmad (CTO)

## Context

Nodes evolve. `WhatsAppSend` shipped today may need a new required
parameter in 6 months (e.g., `template_category` to comply with a
Meta policy change). What happens to deployed workflows running the
old version?

This decision must be made **before the first external merchant
activates a workflow**, because changing the versioning model after
the catalog is in production breaks every active workflow.

## Options

| Pattern | What it does | Cost |
|---------|--------------|------|
| Latest-wins | Every workflow always runs the latest version | Silent behavior changes on merchant workflows; one bad node release is a fleet-wide incident |
| Pinned | Every workflow pins exact node versions; old versions kept forever | Catalog file size grows; merchants on old versions miss bug fixes |
| Hybrid (pinned with deprecation lifecycle) | Pinned, but old versions deprecated after N months; mandatory upgrade after | Forced migrations; merchant friction |

## Decision

**Pinned, with semver-style versioning per node.**

- Each node has a version field: `WhatsAppSend@1.0`, `WhatsAppSend@2.0`.
- Workflows save the exact node versions they use.
- Old node versions stay in the catalog. Never silently deleted.
- A merchant can upgrade a node version in a workflow via a
  **guided migration**: the canvas shows what changed, what new
  ports exist, and walks them through filling in any new required
  inputs. The migration is opt-in.

### Versioning rules

- **Major bump (1.0 → 2.0):** breaking change to the node interface
  — new required port, renamed output, semantic change to existing
  behavior.
- **Minor bump (1.0 → 1.1):** additive — new optional port, new
  output, internal performance improvement. Backwards-compatible
  by definition.
- **Patch (1.0.0 → 1.0.1):** bug fix only. No interface change.
  Applied to workflows automatically. (This is the one place
  "latest-wins" applies — bug fixes for the version a workflow is
  pinned to, never new majors.)

### Why pinned and not latest-wins

- Merchants do not expect their cart-recovery workflow to silently
  change behavior overnight.
- A breaking node change applied automatically to 10,000 active
  workflows = P0 incident at scale.
- Pinned + opt-in upgrade respects merchant agency. They control
  when their automation changes.

## Exceptions (CVE-driven mandatory migration)

If an old node version contains a security vulnerability (e.g., an
auth bypass in a payment node), merchants on the vulnerable version
get a forced migration with notification. Policy:

- 14 days notice for non-critical CVEs
- 24 hours notice for critical CVEs
- If a merchant does not migrate by the deadline, the workflow is
  paused (not deleted), and the merchant is notified again with
  an "upgrade or stay paused" message.

### Mandatory merchant notification on forced deploy

When the CVE escape hatch fires and a breaking node version is
force-deployed, the merchant receives a notification in their
canvas. The notification MUST include:

1. A plain-language explanation of what changed and why (in the
   merchant's language per P-7 — AR / FR / EN).
2. A list of affected workflows in the merchant's account.
3. A direct link to update each affected workflow.
4. The deadline by which the workflow will be paused if not
   updated (or, if already deployed, the timestamp of the forced
   migration).

Silent breaking changes are trust-killers. This is the only path
that overrides merchant agency, and it exists because data security
overrides P-5 (merchant sees commerce, not infrastructure) when the
infrastructure is leaking their data — but even when we override
P-5, we do not override the merchant's right to know.

## Consequences

Positive:
- Workflows are stable across time — merchants can rely on them
- Catalog evolves freely; old code does not constrain new design
- CVE escape hatch exists without making it the default behavior

Negative:
- Catalog file size grows with every major bump. Acceptable through
  Phase 4 at least; revisit after.
- Merchants on old node versions miss UX improvements until they
  migrate. Mitigation: the canvas surfaces "your workflow uses an
  older WhatsAppSend — see what's new in 2.0" prompts.
- Guided migrations are real engineering work per major bump.
  Mitigation: structured migration metadata in the node definition
  so the canvas can drive most migrations declaratively.

## Outstanding implementation questions

Resolved by acceptance:
- Semver pinning per node with explicit CVE escape hatch — **YES**.
- Mandatory merchant notification on any forced breaking deploy —
  **YES**, per the section above.

Deferred to implementation:
- Catalog growth — acceptable to keep every major version in the
  shipped binary indefinitely, or should old versions move to a
  lazy-loaded layer after ~2 years of disuse? Revisit when binary
  size becomes a real constraint, not before.
- Pricing — does an active workflow on an old version count the
  same as one on the current version for billing? Affects whether
  merchants face cost pressure to migrate.
- Bulk migration tools — should Lamar Tech operators be able to
  run a guided migration across all tenants on `WhatsAppSend@1.0`?
  Phase 4 admin-panel feature if yes.

## Enforcement

- Every node definition file MUST declare a version string. CI
  rejects nodes without one.
- A workflow that references a node version not present in the
  catalog fails to compile (C-02). This is intentional — it forces
  migration awareness instead of silent fallback.
- The `cargo test` suite for `warp-storage` includes a workflow
  loader test that asserts every shipped template loads against the
  current catalog.
