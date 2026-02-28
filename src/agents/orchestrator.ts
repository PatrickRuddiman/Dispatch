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
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseTaskFile, markTaskComplete, buildTaskContext, groupTasksByMode, type TaskFile } from "../parser.js";
import { dispatchTask, type DispatchResult } from "../dispatcher.js";
import { boot as bootPlanner } from "./planner.js";
import { log } from "../logger.js";
import { registerCleanup } from "../cleanup.js";
import { createTui } from "../tui.js";
import type { Agent, AgentBootOptions } from "../agent.js";
import type { ProviderName } from "../provider.js";
import { bootProvider } from "../providers/index.js";
import { getDatasource, detectDatasource } from "../datasources/index.js";
import type { Datasource, DatasourceName, IssueDetails, IssueFetchOptions } from "../datasource.js";

/**
 * Runtime options passed to `orchestrate()` — these control what gets
 * dispatched and how, separate from the agent's boot-time configuration.
 */
export interface OrchestrateRunOptions {
  /** Issue IDs to dispatch (empty = all open issues from datasource) */
  issueIds: string[];
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

/** Result of writing issue items to a temp directory. */
interface WriteItemsResult {
  /** Sorted list of written file paths */
  files: string[];
  /** Mapping from file path to the original IssueDetails */
  issueDetailsByFile: Map<string, IssueDetails>;
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
        issueIds,
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
        return dryRunMode(issueIds, cwd, source, org, project);
      }

      // ── Start TUI ───────────────────────────────────────────────
      const tui = createTui();
      tui.state.provider = provider;

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
 * Parse an issue ID and slug from a `<id>-<slug>.md` filename.
 *
 * Returns the numeric issue ID and slug, or `null` if the filename
 * does not match the expected `<id>-<slug>.md` pattern.
 */
export function parseIssueFilename(filePath: string): { issueId: string; slug: string } | null {
  const filename = basename(filePath);
  const match = /^(\d+)-(.+)\.md$/.exec(filename);
  if (!match) return null;
  return { issueId: match[1], slug: match[2] };
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
    const parsed = parseIssueFilename(taskFile.path);
    if (!parsed) continue;

    const { issueId } = parsed;
    const filename = basename(taskFile.path);
    try {
      await datasource.close(issueId, fetchOpts);
      log.success(`Closed issue #${issueId} (all tasks in ${filename} completed)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Could not close issue #${issueId}: ${message}`);
    }
  }
}

/**
 * Fetch specific issues by ID from a datasource.
 * Logs a warning and skips any ID that fails to fetch.
 */
async function fetchItemsById(
  issueIds: string[],
  datasource: Datasource,
  fetchOpts: IssueFetchOptions,
): Promise<IssueDetails[]> {
  const ids = issueIds.flatMap((id) =>
    id.split(",").map((s) => s.trim()).filter(Boolean)
  );
  const items = [];
  for (const id of ids) {
    try {
      const item = await datasource.fetch(id, fetchOpts);
      items.push(item);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Could not fetch issue #${id}: ${message}`);
    }
  }
  return items;
}

/**
 * Write a list of IssueDetails to a temp directory as `{number}-{slug}.md` files.
 * Returns the sorted file paths and a mapping from each path to its original IssueDetails.
 */
async function writeItemsToTempDir(items: IssueDetails[]): Promise<WriteItemsResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "dispatch-"));
  const files: string[] = [];
  const issueDetailsByFile = new Map<string, IssueDetails>();

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
    issueDetailsByFile.set(filepath, item);
  }

  files.sort((a, b) => {
    const numA = parseInt(basename(a).match(/^(\d+)/)?.[1] ?? "0", 10);
    const numB = parseInt(basename(b).match(/^(\d+)/)?.[1] ?? "0", 10);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b);
  });

  return { files, issueDetailsByFile };
}

async function dryRunMode(
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
