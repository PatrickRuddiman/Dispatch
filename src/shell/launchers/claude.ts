/**
 * Claude Code shell launcher — spawns the `claude` CLI in interactive mode
 * with the Dispatch MCP server injected via stdio subprocess.
 *
 * SDK bridgeable: NO — Claude SDK creates API sessions separate from the CLI.
 *
 * Key flags:
 *   --dangerously-skip-permissions   Auto-accept all permissions
 *   --mcp-config <file>              Load MCP servers from JSON file
 *   [prompt]                         Positional arg starts interactive session with prompt
 */

import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ShellLauncher, ShellLaunchResult, ShellLauncherOptions } from "../launcher-interface.js";

export const launchClaude: ShellLauncher = async (opts: ShellLauncherOptions): Promise<ShellLaunchResult> => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dispatch-mcp-"));
  const configPath = join(tmpDir, "mcp.json");

  const mcpConfig = {
    mcpServers: {
      dispatch: {
        command: "dispatch",
        args: ["mcp", "--cwd", opts.cwd],
      },
    },
  };

  await writeFile(configPath, JSON.stringify(mcpConfig, null, 2));

  const args: string[] = [
    "--dangerously-skip-permissions",
    "--mcp-config", configPath,
  ];

  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  // Positional arg for interactive mode (NOT --prompt which is non-interactive)
  if (opts.initialPrompt) {
    args.push(opts.initialPrompt);
  }

  const child = spawn("claude", args, {
    cwd: opts.cwd,
    stdio: "inherit",
    env: { ...process.env },
  });

  return {
    process: child,
    sdkBridgeable: false,
    cleanup: async () => {
      try {
        await unlink(configPath);
        const { rmdir } = await import("node:fs/promises");
        await rmdir(tmpDir);
      } catch { /* best effort */ }
    },
  };
};
