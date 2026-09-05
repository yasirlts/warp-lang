#!/usr/bin/env node
/**
 * warpc — compile a `.warp` system to a deployable `model.json` artifact.
 *
 *   warpc <system.warp> [-o model.json] [--profile id] [--lifecycle id] [--auction id]
 *
 * This is the boundary tool. It runs at BUILD time in the repo (or wherever the
 * compiler is installed) and emits plain JSON. Nothing downstream needs the
 * compiler again: a host installs the runtime library, loads this file, and runs
 * it. See docs/DEPLOYMENT.md.
 *
 * Output is canonical — sorted keys, fixed formatting — so the same source always
 * produces byte-identical output and an artifact can be committed and diffed like
 * any other build product.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { compileSystem, serializeSystem, WarpDeployError, WarpLangError } from "../dist/index.js";

function usage(code) {
  const out = code === 0 ? console.log : console.error;
  out(`warpc — compile a .warp system to a deployable model.json

  warpc <system.warp> [options]

Options:
  -o, --out <file>       write the artifact here (default: stdout)
      --profile <id>     base profile, when the file declares several
      --lifecycle <id>   lifecycle to record, when the file declares several
      --auction <id>     auction to run, when the file declares several
      --id <id>          override the model id
  -h, --help             show this
`);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) usage(argv.length === 0 ? 1 : 0);

let input;
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-o" || a === "--out") opts.out = argv[++i];
  else if (a === "--profile") opts.profile = argv[++i];
  else if (a === "--lifecycle") opts.lifecycle = argv[++i];
  else if (a === "--auction") opts.auction = argv[++i];
  else if (a === "--id") opts.id = argv[++i];
  else if (a.startsWith("-")) {
    console.error(`warpc: unknown option '${a}'`);
    usage(1);
  } else if (input === undefined) input = a;
  else {
    console.error(`warpc: unexpected argument '${a}' (one input file at a time)`);
    usage(1);
  }
}
if (input === undefined) {
  console.error("warpc: no input file");
  usage(1);
}

let source;
try {
  source = readFileSync(input, "utf8");
} catch (e) {
  console.error(`warpc: cannot read ${input}: ${e.message}`);
  process.exit(1);
}

let artifact;
try {
  const system = compileSystem(source, {
    file: basename(input),
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
    ...(opts.lifecycle !== undefined ? { lifecycle: opts.lifecycle } : {}),
    ...(opts.auction !== undefined ? { auction: opts.auction } : {}),
    ...(opts.id !== undefined ? { id: opts.id } : {}),
  });
  artifact = serializeSystem(system);
} catch (e) {
  // A positioned compile/syntax error prints as file:line:col — the same form an
  // editor or a build log can jump to.
  if (e instanceof WarpLangError) {
    console.error(`warpc: ${e.format()}`);
    process.exit(1);
  }
  if (e instanceof WarpDeployError) {
    // A computed value cannot be baked into a static artifact. Refusing beats
    // shipping a model with the rule silently missing.
    console.error(`warpc: ${input}: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

if (opts.out === undefined) {
  process.stdout.write(artifact);
} else {
  writeFileSync(opts.out, artifact);
  console.error(`warpc: wrote ${opts.out}`);
}
