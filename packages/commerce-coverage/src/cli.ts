/**
 * warp-coverage CLI.
 *
 *   warp-coverage audit   [--config <path>] [--json]   # measure + report coverage
 *   warp-coverage enforce [--config <path>] [--json]   # build gate: nonzero on unguarded sinks
 *
 * `audit` always exits 0 on a successful run (it measures). `enforce` exits 0 when
 * every enforceable (declared, analyzable, non-allow-listed) sink is guarded at or
 * above the configured threshold, and nonzero otherwise — so CI fails when a new
 * unguarded money-path would ship. Usage/config errors exit 2.
 */
import { loadConfig } from "./config.js";
import { runAudit } from "./audit.js";
import { buildReport, formatHuman } from "./report.js";
import { evaluateEnforcement, formatEnforcement } from "./enforce.js";

function usage(): never {
  console.error("usage: warp-coverage <audit|enforce> [--config <path>] [--json]");
  process.exit(2);
}

function parseArgs(argv: string[]): { configPath: string; json: boolean } {
  let configPath = "warp-coverage.config.json";
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") {
      const next = argv[++i];
      if (!next) usage();
      configPath = next;
    } else if (a === "--json") {
      json = true;
    } else {
      console.error(`unknown argument: ${a}`);
      usage();
    }
  }
  return { configPath, json };
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== "audit" && cmd !== "enforce") usage();
  const { configPath, json } = parseArgs(argv.slice(1));

  let loaded;
  try {
    loaded = loadConfig(configPath);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  const report = buildReport(runAudit(loaded));

  if (cmd === "audit") {
    console.log(json ? JSON.stringify(report, null, 2) : formatHuman(report));
    return;
  }

  // enforce
  const result = evaluateEnforcement(report, {
    failUnder: loaded.config.failUnder,
    onUnanalyzable: loaded.config.onUnanalyzable,
  });
  console.log(json ? JSON.stringify({ enforcement: result, report }, null, 2) : formatEnforcement(result, report));
  process.exit(result.exitCode);
}

main();
