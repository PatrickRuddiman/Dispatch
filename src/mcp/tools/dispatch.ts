/**
 * MCP tools: dispatch_run, dispatch_dry_run
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { boot as bootOrchestrator } from "../../orchestrator/runner.js";
import { createRun } from "../state/manager.js";
import { PROVIDER_NAMES } from "../../providers/interface.js";
import { DATASOURCE_NAMES } from "../../datasources/interface.js";
import { forkDispatchRun } from "./_fork-run.js";

export function registerDispatchTools(server: McpServer, cwd: string): void {
  // ── dispatch_run ──────────────────────────────────────────────
  server.tool(
    "dispatch_run",
    "Execute dispatch pipeline for one or more issue IDs. Returns a runId immediately; progress is pushed via logging notifications.",
    {
      issueIds: z.array(z.string()).min(1).describe("Issue IDs to dispatch (e.g. ['42', '43'])"),
      provider: z.enum(PROVIDER_NAMES).optional().describe("Agent provider (default: opencode)"),
      source: z.enum(DATASOURCE_NAMES).optional().describe("Issue datasource: github, azdevops, md"),
      concurrency: z.number().int().min(1).max(32).optional().describe("Max parallel tasks"),
      noPlan: z.boolean().optional().describe("Skip the planner agent"),
      noBranch: z.boolean().optional().describe("Skip branch creation and PR lifecycle"),
      noWorktree: z.boolean().optional().describe("Skip git worktree isolation"),
      retries: z.number().int().min(0).max(10).optional().describe("Retry attempts per task"),
    },
    async (args) => {
      const runId = createRun({ cwd, issueIds: args.issueIds });

      forkDispatchRun(runId, server, {
        type: "dispatch",
        cwd,
        opts: {
          issueIds: args.issueIds,
          dryRun: false,
          provider: args.provider ?? "opencode",
          source: args.source,
          concurrency: args.concurrency ?? 1,
          noPlan: args.noPlan,
          noBranch: args.noBranch,
          noWorktree: args.noWorktree,
          retries: args.retries,
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ runId, status: "running" }) }],
      };
    }
  );

  // ── dispatch_dry_run ──────────────────────────────────────────
  server.tool(
    "dispatch_dry_run",
    "Preview tasks that would be dispatched for the given issue IDs without executing anything.",
    {
      issueIds: z.array(z.string()).min(1).describe("Issue IDs to preview"),
      source: z.enum(DATASOURCE_NAMES).optional().describe("Issue datasource: github, azdevops, md"),
    },
    async (args) => {
      try {
        const orchestrator = await bootOrchestrator({ cwd });
        const result = await orchestrator.orchestrate({
          issueIds: args.issueIds,
          dryRun: true,
          source: args.source,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
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
