# Contributing to warp-lang

Thanks for your interest in the Warp Commerce Model. This repository holds the
canonical schema, four reference language bindings, a language-neutral
conformance suite, an MCP server, an agent demo, and the `.warp` DSL compiler.
This guide explains how the pieces fit together, how to run the tests, and what a
pull request needs to clear.

The single bar for any change is simple: **the conformance suite stays green and
the bindings still agree.** Everything below is in service of that.

---

## Repository layout

The repo is one canonical schema with several implementations generated from it.

| Path | What it is |
|------|------------|
| [`schema/`](schema/) | The canonical, language-neutral source of truth. `structure/*.schema.json` (JSON Schema 2020-12) plus `behavior/` (`transitions.json`, `invariants.json`). Version in [`schema/VERSION`](schema/VERSION). |
| [`packages/commerce-types/`](packages/commerce-types/) | The TypeScript binding — `@warp-lang/commerce-types` (npm). Types generated from the schema. |
| [`packages/commerce-types-py/`](packages/commerce-types-py/) | The Python binding — `warp-commerce-types` (PyPI). |
| [`crates/warp-commerce-types/`](crates/warp-commerce-types/) | The Rust binding — generated types plus a `runtime` port of the reference runner. |
| [`bindings/go/`](bindings/go/) | The Go binding — generated types plus a `runtime.go` port of the reference runner. |
| [`packages/commerce-mcp/`](packages/commerce-mcp/) | The MCP server that exposes model checks to AI agents. |
| [`packages/agent-demo/`](packages/agent-demo/) | A demo that puts an agent next to the model checks (canned, keyless replay plus live verdicts). |
| [`conformance/`](conformance/) | The language-neutral fixtures, the zero-dependency runner, and the four-way cross-check tooling. |
| [`crates/warp-core/`](crates/warp-core/), [`crates/warp-mcp/`](crates/warp-mcp/), [`crates/warp-generated/`](crates/warp-generated/) | The `.warp` DSL compiler (hand-written lexer / parser / type checker / codegen) and supporting crates. |
| [`spec/`](spec/), [`docs/`](docs/) | The prose spec, versioned type specs, ADRs, and case studies. |

The four bindings (TypeScript, Python, Rust, Go) are **all generated from
`schema/`** and proven equivalent by the conformance cross-check. The schema is
the arbiter: when a binding and the schema disagree, the schema wins.

---

## The schema is frozen

`schema/` is at **v1.0.0 and frozen** (see [`schema/README.md`](schema/README.md)
and [`schema/VERSION`](schema/VERSION)). This is the most important rule in the
repo.

- **Do not change the shape or behavior of the schema** — the structure files,
  the transition table, or the invariants — as part of a routine contribution.
  The conformance fixtures, all four bindings, and anything that calls itself
  "Warp-compatible" are pinned to this version. A change here redefines what
  "Warp-compatible" means.
- **Fixtures are only added within a major version.** Changing or removing a
  fixture — anything that could change a verdict — requires a major bump
  (see [`conformance/README.md`](conformance/README.md) → Versioning).
- A schema change is therefore a **governance decision**, not a code review. It
  goes through the process in [`GOVERNANCE.md`](GOVERNANCE.md) and is recorded as
  an ADR in [`docs/adr/`](docs/adr/). No ADR, no schema change.

You can still contribute a great deal without touching the schema: bug fixes in a
binding that bring it back into agreement, documentation, new case studies,
additional valid/invalid fixtures that lock in already-specified behavior, tests,
and tooling.

---

## Running the tests

You need the toolchains for whichever part you touch. CI runs all of them; for a
local change you usually only need the relevant ones.

### Conformance — the bar every change must clear

```bash
node conformance/runner/run.mjs          # all fixtures vs the canonical schema (zero deps)
node conformance/tooling/crosscheck.mjs  # TS / Python / Rust / Go agreement table
```

The runner is the normative validator and needs only Node — no install step. A
clean run prints `CONFORMANT ✓` and exits `0`; a mismatch exits `1` and lists the
offending fixtures.

The cross-check needs **all four** toolchains because it builds each binding: the
TS package must be built (`packages/commerce-types/dist`), the Python package
importable, a Rust toolchain (it runs `cargo run -p warp-commerce-types --bin
crosscheck-rust`), and a Go toolchain (it runs `go run ./cmd/crosscheck-go`). It
prints `fixture | expected | TS | Python | Rust | Go | agree?` and exits non-zero
on any disagreement.

### Per-binding tests

```bash
# TypeScript (packages/commerce-types, also commerce-mcp, agent-demo)
cd packages/commerce-types && npm ci && npm run typecheck && npm test && npm run build

# Python (packages/commerce-types-py)
cd packages/commerce-types-py && pip install -e ".[dev]" && pytest && mypy .

# Rust (the workspace: warp-core compiler, warp-mcp, warp-generated, warp-commerce-types)
cargo test --workspace

# Go (bindings/go)
cd bindings/go && go build ./... && go vet ./... && go test ./...
```

> Note: `cargo --workspace` builds can be heavy. If you are iterating on one
> crate, scope with `-p <crate>` (e.g. `cargo test -p warp-commerce-types`).

### Codegen drift gates

Each binding's types are generated from the schema, and CI fails if a checked-in
binding has drifted from the schema. Because the schema is frozen these should
already be green; run them if you regenerate a binding:

```bash
npm run codegen                                              # TS  (--check mode)
node crates/warp-commerce-types/scripts/generate-rust.mjs --check
node bindings/go/generate-go.mjs --check
```

The Python generator lives at
[`packages/commerce-types-py/scripts/generate_from_schema.py`](packages/commerce-types-py/scripts/generate_from_schema.py).

### Schema validation

```bash
node schema/validate.mjs   # validates the schema files themselves
```

---

## Pull request expectations

1. **Keep conformance green.** `node conformance/runner/run.mjs` and
   `node conformance/tooling/crosscheck.mjs` must both pass. This is
   non-negotiable; CI enforces it.
2. **Keep the bindings in agreement.** A fix in one binding that the cross-check
   surfaces should bring it back into agreement with the other three, not paper
   over a divergence. Surfacing a divergence is exactly what the suite is for —
   see [`schema/BACKLOG-v1.1.md`](schema/BACKLOG-v1.1.md) for how the one
   historical case was tracked and resolved.
3. **Lock new behavior with a fixture.** New commerce behavior should come with a
   fixture (valid or invalid, with the rejecting rule named in its
   `.expected.json` sidecar) so it cannot regress. Adding fixtures is allowed
   within the major version; changing or removing one is a major bump.
4. **Do not touch the frozen schema** unless your change has gone through
   governance and carries an ADR. See [`GOVERNANCE.md`](GOVERNANCE.md).
5. **Run the toolchain you touched.** A TS-only change does not need a Go
   toolchain locally, but CI runs everything, so expect the full matrix on your
   PR.
6. **Be honest in claims.** Describe what a change does and does not do. A
   conformance pass means "agrees with the model on these fixtures at this schema
   version" — not "correct in general." Size claims to that.

Issues and pull requests are welcome. If you want to add a new language binding,
follow [`docs/authoring-a-binding.md`](docs/authoring-a-binding.md) — it walks the
concrete path from reading the schema to passing the four-way cross-check.

---

## License

By contributing you agree your contribution is licensed under the repository's
MIT license (see [`LICENSE`](LICENSE)).
