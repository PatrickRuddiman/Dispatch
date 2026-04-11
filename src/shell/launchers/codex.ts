/**
 * Codex shell launcher — spawns the `codex` CLI in full-auto mode
 * with the Dispatch MCP server registered.
 *
 * SDK bridgeable: NO — Codex SDK uses OpenAI API directly, no shared server.
 *
 * Key flags:
 *   -a never           Never ask for user approval (full auto)
 *   -m <model>         Model override
 *   [PROMPT]           Positional prompt arg
 *
 * MCP injection: Uses `codex mcp add` before launch to register the server.
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ShellLauncher, ShellLaunchResult, ShellLauncherOptions } from "../launcher-interface.js";

const exec = promisify(execFile);

export const launchCodex: ShellLauncher = async (opts: ShellLauncherOptions): Promise<ShellLaunchResult> => {
  // Register the Dispatch MCP server with Codex
  try {
    await exec("codex", [
      "mcp", "add", "dispatch", "--",
      "dispatch", "mcp", "--cwd", opts.cwd,
    ], { timeout: 10_000 });
  } catch {
    // May already be registered — continue
  }

  const args: string[] = [
    "-a", "never",
  ];

  if (opts.model) {
    args.push("-m", opts.model);
  }

  if (opts.initialPrompt) {
    args.push(opts.initialPrompt);
  }

  const child = spawn("codex", args, {
    cwd: opts.cwd,
    stdio: "inherit",
    env: { ...process.env },
  });

  return {
    process: child,
    sdkBridgeable: false,
    cleanup: async () => {
      try {
        await exec("codex", ["mcp", "remove", "dispatch"], { timeout: 10_000 });
      } catch { /* best effort */ }
    },
  };
};
