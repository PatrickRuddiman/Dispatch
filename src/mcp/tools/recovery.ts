/**
 * MCP tools: task_retry, run_retry
 *
 * These tools allow an MCP client to retry a failed task or re-run
 * all failed tasks from a dispatch run.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRun, getTasksForRun, createRun, finishRun, updateRunCounters, updateTaskStatus, emitLog } from "../state/manager.js";
import { boot as bootOrchestrator } from "../../orchestrator/runner.js";
import { loadConfig } from "../../config.js";
import { join } from "node:path";

export function registerRecoveryTools(server: McpServer, cwd: string): void {
  // ── run_retry ─────────────────────────────────────────────────
  server.tool(
    "run_retry",
    "Re-run all failed tasks from a previous dispatch run. Returns a new runId.",
    {
      runId: z.string().describe("The original runId to retry failed tasks from"),
      provider: z.string().optional().describe("Agent provider (default: from config)"),
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

      if (failedTasks.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ message: "No failed tasks found", originalRunId: args.runId }) }],
        };
      }

      const config = await loadConfig(join(cwd, ".dispatch"));
      const issueIds = JSON.parse(originalRun.issueIds) as string[];
      const newRunId = createRun({ cwd, issueIds });

      setImmediate(async () => {
        try {
          const orchestrator = await bootOrchestrator({ cwd });
          emitLog(newRunId, `Retrying ${failedTasks.length} failed task(s) from run ${args.runId}`);

          const result = await orchestrator.orchestrate({
            issueIds,
            dryRun: false,
            provider: (args.provider as any) ?? config.provider ?? "opencode",
            source: config.source as any,
            concurrency: args.concurrency ?? config.concurrency ?? 1,
            force: true, // re-run even previously completed tasks? No — force just skips run-state check
            progressCallback: (event) => {
              if (event.type === "task_start") {
                emitLog(newRunId, `Task started: ${event.taskText}`);
                if (event.taskId) updateTaskStatus(newRunId, event.taskId, "running");
              } else if (event.type === "task_done") {
                emitLog(newRunId, `Task done: ${event.taskText}`);
                if (event.taskId) updateTaskStatus(newRunId, event.taskId, "success");
              } else if (event.type === "task_failed") {
                emitLog(newRunId, `Task failed: ${event.taskText} — ${event.error}`, "error");
                if (event.taskId) updateTaskStatus(newRunId, event.taskId, "failed", { error: event.error });
              }
            },
          });

          updateRunCounters(newRunId, result.total, result.completed, result.failed);
          finishRun(newRunId, result.failed > 0 ? "failed" : "completed");
          emitLog(newRunId, `Retry complete: ${result.completed}/${result.total} succeeded`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          finishRun(newRunId, "failed", msg);
          emitLog(newRunId, `Retry error: ${msg}`, "error");
        }
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
      provider: z.string().optional(),
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

      const config = await loadConfig(join(cwd, ".dispatch"));
      const issueIds = JSON.parse(originalRun.issueIds) as string[];
      const newRunId = createRun({ cwd, issueIds });

      setImmediate(async () => {
        try {
          const orchestrator = await bootOrchestrator({ cwd });
          emitLog(newRunId, `Retrying task: ${task.taskText}`);

          const result = await orchestrator.orchestrate({
            issueIds,
            dryRun: false,
            provider: (args.provider as any) ?? config.provider ?? "opencode",
            source: config.source as any,
            concurrency: 1,
            force: true,
            progressCallback: (event) => {
              if (event.type === "task_start") {
                emitLog(newRunId, `Task started: ${event.taskText}`);
              } else if (event.type === "task_done") {
                emitLog(newRunId, `Task done: ${event.taskText}`);
              } else if (event.type === "task_failed") {
                emitLog(newRunId, `Task failed: ${event.taskText} — ${event.error}`, "error");
              }
            },
          });

          updateRunCounters(newRunId, result.total, result.completed, result.failed);
          finishRun(newRunId, result.failed > 0 ? "failed" : "completed");
          emitLog(newRunId, `Task retry complete`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          finishRun(newRunId, "failed", msg);
          emitLog(newRunId, `Task retry error: ${msg}`, "error");
        }
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ runId: newRunId, status: "running", taskId: args.taskId }) }],
      };
    }
  );
}
