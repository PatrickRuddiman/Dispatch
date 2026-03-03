/**
 * CLI entry point for `dispatch`.
 *
 * This module is a thin argument-parsing shell. It parses CLI arguments,
 * boots the orchestrator, delegates all workflow logic (config loading,
 * validation, pipeline selection) to the orchestrator's `runFromCli()`
 * method, and exits based on the result.
 *
 * Process-level concerns (signal handlers, config subcommand) remain here.
 */

import { resolve, join } from "node:path";
import { boot as bootOrchestrator, type RawCliArgs } from "./orchestrator/runner.js";
import { log } from "./helpers/logger.js";
import { runCleanup } from "./helpers/cleanup.js";
import type { ProviderName } from "./providers/interface.js";
import type { DatasourceName } from "./datasources/interface.js";
import { PROVIDER_NAMES } from "./providers/index.js";
import { DATASOURCE_NAMES } from "./datasources/index.js";
import { handleConfigCommand } from "./config.js";

const HELP = `
  dispatch — AI agent orchestration CLI

  Usage:
    dispatch [issue-id...]           Dispatch specific issues (or all open issues if none given)
    dispatch --spec <ids>            Generate spec files from issues
    dispatch --spec <glob>           Generate specs from local markdown files in the configured datasource
    dispatch --respec                Regenerate all existing specs
    dispatch --respec <ids>          Regenerate specs for specific issues
    dispatch --respec <glob>         Regenerate specs matching a glob pattern
    dispatch --spec "description"    Generate a spec from an inline text description
    dispatch --fix-tests             Run tests and fix failures via AI agent

  Dispatch options:
    --dry-run              List tasks without dispatching (also works with --spec)
    --no-plan              Skip the planner agent, dispatch directly
    --no-branch            Skip branch creation, push, and PR lifecycle
    --no-worktree          Skip git worktree isolation for parallel issues
    --force              Ignore prior run state and re-run all tasks
    --concurrency <n>      Max parallel dispatches (default: min(cpus, freeMB/500))
    --provider <name>      Agent backend: ${PROVIDER_NAMES.join(", ")} (default: opencode)
    --server-url <url>     URL of a running provider server
    --plan-timeout <min>   Planning timeout in minutes (default: 10)
    --plan-retries <n>     Retry attempts after planning timeout (default: 1)
    --cwd <dir>            Working directory (default: cwd)

  Spec options:
    --spec <value>         Comma-separated issue numbers or glob pattern for .md files (creates specs in configured datasource)
    --respec [value]       Regenerate specs: issue numbers, glob, or omit to regenerate all existing specs
    --spec <value>         Comma-separated issue numbers, glob pattern for .md files, or inline text description
    --source <name>        Issue source: ${DATASOURCE_NAMES.join(", ")} (optional; auto-detected from git remote, falls back to md)
    --org <url>            Azure DevOps organization URL
    --project <name>       Azure DevOps project name
    --output-dir <dir>     Output directory for specs (default: .dispatch/specs)

  General:
    --verbose              Show detailed debug output for troubleshooting
    -h, --help             Show this help
    -v, --version          Show version

  Config:
    dispatch config                     Launch interactive configuration wizard

  Examples:
    dispatch 14
    dispatch 14,15,16
    dispatch 14 15 16
    dispatch
    dispatch 14 --dry-run
    dispatch 14 --provider copilot
    dispatch --spec 42,43,44
    dispatch --spec 42,43 --source github --provider copilot
    dispatch --spec 100,200 --source azdevops --org https://dev.azure.com/myorg --project MyProject
    dispatch --spec "drafts/*.md"
    dispatch --spec "drafts/*.md" --source github
    dispatch --spec "./my-feature.md" --provider copilot
    dispatch --respec
    dispatch --respec 42,43,44
    dispatch --respec "specs/*.md"
    dispatch --spec "add dark mode toggle to settings page"
    dispatch --spec "feature A should do x" --provider copilot
    dispatch config
`.trimStart();

/** Parsed CLI arguments including shell-only flags (help, version). */
export interface ParsedArgs extends Omit<RawCliArgs, "explicitFlags"> {
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): [ParsedArgs, Set<string>] {
  const args: ParsedArgs = {
    issueIds: [],
    dryRun: false,
    noPlan: false,
    noBranch: false,
    noWorktree: false,
    force: false,
    provider: "opencode",
    cwd: process.cwd(),
    help: false,
    version: false,
    verbose: false,
  };

  const explicitFlags = new Set<string>();

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      explicitFlags.add("help");
    } else if (arg === "--version" || arg === "-v") {
      args.version = true;
      explicitFlags.add("version");
    } else if (arg === "--dry-run") {
      args.dryRun = true;
      explicitFlags.add("dryRun");
    } else if (arg === "--no-plan") {
      args.noPlan = true;
      explicitFlags.add("noPlan");
    } else if (arg === "--no-branch") {
      args.noBranch = true;
      explicitFlags.add("noBranch");
    } else if (arg === "--no-worktree") {
      args.noWorktree = true;
      explicitFlags.add("noWorktree");
    } else if (arg === "--force") {
      args.force = true;
      explicitFlags.add("force");
    } else if (arg === "--verbose") {
      args.verbose = true;
      explicitFlags.add("verbose");
    } else if (arg === "--spec") {
      i++;
      const specs: string[] = [];
      while (i < argv.length && !argv[i].startsWith("--")) {
        specs.push(argv[i]);
        i++;
      }
      i--; // outer loop will i++
      args.spec = specs.length === 1 ? specs[0] : specs;
      explicitFlags.add("spec");
    } else if (arg === "--respec") {
      i++;
      const respecs: string[] = [];
      while (i < argv.length && !argv[i].startsWith("--")) {
        respecs.push(argv[i]);
        i++;
      }
      i--; // outer loop will i++
      args.respec = respecs.length === 1 ? respecs[0] : respecs;
      explicitFlags.add("respec");
    } else if (arg === "--fix-tests") {
      args.fixTests = true;
      explicitFlags.add("fixTests");
    } else if (arg === "--source") {
      i++;
      const val = argv[i];
      if (!DATASOURCE_NAMES.includes(val as DatasourceName)) {
        log.error(
          `Unknown source "${val}". Available: ${DATASOURCE_NAMES.join(", ")}`
        );
        process.exit(1);
      }
      args.issueSource = val as DatasourceName;
      explicitFlags.add("issueSource");
    } else if (arg === "--org") {
      i++;
      args.org = argv[i];
      explicitFlags.add("org");
    } else if (arg === "--project") {
      i++;
      args.project = argv[i];
      explicitFlags.add("project");
    } else if (arg === "--output-dir") {
      i++;
      args.outputDir = resolve(argv[i]);
      explicitFlags.add("outputDir");
    } else if (arg === "--concurrency") {
      i++;
      const val = parseInt(argv[i], 10);
      if (isNaN(val) || val < 1) {
        log.error("--concurrency must be a positive integer");
        process.exit(1);
      }
      args.concurrency = val;
      explicitFlags.add("concurrency");
    } else if (arg === "--provider") {
      i++;
      const val = argv[i];
      if (!PROVIDER_NAMES.includes(val as ProviderName)) {
        log.error(`Unknown provider "${val}". Available: ${PROVIDER_NAMES.join(", ")}`);
        process.exit(1);
      }
      args.provider = val as ProviderName;
      explicitFlags.add("provider");
    } else if (arg === "--server-url") {
      i++;
      args.serverUrl = argv[i];
      explicitFlags.add("serverUrl");
    } else if (arg === "--plan-timeout") {
      i++;
      const val = parseFloat(argv[i]);
      if (isNaN(val) || val <= 0) {
        log.error("--plan-timeout must be a positive number (minutes)");
        process.exit(1);
      }
      args.planTimeout = val;
      explicitFlags.add("planTimeout");
    } else if (arg === "--plan-retries") {
      i++;
      const val = parseInt(argv[i], 10);
      if (isNaN(val) || val < 0) {
        log.error("--plan-retries must be a non-negative integer");
        process.exit(1);
      }
      args.planRetries = val;
      explicitFlags.add("planRetries");
    } else if (arg === "--cwd") {
      i++;
      args.cwd = resolve(argv[i]);
      explicitFlags.add("cwd");
    } else if (!arg.startsWith("-")) {
      args.issueIds.push(arg);
    } else {
      log.error(`Unknown option: ${arg}`);
      process.exit(1);
    }

    i++;
  }

  return [args, explicitFlags];
}

async function main() {
  const rawArgv = process.argv.slice(2);

  // ── Config subcommand — must run before parseArgs ──────────
  if (rawArgv[0] === "config") {
    let cwd = process.cwd();
    for (let i = 1; i < rawArgv.length; i++) {
      if (rawArgv[i] === "--cwd" && i + 1 < rawArgv.length) {
        cwd = resolve(rawArgv[i + 1]);
        break;
      }
    }
    const configDir = join(cwd, ".dispatch");
    await handleConfigCommand(rawArgv.slice(1), configDir);
    process.exit(0);
  }

  const [args, explicitFlags] = parseArgs(rawArgv);

  // Enable verbose logging before anything else
  log.verbose = args.verbose;

  // ── Graceful shutdown on signals ───────────────────────────
  process.on("SIGINT", async () => {
    log.debug("Received SIGINT, cleaning up...");
    await runCleanup();
    process.exit(130);
  });

  process.on("SIGTERM", async () => {
    log.debug("Received SIGTERM, cleaning up...");
    await runCleanup();
    process.exit(143);
  });

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.version) {
    console.log(`dispatch v${__VERSION__}`);
    process.exit(0);
  }

  // ── Delegate to orchestrator ───────────────────────────────
  const orchestrator = await bootOrchestrator({ cwd: args.cwd });
  const { help: _, version: __, ...rawArgs } = args;
  const summary = await orchestrator.runFromCli({ ...rawArgs, explicitFlags });

  // Determine exit code from summary
  const failed = "failed" in summary ? summary.failed : ("success" in summary && !summary.success ? 1 : 0);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  log.error(log.formatErrorChain(err));
  await runCleanup();
  process.exit(1);
});
