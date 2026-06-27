/**
 * warp-coverage CLI.
 *
 *   warp-coverage audit [--config <path>] [--json]
 *
 * Prints the coverage statement (human-readable, or JSON with --json). Default
 * config path is ./warp-coverage.config.json. Exit code 0 on a successful audit,
 * 2 on a usage/config error. (This tool MEASURES coverage; it does not enforce —
 * the enforcer is a separate tool.)
 */
import { loadConfig } from "./config.js";
import { runAudit } from "./audit.js";
import { buildReport, formatHuman } from "./report.js";

function usage(): never {
  console.error("usage: warp-coverage audit [--config <path>] [--json]");
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== "audit") usage();

  let configPath = "warp-coverage.config.json";
  let json = false;
  for (let i = 1; i < argv.length; i++) {
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

  let loaded;
  try {
    loaded = loadConfig(configPath);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  const report = buildReport(runAudit(loaded));
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHuman(report));
  }
}

main();
