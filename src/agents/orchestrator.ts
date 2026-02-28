/**
 * Orchestrator — the core loop that drives the dispatch pipeline:
 *   1. Glob for task files
 *   2. Parse unchecked tasks
 *   3. Boot the selected provider (OpenCode, Copilot, etc.)
 *   4. Plan each task via a planner agent (optional)
 *   5. Execute each task via the executor agent
 *   6. Mark complete in markdown
 */

import { basename, join } from "node:path";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseTaskFile, buildTaskContext, groupTasksByMode, type TaskFile } from "../parser.js";
import type { DispatchResult } from "../dispatcher.js";
import { boot as bootPlanner } from "./planner.js";
import { boot as bootExecutor } from "./executor.js";
import { log } from "../logger.js";
import { registerCleanup } from "../cleanup.js";
import { createTui } from "../tui.js";
import type { AgentBootOptions } from "../agent.js";
import type { ProviderName } from "../provider.js";
import { bootProvider } from "../providers/index.js";
import { getDatasource, detectDatasource } from "../datasources/index.js";
import type { Datasource, DatasourceName, IssueDetails, IssueFetchOptions } from "../datasource.js";
import { glob } from "glob";
import type { SpecOptions, SpecSummary } from "../spec-generator.js";
import { isIssueNumbers, resolveSource, defaultConcurrency } from "../spec-generator.js";
import { boot as bootSpecAgent } from "./spec.js";
import { extractTitle } from "../datasources/md.js";
import { elapsed } from "../format.js";

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

/**
 * Dispatch-mode run options — extends the existing options with an explicit
 * mode discriminator.
 */
export interface DispatchRunOptions extends OrchestrateRunOptions {
  mode: "dispatch";
}

/**
 * Spec-mode run options — mirrors `SpecOptions` with an explicit mode
 * discriminator. The `cwd` field is omitted because it is provided at
 * boot time via `AgentBootOptions`.
 */
export interface SpecRunOptions extends Omit<SpecOptions, "cwd"> {
  mode: "spec";
}

/**
 * Unified run options for all orchestrator workflows.
 *
 * A discriminated union keyed on `mode`:
 * - `"dispatch"` — run the dispatch pipeline (discover, plan, execute, sync)
 * - `"spec"`     — run the spec-generation pipeline
 *
 * This establishes a single entry point for all current and future workflow
 * modes, replacing the need for separate top-level functions per mode.
 */
export type UnifiedRunOptions = DispatchRunOptions | SpecRunOptions;

/**
 * Unified result type returned by `run()`.
 *
 * - In dispatch mode, returns a `DispatchSummary`
 * - In spec mode, returns a `SpecSummary`
 */
export type RunResult = DispatchSummary | SpecSummary;

/** Result of writing issue items to a temp directory. */
interface WriteItemsResult {
  /** Sorted list of written file paths */
  files: string[];
  /** Mapping from file path to the original IssueDetails */
  issueDetailsByFile: Map<string, IssueDetails>;
}

/**
 * A booted orchestrator that coordinates the full dispatch pipeline.
 *
 * The orchestrator is not an agent — it is a standalone pipeline coordinator
 * that boots and manages agents (planner, executor) internally.
 */
export interface OrchestratorAgent {
  /**
   * Run the dispatch pipeline — discover tasks, optionally plan them,
   * execute via the provider, mark complete, and commit.
   */
  orchestrate(opts: OrchestrateRunOptions): Promise<DispatchSummary>;

  /**
   * Run the spec generation pipeline — resolve datasource, boot provider,
   * generate specs in batches, cleanup, and return a summary.
   */
  generateSpecs(opts: SpecOptions): Promise<SpecSummary>;

  /**
   * Unified entry point for all orchestrator workflows.
   *
   * Dispatches to the appropriate pipeline based on `opts.mode`:
   * - `"dispatch"` — delegates to the dispatch pipeline (same as `orchestrate()`)
   * - `"spec"`     — delegates to the spec-generation pipeline
   *
   * Callers that know their mode at compile time can still use `orchestrate()`
   * directly. This method is intended for the CLI and other callers that need
   * a single entry point.
   */
  run(opts: UnifiedRunOptions): Promise<RunResult>;
}

/**
 * Boot an orchestrator agent.
 */
export async function boot(opts: AgentBootOptions): Promise<OrchestratorAgent> {
  const { cwd } = opts;

  const agent: OrchestratorAgent = {
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
    },

    async generateSpecs(opts: SpecOptions): Promise<SpecSummary> {
      const {
        issues,
        provider,
        serverUrl,
        cwd: specCwd,
        outputDir = join(specCwd, ".dispatch", "specs"),
        org,
        project,
        concurrency = defaultConcurrency(),
      } = opts;

      const pipelineStart = Date.now();

      // ── Resolve datasource ─────────────────────────────────────
      const source = await resolveSource(issues, opts.issueSource, specCwd);
      if (!source) {
        return { total: 0, generated: 0, failed: 0, files: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
      }

      const datasource = getDatasource(source);
      const fetchOpts: IssueFetchOptions = { cwd: specCwd, org, project };

      // ── Determine items to process ─────────────────────────────
      const isTrackerMode = isIssueNumbers(issues);
      let items: { id: string; details: IssueDetails | null; error?: string }[];

      if (isTrackerMode) {
        // Issue-tracker mode: parse issue numbers and fetch via datasource
        const issueNumbers = issues
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        if (issueNumbers.length === 0) {
          log.error("No issue numbers provided. Use --spec 1,2,3");
          return { total: 0, generated: 0, failed: 0, files: [], durationMs: 0, fileDurationsMs: {} };
        }

        const fetchStart = Date.now();
        log.info(`Fetching ${issueNumbers.length} issue(s) from ${source} (concurrency: ${concurrency})...`);

        items = [];
        const fetchQueue = [...issueNumbers];

        while (fetchQueue.length > 0) {
          const batch = fetchQueue.splice(0, concurrency);
          log.debug(`Fetching batch of ${batch.length}: #${batch.join(", #")}`);
          const batchResults = await Promise.all(
            batch.map(async (id) => {
              try {
                const details = await datasource.fetch(id, fetchOpts);
                log.success(`Fetched #${id}: ${details.title}`);
                log.debug(`Body: ${details.body?.length ?? 0} chars, Labels: ${details.labels.length}, Comments: ${details.comments.length}`);
                return { id, details };
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                log.error(`Failed to fetch #${id}: ${message}`);
                log.debug(log.formatErrorChain(err));
                return { id, details: null, error: message };
              }
            })
          );
          items.push(...batchResults);
        }
        log.debug(`Issue fetching completed in ${elapsed(Date.now() - fetchStart)}`);
      } else {
        // File/glob mode: resolve files and build IssueDetails from content
        const files = await glob(issues, { cwd: specCwd, absolute: true });

        if (files.length === 0) {
          log.error(`No files matched the pattern "${Array.isArray(issues) ? issues.join(", ") : issues}".`);
          return { total: 0, generated: 0, failed: 0, files: [], durationMs: 0, fileDurationsMs: {} };
        }

        log.info(`Matched ${files.length} file(s) for spec generation (concurrency: ${concurrency})...`);

        items = [];
        for (const filePath of files) {
          try {
            const content = await readFile(filePath, "utf-8");
            const title = extractTitle(content, filePath);
            const details: IssueDetails = {
              number: filePath,
              title,
              body: content,
              labels: [],
              state: "open",
              url: filePath,
              comments: [],
              acceptanceCriteria: "",
            };
            items.push({ id: filePath, details });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            items.push({ id: filePath, details: null, error: message });
          }
        }
      }

      const validItems = items.filter((i) => i.details !== null);
      if (validItems.length === 0) {
        const noun = isTrackerMode ? "issues" : "files";
        log.error(`No ${noun} could be loaded. Aborting spec generation.`);
        return { total: items.length, generated: 0, failed: items.length, files: [], durationMs: Date.now() - pipelineStart, fileDurationsMs: {} };
      }

      // ── Boot AI provider ────────────────────────────────────────
      const bootStart = Date.now();
      log.info(`Booting ${provider} provider...`);
      log.debug(serverUrl ? `Using server URL: ${serverUrl}` : "No --server-url, will spawn local server");
      const instance = await bootProvider(provider, { url: serverUrl, cwd: specCwd });
      registerCleanup(() => instance.cleanup());
      log.debug(`Provider booted in ${elapsed(Date.now() - bootStart)}`);

      // ── Boot spec agent ─────────────────────────────────────────
      const specAgent = await bootSpecAgent({ provider: instance, cwd: specCwd });

      // ── Generate spec for each item (parallel batches) ──────────
      await mkdir(outputDir, { recursive: true });

      const generatedFiles: string[] = [];
      let failed = items.filter((i) => i.details === null).length;
      const fileDurationsMs: Record<string, number> = {};

      const genQueue = [...validItems];

      while (genQueue.length > 0) {
        const batch = genQueue.splice(0, concurrency);
        log.info(`Generating specs for batch of ${batch.length} (${generatedFiles.length + failed}/${items.length} done)...`);

        const batchResults = await Promise.all(
          batch.map(async ({ id, details }) => {
            const specStart = Date.now();

            // Determine the spec output filepath
            let filepath: string;
            if (isTrackerMode) {
              // Issue-tracker: write to outputDir with slug filename
              const slug = details!.title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 60);
              const filename = `${id}-${slug}.md`;
              filepath = join(outputDir, filename);
            } else {
              // File-based: overwrite the source file in-place
              filepath = id;
            }

            try {
              log.info(`Generating spec for ${isTrackerMode ? `#${id}` : filepath}: ${details!.title}...`);

              const result = await specAgent.generate({
                issue: isTrackerMode ? details! : undefined,
                filePath: isTrackerMode ? undefined : id,
                fileContent: isTrackerMode ? undefined : details!.body,
                cwd: specCwd,
                outputPath: filepath,
              });

              if (!result.success) {
                throw new Error(result.error ?? "Spec generation failed");
              }

              const specDuration = Date.now() - specStart;
              fileDurationsMs[filepath] = specDuration;
              log.success(`Spec written: ${filepath} (${elapsed(specDuration)})`);

              // Push spec content back to the datasource
              try {
                if (isTrackerMode) {
                  // Tracker mode: update the existing issue with the generated spec
                  await datasource.update(id, details!.title, result.content, fetchOpts);
                  log.success(`Updated issue #${id} with spec content`);
                } else if (datasource.name !== "md") {
                  // File/glob mode with tracker datasource: create a new issue and delete the local file
                  const created = await datasource.create(details!.title, result.content, fetchOpts);
                  log.success(`Created issue #${created.number} from ${filepath}`);
                  await unlink(filepath);
                  log.success(`Deleted local spec ${filepath} (now tracked as issue #${created.number})`);
                }
                // md datasource + file/glob mode: file already written in-place, nothing to do
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const label = isTrackerMode ? `issue #${id}` : filepath;
                log.warn(`Could not sync ${label} to datasource: ${message}`);
              }

              return filepath;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log.error(`Failed to generate spec for ${isTrackerMode ? `#${id}` : filepath}: ${message}`);
              log.debug(log.formatErrorChain(err));
              return null;
            }
          })
        );

        for (const result of batchResults) {
          if (result !== null) {
            generatedFiles.push(result);
          } else {
            failed++;
          }
        }
      }

      // ── Cleanup ─────────────────────────────────────────────────
      await specAgent.cleanup();
      await instance.cleanup();

      const totalDuration = Date.now() - pipelineStart;
      log.info(
        `Spec generation complete: ${generatedFiles.length} generated, ${failed} failed in ${elapsed(totalDuration)}`
      );

      if (generatedFiles.length > 0) {
        log.dim(`\n  Run these specs with:`);
        if (isTrackerMode) {
          log.dim(`    dispatch "${outputDir}/*.md"\n`);
        } else {
          log.dim(`    dispatch ${generatedFiles.map((f) => '"' + f + '"').join(" ")}\n`);
        }
      }

      return {
        total: items.length,
        generated: generatedFiles.length,
        failed,
        files: generatedFiles,
        durationMs: totalDuration,
        fileDurationsMs,
      };
    },

    async run(opts: UnifiedRunOptions): Promise<RunResult> {
      switch (opts.mode) {
        case "dispatch": {
          // Strip the mode field and delegate to the existing orchestrate() method
          const { mode: _, ...dispatchOpts } = opts;
          return agent.orchestrate(dispatchOpts);
        }
        case "spec": {
          // Strip the mode field and delegate to the existing generateSpecs() method
          const { mode: _, ...specOpts } = opts;
          return agent.generateSpecs({ ...specOpts, cwd });
        }
        default:
          throw new Error(`Unknown run mode: ${(opts as { mode: string }).mode}`);
      }
    },
  };

  return agent;
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
