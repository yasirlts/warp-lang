# Open-core scoping — decision doc (options and tradeoffs)

Status: draft for maintainer decision. This document does not decide anything.
It lays out what is currently open in this repository, what could plausibly be
held back as a commercial offering, and the honest tradeoffs of each split. The
business decision is the maintainer's to make.

Scope note: this is a positioning and licensing document, not a code change. It
touches no schema, no package, and no crate.

---

## 1. Why this document exists

"Open-core" describes a project where a well-defined core is released under a
permissive or open license and a separate set of capabilities is sold. For that
model to be honest, two lines have to be drawn clearly:

1. What is open, and under what terms.
2. What is commercial, and why it is reasonable to charge for it rather than
   release it.

The warp-lang repository already carries informal signals about where these
lines might fall. The root `Cargo.toml` comment states that "the node catalog,
storage, and the commercial server are intentionally NOT part of this open
workspace." The README states that "the commercial server — billing, payments,
tenancy, signup — is not part of this open release" while a managed compiler is
hosted at warp.aimer.ma. This document collects those scattered signals into one
place and turns them into explicit options so the split can be decided
deliberately rather than by accident.

This is a decision doc, not a decision. Where a choice exists, it is presented as
options with tradeoffs.

---

## 2. What actually exists today (ground truth)

Everything below was confirmed present in the repository at the time of writing.
Where something is aspirational or partial, that is called out.

### Currently in the repo, MIT-licensed

The repository root `LICENSE` is MIT (Copyright 2026 Yasir Ahmad / Lamar Tech
Solutions). The workspace `Cargo.toml` sets `license = "MIT"` for all crates.

- **The model and schema** — `schema/structure/` holds eight JSON Schema files
  (party, value, intent, commitment, fulfillment, money, auxiliary, index, plus
  a shared value schema); `schema/behavior/` holds `transitions.json` and
  `invariants.json`. `schema/VERSION` is `1.0.0` and described as frozen. This is
  the source of truth the README calls "one frozen schema."
- **The conformance suite** — `conformance/` with `manifest.json`,
  `conformance/valid/` (16 fixtures) and `conformance/invalid/` (20 fixtures),
  a `runner/run.mjs`, plus `transitions/`, `case-studies/`, and `tooling/`.
  `conformance/VERSION` is `1.0.0`. The README's badge claims 51/51 against
  schema v1.0.0.
- **The language bindings** — four, all generated from the schema:
  - TypeScript: `packages/commerce-types` (`@warp-lang/commerce-types`, v1.3.0,
    MIT), published to npm per the README badge.
  - Python: `packages/commerce-types-py` (`warp-commerce-types`, v1.3.0, MIT),
    published to PyPI per the README badge.
  - Rust: `crates/warp-commerce-types` (the binding plus a `crosscheck-rust`
    binary that emits per-fixture verdicts for the cross-check).
  - Go: `bindings/go` (module `github.com/yasirlts/warp-lang/bindings/go`),
    generated via `generate-go.mjs`.
- **The MCP server** — `packages/commerce-mcp` (`@warp-lang/commerce-mcp`,
  v0.1.0, marked `private: true`) with `src/index.ts`, `schemas.ts`,
  `server.ts`; and `crates/warp-mcp` (a Rust MCP server exposing Warp workflow
  tools over stdio JSON-RPC). Note the npm package is currently `private`, so it
  is in the tree but not published.
- **The compiler crate** — `crates/warp-core` holds the DSL compiler
  (`src/dsl/`: lexer, parser, ast, type_checker, codegen), an `ai_builder/`, a
  management `api/` (merchant + workflow), a `poc/`, and `templates.rs`. The
  README states the DSL compiler blocks I-1 (currency mixing) and blocks I-2 at
  lifecycle-stage granularity; per-commitment-state I-2 is listed as planned,
  not present.
- **The agent demo** — `packages/agent-demo` (`@warp-lang/agent-demo`, v0.1.0,
  marked `private: true`), a demonstration of an AI agent generating commerce
  code against the typed contract.
- **Generated-workflow target** — `crates/warp-generated`, the crate the
  compiler writes into; described as output written by the management API's
  compile endpoint.
- **Specs and docs** — `spec/` (COMMERCE_MODEL, TYPE_SPEC, COMPATIBLE_GUIDE),
  `docs/` including seven ADRs, the manifesto, getting-started, and versioned
  type specs.

### Referenced but not in this repo

- **A hosted/managed compiler** at warp.aimer.ma — the README points to it as a
  key-gated way to compile without a local build. The hosting, the key-gating,
  and the API surface around it are not in this repository.
- **The commercial server** — billing, payments, tenancy, signup. The README
  and the root `Cargo.toml` comment both state this is deliberately outside the
  open release. No such code is present here.
- **The node catalog and storage** — the `Cargo.toml` comment names these as
  intentionally excluded from the open workspace. They are not present here.

So the practical situation today is already a soft open-core split: the model,
schema, conformance suite, four bindings, the compiler crate, and the MCP/agent
tooling are open (with two npm packages marked private); the hosted runtime and
the commercial server are referenced but kept out. The question this document
frames is whether to keep that split, formalize it, widen it, or narrow it.

---

## 3. The candidate split

Two columns, mapped to real components. The point of disagreement is where the
middle rows go, so they are flagged.

| Component (real path) | Natural home | Contested? |
| --- | --- | --- |
| Model + schema (`schema/`) | Open | No |
| Conformance suite (`conformance/`) | Open | No |
| TS / Py / Rust / Go bindings (`packages/*`, `crates/warp-commerce-types`, `bindings/go`) | Open | No |
| MCP server (`packages/commerce-mcp`, `crates/warp-mcp`) | Open (currently `private` on npm) | Mild |
| Agent demo (`packages/agent-demo`) | Open (currently `private`) | Mild |
| Compiler crate (`crates/warp-core`) | Open | Yes |
| Hosted durable-execution runtime | Commercial | No |
| Hosted compiler / registry service | Commercial | Yes |
| Support / SLAs / enterprise | Commercial | No |

The rows marked "Yes" are the ones where a real strategic choice exists. The
rest are close to settled by the repository's current state and stated intent.

---

## 4. What is (or should be) OPEN — and the cost of openness

### 4.1 The model and schema (`schema/`)

Keeping the schema open is the foundation of the entire positioning. The README's
whole argument — "independent implementations produce the same answers" — only
holds if the schema is inspectable. A closed schema cannot be a standard, and the
"language-neutral model of commerce" claim collapses without it.

- Benefit of open: maximum adoption, third-party bindings become possible,
  credibility as a specification rather than a product.
- Cost of open: the schema is the most defensible asset, and giving it away
  means anyone can build a competing runtime against the same model. There is no
  technical lock-in at the schema layer; the moat, if any, has to live elsewhere
  (hosting, support, the compiler's UX, brand).

There is little realistic alternative here. A commercial schema would undercut
the project's reason to exist. The honest tradeoff is that openness at this layer
is a strategic giveaway accepted in exchange for the standard-setting position.

### 4.2 The conformance suite (`conformance/`)

The conformance suite is what makes "four bindings proven equivalent" a checkable
claim rather than a marketing line. Keeping it open lets third parties verify
their own bindings and trust the cross-check.

- Benefit of open: the conformance badge means something to outsiders; the suite
  becomes the definition of "Warp-compatible," which is itself a positioning
  asset.
- Cost of open: a competitor can use the suite to certify their own
  implementation as compatible without contributing anything back. That is also
  arguably the point of a conformance suite, so the cost is mostly the loss of
  exclusivity, not a direct revenue risk.

Option to consider: keep the suite open but reserve the "Warp-compatible" mark or
a certification process as a governed (possibly commercial) program. That
separates the open test fixtures from the right to claim a badge. Tradeoff: a
governed mark adds administrative overhead and can read as gatekeeping, which cuts
against the open positioning.

### 4.3 The bindings (TS, Py, Rust, Go)

The bindings are generated from the schema, so they carry little independent IP —
their value is convenience and reach. Two are already published (npm, PyPI) under
MIT. Closing them would contradict the existing published packages and provide
almost no protection, since anyone with the open schema can regenerate them.

- Benefit of open: distribution. Published packages are the top of the adoption
  funnel.
- Cost of open: essentially none beyond what is already conceded by an open
  schema.

This row is effectively decided by what is already shipped. Reversing it would be
costlier (breaking published packages) than any plausible benefit.

### 4.4 The MCP server and agent demo

Both exist in the tree; both npm packages are currently marked `private`, so they
are not published even though they are in an MIT repo. There are two coherent
readings:

- Treat them as open developer tooling. Rationale: the README's forward-looking
  positioning is "a typed contract for AI agents to generate against," and an
  open MCP server plus a working agent demo is the most direct proof of that
  story. Keeping them open maximizes the agentic-commerce narrative.
- Treat them as the thin end of a commercial wedge. Rationale: a polished,
  hosted MCP endpoint (rather than a local stdio server) could be a paid
  convenience. The `private` flag may simply mean "not ready to publish" rather
  than "intended commercial," and that ambiguity is worth resolving explicitly.

Tradeoff: open MCP tooling strengthens the standard and the AI-agent story but
gives away a natural hosted-service hook. The decision hinges on whether the
agentic angle is primarily a credibility play (favor open) or a product line
(favor a hosted commercial tier with the local server staying open).

### 4.5 The compiler crate (`crates/warp-core`) — the genuinely contested row

This is the one row where the choice materially shapes the business.

The compiler is the most product-like open component. It turns the model into
something operational: it parses the `.warp` DSL, type-checks it, blocks I-1
currency mixing and lifecycle-stage I-2, and emits generated workflows. A hosted
version already runs at warp.aimer.ma. So the compiler sits exactly on the open
/ commercial fault line.

Three options:

- **Option A — compiler fully open (status quo).** The crate stays MIT in this
  workspace; the hosted compiler is sold purely as convenience (no local build
  required, key-gated API).
  - Pro: a single source of truth, no code forking between an open and a closed
    compiler, maximum trust, easiest contribution story.
  - Con: the hosted compiler's only advantage is convenience and uptime, which
    is a weak moat. Anyone can run the same compiler locally for free. Revenue
    has to come from hosting/runtime/support, not the compiler itself.
- **Option B — open compiler core, commercial advanced passes.** Keep parsing,
  type-checking, and the published invariant checks open; hold back advanced or
  enterprise compiler features (for example richer static I-2, optimization
  passes, or proprietary node-registry integrations) for the commercial build.
  - Pro: preserves an open compiler that honors the published claims while
    creating a real paid differentiator.
  - Con: this is the classic open-core trap. Drawing the line inside one crate is
    hard to communicate, invites "crippled open version" criticism, and risks
    the open compiler's published guarantees drifting from the commercial one.
    The roadmap already lists per-commitment-state I-2 as planned-not-present;
    making that a paid feature would mean a published invariant is only partly
    checkable for free, which is a credibility risk that must be weighed
    explicitly.
- **Option C — compiler commercial, model/conformance open.** Open only the
  schema, conformance, and bindings; treat the compiler as a commercial product.
  - Pro: clearest commercial asset; the compiler is the most valuable artifact.
  - Con: directly contradicts the current repository (the compiler crate is
    already MIT and in the open workspace) and the README's "build and run the
    compiler from this repo" instructions. Reversing this would be a visible
    retraction and would weaken the standard, since a model without an open
    reference compiler is much harder to adopt.

No recommendation is made here. The trade is roughly: how much do you value an
open reference compiler as adoption fuel versus a closed compiler as a revenue
anchor. The status quo (A) is the least surprising given what is already shipped;
B and C both require accepting communication and credibility costs in exchange
for a stronger moat.

---

## 5. What COULD be commercial — and the cost of closing it

### 5.1 A hosted durable-execution runtime

Durable execution (workflows that survive restarts, durable timers,
human-in-the-loop pauses) is provided by Restate's MIT-licensed SDK per
ADR-0006. The runtime that operates workflows in production — the thing that
actually keeps a 24-hour delay alive across a restart for a paying merchant — is
the most natural commercial offering. The README already states the commercial
server (billing, payments, tenancy, signup) is outside the open release.

- Why this is a defensible commercial line: operating a durable, multi-tenant
  runtime is real ongoing work (uptime, scaling, isolation, on-call). Charging
  for operation rather than for code is the cleanest open-core pattern, and it
  does not require closing any of the model's IP.
- Cost of keeping it closed: the open project alone cannot demonstrate a
  production execution story end to end. Evaluators get the model, the compiler,
  and generated workflows, but have to bring their own Restate deployment to run
  them durably. That is a friction point for self-hosters and should be
  acknowledged. Mitigation option: publish enough deployment guidance (or a
  minimal open self-host path) that the closed runtime is a convenience, not the
  only way to run anything.

### 5.2 A hosted compiler / registry service

The managed compiler at warp.aimer.ma already exists as a key-gated service. A
registry — for sharing templates, nodes, or compiled workflows — is a natural
extension. This is contested because it overlaps with the compiler row in
section 4.5: the same artifact can be open as a crate and commercial as a hosted
service.

- Why it can be commercial: hosting, key-gating, persistence, and a shared
  registry are operational services distinct from the compiler code. Selling the
  service while open-sourcing the engine is internally consistent.
- Cost / risk: if the hosted service quietly accrues capabilities the open
  compiler lacks, the split slides from "convenience hosting" toward Option B
  (commercial advanced passes) without that being decided on purpose. The honest
  move is to decide section 4.5 first, because it constrains how far this service
  can diverge from the open compiler.

### 5.3 Support, SLAs, and enterprise

Paid support, response-time SLAs, security review, indemnification, and
enterprise onboarding are the least contentious commercial line — they sell
assurance and labor, not closed code, and are compatible with any of the
section-4 outcomes.

- Why it works: no IP is withheld; the open project stays fully open; revenue
  comes from the relationship.
- Limit: support revenue typically scales with headcount, not with software, so
  it tends to complement rather than replace a product line. It is a sound floor,
  not usually a sufficient ceiling on its own.

---

## 6. Cross-cutting tensions the maintainer should weigh

- **Standard versus product.** The further the commercial line is pushed into
  the compiler (4.5 Option B/C), the stronger the moat and the weaker the
  "standard" positioning. The README leans hard on standard-setting language
  ("independent implementations produce the same answers"). A commercial
  compiler is in tension with that framing; a commercial runtime is not.
- **The `private` packages are an undecided signal.** `commerce-mcp` and
  `agent-demo` are MIT in an open repo but `private` on npm. That is currently
  ambiguous. Deciding section 4.4 explicitly removes a place where the split is
  being made by a packaging default rather than a choice.
- **Published packages constrain reversals.** The TS and Python bindings are
  already public under MIT. Anything built on the open schema can be regenerated
  by third parties regardless of future decisions, so closing the bindings or
  the schema later would be costly and largely ineffective.
- **Credibility of invariant claims.** The project advertises six invariants and
  a conformance badge. If any published, advertised check becomes a paid-only
  feature, the public claims and the free artifact diverge. This is the sharpest
  risk in Option B and must be weighed deliberately, not slipped in.
- **Self-host friction.** With the runtime closed, the open artifacts stop short
  of a production execution demo. How much friction that creates depends on how
  much deployment guidance accompanies the open release.

---

## 7. Decision checklist (for the maintainer, not decided here)

1. Compiler (4.5): A (fully open), B (open core + commercial passes), or C
   (commercial compiler)? This is the load-bearing choice.
2. MCP server and agent demo (4.4): publish as open tooling, or keep one or both
   as commercial hooks? Resolve the `private` ambiguity either way.
3. Conformance mark (4.2): keep the suite open with no mark, or add a governed /
   commercial "Warp-compatible" certification on top of the open fixtures?
4. Runtime (5.1): confirm the hosted durable-execution runtime as the primary
   commercial line, and decide how much self-host guidance to ship alongside.
5. Hosted compiler/registry (5.2): scope it as convenience hosting only, or as a
   tier that may diverge from the open compiler — consistent with the answer to
   item 1.
6. Support/SLA (5.3): confirm as a complementary line; decide whether it is the
   floor or a meaningful pillar.

Each of these is a business call. This document's job is to make the options and
their costs legible, not to choose among them.

---

## 8. References (in-repo)

- `LICENSE` — MIT, repository-wide.
- `Cargo.toml` (workspace) — the comment naming node catalog, storage, and the
  commercial server as intentionally outside the open workspace.
- `README.md` — the commercial-server exclusion note, the managed-compiler
  reference (warp.aimer.ma), and the roadmap's planned-not-present items.
- `schema/` and `schema/VERSION` (1.0.0) — the frozen model.
- `conformance/`, `conformance/VERSION` (1.0.0), `conformance/manifest.json` —
  the conformance suite.
- `packages/commerce-types`, `packages/commerce-types-py`,
  `crates/warp-commerce-types`, `bindings/go` — the four bindings.
- `packages/commerce-mcp`, `crates/warp-mcp` — the MCP servers.
- `packages/agent-demo` — the agent demonstration.
- `crates/warp-core` — the DSL compiler; `crates/warp-generated` — its output
  target.
- `docs/adr/0006-restate-as-execution-foundation.md` — durable execution via the
  MIT Restate SDK.
