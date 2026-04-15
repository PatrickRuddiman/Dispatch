/**
 * Forks a dispatch-worker child process and wires:
 * - IPC messages -> DB updates (createTask, updateTaskStatus, updateRunCounters, finishRun)
 * - IPC messages -> log callback notifications
 * - Periodic heartbeat (every 30s)
 * - Cleanup on exit
 *
 * This module is transport-agnostic — it accepts a plain logCallback instead
 * of an McpServer reference, so both MCP and CLI can use it.
 */

import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createTask, updateTaskStatus, updateRunCounters, finishRun, finishSpecRun,
  emitLog,
} from "../mcp/state/manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// When bundled by tsup, this file is inlined into dist/cli.js (__dirname = dist/).
// The worker lives at dist/mcp/dispatch-worker.js, so try multiple possible locations.
const WORKER_PATH = [
  join(__dirname, "mcp", "dispatch-worker.js"),       // bundled: __dirname = dist/
  join(__dirname, "..", "mcp", "dispatch-worker.js"),  // unbundled: __dirname = dist/queue/
  join(__dirname, "..", "dispatch-worker.js"),          // legacy unbundled: __dirname = dist/mcp/tools/
].find((p) => existsSync(p)) ?? join(__dirname, "mcp", "dispatch-worker.js");
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Callback for log messages emitted during a run. */
export type LogCallback = (message: string, level?: "info" | "warn" | "error") => void;

export interface ForkRunOptions {
  /** Called when the worker sends a "done" message. */
  onDone?: (result: Record<string, unknown>) => void;
  /** Called when the worker process exits (after internal cleanup). */
  onExit?: (code: number | null) => void;
  /** Optional log callback wired before forking. */
  logCallback?: LogCallback;
  /** Which DB table this run belongs to — determines how errors and results are finalized. */
  runType?: "runs" | "spec_runs";
}

export function forkDispatchRun(
  runId: string,
  workerMessage: Record<string, unknown>,
  options?: ForkRunOptions,
): ChildProcess {
  // 1. Verify the compiled worker exists before attempting to fork
  if (!existsSync(WORKER_PATH)) {
    throw new Error(
      `Dispatch worker not found at ${WORKER_PATH}. Run 'npm run build' to compile the project before using MCP tools.`,
    );
  }

  // 2. Fork worker
  const worker = fork(WORKER_PATH, [], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  worker.send(workerMessage);

  // 3. Heartbeat
  const heartbeat = setInterval(() => {
    emitLog(runId, `Run ${runId} still in progress...`);
  }, HEARTBEAT_INTERVAL_MS);

  // 4. Handle IPC messages
  worker.on("message", (msg: Record<string, unknown>) => {
    const msgType = msg["type"] as string;
    switch (msgType) {
      case "progress": {
        const event = msg["event"] as Record<string, unknown>;
        const eventType = event["type"] as string;
        switch (eventType) {
          case "task_start":
            createTask({
              runId,
              taskId: event["taskId"] as string,
              taskText: event["taskText"] as string,
              file: (event["file"] as string) ?? (event["taskId"] as string).split(":")[0] ?? "",
              line: (event["line"] as number) ?? parseInt((event["taskId"] as string).split(":")[1] ?? "0", 10),
            });
            updateTaskStatus(runId, event["taskId"] as string, "running");
            emitLog(runId, `Task started: ${event["taskText"] as string}`);
            break;
          case "task_done":
            updateTaskStatus(runId, event["taskId"] as string, "success");
            emitLog(runId, `Task done: ${event["taskText"] as string}`);
            break;
          case "task_failed":
            updateTaskStatus(runId, event["taskId"] as string, "failed", { error: event["error"] as string });
            emitLog(runId, `Task failed: ${event["taskText"] as string} — ${event["error"] as string}`, "error");
            break;
          case "phase_change":
            emitLog(runId, (event["message"] as string) ?? `Phase: ${event["phase"] as string}`);
            break;
          case "log":
            emitLog(runId, event["message"] as string);
            break;
        }
        break;
      }
      case "spec_progress": {
        const event = msg["event"] as Record<string, unknown>;
        const eventType = event["type"] as string;
        switch (eventType) {
          case "item_start":
            emitLog(runId, `Generating spec for: ${(event["itemTitle"] as string) ?? (event["itemId"] as string)}`);
            break;
          case "item_done":
            emitLog(runId, `Spec done: ${(event["itemTitle"] as string) ?? (event["itemId"] as string)}`);
            break;
          case "item_failed":
            emitLog(runId, `Spec failed: ${(event["itemTitle"] as string) ?? (event["itemId"] as string)} — ${event["error"] as string}`, "error");
            break;
          case "log":
            emitLog(runId, event["message"] as string);
            break;
        }
        break;
      }
      case "done": {
        const result = msg["result"] as Record<string, unknown>;
        if (options?.onDone) {
          options.onDone(result);
        } else if ("completed" in result) {
          // Dispatch result
          updateRunCounters(runId, result["total"] as number, result["completed"] as number, result["failed"] as number);
          finishRun(runId, (result["failed"] as number) > 0 ? "failed" : "completed");
          emitLog(runId, `Dispatch complete: ${result["completed"] as number}/${result["total"] as number} tasks succeeded`);
        } else if ("generated" in result) {
          // Spec result
          const total = result["total"] as number;
          const generated = result["generated"] as number;
          const failed = result["failed"] as number;
          finishSpecRun(runId, failed > 0 ? "failed" : "completed", { total, generated, failed });
          emitLog(runId, `Spec complete: ${generated}/${total} specs generated`);
        }
        break;
      }
      case "error": {
        const errorMsg = msg["message"] as string;
        if (options?.runType === "spec_runs") {
          finishSpecRun(runId, "failed", { total: 0, generated: 0, failed: 0 }, errorMsg);
        } else {
          finishRun(runId, "failed", errorMsg);
        }
        emitLog(runId, `Run error: ${errorMsg}`, "error");
        break;
      }
    }
  });

  // 5. Cleanup on exit
  worker.on("exit", (code) => {
    clearInterval(heartbeat);
    if (code !== 0 && code !== null) {
      const exitError = `Worker process exited with code ${code}`;
      if (options?.runType === "spec_runs") {
        finishSpecRun(runId, "failed", { total: 0, generated: 0, failed: 0 }, exitError);
      } else {
        finishRun(runId, "failed", exitError);
      }
      emitLog(runId, `Worker process exited unexpectedly (code ${code})`, "error");
    }
    options?.onExit?.(code);
  });

  return worker;
}
