#!/usr/bin/env node
/**
 * warpc — the Warp language command-line tool.
 *
 *   warpc compile <file.warp> [-o model.json] [--profile id] [--lifecycle id] [--auction id] [--id id]
 *   warpc check   <file.warp> [--json]
 *   warpc fmt     <file.warp>... [--write | --check]
 *   warpc <file.warp> [...]        (same as `compile` — the rung-C form still works)
 *
 * Everything here composes the parser, compiler and formatter that ship in
 * ../dist; the CLI adds argument handling and exit codes, nothing else. See
 * docs/TOOLING.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  check,
  compileSystem,
  format,
  formatDiagnostics,
  serializeSystem,
  WarpDeployError,
  WarpLangError,
} from "../dist/index.js";

const USAGE = `warpc — the Warp language tool

  warpc compile <file.warp> [options]   compile to a deployable model.json
  warpc check   <file.warp> [--json]    report every diagnostic, emit nothing
  warpc fmt     <file.warp>... [--write | --check]
                                        format to canonical .warp
  warpc <file.warp> [options]           same as \`compile\`

compile options:
  -o, --out <file>       write the artifact here (default: stdout)
      --profile <id>     base profile, when the file declares several
      --lifecycle <id>   lifecycle to record, when the file declares several
      --auction <id>     auction to run, when the file declares several
      --id <id>          override the model id

check options:
      --json             one JSON object per line: {severity, code, message, file, line, column}

fmt options:
      --write            rewrite each file in place (default: print to stdout)
      --check            exit 1 if any file is not already canonical; change nothing

Exit codes: 0 ok · 1 diagnostics / not formatted / bad usage · 2 cannot read a file
`;

function usage(code) {
  (code === 0 ? console.log : console.error)(USAGE);
  process.exit(code);
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    console.error(`warpc: cannot read ${path}: ${e.message}`);
    process.exit(2);
  }
}

/** Split argv into positionals and options, treating `--x v` and `-x v` as valued. */
function parseArgs(argv, valued) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      const name = a.replace(/^-+/, "");
      if (valued.includes(name)) opts[name] = argv[++i];
      else opts[name] = true;
    } else positional.push(a);
  }
  return { positional, opts };
}

// ---------------------------------------------------------------------------

function cmdCompile(argv) {
  const { positional, opts } = parseArgs(argv, ["o", "out", "profile", "lifecycle", "auction", "id"]);
  if (opts.h || opts.help) usage(0);
  if (positional.length !== 1) {
    console.error(positional.length === 0 ? "warpc compile: no input file" : "warpc compile: one input file at a time");
    usage(1);
  }
  const input = positional[0];
  const out = opts.o ?? opts.out;
  const source = read(input);

  let artifact;
  try {
    artifact = serializeSystem(
      compileSystem(source, {
        file: basename(input),
        ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
        ...(opts.lifecycle !== undefined ? { lifecycle: opts.lifecycle } : {}),
        ...(opts.auction !== undefined ? { auction: opts.auction } : {}),
        ...(opts.id !== undefined ? { id: opts.id } : {}),
      }),
    );
  } catch (e) {
    if (e instanceof WarpLangError) {
      console.error(`warpc: ${e.format()}`);
      process.exit(1);
    }
    if (e instanceof WarpDeployError) {
      console.error(`warpc: ${input}: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  if (out === undefined) process.stdout.write(artifact);
  else {
    writeFileSync(out, artifact);
    console.error(`warpc: wrote ${out}`);
  }
}

function cmdCheck(argv) {
  const { positional, opts } = parseArgs(argv, []);
  if (opts.h || opts.help) usage(0);
  if (positional.length === 0) {
    console.error("warpc check: no input file");
    usage(1);
  }
  let total = 0;
  let errors = 0;
  for (const input of positional) {
    const diags = check(read(input), { file: basename(input) });
    total += diags.length;
    errors += diags.filter((d) => d.severity === "error").length;
    if (opts.json) {
      for (const d of diags) process.stdout.write(`${JSON.stringify({ ...d, file: input })}\n`);
    } else if (diags.length > 0) {
      console.log(formatDiagnostics(diags.map((d) => ({ ...d, file: input }))));
    }
  }
  if (!opts.json) {
    if (total === 0) console.log(`warpc check: ${positional.length} file${positional.length === 1 ? "" : "s"}, no problems`);
    else console.log(`warpc check: ${errors} error${errors === 1 ? "" : "s"}, ${total - errors} warning${total - errors === 1 ? "" : "s"}`);
  }
  process.exit(errors > 0 ? 1 : 0);
}

function cmdFmt(argv) {
  const { positional, opts } = parseArgs(argv, []);
  if (opts.h || opts.help) usage(0);
  if (positional.length === 0) {
    console.error("warpc fmt: no input file");
    usage(1);
  }
  if (opts.write && opts.check) {
    console.error("warpc fmt: --write and --check are exclusive");
    usage(1);
  }
  let notCanonical = 0;
  for (const input of positional) {
    const source = read(input);
    let formatted;
    try {
      formatted = format(source, { file: basename(input) });
    } catch (e) {
      if (e instanceof WarpLangError) {
        console.error(`warpc fmt: ${e.format()}`);
        process.exit(1);
      }
      throw e;
    }
    if (opts.check) {
      if (formatted !== source) {
        notCanonical++;
        console.log(`${input}: not formatted`);
      }
    } else if (opts.write) {
      if (formatted !== source) {
        writeFileSync(input, formatted);
        console.error(`warpc fmt: formatted ${input}`);
      }
    } else process.stdout.write(formatted);
  }
  if (opts.check) {
    if (notCanonical === 0) console.log(`warpc fmt: ${positional.length} file${positional.length === 1 ? "" : "s"} already formatted`);
    process.exit(notCanonical > 0 ? 1 : 0);
  }
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.length === 0) usage(1);
if (argv[0] === "-h" || argv[0] === "--help") usage(0);

switch (argv[0]) {
  case "compile":
    cmdCompile(argv.slice(1));
    break;
  case "check":
    cmdCheck(argv.slice(1));
    break;
  case "fmt":
    cmdFmt(argv.slice(1));
    break;
  default:
    // Rung-C form: `warpc <file.warp> [-o …]` — still compile.
    cmdCompile(argv);
}
