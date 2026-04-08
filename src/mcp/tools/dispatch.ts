/**
 * MCP tools: dispatch_run, dispatch_dry_run
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { boot as bootOrchestrator } from "../../orchestrator/runner.js";
import { createRun, finishRun, updateRunCounters, createTask, updateTaskStatus, emitLog } from "../state/manager.js";
import { buildTaskId } from "../../helpers/run-state.js";
import { PROVIDER_NAMES } from "../../providers/interface.js";
import { DATASOURCE_NAMES } from "../../datasources/interface.js";

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

      setImmediate(() => { void (async () => {
        try {
          const orchestrator = await bootOrchestrator({ cwd });
          emitLog(runId, `Starting dispatch for issues: ${args.issueIds.join(", ")}`);

          const result = await orchestrator.orchestrate({
            issueIds: args.issueIds,
            dryRun: false,
            provider: args.provider ?? "opencode",
            source: args.source,
            concurrency: args.concurrency ?? 1,
            noPlan: args.noPlan,
            noBranch: args.noBranch,
            noWorktree: args.noWorktree,
            retries: args.retries,
            progressCallback: (event) => {
              switch (event.type) {
                case "task_start":
                  emitLog(runId, `Task started: ${event.taskText}`);
                  updateTaskStatus(runId, event.taskId, "running");
                  break;
                case "task_done":
                  emitLog(runId, `Task done: ${event.taskText}`);
                  updateTaskStatus(runId, event.taskId, "success");
                  break;
                case "task_failed":
                  emitLog(runId, `Task failed: ${event.taskText} — ${event.error}`, "error");
                  updateTaskStatus(runId, event.taskId, "failed", { error: event.error });
                  break;
                case "phase_change":
                  emitLog(runId, event.message ?? `Phase: ${event.phase}`);
                  break;
                case "log":
                  emitLog(runId, event.message);
                  break;
                default: {
                  const _exhaustive: never = event;
                  void _exhaustive;
                }
              }
              updateRunCounters(
                runId,
                0, // we'll update with final counts at the end
                0,
                0,
              );
            },
          });

          updateRunCounters(runId, result.total, result.completed, result.failed);
          finishRun(runId, result.failed > 0 ? "failed" : "completed");
          emitLog(runId, `Dispatch complete: ${result.completed}/${result.total} tasks succeeded`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          finishRun(runId, "failed", msg);
          emitLog(runId, `Dispatch error: ${msg}`, "error");
        }
      })(); });

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
