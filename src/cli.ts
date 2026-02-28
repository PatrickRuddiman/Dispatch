/**
 * CLI entry point for `dispatch`.
 *
 * Usage:
 *   dispatch <glob>              Dispatch tasks matching the glob pattern
 *   dispatch tasks/**\/*.md       Common usage — process task files
 *
 * Spec mode:
 *   dispatch --spec 1,2,3        Generate spec files from issues
 *   dispatch --spec "drafts/*.md" Generate specs from local markdown files
 *
 * Options:
 *   --spec <value>      Issue numbers (comma-separated) or glob pattern for local .md files
 *   --source <name>     Issue source: github, azdevops (auto-detected from remote)
 *   --org <url>         Azure DevOps organization URL
 *   --project <name>    Azure DevOps project name
 *   --output-dir <dir>  Output directory for generated specs (default: .dispatch/specs)
 *   --dry-run           List tasks without executing
 *   --concurrency N     Max parallel dispatches (default: 1)
 *   --provider NAME     Agent backend: opencode, copilot (default: opencode)
 *   --server-url URL    Connect to a running provider server
 *   --help              Show usage information
 */

import { resolve } from "node:path";
import { bootOrchestrator } from "./agents/index.js";
import { generateSpecs, defaultConcurrency } from "./spec-generator.js";
import { log } from "./logger.js";
import { runCleanup } from "./cleanup.js";
import type { ProviderName } from "./provider.js";
import type { IssueSourceName } from "./issue-fetcher.js";
import { PROVIDER_NAMES } from "./providers/index.js";
import { ISSUE_SOURCE_NAMES } from "./issue-fetchers/index.js";
import { handleConfigCommand, loadConfig } from "./config.js";

const HELP = `
  dispatch — AI agent orchestration CLI

  Usage:
    dispatch <glob>                  Dispatch tasks from markdown files
    dispatch --spec <ids>            Generate spec files from issues
    dispatch --spec <glob>           Generate specs from local markdown files

  Dispatch options:
    --dry-run              List tasks without dispatching
    --no-plan              Skip the planner agent, dispatch directly
    --concurrency <n>      Max parallel dispatches (default: min(cpus, freeMB/500))
    --provider <name>      Agent backend: ${PROVIDER_NAMES.join(", ")} (default: opencode)
    --server-url <url>     URL of a running provider server
    --cwd <dir>            Working directory (default: cwd)

  Spec options:
    --spec <value>         Comma-separated issue numbers or glob pattern for local .md files
    --source <name>        Issue source: ${ISSUE_SOURCE_NAMES.join(", ")} (auto-detected from git remote)
    --org <url>            Azure DevOps organization URL
    --project <name>       Azure DevOps project name
    --output-dir <dir>     Output directory for specs (default: .dispatch/specs)

  General:
    --verbose              Show detailed debug output for troubleshooting
    -h, --help             Show this help
    -v, --version          Show version

  Config:
    dispatch config set <key> <value>   Set a default config value
    dispatch config get <key>           Get a config value
    dispatch config list                List all config values
    dispatch config reset               Reset config (delete config file)
    dispatch config path                Show config file path

    Valid keys: provider, concurrency, source, org, project, serverUrl

  Examples:
    dispatch "tasks/**/*.md"
    dispatch "tasks/**/*.md" --provider copilot
    dispatch "tasks/**/*.md" --dry-run
    dispatch "tasks/**/*.md" --concurrency 3
    dispatch --spec 42,43,44
    dispatch --spec 42,43 --source github --provider copilot
    dispatch --spec 100,200 --source azdevops --org https://dev.azure.com/myorg --project MyProject
    dispatch --spec "drafts/*.md"
    dispatch --spec "./my-feature.md" --provider copilot
    dispatch config set provider copilot
    dispatch config list
    dispatch config reset
`.trimStart();

interface CliArgs {
  pattern: string[];
  dryRun: boolean;
  noPlan: boolean;
  /** undefined means "use mode-specific default" */
  concurrency?: number;
  provider: ProviderName;
  serverUrl?: string;
  cwd: string;
  help: boolean;
  version: boolean;
  verbose: boolean;
  // Spec mode
  spec?: string;
  issueSource?: IssueSourceName;
  org?: string;
  project?: string;
  outputDir?: string;
}

function parseArgs(argv: string[]): [CliArgs, Set<string>] {
  const args: CliArgs = {
    pattern: [],
    dryRun: false,
    noPlan: false,
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
    } else if (arg === "--verbose") {
      args.verbose = true;
      explicitFlags.add("verbose");
    } else if (arg === "--spec") {
      i++;
      args.spec = argv[i];
      explicitFlags.add("spec");
    } else if (arg === "--source") {
      i++;
      const val = argv[i];
      if (!ISSUE_SOURCE_NAMES.includes(val as IssueSourceName)) {
        log.error(
          `Unknown issue source "${val}". Available: ${ISSUE_SOURCE_NAMES.join(", ")}`
        );
        process.exit(1);
      }
      args.issueSource = val as IssueSourceName;
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
    } else if (arg === "--cwd") {
      i++;
      args.cwd = resolve(argv[i]);
      explicitFlags.add("cwd");
    } else if (!arg.startsWith("-")) {
      args.pattern.push(arg);
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
    await handleConfigCommand(rawArgv.slice(1));
    process.exit(0);
  }

  const [args, explicitFlags] = parseArgs(rawArgv);

  // ── Merge config-file defaults beneath CLI flags ───────────
  const config = await loadConfig();

  // Config key → CliArgs field mapping
  const CONFIG_TO_CLI: Record<string, keyof typeof args> = {
    provider: "provider",
    concurrency: "concurrency",
    source: "issueSource",
    org: "org",
    project: "project",
    serverUrl: "serverUrl",
  };

  for (const [configKey, cliField] of Object.entries(CONFIG_TO_CLI)) {
    const configValue = config[configKey as keyof typeof config];
    if (configValue !== undefined && !explicitFlags.has(cliField)) {
      (args as unknown as Record<string, unknown>)[cliField] = configValue;
    }
  }

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
    console.log("dispatch v0.1.0");
    process.exit(0);
  }

  // ── Spec mode ──────────────────────────────────────────────
  if (args.spec) {
    const summary = await generateSpecs({
      issues: args.spec,
      issueSource: args.issueSource,
      provider: args.provider,
      serverUrl: args.serverUrl,
      cwd: args.cwd,
      outputDir: args.outputDir,
      org: args.org,
      project: args.project,
      concurrency: args.concurrency,
    });

    process.exit(summary.failed > 0 ? 1 : 0);
  }

  // ── Dispatch mode ──────────────────────────────────────────
  if (!args.pattern.length) {
    log.error("Missing glob pattern. Usage: dispatch <glob>");
    log.dim('  Example: dispatch "tasks/**/*.md"');
    log.dim("  Example: dispatch tasks/a.md tasks/b.md");
    log.dim("  Or use:  dispatch --spec 1,2,3");
    process.exit(1);
  }

  const orchestrator = await bootOrchestrator({ cwd: args.cwd });
  const summary = await orchestrator.orchestrate({
    pattern: args.pattern,
    concurrency: args.concurrency ?? defaultConcurrency(),
    dryRun: args.dryRun,
    noPlan: args.noPlan,
    provider: args.provider,
    serverUrl: args.serverUrl,
  });
  await orchestrator.cleanup();

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  log.error(err instanceof Error ? err.message : String(err));
  await runCleanup();
  process.exit(1);
});
