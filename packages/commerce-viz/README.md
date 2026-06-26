# @warp-lang/commerce-viz

A read-only visualizer of the Warp Commerce Model. It renders the model's real
state-transition table as a **state graph** — nodes are states, arrows are legal
transitions — as an SVG (one per primitive) or a single self-contained HTML page.

## Honest scope

This package **reads and draws** the model. That is all it does.

- It is **read-only**. Phase 1 (this package) renders; it does not edit.
- It is **not a no-code platform** and **not a workflow builder**.
- It does **not execute, validate, authorize, settle, or simulate** any commerce
  action. For structural validation use
  [`@warp-lang/commerce-types`](https://www.npmjs.com/package/@warp-lang/commerce-types);
  to expose that validation to an agent use
  [`@warp-lang/commerce-mcp`](../commerce-mcp).
- The graph is **derived from the frozen schema**, never hardcoded. If the schema
  changes, the rendered graph changes with it.

## How the graph is derived from the model

The renderer reads the real transition table at
[`schema/behavior/transitions.json`](../../schema/behavior/transitions.json) — the
machine-readable form of the model's State Monotonicity invariant — and builds a
graph per primitive (`commitment`, `intent`, `fulfillment`) from it:

- **Nodes** — every state that appears in the table, either as a source key or as
  a transition target.
- **Edges** — one directed edge for every `source → target` pair listed in the
  table. A pair not listed is not drawn (the table is exhaustive).
- **Terminal states** — a state whose row is an empty list is drawn with a red
  border.

Nothing about the states or edges is written into this package's code. The loader
([`src/transitions.ts`](src/transitions.ts)) parses the JSON; the renderer
([`src/render.ts`](src/render.ts)) lays it out. The layout is a deterministic
layered placement, so the same table always produces the same artifact (useful for
committing and diffing a sample).

> Note: the table documents one special case in `notes.fulfillment_failed_recovery`
> — a `Failed` fulfillment may return to `Planned` only when its `recoverable` flag
> is true. That is a runtime, data-dependent edge, not a static table entry, so it
> is not drawn as a fixed arrow. The static graph shows the table as written, where
> `Failed` is an empty (terminal) row.

## Run it

```sh
npm install
# render every primitive to ./out as SVG + a combined HTML page
npm run render
# or regenerate the committed sample under ./examples
npm run sample
# build the bundled CLI/library to ./dist
npm run build
```

CLI:

```sh
warp-commerce-viz [--out <dir>] [--format svg|html|both]
```

- `--out <dir>` output directory (default `out`)
- `--format` `svg` (one file per primitive), `html` (one combined page), or
  `both` (default)

## Sample output

A committed sample lives in [`examples/`](examples): one SVG per primitive plus a
combined [`examples/index.html`](examples/index.html). Open the HTML in any
browser straight from disk — no server, no external assets.

## Tests

`npm test` renders each graph, parses the rendered SVG/HTML back out, and asserts
the nodes and edges match `schema/behavior/transitions.json` — the expectations
are read from that file at test time, so they are derived from the model rather
than hardcoded.

## Phase 2 (future, not in this package)

A later phase could let a user edit a graph and **emit a model** (a transition
table or a higher-level workflow description) from the edited graph, with the
edits validated against the frozen invariants before anything is emitted. That
write path is out of scope here; this package is the read-only viewer it builds on.
