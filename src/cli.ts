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
import { Command, Option, CommanderError } from "commander";
import { boot as bootOrchestrator, type RawCliArgs } from "./orchestrator/runner.js";
import { log } from "./helpers/logger.js";
import { runCleanup } from "./helpers/cleanup.js";
import type { ProviderName } from "./providers/interface.js";
import type { DatasourceName } from "./datasources/interface.js";
import { PROVIDER_NAMES } from "./providers/index.js";
import { DATASOURCE_NAMES } from "./datasources/index.js";
import { handleConfigCommand, CONFIG_BOUNDS } from "./config.js";

export const MAX_CONCURRENCY = CONFIG_BOUNDS.concurrency.max;

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
    --feature [name]       Group issues into a single feature branch and PR
    --force              Ignore prior run state and re-run all tasks
    --concurrency <n>      Max parallel dispatches (default: min(cpus, freeMB/500), max: ${MAX_CONCURRENCY})
    --provider <name>      Agent backend: ${PROVIDER_NAMES.join(", ")} (default: opencode)
    --server-url <url>     URL of a running provider server
    --plan-timeout <min>   Planning timeout in minutes (default: 10)
    --retries <n>          Retry attempts for all agents (default: 2)
    --plan-retries <n>     Retry attempts after planning timeout (overrides --retries for planner)
    --test-timeout <min>   Test timeout in minutes (default: 5)
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
    dispatch --feature
    dispatch --feature my-feature
    dispatch config
`.trimStart();

/** Parsed CLI arguments including shell-only flags (help, version). */
export interface ParsedArgs extends Omit<RawCliArgs, "explicitFlags"> {
  help: boolean;
  version: boolean;
  feature?: string | boolean;
}

export function parseArgs(argv: string[]): [ParsedArgs, Set<string>] {
  const program = new Command();

  program
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    })
    .helpOption(false)
    .argument("[issueIds...]")
    .option("-h, --help", "Show help")
    .option("-v, --version", "Show version")
    .option("--dry-run", "List tasks without dispatching")
    .option("--no-plan", "Skip the planner agent")
    .option("--no-branch", "Skip branch creation")
    .option("--no-worktree", "Skip git worktree isolation")
    .option("--feature [name]", "Group issues into a single feature branch")
    .option("--force", "Ignore prior run state")
    .option("--verbose", "Show detailed debug output")
    .option("--fix-tests", "Run tests and fix failures")
    .option("--spec <values...>", "Spec mode: issue numbers, glob, or text")
    .option("--respec [values...]", "Regenerate specs")
    .addOption(
      new Option("--provider <name>", "Agent backend").choices(PROVIDER_NAMES),
    )
    .addOption(
      new Option("--source <name>", "Issue source").choices(
        DATASOURCE_NAMES as string[],
      ),
    )
    .option(
      "--concurrency <n>",
      "Max parallel dispatches",
      (val: string): number => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1) throw new CommanderError(1, "commander.invalidArgument", "--concurrency must be a positive integer");
        if (n > MAX_CONCURRENCY) throw new CommanderError(1, "commander.invalidArgument", `--concurrency must not exceed ${MAX_CONCURRENCY}`);
        return n;
      },
    )
    .option(
      "--plan-timeout <min>",
      "Planning timeout in minutes",
      (val: string): number => {
        const n = parseFloat(val);
        if (isNaN(n) || n < CONFIG_BOUNDS.planTimeout.min) throw new CommanderError(1, "commander.invalidArgument", "--plan-timeout must be a positive number (minutes)");
        if (n > CONFIG_BOUNDS.planTimeout.max) throw new CommanderError(1, "commander.invalidArgument", `--plan-timeout must not exceed ${CONFIG_BOUNDS.planTimeout.max}`);
        return n;
      },
    )
    .option(
      "--retries <n>",
      "Retry attempts",
      (val: string): number => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 0) throw new CommanderError(1, "commander.invalidArgument", "--retries must be a non-negative integer");
        return n;
      },
    )
    .option(
      "--plan-retries <n>",
      "Planner retry attempts",
      (val: string): number => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 0) throw new CommanderError(1, "commander.invalidArgument", "--plan-retries must be a non-negative integer");
        return n;
      },
    )
    .option(
      "--test-timeout <min>",
      "Test timeout in minutes",
      (val: string): number => {
        const n = parseFloat(val);
        if (isNaN(n) || n <= 0) throw new CommanderError(1, "commander.invalidArgument", "--test-timeout must be a positive number (minutes)");
        return n;
      },
    )
    .option("--cwd <dir>", "Working directory", (val: string) => resolve(val))
    .option("--output-dir <dir>", "Output directory", (val: string) => resolve(val))
    .option("--org <url>", "Azure DevOps organization URL")
    .option("--project <name>", "Azure DevOps project name")
    .option("--server-url <url>", "Provider server URL");

  try {
    program.parse(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      log.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const opts = program.opts();

  // ── Build ParsedArgs ────────────────────────────────────────
  const args: ParsedArgs = {
    issueIds: program.args,
    dryRun: opts.dryRun ?? false,
    noPlan: !opts.plan,
    noBranch: !opts.branch,
    noWorktree: !opts.worktree,
    force: opts.force ?? false,
    provider: opts.provider ?? "opencode",
    cwd: opts.cwd ?? process.cwd(),
    help: opts.help ?? false,
    version: opts.version ?? false,
    verbose: opts.verbose ?? false,
  };

  // Optional fields — only set when explicitly provided
  if (opts.spec !== undefined) {
    args.spec = opts.spec.length === 1 ? opts.spec[0] : opts.spec;
  }
  if (opts.respec !== undefined) {
    if (opts.respec === true) {
      args.respec = [];
    } else {
      args.respec = opts.respec.length === 1 ? opts.respec[0] : opts.respec;
    }
  }
  if (opts.fixTests) args.fixTests = true;
  if (opts.feature) args.feature = opts.feature;
  if (opts.source !== undefined) args.issueSource = opts.source;
  if (opts.concurrency !== undefined) args.concurrency = opts.concurrency;
  if (opts.serverUrl !== undefined) args.serverUrl = opts.serverUrl;
  if (opts.planTimeout !== undefined) args.planTimeout = opts.planTimeout;
  if (opts.retries !== undefined) args.retries = opts.retries;
  if (opts.planRetries !== undefined) args.planRetries = opts.planRetries;
  if (opts.testTimeout !== undefined) args.testTimeout = opts.testTimeout;
  if (opts.org !== undefined) args.org = opts.org;
  if (opts.project !== undefined) args.project = opts.project;
  if (opts.outputDir !== undefined) args.outputDir = opts.outputDir;

  // ── Derive explicitFlags from Commander option sources ─────
  const explicitFlags = new Set<string>();

  const SOURCE_MAP: Record<string, string> = {
    help: "help",
    version: "version",
    dryRun: "dryRun",
    plan: "noPlan",
    branch: "noBranch",
    worktree: "noWorktree",
    force: "force",
    verbose: "verbose",
    spec: "spec",
    respec: "respec",
    fixTests: "fixTests",
    feature: "feature",
    source: "issueSource",
    provider: "provider",
    concurrency: "concurrency",
    serverUrl: "serverUrl",
    planTimeout: "planTimeout",
    retries: "retries",
    planRetries: "planRetries",
    testTimeout: "testTimeout",
    cwd: "cwd",
    org: "org",
    project: "project",
    outputDir: "outputDir",
  };

  for (const [attr, flag] of Object.entries(SOURCE_MAP)) {
    if (program.getOptionValueSource(attr) === "cli") {
      explicitFlags.add(flag);
    }
  }

  return [args, explicitFlags];
}

async function main() {
  const rawArgv = process.argv.slice(2);

  // ── Config subcommand via Commander ────────────────────────
  if (rawArgv[0] === "config") {
    const configProgram = new Command("dispatch-config")
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })
      .helpOption(false)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .option("--cwd <dir>", "Working directory", (v: string) => resolve(v));

    try {
      configProgram.parse(rawArgv.slice(1), { from: "user" });
    } catch (err) {
      if (err instanceof CommanderError) {
        log.error(err.message);
        process.exit(1);
      }
      throw err;
    }

    const configDir = join(configProgram.opts().cwd ?? process.cwd(), ".dispatch");
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
