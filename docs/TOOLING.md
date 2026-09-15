# Warp language tooling — `warpc`

The tools that make `.warp` comfortable to author in. Everything here composes
the parser, compiler and AST that already ship in `@warp-lang/commerce-lang` —
there is no second grammar, no separate linter, and nothing that could disagree
with the compiler about what a file means.

```sh
npx warpc fmt     shop.warp --write      # canonical layout, in place
npx warpc check   shop.warp             # every diagnostic, emit nothing
npx warpc compile shop.warp -o model.json   # the deployable artifact (rung C)
```

---

## `warpc fmt` — the formatter

```sh
warpc fmt <file.warp>...            # print the canonical form
warpc fmt <file.warp>... --write    # rewrite in place
warpc fmt <file.warp>... --check    # exit 1 if any file is not canonical (CI)
```

**The guarantee: formatting never changes meaning.** The formatter walks the
parser's own AST and prints it, so `parse(format(src))` equals `parse(src)`. It
has no grammar of its own and cannot introduce a construct the parser reads
differently. This is tested — on a file using every construct the language has,
and on every commerce-lang `.warp` file in the repo — not promised.

What it does:

- consistent two-space indent, one blank line between declarations;
- aligned keys within a block, aligned arrows within a lifecycle;
- short blocks (`tender`, `leg`) on one line, long ones expanded;
- **comments kept, in place** — a comment above an item stays above it, a
  comment at the end of a line stays there, and a comment block the author
  separated with a blank line keeps its separation;
- the minimum parentheses that preserve an expression's tree —
  `(committed - 50 MAD) * 2` keeps its parens, `(committed * 2) + 5 MAD` loses
  the redundant ones — and never fewer than the tree needs.

What it does **not** do: reorder, sort, rename, remove, compute, or check
anything. Declarations, fields, states, transitions and legs come out in the
order you wrote them. A file with a dangling reference formats fine and then
fails `warpc check`, which is the right division of labour.

Idempotent: `format(format(x)) === format(x)`.

## `warpc check` — diagnostics

```sh
warpc check <file.warp>...          # human-readable, exit 1 on any error
warpc check <file.warp>... --json   # one JSON object per line, for editors
```

Runs the real parser and compiler and reports what they say, with `line:col`,
without emitting an artifact. It is the "does my file have problems?" command.

```
shop.warp:3:9: error: Unknown commitment state 'Reversed' declared in lifecycle 'l'. …
shop.warp:10:23: error: Policy 'a' applies_to profile 'missing', which this document does not declare. …
warpc check: 2 errors, 0 warnings
```

**How much is collected, honestly:**

| Class | Collected? | Why |
|---|---|---|
| Syntax | **first error only** | the parser stops at the first malformed token; error recovery is a parser change this rung does not make |
| Compile | **all**, per declaration | each declaration is compiled on its own, so a bad lifecycle and a bad policy both report |
| Cross-declaration | after the parts are sound | a policy applying to a missing profile, an ambiguous base profile |
| Deployability | **warning** | a computed (rung-5A) value compiles and runs in-process, but `warpc compile` will refuse to serialize it — better to learn that here |

Exit codes: `0` no errors (warnings allowed) · `1` at least one error · `2` a file
could not be read.

### `--json` for editors

```json
{"severity":"error","code":"compile","message":"…","file":"shop.warp","line":3,"column":9}
```

Positions are 1-based. `code` is one of `syntax`, `compile`, `undeployable`. This
is the cheap, real editor aid: any editor that can run a command and read a line
of JSON per diagnostic can show Warp errors inline.

---

## What is real and what is future

**Real, in this rung:** the formatter; `check` with collected diagnostics and
`--json`; the compile CLI.

**Not shipped: a syntax-highlighting grammar for commerce-lang.** There is
already a TextMate grammar under `editors/vscode/warp-language/` — for the
*workflow* DSL, a different language that happens to share the `.warp` extension.
A second grammar registered for the same extension would fight the first. Which
dialect owns `.warp` in editors is a decision the repo has not made, and a
highlighting grammar is not the place to make it by accident. It ships once that
is decided.

**Future, and not implied to exist:** a language server. `check --json` gives an
editor positioned diagnostics on save; a full LSP (live diagnostics as you type,
go-to-definition, hover, completion) is its own project and is not here.

## In CI

```yaml
- run: npx warpc fmt --check examples/deploy-host/shop.warp
- run: npx warpc check     examples/deploy-host/shop.warp
```

The repo runs both on every commerce-lang `.warp` file it ships, so the files a
reader sees are the formatter's output, and they compile.
