/**
 * MCP tools: task_retry, run_retry
 *
 * These tools allow an MCP client to retry a failed task or re-run
 * all failed tasks from a dispatch run.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRun, getTasksForRun, createRun } from "../state/manager.js";
import { PROVIDER_NAMES } from "../../providers/interface.js";
import { forkDispatchRun } from "./_fork-run.js";
import { loadMcpConfig } from "./_resolve-config.js";
import { parseIssueFilename } from "../../orchestrator/datasource-helpers.js";

const issueIdsSchema = z.array(z.string());

export function registerRecoveryTools(server: McpServer, cwd: string): void {
  // ── run_retry ─────────────────────────────────────────────────
  server.tool(
    "run_retry",
    "Re-run all failed tasks from a previous dispatch run. Returns a new runId.",
    {
      runId: z.string().describe("The original runId to retry failed tasks from"),
      provider: z.enum(PROVIDER_NAMES).optional().describe("Agent provider (default: from config)"),
      concurrency: z.number().int().min(1).max(32).optional(),
    },
    async (args) => {
      const originalRun = getRun(args.runId);
      if (!originalRun) {
        return {
          content: [{ type: "text", text: `Run ${args.runId} not found` }],
          isError: true,
        };
      }

      const tasks = getTasksForRun(args.runId);
      const failedTasks = tasks.filter((t) => t.status === "failed");

      // A run can fail before any tasks are created (e.g. boot/config error).
      // In that case, re-dispatch using the original issueIds rather than
      // returning "No failed tasks" — only skip retry for successful runs.
      if (failedTasks.length === 0 && originalRun.status !== "failed") {
        return {
          content: [{ type: "text", text: JSON.stringify({ message: "No failed tasks found", originalRunId: args.runId }) }],
        };
      }

      let config;
      try {
        config = await loadMcpConfig(cwd, { provider: args.provider });
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      const allIssueIds = issueIdsSchema.parse(JSON.parse(originalRun.issueIds));

      // Only re-dispatch issues that actually failed, not the entire original set.
      // Fall back to all IDs when the run failed before any tasks were created.
      let issueIds: string[];
      if (failedTasks.length === 0) {
        issueIds = allIssueIds;
      } else {
        const failedIssueIds = new Set<string>();
        for (const t of failedTasks) {
          const parsed = parseIssueFilename(t.file || t.taskId.split(":")[0]);
          if (parsed) failedIssueIds.add(parsed.issueId);
        }
        issueIds = failedIssueIds.size > 0 ? [...failedIssueIds] : allIssueIds;
      }

      const newRunId = createRun({ cwd, issueIds });

      forkDispatchRun(newRunId, server, {
        type: "dispatch",
        cwd,
        opts: {
          issueIds,
          dryRun: false,
          provider: config.provider,
          model: config.model,
          fastProvider: config.fastProvider,
          fastModel: config.fastModel,
          agents: config.agents,
          source: config.source,
          org: config.org,
          project: config.project,
          workItemType: config.workItemType,
          iteration: config.iteration,
          area: config.area,
          username: config.username,
          planTimeout: config.planTimeout,
          concurrency: args.concurrency ?? config.concurrency ?? 1,
          force: true,
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ runId: newRunId, status: "running", originalRunId: args.runId }) }],
      };
    }
  );

  // ── task_retry ────────────────────────────────────────────────
  server.tool(
    "task_retry",
    "Retry a specific failed task by taskId from a previous run. Returns a new runId.",
    {
      runId: z.string().describe("The original runId"),
      taskId: z.string().describe("The taskId to retry (from status_get)"),
      provider: z.enum(PROVIDER_NAMES).optional(),
    },
    async (args) => {
      const originalRun = getRun(args.runId);
      if (!originalRun) {
        return {
          content: [{ type: "text", text: `Run ${args.runId} not found` }],
          isError: true,
        };
      }

      const tasks = getTasksForRun(args.runId);
      const task = tasks.find((t) => t.taskId === args.taskId);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task ${args.taskId} not found in run ${args.runId}` }],
          isError: true,
        };
      }

      let config;
      try {
        config = await loadMcpConfig(cwd, { provider: args.provider });
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      // Extract the single issue ID from the task's file field.
      // Fall back to all original issue IDs if parsing fails.
      const allIssueIds = issueIdsSchema.parse(JSON.parse(originalRun.issueIds));
      const parsed = parseIssueFilename(task.file || task.taskId.split(":")[0]);
      const issueIds = parsed ? [parsed.issueId] : allIssueIds;

      const newRunId = createRun({ cwd, issueIds });

      forkDispatchRun(newRunId, server, {
        type: "dispatch",
        cwd,
        opts: {
          issueIds,
          dryRun: false,
          provider: config.provider,
          model: config.model,
          fastProvider: config.fastProvider,
          fastModel: config.fastModel,
          agents: config.agents,
          source: config.source,
          org: config.org,
          project: config.project,
          workItemType: config.workItemType,
          iteration: config.iteration,
          area: config.area,
          username: config.username,
          planTimeout: config.planTimeout,
          concurrency: 1,
          force: true,
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ runId: newRunId, status: "running", taskId: args.taskId }) }],
      };
    }
  );
}
