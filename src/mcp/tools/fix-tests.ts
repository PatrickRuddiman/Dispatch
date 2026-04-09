/**
 * MCP tool: fix_tests
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRun } from "../state/manager.js";
import { PROVIDER_NAMES } from "../../providers/interface.js";
import { DATASOURCE_NAMES } from "../../datasources/interface.js";
import { forkDispatchRun } from "./_fork-run.js";
import { loadMcpConfig } from "./_resolve-config.js";

export function registerFixTestsTools(server: McpServer, cwd: string): void {
  server.tool(
    "fix_tests",
    "Run tests, detect failures, and dispatch an AI agent to fix them. Optionally target specific issue branches via worktrees.",
    {
      issueIds: z.array(z.string()).optional().describe("Issue IDs to run fix-tests on specific branches (omit to run in current directory)"),
      provider: z.enum(PROVIDER_NAMES).optional().describe("Agent provider (default: from config)"),
      source: z.enum(DATASOURCE_NAMES).optional().describe("Issue datasource: github, azdevops, md (default: from config)"),
      testTimeout: z.number().int().min(1).optional().describe("Test command timeout in minutes"),
    },
    async (args) => {
      let config;
      try {
        config = await loadMcpConfig(cwd, { provider: args.provider, source: args.source });
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      const runId = createRun({ cwd, issueIds: args.issueIds ?? [] });

      forkDispatchRun(runId, server, {
        type: "fix-tests",
        cwd,
        opts: {
          issueIds: args.issueIds,
          provider: config.provider,
          source: config.source,
          org: config.org,
          project: config.project,
          testTimeout: args.testTimeout ?? config.testTimeout,
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ runId, status: "running" }) }],
      };
    }
  );
}
