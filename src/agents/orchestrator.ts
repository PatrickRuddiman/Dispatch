/**
 * Orchestrator agent — the core loop that drives the dispatch pipeline:
 *   1. Glob for task files
 *   2. Parse unchecked tasks
 *   3. Boot the selected provider (OpenCode, Copilot, etc.)
 *   4. Plan each task via a planner agent (optional)
 *   5. Dispatch each task in an isolated session
 *   6. Mark complete in markdown
 */

import { basename, join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { glob } from "glob";
import { parseTaskFile, markTaskComplete, buildTaskContext, groupTasksByMode, type Task, type TaskFile } from "../parser.js";
import { dispatchTask, type DispatchResult } from "../dispatcher.js";
import { boot as bootPlanner } from "./planner.js";
import { log } from "../logger.js";
import { registerCleanup } from "../cleanup.js";
import { createTui, type TaskState } from "../tui.js";
import type { Agent, AgentBootOptions } from "../agent.js";
import type { ProviderName } from "../provider.js";
import { bootProvider } from "../providers/index.js";
import { getDatasource, detectDatasource } from "../datasources/index.js";
import type { DatasourceName, IssueFetchOptions } from "../datasource.js";

/**
 * Runtime options passed to `orchestrate()` — these control what gets
 * dispatched and how, separate from the agent's boot-time configuration.
 */
export interface OrchestrateRunOptions {
  /** Glob pattern(s) for task files */
  pattern: string[];
  /** Max parallel dispatches */
  concurrency: number;
  /** List tasks without executing */
  dryRun: boolean;
  /** Skip the planner agent and dispatch tasks directly */
  noPlan?: boolean;
  /** Which agent backend to use (default: "opencode") */
  provider?: ProviderName;
  /** URL of a running provider server */
  serverUrl?: string;
  /** Configured datasource name (e.g. "github", "azdevops", "md") */
  source?: DatasourceName;
  /** Azure DevOps organization URL */
  org?: string;
  /** Azure DevOps project name */
  project?: string;
}

export interface DispatchSummary {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  results: DispatchResult[];
}

/**
 * A booted orchestrator agent that coordinates the full dispatch pipeline.
 *
 * To add a new orchestrator implementation:
 *   1. Create `src/agents/<name>.ts`
 *   2. Export an async `boot` function that returns an `OrchestratorAgent`
 *   3. Register it in `src/agents/index.ts`
 */
export interface OrchestratorAgent extends Agent {
  /**
   * Run the dispatch pipeline — discover tasks, optionally plan them,
   * execute via the provider, mark complete, and commit.
   */
  orchestrate(opts: OrchestrateRunOptions): Promise<DispatchSummary>;
}

/**
 * Boot an orchestrator agent.
 */
export async function boot(opts: AgentBootOptions): Promise<OrchestratorAgent> {
  const { cwd } = opts;

  return {
    name: "orchestrator",

    async orchestrate(runOpts: OrchestrateRunOptions): Promise<DispatchSummary> {
      const {
        pattern,
        concurrency,
        dryRun,
        serverUrl,
        noPlan,
        provider = "opencode",
        source,
        org,
        project,
      } = runOpts;

      // Dry-run mode uses simple log output
      if (dryRun) {
        return dryRunMode(pattern, cwd, source, org, project);
      }

      // ── Start TUI ───────────────────────────────────────────────
      const tui = createTui();
      tui.state.provider = provider;

      try {
        // ── 1. Discover task files ──────────────────────────────────
        tui.state.phase = "discovering";
        let files: string[];

        const useDatasource = source && pattern.length === 0;

        if (useDatasource) {
          // Datasource-based discovery: list work items, fetch to temp dir
          const datasource = getDatasource(source);
          const fetchOpts: IssueFetchOptions = { cwd, org, project };
          const items = await datasource.list(fetchOpts);

          if (items.length === 0) {
            tui.state.phase = "done";
            tui.stop();
            log.warn("No work items found from datasource: " + source);
            return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
          }

          // Fetch each item to a temp directory as a markdown file
          const tempDir = await mkdtemp(join(tmpdir(), "dispatch-"));
          files = [];

          for (const item of items) {
            const slug = item.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 60);
            const filename = `${item.number}-${slug}.md`;
            const filepath = join(tempDir, filename);
            await writeFile(filepath, item.body, "utf-8");
            files.push(filepath);
          }
        } else {
          // Glob-based discovery (existing behavior)
          files = await glob(pattern, { cwd, absolute: true });
        }

        if (files.length === 0) {
          tui.state.phase = "done";
          tui.stop();
          log.warn("No files matched the pattern(s): " + pattern.join(", "));
          return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
        }

        // Sort numerically by leading digits in filename (e.g. "6-foo.md" before "11-bar.md")
        files.sort((a, b) => {
          const numA = parseInt(basename(a).match(/^(\d+)/)?.[1] ?? "0", 10);
          const numB = parseInt(basename(b).match(/^(\d+)/)?.[1] ?? "0", 10);
          if (numA !== numB) return numA - numB;
          return a.localeCompare(b);
        });

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

        // Build a lookup from file path → raw content for filtered planner context
        const fileContentMap = new Map<string, string>();
        for (const tf of taskFiles) {
          fileContentMap.set(tf.path, tf.content);
        }

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

        // ── 3. Boot provider ────────────────────────────────────────
        tui.state.phase = "booting";
        const instance = await bootProvider(provider, { url: serverUrl, cwd });
        registerCleanup(() => instance.cleanup());
        if (serverUrl) {
          tui.state.serverUrl = serverUrl;
        }
        if (instance.model) {
          tui.state.model = instance.model;
        }

        // ── 4. Boot planner agent (unless --no-plan) ────────────────
        const planner = noPlan ? null : await bootPlanner({ provider: instance, cwd });

        // ── 5. Dispatch tasks ───────────────────────────────────────
        tui.state.phase = "dispatching";
        const results: DispatchResult[] = [];
        let completed = 0;
        let failed = 0;

        const groups = groupTasksByMode(allTasks);

        for (const group of groups) {
          // Dispatch all tasks in the group concurrently, respecting --concurrency
          const groupQueue = [...group];

          while (groupQueue.length > 0) {
            const batch = groupQueue.splice(0, concurrency);
            const batchResults = await Promise.all(
              batch.map(async (task) => {
                const tuiTask = tui.state.tasks.find((t) => t.task === task)!;
                const startTime = Date.now();
                tuiTask.elapsed = startTime;

                // ── Phase A: Plan (unless --no-plan) ─────────────────
                let plan: string | undefined;
                if (planner) {
                  tuiTask.status = "planning";
                  const rawContent = fileContentMap.get(task.file);
                  const fileContext = rawContent ? buildTaskContext(rawContent, task) : undefined;
                  const planResult = await planner.plan(task, fileContext);

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
        }

        // ── 6. Close originating issues for completed spec files ────
        await closeCompletedSpecIssues(taskFiles, results, cwd, source, org, project);

        // ── 7. Cleanup ──────────────────────────────────────────────
        await planner?.cleanup();
        await instance.cleanup();

        tui.state.phase = "done";
        tui.stop();

        return { total: allTasks.length, completed, failed, skipped: 0, results };
      } catch (err) {
        tui.stop();
        throw err;
      }
    },

    async cleanup(): Promise<void> {
      // Orchestrator has no persistent resources — provider and planner
      // are created and cleaned up within each orchestrate() call
    },
  };
}

/**
 * For each spec file where all tasks completed successfully, extract the
 * issue number from the filename (`<id>-<slug>.md`) and close the originating
 * issue on the tracker.
 */
async function closeCompletedSpecIssues(
  taskFiles: TaskFile[],
  results: DispatchResult[],
  cwd: string,
  source?: DatasourceName,
  org?: string,
  project?: string,
): Promise<void> {
  // Resolve the datasource — use explicit source or auto-detect
  let datasourceName = source;
  if (!datasourceName) {
    datasourceName = await detectDatasource(cwd) ?? undefined;
  }
  if (!datasourceName) return;

  const datasource = getDatasource(datasourceName);

  // Build a set of tasks that succeeded
  const succeededTasks = new Set(
    results.filter((r) => r.success).map((r) => r.task)
  );

  const fetchOpts: IssueFetchOptions = { cwd, org, project };

  for (const taskFile of taskFiles) {
    const fileTasks = taskFile.tasks;
    if (fileTasks.length === 0) continue;

    // Only close if every task in this file completed successfully
    const allSucceeded = fileTasks.every((t) => succeededTasks.has(t));
    if (!allSucceeded) continue;

    // Extract the issue ID from the filename: "<id>-<slug>.md"
    const filename = basename(taskFile.path);
    const match = /^(\d+)-/.exec(filename);
    if (!match) continue;

    const issueId = match[1];
    try {
      await datasource.close(issueId, fetchOpts);
      log.success(`Closed issue #${issueId} (all tasks in ${filename} completed)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Could not close issue #${issueId}: ${message}`);
    }
  }
}

async function dryRunMode(
  pattern: string[],
  cwd: string,
  source?: DatasourceName,
  org?: string,
  project?: string,
): Promise<DispatchSummary> {
  let files: string[];

  const useDatasource = source && pattern.length === 0;

  if (useDatasource) {
    const datasource = getDatasource(source);
    const fetchOpts: IssueFetchOptions = { cwd, org, project };
    const items = await datasource.list(fetchOpts);

    if (items.length === 0) {
      log.warn("No work items found from datasource: " + source);
      return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
    }

    const tempDir = await mkdtemp(join(tmpdir(), "dispatch-"));
    files = [];

    for (const item of items) {
      const slug = item.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
      const filename = `${item.number}-${slug}.md`;
      const filepath = join(tempDir, filename);
      await writeFile(filepath, item.body, "utf-8");
      files.push(filepath);
    }
  } else {
    files = await glob(pattern, { cwd, absolute: true });
  }

  files.sort((a, b) => {
    const numA = parseInt(basename(a).match(/^(\d+)/)?.[1] ?? "0", 10);
    const numB = parseInt(basename(b).match(/^(\d+)/)?.[1] ?? "0", 10);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b);
  });

  if (files.length === 0) {
    log.warn("No files matched the pattern(s): " + pattern.join(", "));
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
