/**
 * MCP tools: config_get, config_set
 */

import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, saveConfig, validateConfigValue, CONFIG_KEYS, type ConfigKey } from "../../config.js";

/** Config keys that store numeric values. */
const NUMERIC_KEYS: ConfigKey[] = ["testTimeout", "planTimeout", "specTimeout", "specWarnTimeout", "specKillTimeout", "concurrency"];

export function registerConfigTools(server: McpServer, cwd: string): void {
  server.tool(
    "config_get",
    "Get the current Dispatch configuration from .dispatch/config.json.",
    {},
    async () => {
      const config = await loadConfig(join(cwd, ".dispatch"));
      // Exclude nextIssueId — internal counter, not useful for the agent
      const { nextIssueId: _, ...safeConfig } = config;
      return {
        content: [{ type: "text", text: JSON.stringify(safeConfig) }],
      };
    }
  );

  server.tool(
    "config_set",
    "Set a Dispatch configuration value in .dispatch/config.json.",
    {
      key: z.enum(CONFIG_KEYS).describe("Configuration key to set"),
      value: z.string().describe("Value to set (strings, numbers as string, provider/source names)"),
    },
    async (args) => {
      if (args.key === "agents") {
        return {
          content: [{ type: "text", text: "The 'agents' key requires object-level configuration. Edit .dispatch/config.json directly or use 'dispatch config'." }],
          isError: true,
        };
      }

      const validationError = validateConfigValue(args.key, args.value);
      if (validationError) {
        return {
          content: [{ type: "text", text: validationError }],
          isError: true,
        };
      }

      try {
        const configDir = join(cwd, ".dispatch");
        const config = await loadConfig(configDir);
        const typedValue = NUMERIC_KEYS.includes(args.key) ? Number(args.value) : args.value;
        (config as Record<string, unknown>)[args.key] = typedValue;
        await saveConfig(config, configDir);

        const { nextIssueId: _, ...safeConfig } = config;
        return {
          content: [{ type: "text", text: JSON.stringify({ updated: { [args.key]: typedValue }, config: safeConfig }) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
