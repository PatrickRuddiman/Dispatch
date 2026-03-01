/**
 * Dispatch pipeline — the core execution pipeline that discovers tasks,
 * optionally plans them via the planner agent, executes them via the
 * executor agent, syncs completion state back to the datasource, and
 * cleans up resources.
 */

import { readFile } from "node:fs/promises";
import { parseTaskFile, buildTaskContext, groupTasksByMode, type TaskFile } from "../parser.js";
import type { DispatchResult } from "../dispatcher.js";
import { boot as bootPlanner } from "../agents/planner.js";
import { boot as bootExecutor } from "../agents/executor.js";
import { log } from "../logger.js";
import { registerCleanup } from "../cleanup.js";
import { createTui } from "../tui.js";
import type { ProviderName } from "../providers/interface.js";
import { bootProvider } from "../providers/index.js";
import { getDatasource } from "../datasources/index.js";
import type { DatasourceName, IssueDetails, IssueFetchOptions } from "../datasources/interface.js";
import type { OrchestrateRunOptions, DispatchSummary } from "../agents/orchestrator.js";
import {
  fetchItemsById,
  writeItemsToTempDir,
  closeCompletedSpecIssues,
  parseIssueFilename,
} from "./datasource-helpers.js";

/**
 * Run the full dispatch pipeline: discover tasks from a datasource,
 * optionally plan them via the planner agent, execute via the executor
 * agent, sync completion state, and clean up.
 */
export async function runDispatchPipeline(
  opts: OrchestrateRunOptions,
  cwd: string,
): Promise<DispatchSummary> {
  const {
    issueIds,
    concurrency,
    dryRun,
    serverUrl,
    noPlan,
    provider = "opencode",
    source,
    org,
    project,
  } = opts;

  // Dry-run mode uses simple log output
  if (dryRun) {
    return dryRunMode(issueIds, cwd, source, org, project);
  }

  // ── Start TUI ───────────────────────────────────────────────
  const tui = createTui();
  tui.state.provider = provider;
  tui.state.source = source;

  try {
    // ── 1. Discover task files ──────────────────────────────────
    tui.state.phase = "discovering";

    if (!source) {
      tui.state.phase = "done";
      tui.stop();
      log.error("No datasource configured. Use --source or run: dispatch config set source <name>");
      return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
    }

    const datasource = getDatasource(source);
    const fetchOpts: IssueFetchOptions = { cwd, org, project };
    const items = issueIds.length > 0
      ? await fetchItemsById(issueIds, datasource, fetchOpts)
      : await datasource.list(fetchOpts);

    if (items.length === 0) {
      tui.state.phase = "done";
      tui.stop();
      const label = issueIds.length > 0 ? `issue(s) ${issueIds.join(", ")}` : `datasource: ${source}`;
      log.warn("No work items found from " + label);
      return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
    }

    const { files, issueDetailsByFile } = await writeItemsToTempDir(items);
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
    const executor = await bootExecutor({ provider: instance, cwd });

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

            // ── Phase B: Execute via executor agent ──────────────
            tuiTask.status = "running";
            const execResult = await executor.execute({
              task,
              cwd,
              plan: plan ?? null,
            });

            if (execResult.success) {
              // Sync checked-off state back to the datasource
              try {
                const parsed = parseIssueFilename(task.file);
                if (parsed) {
                  const updatedContent = await readFile(task.file, "utf-8");
                  const details = issueDetailsByFile.get(task.file);
                  const title = details?.title ?? parsed.slug;
                  await datasource.update(parsed.issueId, title, updatedContent, fetchOpts);
                  log.success(`Synced task completion to issue #${parsed.issueId}`);
                }
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                log.warn(`Could not sync task completion to datasource: ${message}`);
              }

              tuiTask.status = "done";
              tuiTask.elapsed = Date.now() - startTime;
              completed++;
            } else {
              tuiTask.status = "failed";
              tuiTask.error = execResult.error;
              tuiTask.elapsed = Date.now() - startTime;
              failed++;
            }

            return execResult.dispatchResult;
          })
        );

        results.push(...batchResults);
      }
    }

    // ── 6. Close originating issues for completed spec files ────
    await closeCompletedSpecIssues(taskFiles, results, cwd, source, org, project);

    // ── 7. Cleanup ──────────────────────────────────────────────
    await executor.cleanup();
    await planner?.cleanup();
    await instance.cleanup();

    tui.state.phase = "done";
    tui.stop();

    return { total: allTasks.length, completed, failed, skipped: 0, results };
  } catch (err) {
    tui.stop();
    throw err;
  }
}

/**
 * Dry-run mode — discovers and parses tasks, logs them, but does not
 * execute anything.
 */
export async function dryRunMode(
  issueIds: string[],
  cwd: string,
  source?: DatasourceName,
  org?: string,
  project?: string,
): Promise<DispatchSummary> {
  if (!source) {
    log.error("No datasource configured. Use --source or run: dispatch config set source <name>");
    return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
  }

  const datasource = getDatasource(source);
  const fetchOpts: IssueFetchOptions = { cwd, org, project };
  const items = issueIds.length > 0
    ? await fetchItemsById(issueIds, datasource, fetchOpts)
    : await datasource.list(fetchOpts);

  if (items.length === 0) {
    const label = issueIds.length > 0 ? `issue(s) ${issueIds.join(", ")}` : `datasource: ${source}`;
    log.warn("No work items found from " + label);
    return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
  }

  const { files } = await writeItemsToTempDir(items);

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
