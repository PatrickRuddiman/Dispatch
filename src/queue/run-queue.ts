/**
 * SQLite-backed run queue.
 *
 * Gates how many child processes (dispatch runs + spec runs) can execute
 * simultaneously. The database is the source of truth: runs are inserted
 * with status "queued", and the RunQueue drains them into forked child
 * processes as slots become available.
 *
 * This module is transport-agnostic — both MCP and CLI can use it.
 */

import { forkDispatchRun, type ForkRunOptions, type LogCallback } from "./fork-run.js";
import {
  countActiveRuns,
  getNextQueued,
  markRunStarted,
  markSpecRunStarted,
  failAllQueuedRuns,
  emitLog,
  addLogCallback,
} from "../mcp/state/manager.js";

/**
 * Per-run metadata kept in memory so we can fork with the right callbacks
 * (not serializable to DB).
 */
interface RunContext {
  logCallback?: LogCallback;
  options?: ForkRunOptions;
}

export class RunQueue {
  private readonly limit: number;
  /** In-memory map of runId → context needed to fork (callbacks). */
  private readonly contexts = new Map<string, RunContext>();

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  /**
   * Enqueue a run for execution. The run must already exist in the DB with
   * status "queued" and a serialized workerMessage.
   *
   * If a slot is available the run is forked immediately; otherwise it waits
   * in the DB queue until a running child exits.
   */
  enqueue(runId: string, logCallback?: LogCallback, options?: ForkRunOptions): void {
    this.contexts.set(runId, { logCallback, options });
    // Wire the log callback into the live-run registry so emitLog() reaches it
    if (logCallback) {
      addLogCallback(runId, logCallback);
    }
    this.drain();
  }

  /**
   * Drain the queue: fork queued runs while slots are available.
   * Called on enqueue and whenever a child process exits.
   */
  drain(): void {
    let active = countActiveRuns();

    while (active < this.limit) {
      const next = getNextQueued();
      if (!next) break;

      const { runId, workerMessage, table } = next;

      // Transition to "running" in the DB
      if (table === "runs") {
        markRunStarted(runId);
      } else {
        markSpecRunStarted(runId);
      }

      // Deserialize the worker message
      let parsedMessage: Record<string, unknown>;
      try {
        parsedMessage = JSON.parse(workerMessage) as Record<string, unknown>;
      } catch {
        emitLog(runId, `Failed to parse queued worker message`, "error");
        continue;
      }

      // Retrieve in-memory context (callbacks)
      const ctx = this.contexts.get(runId);
      if (!ctx) {
        // This can happen if the server restarted — the DB has queued runs
        // but we lost the in-memory context. These runs were already
        // marked failed by markOrphanedRunsFailed() on startup.
        continue;
      }
      this.contexts.delete(runId);

      emitLog(runId, `Run started (${active + 1}/${this.limit} slots used)`);

      // Fork the child process
      const userOnExit = ctx.options?.onExit;
      forkDispatchRun(runId, parsedMessage, {
        ...ctx.options,
        runType: table,
        logCallback: ctx.logCallback,
        onExit: (code) => {
          userOnExit?.(code);
          // When a child exits, try to drain the next queued run
          this.drain();
        },
      });

      active++;
    }
  }

  /** Mark all queued runs as failed (for graceful shutdown). */
  abort(): void {
    failAllQueuedRuns();
    this.contexts.clear();
  }

  /** Current concurrency limit. */
  get maxRuns(): number {
    return this.limit;
  }
}

// ── Singleton ────────────────────────────────────────────────

let _queue: RunQueue | null = null;

/** Initialize the global RunQueue. Call once during startup. */
export function initRunQueue(limit: number): void {
  _queue = new RunQueue(limit);
}

/** Get the global RunQueue instance. */
export function getRunQueue(): RunQueue {
  if (!_queue) {
    throw new Error("RunQueue not initialized. Call initRunQueue(limit) first.");
  }
  return _queue;
}

/** Reset the singleton (for testing). */
export function resetRunQueue(): void {
  _queue = null;
}
