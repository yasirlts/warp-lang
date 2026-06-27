# @warp-lang/commerce-coverage

A coverage audit you run against **your** codebase to answer one question:

> *Where does my code touch money-state, and which of those calls are guarded by Warp?*

It prints a **coverage statement** — a number, a gap list, and a clearly-separated
list of sites it could not analyze:

```
Warp guards 3 of 5 analyzable declared money-sinks (60%). 1 sink could not be
analyzed (listed below) and is NOT counted as covered. This is a structural
coverage signal over declared sinks, not a proof of correctness or completeness.
```

## What it is — and what it is not

- **It reports coverage of the sinks YOU declare.** Warp cannot know which calls in
  your code mutate money-state, so you declare them (ORM writes, payment-SDK calls,
  ledger posts) as patterns. The audit measures coverage of *that declaration*. A
  sink you do not declare is not measured — and is never silently counted as covered.
- **"Covered" is a structural signal, not a correctness proof.** It means a Warp
  guard entry runs on the control-flow path to the sink. It does **not** prove the
  guard validated *that* write correctly.
- **Sites it cannot analyze are reported separately and never counted as covered.**
  A sink reached by dynamic dispatch, an alias, a passed callback, reflection, or a
  raw SQL string is listed under UNDETECTED / UNANALYZABLE. The coverage percentage
  is computed over **analyzable sinks only**; the unanalyzable count is shown apart.
- **Partial coverage is the expected, honest output.** This tool measures coverage;
  it does not guarantee safety.

## Install & run

```bash
npm install
npm run build
node dist/cli.js audit --config warp-coverage.config.json        # human-readable
node dist/cli.js audit --config warp-coverage.config.json --json # machine-readable
# (installed as the `warp-coverage` binary)
```

## Configure (declare your sinks)

`warp-coverage.config.json`:

```json
{
  "projectRoots": ["src"],
  "moneySinks": [
    { "name": "postLedger", "description": "ledger post" },
    { "name": "chargeCard", "module": "stripe" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `projectRoots` | Files/dirs to scan (relative to the config file, or absolute). |
| `moneySinks` | **Your** money-state operations, matched by call-site `name` (optionally narrowed to an import `module`). Coverage is reported against this declaration. |
| `guardEntries` | The Warp guard surface; defaults to the named `@warp-lang/commerce-types` entries (`guardAction`, `guardObject`, `guardWithProfile`, `guardConcession`, `createSession`, `createMultiAgentSession`, `toEffect`). Overridable. |
| `allowList` | Accepted unguarded exceptions: `{ "target": "file" or "file:line", "reason": "…" }`. The `reason` is **required** — a reasonless entry is a config error. Allow-listed sinks do not fail enforcement and are listed (with their reasons) for audit; they are still counted as uncovered in the audit %. |
| `failUnder` | Enforcement threshold (default `100`): the minimum % of enforceable sinks (analyzable minus allow-listed) that must be guarded for `enforce` to pass. |
| `onUnanalyzable` | `"warn"` (default) or `"block"`: how `enforce` treats sinks it cannot analyze (see below). Never a silent pass. |
| `extensions` / `exclude` | File extensions to scan / directory names to skip (sensible defaults). |

## How "covered" is decided (the path analysis, conservatively)

For each declared sink call, the audit looks for a guard entry that runs
**unconditionally before** it: a guard in the sink's block or an enclosing block,
positioned earlier on the linear path. A guard buried in a branch the sink is not
in, or after the sink, does **not** count. When reachability cannot be resolved,
the result leans **uncovered**, never covered:

| Classification | Meaning |
| --- | --- |
| `COVERED` | A guard entry runs unconditionally before the sink on its path (structural signal). |
| `UNGUARDED` | No guard on the path — or a guard exists but only conditionally / after the sink (counted as not covered, with the reason stated). |
| `UNANALYZABLE` | The sink is reached indirectly (alias / callback / dynamic dispatch) and its guard path cannot be determined statically. **Listed separately; never counted as covered.** |

## Enforce (the build gate)

`audit` measures; `enforce` makes it a gate so new unguarded money-paths cannot ship:

```bash
node dist/cli.js enforce --config warp-coverage.config.json        # human
node dist/cli.js enforce --config warp-coverage.config.json --json # machine-readable
```

- **Exit nonzero** when any enforceable sink — declared, analyzable, and not
  allow-listed — is unguarded (below `failUnder`, default 100%). The failure names
  each unguarded sink with its `file:line`. **Exit zero** when every enforceable
  sink is guarded or explicitly allow-listed.
- **Allow-listed exceptions are deliberate and visible.** Each requires a `reason`;
  the enforcer lists them with their reasons. A reasonless allow-list entry is a
  config error.
- **Unanalyzable sinks are never silently passed.** `onUnanalyzable: "warn"`
  (default) passes the build but prints them prominently as *"Warp cannot see these
  — your responsibility"*; `"block"` fails the build on any unanalyzable sink. Pick
  consciously: `warn` keeps the gate focused on what can be checked while keeping
  the blind spots loud; `block` refuses to ship anything the tool can't see.

Wire it into CI as a step (`warp-coverage enforce …`); a nonzero exit fails the build.

**The precise claim:** this prevents new unguarded *declared, analyzable* money-paths
from shipping. It is **not** a guarantee of total coverage — undeclared, dynamic, or
unanalyzable writes remain your responsibility, and the enforcer restates this on
every run.

## Scope & limits (read this)

- Static, AST-based, TypeScript/JavaScript first.
- It sees **declared** sinks called **directly**. It cannot see writes via dynamic
  dispatch, reflection, or raw SQL strings — those are reported as undetected when
  it can tell a declared sink is involved, and are simply invisible when it cannot
  (so declare your sinks well, and treat the number as a floor, not a ceiling).
- The percentage is over analyzable sinks only; the unanalyzable count sits beside
  it and is never folded in.
- `audit` reports; `enforce` blocks (nonzero exit) on unguarded declared, analyzable
  sinks. Enforcement is scoped to what the audit can see — it prevents new unguarded
  declared paths from shipping; it does not prove total coverage.

This package is `0.1.0` and unpublished.
