/**
 * Copilot shell launcher — spawns the `copilot` CLI in interactive mode
 * with the Dispatch MCP server injected via stdio subprocess.
 *
 * SDK bridgeable: YES — Copilot CLI starts an HTTP server that the SDK
 * can connect to via CopilotClient({ cliUrl }).
 *
 * Key flags:
 *   --allow-all                      Auto-accept all permissions
 *   --additional-mcp-config @<file>  Load additional MCP servers from JSON file
 *   --model <model>                  Set AI model
 */

import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ShellLauncher, ShellLaunchResult, ShellLauncherOptions } from "../launcher-interface.js";

export const launchCopilot: ShellLauncher = async (opts: ShellLauncherOptions): Promise<ShellLaunchResult> => {
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
    "--allow-all",
    "--additional-mcp-config", `@${configPath}`,
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  const child = spawn("copilot", args, {
    cwd: opts.cwd,
    stdio: "inherit",
    env: { ...process.env },
  });

  return {
    process: child,
    sdkBridgeable: true,
    cleanup: async () => {
      try {
        await unlink(configPath);
        const { rmdir } = await import("node:fs/promises");
        await rmdir(tmpDir);
      } catch { /* best effort */ }
    },
  };
};
