/**
 * Interactive auth setup per provider — walks users through configuring
 * credentials for each AI provider during `dispatch config`.
 *
 * Each provider has a different auth mechanism:
 *   - Copilot: GitHub token (env var or gh CLI login)
 *   - Claude: Anthropic API key or `claude login`
 *   - Codex: OpenAI API key
 *   - OpenCode: OpenCode's own config system
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { log } from "../helpers/logger.js";
import type { ProviderName } from "./interface.js";
import { PROVIDER_REGISTRY, type AuthStatus } from "./registry.js";

const exec = promisify(execFile);

/** Timeout for spawned auth commands. */
const AUTH_CMD_TIMEOUT_MS = 120_000;

/**
 * Run the interactive auth setup for a single provider.
 * Returns true if auth was successfully configured.
 */
export async function setupProviderAuth(name: ProviderName): Promise<boolean> {
  const meta = PROVIDER_REGISTRY[name];

  switch (name) {
    case "copilot":
      return setupCopilotAuth();
    case "claude":
      return setupClaudeAuth();
    case "codex":
      return setupCodexAuth();
    case "opencode":
      return setupOpencodeAuth();
    default: {
      const _exhaustive: never = name;
      log.warn(`No auth setup for provider "${_exhaustive}"`);
      return false;
    }
  }
}

async function setupCopilotAuth(): Promise<boolean> {
  log.info(chalk.bold("GitHub Copilot Authentication"));
  console.log();

  const method = await select({
    message: "How would you like to authenticate?",
    choices: [
      {
        name: "GitHub CLI (gh auth login)",
        value: "gh-cli" as const,
        description: "Uses the GitHub CLI's device flow — opens a browser",
      },
      {
        name: "Environment variable",
        value: "env-var" as const,
        description: "Set GITHUB_TOKEN or GH_TOKEN manually",
      },
    ],
  });

  if (method === "gh-cli") {
    try {
      log.info("Running 'gh auth login'...");
      // gh auth login uses interactive terminal — spawn with inherited stdio
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("gh", ["auth", "login"], {
          stdio: "inherit",
          timeout: AUTH_CMD_TIMEOUT_MS,
        });
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`gh auth login exited with code ${code}`)),
        );
        child.on("error", reject);
      });
      return await verifyAuth("copilot");
    } catch (err) {
      log.warn(`GitHub CLI auth failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // env-var path
  log.info("Set one of these environment variables in your shell profile:");
  log.info(`  ${chalk.cyan("GITHUB_TOKEN")}=<your token>`);
  log.info(`  ${chalk.cyan("GH_TOKEN")}=<your token>`);
  console.log();
  log.dim("After setting the variable, restart your terminal and re-run 'dispatch config'.");
  return false;
}

async function setupClaudeAuth(): Promise<boolean> {
  log.info(chalk.bold("Claude Code Authentication"));
  console.log();

  const method = await select({
    message: "How would you like to authenticate?",
    choices: [
      {
        name: "API key (ANTHROPIC_API_KEY)",
        value: "api-key" as const,
        description: "Paste your Anthropic API key",
      },
      {
        name: "Claude CLI login",
        value: "cli-login" as const,
        description: "Run 'claude login' — opens a browser",
      },
    ],
  });

  if (method === "cli-login") {
    try {
      log.info("Running 'claude login'...");
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("claude", ["login"], {
          stdio: "inherit",
          timeout: AUTH_CMD_TIMEOUT_MS,
        });
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`claude login exited with code ${code}`)),
        );
        child.on("error", reject);
      });
      return await verifyAuth("claude");
    } catch (err) {
      log.warn(`Claude login failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // API key path
  log.info("Set the following environment variable in your shell profile:");
  log.info(`  ${chalk.cyan("ANTHROPIC_API_KEY")}=<your API key>`);
  console.log();
  log.dim("After setting the variable, restart your terminal and re-run 'dispatch config'.");
  return false;
}

async function setupCodexAuth(): Promise<boolean> {
  log.info(chalk.bold("OpenAI Codex Authentication"));
  console.log();

  log.info("Set the following environment variable in your shell profile:");
  log.info(`  ${chalk.cyan("OPENAI_API_KEY")}=<your API key>`);
  console.log();
  log.dim("After setting the variable, restart your terminal and re-run 'dispatch config'.");
  return false;
}

async function setupOpencodeAuth(): Promise<boolean> {
  log.info(chalk.bold("OpenCode Authentication"));
  console.log();

  log.info("OpenCode uses its own configuration system.");
  log.info("Run 'opencode' to set up your providers and API keys.");
  console.log();
  log.dim("After configuring OpenCode, re-run 'dispatch config'.");
  return false;
}

/**
 * Verify that auth is working for a provider after setup.
 */
async function verifyAuth(name: ProviderName): Promise<boolean> {
  const meta = PROVIDER_REGISTRY[name];
  const status = await meta.checkAuth();
  if (status.status === "authenticated") {
    log.success(`${meta.displayName} authentication verified.`);
    return true;
  }
  log.warn(`${meta.displayName} authentication could not be verified: ${status.hint}`);
  return false;
}
