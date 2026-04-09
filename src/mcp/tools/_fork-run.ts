/**
 * Forks a dispatch-worker child process and wires:
 * - IPC messages -> DB updates (createTask, updateTaskStatus, updateRunCounters, finishRun)
 * - IPC messages -> MCP logging notifications (via addLogCallback)
 * - Periodic heartbeat (every 30s)
 * - Cleanup on exit
 */

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createTask, updateTaskStatus, updateRunCounters, finishRun,
  emitLog,
} from "../state/manager.js";
import { wireRunLogs } from "../server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_PATH = join(__dirname, "..", "dispatch-worker.js");
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface ForkRunOptions {
  /** Called when the worker sends a "done" message. */
  onDone?: (result: Record<string, unknown>) => void;
}

export function forkDispatchRun(
  runId: string,
  server: McpServer,
  workerMessage: Record<string, unknown>,
  options?: ForkRunOptions,
): ChildProcess {
  // 1. Wire push notifications (reuse the existing helper from server.ts)
  wireRunLogs(runId, server);

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
        } else if ("mode" in result && result["mode"] === "fix-tests") {
          // Fix-tests result
          const success = result["success"] as boolean;
          finishRun(runId, success ? "completed" : "failed", success ? undefined : (result["error"] as string));
          emitLog(runId, `Fix-tests ${success ? "completed successfully" : "failed"}`);
        } else if ("completed" in result) {
          // Dispatch result
          updateRunCounters(runId, result["total"] as number, result["completed"] as number, result["failed"] as number);
          finishRun(runId, (result["failed"] as number) > 0 ? "failed" : "completed");
          emitLog(runId, `Dispatch complete: ${result["completed"] as number}/${result["total"] as number} tasks succeeded`);
        }
        break;
      }
      case "error": {
        finishRun(runId, "failed", msg["message"] as string);
        emitLog(runId, `Run error: ${msg["message"] as string}`, "error");
        break;
      }
    }
  });

  // 5. Cleanup on exit
  worker.on("exit", (code) => {
    clearInterval(heartbeat);
    if (code !== 0 && code !== null) {
      finishRun(runId, "failed", `Worker process exited with code ${code}`);
      emitLog(runId, `Worker process exited unexpectedly (code ${code})`, "error");
    }
  });

  return worker;
}
