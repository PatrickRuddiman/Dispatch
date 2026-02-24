/**
 * Orchestrator — the core loop that drives the dispatch pipeline:
 *   1. Glob for task files
 *   2. Parse unchecked tasks
 *   3. Dispatch each to OpenCode in an isolated session
 *   4. Mark complete in markdown
 *   5. Commit with conventional commits
 */

import { glob } from "glob";
import { parseTaskFile, markTaskComplete, type Task, type TaskFile } from "./parser.js";
import { bootOpencode, dispatchTask, type DispatchResult } from "./dispatcher.js";
import { planTask } from "./planner.js";
import { commitTask } from "./git.js";
import { log } from "./logger.js";
import { createTui, type TaskState } from "./tui.js";

export interface DispatchOptions {
  pattern: string;
  cwd: string;
  concurrency: number;
  dryRun: boolean;
  serverUrl?: string;
  /** Skip the planner agent and dispatch tasks directly */
  noPlan?: boolean;
}

export interface DispatchSummary {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  results: DispatchResult[];
}

export async function orchestrate(opts: DispatchOptions): Promise<DispatchSummary> {
  const { pattern, cwd, concurrency, dryRun, serverUrl, noPlan } = opts;

  // Dry-run mode uses simple log output
  if (dryRun) {
    return dryRunMode(pattern, cwd);
  }

  // ── Start TUI ───────────────────────────────────────────────
  const tui = createTui();

  try {
    // ── 1. Discover task files ──────────────────────────────────
    tui.state.phase = "discovering";
    const files = await glob(pattern, { cwd, absolute: true });

    if (files.length === 0) {
      tui.state.phase = "done";
      tui.stop();
      log.warn("No files matched the pattern: " + pattern);
      return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
    }
    tui.state.filesFound = files.length;

    // ── 2. Parse all tasks ──────────────────────────────────────
    tui.state.phase = "parsing";
    const taskFiles: TaskFile[] = [];

    for (const file of files) {
      const tf = await parseTaskFile(file);
      if (tf.tasks.length > 0) {
        taskFiles.push(tf);
      }
    }

    const allTasks = taskFiles.flatMap((tf) => tf.tasks);

    if (allTasks.length === 0) {
      tui.state.phase = "done";
      tui.stop();
      log.warn("No unchecked tasks found");
      return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
    }

    // Populate TUI task list
    tui.state.tasks = allTasks.map((task) => ({
      task,
      status: "pending" as const,
    }));

    // ── 3. Boot OpenCode ────────────────────────────────────────
    tui.state.phase = "booting";
    const instance = await bootOpencode({ url: serverUrl });
    if (serverUrl) {
      tui.state.serverUrl = serverUrl;
    }

    // ── 4. Dispatch tasks ───────────────────────────────────────
    tui.state.phase = "dispatching";
    const results: DispatchResult[] = [];
    let completed = 0;
    let failed = 0;

    const queue = [...allTasks];

    while (queue.length > 0) {
      const batch = queue.splice(0, concurrency);
      const batchResults = await Promise.all(
        batch.map(async (task) => {
          const tuiTask = tui.state.tasks.find((t) => t.task === task)!;
          const startTime = Date.now();
          tuiTask.elapsed = startTime;

          // ── Phase A: Plan (unless --no-plan) ─────────────────
          let plan: string | undefined;
          if (!noPlan) {
            tuiTask.status = "planning";
            const planResult = await planTask(instance, task, cwd);

            if (!planResult.success) {
              tuiTask.status = "failed";
              tuiTask.error = `Planning failed: ${planResult.error}`;
              tuiTask.elapsed = Date.now() - startTime;
              failed++;
              return { task, success: false, error: tuiTask.error } as DispatchResult;
            }

            plan = planResult.prompt;
          }

          // ── Phase B: Execute ─────────────────────────────────
          tuiTask.status = "running";
          const result = await dispatchTask(instance, task, cwd, plan);

          if (result.success) {
            await markTaskComplete(task);
            await commitTask(task, cwd);
            tuiTask.status = "done";
            tuiTask.elapsed = Date.now() - startTime;
            completed++;
          } else {
            tuiTask.status = "failed";
            tuiTask.error = result.error;
            tuiTask.elapsed = Date.now() - startTime;
            failed++;
          }

          return result;
        })
      );

      results.push(...batchResults);
    }

    // ── 5. Cleanup ──────────────────────────────────────────────
    if (instance.cleanup) {
      await instance.cleanup();
    }

    tui.state.phase = "done";
    tui.stop();

    return { total: allTasks.length, completed, failed, skipped: 0, results };
  } catch (err) {
    tui.stop();
    throw err;
  }
}

async function dryRunMode(
  pattern: string,
  cwd: string
): Promise<DispatchSummary> {
  const files = await glob(pattern, { cwd, absolute: true });

  if (files.length === 0) {
    log.warn("No files matched the pattern: " + pattern);
    return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
  }

  const taskFiles: TaskFile[] = [];
  for (const file of files) {
    const tf = await parseTaskFile(file);
    if (tf.tasks.length > 0) {
      taskFiles.push(tf);
    }
  }

  const allTasks = taskFiles.flatMap((tf) => tf.tasks);

  if (allTasks.length === 0) {
    log.warn("No unchecked tasks found");
    return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
  }

  log.info(`Dry run — ${allTasks.length} task(s) across ${taskFiles.length} file(s):\n`);
  for (const task of allTasks) {
    log.task(allTasks.indexOf(task), allTasks.length, `${task.file}:${task.line} — ${task.text}`);
  }

  return {
    total: allTasks.length,
    completed: 0,
    failed: 0,
    skipped: allTasks.length,
    results: [],
  };
}
