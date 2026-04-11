/**
 * OpenCode shell launcher — spawns the `opencode` CLI in interactive mode
 * with the Dispatch MCP server configured in opencode.json.
 *
 * SDK bridgeable: YES — OpenCode starts an HTTP server that the SDK
 * can connect to via createOpencodeClient({ baseUrl }).
 *
 * MCP injection: Writes to {cwd}/opencode.json to register the Dispatch
 * MCP server. Restores the original config on cleanup.
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShellLauncher, ShellLaunchResult, ShellLauncherOptions } from "../launcher-interface.js";

export const launchOpenCode: ShellLauncher = async (opts: ShellLauncherOptions): Promise<ShellLaunchResult> => {
  const configPath = join(opts.cwd, "opencode.json");

  // Read existing config (if any) so we can restore it on cleanup
  let originalConfig: string | null = null;
  let config: Record<string, unknown> = {};
  try {
    originalConfig = await readFile(configPath, "utf-8");
    config = JSON.parse(originalConfig);
  } catch {
    // No existing config — start fresh
  }

  // Inject Dispatch MCP server into the config
  const mcp = (config.mcp ?? {}) as Record<string, unknown>;
  mcp["Dispatch"] = {
    type: "local",
    command: ["dispatch", "mcp", "--cwd", opts.cwd],
    timeout: 600000,
  };
  config.mcp = mcp;

  // Ensure permissions are set to allow-all
  if (!config.permission) {
    config.permission = { "*": "allow", "question": "deny" };
  }

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const child = spawn("opencode", [opts.cwd], {
    cwd: opts.cwd,
    stdio: "inherit",
    env: { ...process.env },
  });

  return {
    process: child,
    sdkBridgeable: true,
    cleanup: async () => {
      // Restore original config
      try {
        if (originalConfig !== null) {
          await writeFile(configPath, originalConfig);
        } else {
          const current = JSON.parse(await readFile(configPath, "utf-8"));
          if (current.mcp?.Dispatch) {
            delete current.mcp.Dispatch;
            if (Object.keys(current.mcp).length === 0) delete current.mcp;
            await writeFile(configPath, JSON.stringify(current, null, 2));
          }
        }
      } catch { /* best effort */ }
    },
  };
};
