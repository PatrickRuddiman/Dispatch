/**
 * MCP tool: config_get
 */

import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../../config.js";

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
}
