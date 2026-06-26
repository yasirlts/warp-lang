/**
 * Tiny CLI/build step for commerce-viz. Reads the frozen transition table and
 * writes state-graph artifacts (per-primitive SVG, plus one combined HTML page)
 * to an output directory.
 *
 *   warp-commerce-viz [--out <dir>] [--format svg|html|both]
 *
 * Defaults: --out ./out, --format both. This generates; it does not serve or
 * execute the model.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGraphs } from "./transitions.js";
import { renderHtml, renderSvg } from "./render.js";

interface Args {
  out: string;
  format: "svg" | "html" | "both";
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: "out", format: "both" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i] ?? args.out;
    else if (a === "--format") {
      const v = argv[++i];
      if (v === "svg" || v === "html" || v === "both") args.format = v;
      else throw new Error(`unknown --format ${v} (expected svg|html|both)`);
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "warp-commerce-viz [--out <dir>] [--format svg|html|both]\n" +
          "  Reads schema/behavior/transitions.json and writes state-graph artifacts.\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

export function run(argv: string[] = process.argv.slice(2)): string[] {
  const args = parseArgs(argv);
  const graphs = loadGraphs();
  mkdirSync(args.out, { recursive: true });
  const written: string[] = [];

  if (args.format === "svg" || args.format === "both") {
    for (const g of graphs) {
      const path = join(args.out, `${g.primitive}.svg`);
      writeFileSync(path, renderSvg(g), "utf8");
      written.push(path);
    }
  }
  if (args.format === "html" || args.format === "both") {
    const path = join(args.out, "index.html");
    writeFileSync(path, renderHtml(graphs), "utf8");
    written.push(path);
  }

  for (const p of written) process.stdout.write(`wrote ${p}\n`);
  return written;
}

run();
