# Maintainers

This document records who maintains warp-lang, what the role entails, and how a
new maintainer is brought on. It is deliberately small and matches where the
project actually is: maintainer-led and early, as
[`GOVERNANCE.md`](GOVERNANCE.md) describes.

## Current maintainers

| Maintainer | Areas | Notes |
|------------|-------|-------|
| Yasir Ahmad (CTO, Lamar Tech) | Schema, governance, releases, conformance, all four bindings | Sole maintainer and final decision-maker per [`GOVERNANCE.md`](GOVERNANCE.md). |
| _(open)_ | _TODO — second maintainer not yet appointed_ | See "Appointing a second maintainer" below. This is a user/maintainer action and is intentionally left blank rather than filled with an invented name. |

A second maintainer is **not yet appointed.** This document is in place so that
when the current maintainer chooses someone, the onboarding path is already
written down. Appointing the person is the maintainer's action; it is not
something this document can do on its own.

## Who maintains what

The repository is one canonical schema with several implementations generated
from it (see [`CONTRIBUTING.md`](CONTRIBUTING.md) → Repository layout). The
maintainer is responsible across all of it:

- **Schema** — [`schema/`](schema/), at **v1.0.0 and frozen**
  ([`schema/VERSION`](schema/VERSION)): the structure files, the transition
  table, and the invariants.
- **Bindings** — the four reference bindings that must stay in agreement:
  TypeScript ([`packages/commerce-types/`](packages/commerce-types/)), Python
  ([`packages/commerce-types-py/`](packages/commerce-types-py/)), Rust
  ([`crates/warp-commerce-types/`](crates/warp-commerce-types/)), and Go
  ([`bindings/go/`](bindings/go/)).
- **Conformance** — the fixtures, the zero-dependency runner, and the four-way
  cross-check tooling in [`conformance/`](conformance/).
- **Releases** — the published packages `@warp-lang/commerce-types` (npm) and
  `warp-commerce-types` (PyPI), per [`RELEASING.md`](RELEASING.md).
- **Governance and ADRs** — [`GOVERNANCE.md`](GOVERNANCE.md) and the decision
  records in [`docs/adr/`](docs/adr/).

## Maintainer responsibilities

### Releases

Releases are tag-triggered and gated, as documented in
[`RELEASING.md`](RELEASING.md). The maintainer:

- Runs the pre-release checklist: both package versions
  (`packages/commerce-types/package.json` and
  `packages/commerce-types-py/pyproject.toml`) match the intended tag, the
  lockfile is in sync, CHANGELOGs are updated, and the release PR's CI gate is
  green.
- Cuts the release by pushing a `vX.Y.Z` tag, which runs
  [`.github/workflows/release.yml`](.github/workflows/release.yml): the full
  conformance gate runs first, the publish jobs `needs:` every gate job (a red
  gate publishes nothing), and `publish-npm` runs before `publish-pypi` to
  prevent a split state where PyPI is ahead of npm.
- Manages release secrets in **Settings → Secrets and variables → Actions** —
  notably that `NPM_TOKEN` is a **granular Read+Write token** scoped to the
  `warp-lang` org (a classic/automation token hits npm's 2FA-on-write and fails
  with `EOTP`), and that `PYPI_TOKEN` is set. Rotating these is a maintainer
  action, not a code change.
- Verifies both registries report the tagged version after publish.

### Schema-change / ADR policy

The schema is **frozen at v1.0.0**, and that is the load-bearing rule of the
project: the four bindings, the conformance fixtures, and every
"Warp-compatible" claim are pinned to it. The maintainer holds the line:

- A change to the schema's structure, transition table, or invariants is a
  **governance decision, not a routine pull request.** It follows the process in
  [`GOVERNANCE.md`](GOVERNANCE.md) → "The schema-change policy": propose, assess
  the blast radius across all four bindings and the fixtures, version it
  correctly (a fixture change that could change a verdict requires a **major
  bump**), and record it as an ADR.
- **No ADR, no architectural change.** Anything that alters the shape, behavior,
  or meaning of the model is an architectural change and needs an ADR in
  [`docs/adr/`](docs/adr/).
- Adding fixtures that lock in already-specified behavior is allowed within the
  major version; changing or removing a fixture is a major bump.

### Conformance gate

The single bar for any change is that **the conformance suite stays green and
the bindings still agree** ([`CONTRIBUTING.md`](CONTRIBUTING.md)). The maintainer
ensures pull requests clear it:

- `node conformance/runner/run.mjs` — the normative validator (Node only, no
  install); a clean run prints `CONFORMANT` and exits `0`.
- `node conformance/tooling/crosscheck.mjs` — the TS / Python / Rust / Go
  agreement table; it exits non-zero on any disagreement.
- CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) enforces this on
  every PR, and the release gate re-runs the same jobs. A binding fix that the
  cross-check surfaces should bring that binding back into agreement, not paper
  over a divergence.

See [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) for what a pass does and does
not establish: it means a binding agrees with the model on the current fixtures
at the current schema version — not that the code is correct in general.

### Security

There is no dedicated `SECURITY.md` or published disclosure process in the
repository today. Until one exists, security reports should go to the maintainer
directly (Yasir Ahmad, via the contact on the GitHub profile / org). Adding a
proper `SECURITY.md` with a disclosure policy is a reasonable early task for the
maintainer team and is the right place to record this once it exists; this
document should be updated to point at it then. Stated plainly so the gap is
visible rather than implied.

## How a new maintainer is onboarded

When the current maintainer appoints a second maintainer, onboarding covers
access, the release process, and the review bar.

### Access

- **GitHub:** add the person to the `yasirlts/warp-lang` repository (and the
  `warp-lang` org) with the permission level the maintainer decides, sufficient
  to review and merge pull requests and to manage Actions and secrets if they
  will cut releases.
- **Release secrets:** if the new maintainer will cut releases, ensure they can
  manage **Settings → Secrets and variables → Actions** — the granular
  `NPM_TOKEN` and `PYPI_TOKEN` described in [`RELEASING.md`](RELEASING.md). They
  do not need personal publish credentials for the tag-triggered path; the
  workflow publishes using the org token.
- **Registries:** for the manual npm fallback in [`RELEASING.md`](RELEASING.md)
  (publishing by hand with `--otp` when CI npm publish fails), the maintainer
  needs to be a member of the `warp-lang` npm org with publish rights and their
  own 2FA set up.

### The release process

A new maintainer should be able to perform a release end to end from
[`RELEASING.md`](RELEASING.md): run the pre-release checklist, push the
`vX.Y.Z` tag, watch the Release workflow (gate green → `publish-npm` green →
`publish-pypi` green), and run the post-publish verification against both
registries. The first release a new maintainer cuts should be done alongside the
current maintainer.

### The review bar

A new maintainer reviews pull requests to the same bar contributors are held to
in [`CONTRIBUTING.md`](CONTRIBUTING.md):

- Conformance stays green (`run.mjs` and `crosscheck.mjs` both pass).
- The four bindings stay in agreement.
- New behavior is locked with a fixture (valid or invalid, with the rejecting
  rule named in its sidecar) — added within the major version.
- The frozen schema is not touched without an ADR through
  [`GOVERNANCE.md`](GOVERNANCE.md).
- Claims are honest and sized to what a conformance pass establishes.

## Appointing a second maintainer

Adding the second maintainer is a maintainer action, not a code change:

1. The current maintainer decides who, and confirms with the person.
2. Grant the access above.
3. Walk them through a release as described, and through a representative PR
   review against the bar.
4. Update the **Current maintainers** table in this document to replace the
   `(open)` row with their name and areas, in a normal pull request.

Until then the second-maintainer slot stays explicitly open.
