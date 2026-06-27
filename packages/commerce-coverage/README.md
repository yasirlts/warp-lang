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
| `allowList` | Optional `file` or `file:line` sites to exclude from detection. Excluded matches are reported transparently in a `SUPPRESSED` section with a count — removed from the measured set, never hidden. |
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

## Scope & limits (read this)

- Static, AST-based, TypeScript/JavaScript first.
- It sees **declared** sinks called **directly**. It cannot see writes via dynamic
  dispatch, reflection, or raw SQL strings — those are reported as undetected when
  it can tell a declared sink is involved, and are simply invisible when it cannot
  (so declare your sinks well, and treat the number as a floor, not a ceiling).
- The percentage is over analyzable sinks only; the unanalyzable count sits beside
  it and is never folded in.
- This is the **measurement** half of enforcement. It tells you where the gaps are;
  it does not block them.

This package is `0.1.0` and unpublished.
