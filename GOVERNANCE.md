# Governance

This is a small, honest description of how decisions are made in warp-lang. It is
intentionally minimal — the project is early and maintainer-led, and this
document says so plainly rather than describing a community process that does not
yet exist.

## Who decides

- **Maintainer.** Yasir Ahmad (CTO, Lamar Tech) is the maintainer and final
  decision-maker on strategic and schema-level questions.
- **Already-decided architecture** lives in the Architecture Decision Records in
  [`docs/adr/`](docs/adr/). An accepted ADR is the source of truth for the
  decision it records.
- **Code-level changes** are decided in pull-request review against the bar in
  [`CONTRIBUTING.md`](CONTRIBUTING.md): conformance stays green and the bindings
  still agree.

The rule of thumb: **no ADR, no architectural change.** Anything that alters the
shape, behavior, or meaning of the model is an architectural change.

## The schema-change policy

The canonical schema in [`schema/`](schema/) is **v1.0.0 and frozen**. This is
the load-bearing rule of the project, because the four bindings, the conformance
fixtures, and every "Warp-compatible" claim are pinned to it.

A change to the schema — its structure, its transition table, or its invariants —
is not a routine pull request. It follows an ADR-style process:

1. **Propose.** Open an issue (or a draft ADR in [`docs/adr/`](docs/adr/))
   describing the change, why the frozen version cannot serve the need, and what
   it would break.
2. **Assess the blast radius.** A schema change ripples into all four bindings'
   generated types, the conformance fixtures, and the version contract. Spell out
   that impact.
3. **Version it correctly.** Fixtures are only *added* within a major version.
   Changing or removing a fixture — anything that could change a verdict —
   requires a **major bump**, because it redefines what "Warp-compatible" means
   (see [`conformance/README.md`](conformance/README.md) → Versioning and
   [`schema/BACKLOG-v1.1.md`](schema/BACKLOG-v1.1.md) for queued items).
4. **Record it.** An accepted schema change is captured as an ADR following the
   existing format (Date / Status / Deciders / Context / Decision /
   Consequences), the way [`docs/adr/`](docs/adr/) already records decisions such
   as the choice of execution foundation.

Until such a change is accepted and versioned, contributions **do not edit the
schema**. Plenty of valuable work — binding bug fixes that restore agreement,
documentation, case studies, additional fixtures that lock in already-specified
behavior, tooling — needs no schema change at all.

## Adding a reference binding

A new language binding that passes the conformance suite (see
[`docs/authoring-a-binding.md`](docs/authoring-a-binding.md)) is welcome as a
contribution. Promoting one to a **reference** binding — wired into the four-way
cross-check and held to the drift gate in CI — is a maintainer decision, because
it adds an ongoing maintenance obligation: every future change must keep that
binding in agreement too.

## What this document is not

This is a governance *stub*, sized to where the project actually is. It does not
claim a steering committee, a voting body, or an established contributor
community — building that is the maintainer's to do over time, not something to
assert before it exists. As the contributor base grows, this document is the
place to record how that changes.
