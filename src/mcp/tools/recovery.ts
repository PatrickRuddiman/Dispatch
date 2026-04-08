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
import { PROVIDER_NAMES } from "../../providers/interface.js";

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

      if (failedTasks.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ message: "No failed tasks found", originalRunId: args.runId }) }],
        };
      }

      const config = await loadConfig(join(cwd, ".dispatch"));
      const issueIds = issueIdsSchema.parse(JSON.parse(originalRun.issueIds));
      const newRunId = createRun({ cwd, issueIds });

      setImmediate(() => { void (async () => {
        try {
          const orchestrator = await bootOrchestrator({ cwd });
          emitLog(newRunId, `Retrying ${failedTasks.length} failed task(s) from run ${args.runId}`);

          const result = await orchestrator.orchestrate({
            issueIds,
            dryRun: false,
            provider: args.provider ?? config.provider ?? "opencode",
            source: config.source,
            concurrency: args.concurrency ?? config.concurrency ?? 1,
            force: true, // re-run even previously completed tasks? No — force just skips run-state check
            progressCallback: (event) => {
              switch (event.type) {
                case "task_start":
                  emitLog(newRunId, `Task started: ${event.taskText}`);
                  updateTaskStatus(newRunId, event.taskId, "running");
                  break;
                case "task_done":
                  emitLog(newRunId, `Task done: ${event.taskText}`);
                  updateTaskStatus(newRunId, event.taskId, "success");
                  break;
                case "task_failed":
                  emitLog(newRunId, `Task failed: ${event.taskText} — ${event.error}`, "error");
                  updateTaskStatus(newRunId, event.taskId, "failed", { error: event.error });
                  break;
                case "phase_change":
                  emitLog(newRunId, event.message ?? `Phase: ${event.phase}`);
                  break;
                case "log":
                  emitLog(newRunId, event.message);
                  break;
                default: {
                  const _exhaustive: never = event;
                  void _exhaustive;
                }
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
      })(); });

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

      const config = await loadConfig(join(cwd, ".dispatch"));
      const issueIds = issueIdsSchema.parse(JSON.parse(originalRun.issueIds));
      const newRunId = createRun({ cwd, issueIds });

      setImmediate(() => { void (async () => {
        try {
          const orchestrator = await bootOrchestrator({ cwd });
          emitLog(newRunId, `Retrying task: ${task.taskText}`);

          const result = await orchestrator.orchestrate({
            issueIds,
            dryRun: false,
            provider: args.provider ?? config.provider ?? "opencode",
            source: config.source,
            concurrency: 1,
            force: true,
            progressCallback: (event) => {
              switch (event.type) {
                case "task_start":
                  emitLog(newRunId, `Task started: ${event.taskText}`);
                  break;
                case "task_done":
                  emitLog(newRunId, `Task done: ${event.taskText}`);
                  break;
                case "task_failed":
                  emitLog(newRunId, `Task failed: ${event.taskText} — ${event.error}`, "error");
                  break;
                case "phase_change":
                  emitLog(newRunId, event.message ?? `Phase: ${event.phase}`);
                  break;
                case "log":
                  emitLog(newRunId, event.message);
                  break;
                default: {
                  const _exhaustive: never = event;
                  void _exhaustive;
                }
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
      })(); });

      return {
        content: [{ type: "text", text: JSON.stringify({ runId: newRunId, status: "running", taskId: args.taskId }) }],
      };
    }
  );
}
