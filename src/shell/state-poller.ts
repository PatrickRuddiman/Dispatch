/**
 * StatePoller — polls the Dispatch SQLite database for run/task state
 * changes and pushes notifications via a callback (wired to provider.send()
 * by the supervisor).
 *
 * This eliminates the need for the orchestrator agent to waste tokens
 * polling monitor_run. State changes are detected by diffing snapshots
 * of the runs and tasks tables.
 */

import { listRuns, getTasksForRun } from "../mcp/state/manager.js";
import type { RunRecord } from "../mcp/state/manager.js";

/** Snapshot of a run's state for diffing. */
interface RunSnapshot {
  status: string;
  completed: number;
  failed: number;
  total: number;
  error: string | null;
}

/** Snapshot of a task's state for diffing. */
interface TaskSnapshot {
  status: string;
  error: string | null;
}

/** Callback to deliver a notification message. */
export type NotifyCallback = (message: string) => void;

export interface Poller {
  /** Stop polling. */
  stop(): void;
}

/**
 * Start polling the database for state changes and deliver notifications
 * via the provided callback.
 */
export function startStatePoller(notify: NotifyCallback, intervalMs = 5000): Poller {
  const runSnapshots = new Map<string, RunSnapshot>();
  const taskSnapshots = new Map<string, TaskSnapshot>();

  function poll() {
    try {
      const runs = listRuns(50);
      checkRunChanges(runs);
    } catch {
      // DB might not be open yet or might be mid-migration — silently skip
    }
  }

  function checkRunChanges(runs: RunRecord[]) {
    for (const run of runs) {
      const key = run.runId;
      const prev = runSnapshots.get(key);

      const current: RunSnapshot = {
        status: run.status,
        completed: run.completed,
        failed: run.failed,
        total: run.total,
        error: run.error,
      };

      if (!prev) {
        runSnapshots.set(key, current);
        if (run.status === "running") {
          snapshotTasks(run.runId);
        }
        continue;
      }

      // Detect status transitions
      if (prev.status !== current.status) {
        if (current.status === "running" && prev.status === "queued") {
          const issueIds = parseIssueIds(run.issueIds);
          notify(`[Dispatch] Run ${short(key)} started for issues ${issueIds.join(", ")}.`);
        } else if (current.status === "completed") {
          const issueIds = parseIssueIds(run.issueIds);
          notify(
            `[Dispatch] Run ${short(key)} completed: ${current.completed}/${current.total} tasks succeeded for issues ${issueIds.join(", ")}.`,
          );
        } else if (current.status === "failed") {
          const issueIds = parseIssueIds(run.issueIds);
          const errorSuffix = current.error ? ` Error: ${current.error}` : "";
          notify(
            `[Dispatch] Run ${short(key)} failed: ${current.completed}/${current.total} tasks succeeded, ${current.failed} failed for issues ${issueIds.join(", ")}.${errorSuffix}`,
          );
        }
      }

      // Detect task-level changes for running runs
      if (current.status === "running") {
        checkTaskChanges(run.runId);
      }

      runSnapshots.set(key, current);
    }
  }

  function snapshotTasks(runId: string) {
    try {
      const tasks = getTasksForRun(runId);
      for (const task of tasks) {
        taskSnapshots.set(`${runId}:${task.taskId}`, {
          status: task.status,
          error: task.error,
        });
      }
    } catch { /* ignore */ }
  }

  function checkTaskChanges(runId: string) {
    try {
      const tasks = getTasksForRun(runId);
      for (const task of tasks) {
        const key = `${runId}:${task.taskId}`;
        const prev = taskSnapshots.get(key);
        const current: TaskSnapshot = { status: task.status, error: task.error };

        if (!prev) {
          taskSnapshots.set(key, current);
          if (task.status === "running") {
            notify(`[Dispatch] Task "${task.taskText}" started in run ${short(runId)}.`);
          }
          continue;
        }

        if (prev.status !== current.status) {
          if (current.status === "success") {
            notify(`[Dispatch] Task "${task.taskText}" completed in run ${short(runId)}.`);
          } else if (current.status === "failed") {
            const errorSuffix = current.error ? ` Error: ${current.error}` : "";
            notify(
              `[Dispatch] Task "${task.taskText}" failed in run ${short(runId)}.${errorSuffix} Use recovery_retry to retry.`,
            );
          }
        }

        taskSnapshots.set(key, current);
      }
    } catch { /* ignore */ }
  }

  const timer = setInterval(poll, intervalMs);
  poll(); // initial poll

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Shorten a UUID for display. */
function short(uuid: string): string {
  return uuid.slice(0, 8);
}

/** Parse the JSON issue IDs string from a run record. */
function parseIssueIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [raw];
  }
}
