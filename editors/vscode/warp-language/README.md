# Warp Commerce Language — VS Code Extension

Phase 3 session 5 — Stream D, LSP stub. Syntax-highlighting +
basic language support for `.warp` workflow files in VS Code.

This is **not** a full Language Server Protocol implementation
yet. Phase 4 will add a real LSP that compiles `.warp` files in
the background and surfaces diagnostics inline. For now the
extension is a TextMate grammar + a `language-configuration.json`
that VS Code's built-in language services pick up.

---

## What it does

- Registers `.warp` files as a first-class language
  (`languageId: "warp"`).
- Highlights the six built-in node types
  (`CartAbandoned`, `OrderPlaced`, `WhatsAppSend`, `DelayFor`,
  `ACPGetCustomerProfile`, `ACPEvaluateStrategy`) in the
  type-name colour.
- Highlights the project header keywords (`project`,
  `version`, `tenant`) as control flow.
- Highlights `Currency(N, MAD)` and `Duration(N, hours)` literals
  with their own colour family — the number, the unit, and the
  type constructor each get distinct scopes.
- Highlights `instance.field` references in the variable colour.
- Auto-closes `{`, `[`, `(`, and `"`; suggests proper
  indentation inside blocks.
- Surfaces `//` as a single-line comment.

The grammar's node-type list mirrors
`BUILTIN_NODE_SPECS` in
[`crates/warp-core/src/dsl/type_checker.rs`](../../../crates/warp-core/src/dsl/type_checker.rs).
When a new built-in node lands, update both:

1. `BUILTIN_NODE_SPECS` (Rust)
2. The `node-types` repository entry in
   [`syntaxes/warp.tmLanguage.json`](syntaxes/warp.tmLanguage.json).

A drift-detection test in the catalog (`node_registry::tests`)
catches the Rust-side mismatch; the TM-grammar side is on the
honour system today and gets a Phase 4 LSP for free.

---

## Install locally

Two options.

### A — Extension host (development)

1. Open this directory in VS Code:
   `code editors/vscode/warp-language`
2. Press **F5**. VS Code launches a new "Extension Development
   Host" window with the extension active.
3. Open any `.warp` file in the new window — for example
   [example.warp](example.warp) in this folder, or one of the
   merchant workflows under
   `crates/warp-server/generated/`.
4. The language picker in the bottom right should read **Warp**.
   Syntax-highlighted output should match the screenshots in the
   Phase 4 LSP follow-up doc.

### B — Sideload as a `.vsix`

1. `cd editors/vscode/warp-language`
2. `npm install --no-save @vscode/vsce`
   (one-off — pulls the `vsce` packager into `node_modules/`)
3. `npx vsce package --no-dependencies`
   produces `warp-language-0.1.0.vsix` in this directory.
4. In VS Code: **Command Palette** → "Extensions: Install from
   VSIX…" → pick the `.vsix` file.

The marketplace publish is out of scope for Phase 3 — internal
sideload is enough to validate the highlighting story.

---

## Phase 4 roadmap

When Stream D wraps up the LSP work, this extension picks up:

- **Diagnostics** — every save runs the file through the Warp
  compiler in the background. Type errors render inline with
  the same wording the canvas + the management API return.
- **Hover documentation** — pointing at a node type shows its
  required + optional inputs, taken from
  `BUILTIN_NODE_SPECS`. Pointing at a commerce type
  (`Currency`, `PhoneNumber`, etc.) shows the type-spec
  summary from
  [`docs/WARP_TYPE_SPEC_v0.1.md`](../../../docs/WARP_TYPE_SPEC_v0.1.md).
- **Completion** — typing `Cart…` suggests `CartAbandoned`;
  typing `profile.` suggests the fields available on the
  preceding `ACPGetCustomerProfile` output.
- **Go-to-definition** — `Ctrl+click` on a node type opens the
  Rust source for that node in `warp-catalog`.

The LSP server itself will be a separate Rust crate
(`warp-lsp`), reusing the same `compile_and_generate` entry
point the canvas API calls.
