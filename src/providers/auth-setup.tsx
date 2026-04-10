/**
 * Interactive auth setup per provider — walks users through configuring
 * credentials for each AI provider during `dispatch config`.
 *
 * Every provider offers two standardized auth methods:
 *   - OAuth / CLI login (device flow or browser-based)
 *   - API key / environment variable
 */

import { select } from "../helpers/ink-prompts.js";
import { log } from "../helpers/logger.js";
import type { ProviderName } from "./interface.js";
import { PROVIDER_REGISTRY } from "./registry.js";

/** Timeout for spawned auth commands. */
const AUTH_CMD_TIMEOUT_MS = 120_000;

/**
 * Run the interactive auth setup for a single provider.
 * Returns true if auth was successfully configured.
 */
export async function setupProviderAuth(name: ProviderName): Promise<boolean> {
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
  log.info("GitHub Copilot Authentication");
  console.log();

  const method = await select({
    message: "How would you like to authenticate?",
    choices: [
      { name: "Copilot CLI login", value: "cli-login" as const, description: "Run 'copilot login' — device code flow" },
      { name: "API key (environment variable)", value: "env-var" as const, description: "Set GITHUB_TOKEN or GH_TOKEN manually" },
    ],
  });

  if (method === "cli-login") {
    try {
      log.info("Running 'copilot login'...");
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("copilot", ["login"], {
          stdio: "inherit",
          timeout: AUTH_CMD_TIMEOUT_MS,
        });
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`copilot login exited with code ${code}`)),
        );
        child.on("error", reject);
      });
      return await verifyAuth("copilot");
    } catch (err) {
      log.warn(`Copilot CLI auth failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // env-var path
  log.info("Set one of these environment variables in your shell profile:");
  log.info("  GITHUB_TOKEN=<your token>");
  log.info("  GH_TOKEN=<your token>");
  console.log();
  log.dim("After setting the variable, restart your terminal and re-run 'dispatch config'.");
  return false;
}

async function setupClaudeAuth(): Promise<boolean> {
  log.info("Claude Code Authentication");
  console.log();

  const method = await select({
    message: "How would you like to authenticate?",
    choices: [
      { name: "Claude CLI login", value: "cli-login" as const, description: "Run 'claude auth login' — opens a browser" },
      { name: "API key (environment variable)", value: "env-var" as const, description: "Set ANTHROPIC_API_KEY manually" },
    ],
  });

  if (method === "cli-login") {
    try {
      log.info("Running 'claude auth login'...");
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("claude", ["auth", "login"], {
          stdio: "inherit",
          timeout: AUTH_CMD_TIMEOUT_MS,
        });
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`claude auth login exited with code ${code}`)),
        );
        child.on("error", reject);
      });
      return await verifyAuth("claude");
    } catch (err) {
      log.warn(`Claude CLI auth failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // env-var path
  log.info("Set the following environment variable in your shell profile:");
  log.info("  ANTHROPIC_API_KEY=<your API key>");
  console.log();
  log.dim("After setting the variable, restart your terminal and re-run 'dispatch config'.");
  return false;
}

async function setupCodexAuth(): Promise<boolean> {
  log.info("OpenAI Codex Authentication");
  console.log();

  const method = await select({
    message: "How would you like to authenticate?",
    choices: [
      { name: "ChatGPT sign-in", value: "cli-login" as const, description: "Run 'codex login --device-auth' — device code flow" },
      { name: "API key (environment variable)", value: "env-var" as const, description: "Set OPENAI_API_KEY manually" },
    ],
  });

  if (method === "cli-login") {
    try {
      log.info("Running 'codex login --device-auth'...");
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("codex", ["login", "--device-auth"], {
          stdio: "inherit",
          timeout: AUTH_CMD_TIMEOUT_MS,
        });
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`codex login exited with code ${code}`)),
        );
        child.on("error", reject);
      });
      return await verifyAuth("codex");
    } catch (err) {
      log.warn(`Codex CLI auth failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // env-var path
  log.info("Set the following environment variable in your shell profile:");
  log.info("  OPENAI_API_KEY=<your API key>");
  console.log();
  log.dim("After setting the variable, restart your terminal and re-run 'dispatch config'.");
  return false;
}

async function setupOpencodeAuth(): Promise<boolean> {
  log.info("OpenCode Authentication");
  console.log();

  const method = await select({
    message: "How would you like to authenticate?",
    choices: [
      { name: "OpenCode CLI login", value: "cli-login" as const, description: "Run 'opencode auth login' interactively" },
      { name: "API key (environment variable)", value: "env-var" as const, description: "Set provider API keys manually" },
    ],
  });

  if (method === "cli-login") {
    try {
      log.info("Running 'opencode auth login'...");
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("opencode", ["auth", "login"], {
          stdio: "inherit",
          timeout: AUTH_CMD_TIMEOUT_MS,
        });
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`opencode auth login exited with code ${code}`)),
        );
        child.on("error", reject);
      });
      return await verifyAuth("opencode");
    } catch (err) {
      log.warn(`OpenCode CLI auth failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // env-var path
  log.info("Set the relevant API key environment variable in your shell profile.");
  log.info("For example:");
  log.info("  ANTHROPIC_API_KEY=<your API key>");
  log.info("  OPENAI_API_KEY=<your API key>");
  console.log();
  log.dim("After setting the variable, restart your terminal and re-run 'dispatch config'.");
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
