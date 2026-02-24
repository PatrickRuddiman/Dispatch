/**
 * CLI entry point for `dispatch`.
 *
 * Usage:
 *   dispatch <glob>              Dispatch tasks matching the glob pattern
 *   dispatch tasks/**\/*.md       Common usage — process task files
 *
 * Options:
 *   --dry-run         List tasks without executing
 *   --concurrency N   Max parallel dispatches (default: 1)
 *   --provider NAME   Agent backend: opencode, copilot (default: opencode)
 *   --server-url URL  Connect to a running provider server
 *   --help            Show usage information
 */

import { resolve } from "node:path";
import { orchestrate } from "./orchestrator.js";
import { log } from "./logger.js";
import type { ProviderName } from "./provider.js";
import { PROVIDER_NAMES } from "./providers/index.js";

const HELP = `
  dispatch — AI agent orchestration CLI

  Usage:
    dispatch <glob>                  Dispatch tasks from markdown files
    dispatch tasks/**/*.md           Process all task files

  Options:
    --dry-run              List tasks without dispatching
    --no-plan              Skip the planner agent, dispatch directly
    --concurrency <n>      Max parallel dispatches (default: 1)
    --provider <name>      Agent backend: ${PROVIDER_NAMES.join(", ")} (default: opencode)
    --server-url <url>     URL of a running provider server
    --cwd <dir>            Working directory (default: cwd)
    -h, --help             Show this help
    -v, --version          Show version

  Examples:
    dispatch "tasks/**/*.md"
    dispatch "tasks/**/*.md" --provider copilot
    dispatch "tasks/**/*.md" --dry-run
    dispatch "tasks/**/*.md" --concurrency 3
    dispatch "tasks/**/*.md" --server-url http://localhost:4096
`.trimStart();

interface CliArgs {
  pattern: string;
  dryRun: boolean;
  noPlan: boolean;
  concurrency: number;
  provider: ProviderName;
  serverUrl?: string;
  cwd: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    pattern: "",
    dryRun: false,
    noPlan: false,
    concurrency: 1,
    provider: "opencode",
    cwd: process.cwd(),
    help: false,
    version: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--version" || arg === "-v") {
      args.version = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--no-plan") {
      args.noPlan = true;
    } else if (arg === "--concurrency") {
      i++;
      const val = parseInt(argv[i], 10);
      if (isNaN(val) || val < 1) {
        log.error("--concurrency must be a positive integer");
        process.exit(1);
      }
      args.concurrency = val;
    } else if (arg === "--provider") {
      i++;
      const val = argv[i];
      if (!PROVIDER_NAMES.includes(val as ProviderName)) {
        log.error(`Unknown provider "${val}". Available: ${PROVIDER_NAMES.join(", ")}`);
        process.exit(1);
      }
      args.provider = val as ProviderName;
    } else if (arg === "--server-url") {
      i++;
      args.serverUrl = argv[i];
    } else if (arg === "--cwd") {
      i++;
      args.cwd = resolve(argv[i]);
    } else if (!arg.startsWith("-")) {
      args.pattern = arg;
    } else {
      log.error(`Unknown option: ${arg}`);
      process.exit(1);
    }

    i++;
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.version) {
    // Read version from package.json at build time via tsup define
    console.log("dispatch v0.1.0");
    process.exit(0);
  }

  if (!args.pattern) {
    log.error("Missing glob pattern. Usage: dispatch <glob>");
    log.dim('  Example: dispatch "tasks/**/*.md"');
    process.exit(1);
  }

  const summary = await orchestrate({
    pattern: args.pattern,
    cwd: args.cwd,
    concurrency: args.concurrency,
    dryRun: args.dryRun,
    noPlan: args.noPlan,
    provider: args.provider,
    serverUrl: args.serverUrl,
  });

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
