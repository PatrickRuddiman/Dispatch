/**
 * Shell entry point — handles the `dispatch shell` subcommand.
 *
 * Selects a provider, verifies its CLI binary is available, initializes
 * the database, and launches the supervisor loop.
 */

import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderName } from "../providers/interface.js";
import { PROVIDER_NAMES } from "../providers/interface.js";
import type { ShellLauncher } from "./launcher-interface.js";
import { runSupervisor } from "./supervisor.js";
import { loadConfig } from "../config.js";
import { log } from "../helpers/logger.js";
import { openDatabase } from "../mcp/state/database.js";

const exec = promisify(execFile);

/** CLI binary name for each provider. */
const PROVIDER_CLI: Record<ProviderName, string> = {
  claude: "claude",
  copilot: "copilot",
  opencode: "opencode",
  codex: "codex",
};

/** Dynamically import the launcher for a provider. */
async function getLauncher(provider: ProviderName): Promise<ShellLauncher> {
  switch (provider) {
    case "claude": {
      const { launchClaude } = await import("./launchers/claude.js");
      return launchClaude;
    }
    case "copilot": {
      const { launchCopilot } = await import("./launchers/copilot.js");
      return launchCopilot;
    }
    case "opencode": {
      const { launchOpenCode } = await import("./launchers/opencode.js");
      return launchOpenCode;
    }
    case "codex": {
      const { launchCodex } = await import("./launchers/codex.js");
      return launchCodex;
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/** Check if a CLI binary is available on PATH. */
async function isBinaryAvailable(binary: string): Promise<boolean> {
  try {
    await exec("which", [binary], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Options for the shell command. */
export interface ShellCommandOptions {
  provider?: ProviderName;
  prompt?: string;
  model?: string;
  cwd: string;
}

/**
 * Run the shell command — the main entry point for `dispatch shell`.
 */
export async function runShellCommand(opts: ShellCommandOptions): Promise<void> {
  const configDir = resolve(opts.cwd, ".dispatch");
  const config = await loadConfig(configDir);

  // Determine provider: CLI flag > config > first enabled
  let provider = opts.provider;

  if (!provider && config.orchestratorProvider) {
    provider = config.orchestratorProvider;
  }

  if (!provider && config.enabledProviders && config.enabledProviders.length > 0) {
    provider = config.enabledProviders[0];
  }

  if (!provider) {
    // Fall back to first provider with CLI available
    for (const name of PROVIDER_NAMES) {
      if (await isBinaryAvailable(PROVIDER_CLI[name])) {
        provider = name;
        break;
      }
    }
  }

  if (!provider) {
    log.error("No provider available. Run 'dispatch config' to set up a provider, or pass --provider <name>.");
    process.exit(1);
  }

  // Verify the CLI binary is available
  const binary = PROVIDER_CLI[provider];
  if (!(await isBinaryAvailable(binary))) {
    log.error(`Provider '${provider}' requires the '${binary}' CLI to be installed and on PATH.`);
    process.exit(1);
  }

  // Ensure TTY for interactive shell
  if (!process.stdout.isTTY) {
    log.error("dispatch shell requires an interactive terminal (TTY).");
    process.exit(1);
  }

  // Initialize the database so the state poller can read from it
  openDatabase(opts.cwd);

  // Install the Dispatch skill into the provider's skill directory
  const { installSkill } = await import("./install-skill.js");
  const removeSkill = await installSkill(provider);

  // Get the launcher for this provider
  const launcher = await getLauncher(provider);

  log.info(`Launching ${provider} orchestrator shell with Dispatch MCP...`);
  log.info(`Use /dispatch in the shell to load the Dispatch orchestration skill.`);

  try {
    await runSupervisor({
      provider,
      launcher,
      cwd: opts.cwd,
      model: opts.model,
      initialPrompt: opts.prompt,
    });
  } finally {
    await removeSkill();
  }
}
