/**
 * Dispatch pipeline — the core execution pipeline that discovers tasks,
 * optionally plans them via the planner agent, executes them via the
 * executor agent, syncs completion state back to the datasource, and
 * cleans up resources.
 */

import { readFile } from "node:fs/promises";
import { parseTaskFile, buildTaskContext, groupTasksByMode, type TaskFile } from "../parser.js";
import type { DispatchResult } from "../dispatcher.js";
import { boot as bootPlanner, type PlannerAgent } from "../agents/planner.js";
import type { AgentResult, PlannerData, ExecutorData } from "../agents/types.js";
import { boot as bootExecutor, type ExecutorAgent } from "../agents/executor.js";
import { boot as bootCommit, type CommitAgent } from "../agents/commit.js";
import { log } from "../helpers/logger.js";
import { registerCleanup } from "../helpers/cleanup.js";
import { createWorktree, removeWorktree, worktreeName } from "../helpers/worktree.js";
import { createTui, type TuiState } from "../tui.js";
import type { ProviderName, ProviderInstance } from "../providers/interface.js";
import { bootProvider } from "../providers/index.js";
import { getDatasource } from "../datasources/index.js";
import type { DatasourceName, DispatchLifecycleOptions, IssueDetails, IssueFetchOptions } from "../datasources/interface.js";
import type { OrchestrateRunOptions, DispatchSummary } from "./runner.js";
import {
  fetchItemsById,
  writeItemsToTempDir,
  closeCompletedSpecIssues,
  parseIssueFilename,
  buildPrBody,
  buildPrTitle,
  getBranchDiff,
  squashBranchCommits,
} from "./datasource-helpers.js";
import { withTimeout, TimeoutError } from "../helpers/timeout.js";
import { withRetry } from "../helpers/retry.js";
import chalk from "chalk";
import { elapsed, renderHeaderLines } from "../helpers/format.js";

/** Default planning timeout in minutes when not specified by the user. */
const DEFAULT_PLAN_TIMEOUT_MIN = 10;

/** Default number of planning retries when not specified by the user. */
const DEFAULT_PLAN_RETRIES = 1;

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
    noBranch,
    noWorktree,
    provider = "opencode",
    model,
    source,
    org,
    project,
    workItemType,
    planTimeout,
    planRetries,
    retries,
  } = opts;

  // Planning timeout/retry defaults
  const planTimeoutMs = (planTimeout ?? DEFAULT_PLAN_TIMEOUT_MIN) * 60_000;
  const maxPlanAttempts = (planRetries ?? retries ?? DEFAULT_PLAN_RETRIES) + 1; // retries + initial attempt

  log.debug(`Plan timeout: ${planTimeout ?? DEFAULT_PLAN_TIMEOUT_MIN}m (${planTimeoutMs}ms), max attempts: ${maxPlanAttempts}`);

  // Dry-run mode uses simple log output
  if (dryRun) {
    return dryRunMode(issueIds, cwd, source, org, project, workItemType);
  }

  // ── Start TUI (or inline logging for verbose mode) ──────────
  const verbose = log.verbose;
  let tui: ReturnType<typeof createTui>;

  if (verbose) {
    // Print inline header banner (same pattern as spec pipeline)
    const headerLines = renderHeaderLines({ provider, source });
    console.log("");
    for (const line of headerLines) console.log(line);
    console.log(chalk.dim("  ─".repeat(24)));
    console.log("");
    log.info("Discovering task files...");

    // Silent state container — no animated rendering
    const state: TuiState = {
      tasks: [],
      phase: "discovering",
      startTime: Date.now(),
      filesFound: 0,
      provider,
      source,
    };
    tui = { state, update: () => {}, stop: () => {} };
  } else {
    tui = createTui();
    tui.state.provider = provider;
    tui.state.source = source;
  }

  try {
    // ── 1. Discover task files ──────────────────────────────────
    tui.state.phase = "discovering";

    if (!source) {
      tui.state.phase = "done";
      tui.stop();
      log.error("No datasource configured. Use --source or run 'dispatch config' to set up defaults.");
      return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
    }

    const datasource = getDatasource(source);
    const fetchOpts: IssueFetchOptions = { cwd, org, project, workItemType };
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
    if (verbose) log.debug(`Found ${files.length} task file(s)`);

    // ── 2. Parse all tasks ──────────────────────────────────────
    tui.state.phase = "parsing";
    if (verbose) log.info("Parsing tasks...");
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

    // Group tasks by their source file (each file = one issue)
    const tasksByFile = new Map<string, typeof allTasks>();
    for (const task of allTasks) {
      const list = tasksByFile.get(task.file) ?? [];
      list.push(task);
      tasksByFile.set(task.file, list);
    }

    // Determine whether to use worktree-based parallel execution.
    // Worktrees are used when: not opted out, branching is enabled, and
    // there are multiple issues to process (single-issue runs use serial
    // mode to avoid unnecessary worktree overhead).
    const useWorktrees = !noWorktree && !noBranch && tasksByFile.size > 1;

    // ── 3. Boot provider ────────────────────────────────────────
    tui.state.phase = "booting";
    if (verbose) log.info(`Booting ${provider} provider...`);
    if (serverUrl) {
      tui.state.serverUrl = serverUrl;
    }
    if (verbose && serverUrl) log.debug(`Server URL: ${serverUrl}`);

    // When using worktrees, providers are booted per-worktree inside
    // processIssueFile. Otherwise, boot a single shared provider.
    let instance: ProviderInstance | undefined;
    let planner: PlannerAgent | null = null;
    let executor: ExecutorAgent | undefined;
    let commitAgent: CommitAgent | undefined;

    if (!useWorktrees) {
      instance = await bootProvider(provider, { url: serverUrl, cwd, model });
      registerCleanup(() => instance!.cleanup());
      if (instance.model) {
        tui.state.model = instance.model;
      }
      if (verbose && instance.model) log.debug(`Model: ${instance.model}`);

      // ── 4. Boot planner agent (unless --no-plan) ────────────────
      planner = noPlan ? null : await bootPlanner({ provider: instance, cwd });
      executor = await bootExecutor({ provider: instance, cwd });
      commitAgent = await bootCommit({ provider: instance, cwd });
    }

    // ── 5. Dispatch tasks ───────────────────────────────────────
    tui.state.phase = "dispatching";
    if (verbose) log.info(`Dispatching ${allTasks.length} task(s)...`);
    const results: DispatchResult[] = [];
    let completed = 0;
    let failed = 0;

    const lifecycleOpts: DispatchLifecycleOptions = { cwd };

    // Resolve git username once for branch naming
    let username = "";
    try {
      username = await datasource.getUsername(lifecycleOpts);
    } catch (err) {
      log.warn(`Could not resolve git username for branch naming: ${log.formatErrorChain(err)}`);
    }

    // Process a single issue file's tasks — handles both worktree and
    // serial branch modes, parameterised by useWorktrees.
    const processIssueFile = async (file: string, fileTasks: typeof allTasks) => {
      const details = issueDetailsByFile.get(file);
      let defaultBranch: string | undefined;
      let branchName: string | undefined;
      let worktreePath: string | undefined;
      let issueCwd = cwd;

      // ── Branch / worktree setup (unless --no-branch) ────────────
      if (!noBranch && details) {
        try {
          defaultBranch = await datasource.getDefaultBranch(lifecycleOpts);
          branchName = datasource.buildBranchName(details.number, details.title, username);

          if (useWorktrees) {
            worktreePath = await createWorktree(cwd, file, branchName);
            registerCleanup(async () => { await removeWorktree(cwd, file); });
            issueCwd = worktreePath;
            log.debug(`Created worktree for issue #${details.number} at ${worktreePath}`);

            // Tag TUI tasks with worktree name for display
            const wtName = worktreeName(file);
            for (const task of fileTasks) {
              const tuiTask = tui.state.tasks.find((t) => t.task === task);
              if (tuiTask) tuiTask.worktree = wtName;
            }
          } else if (datasource.supportsGit()) {
            await datasource.createAndSwitchBranch(branchName, lifecycleOpts);
            log.debug(`Switched to branch ${branchName}`);
          }
        } catch (err) {
          const errorMsg = `Branch creation failed for issue #${details.number}: ${log.extractMessage(err)}`;
          log.error(errorMsg);
          for (const task of fileTasks) {
            const tuiTask = tui.state.tasks.find((t) => t.task === task);
            if (tuiTask) {
              tuiTask.status = "failed";
              tuiTask.error = errorMsg;
            }
            results.push({ task, success: false, error: errorMsg });
          }
          failed += fileTasks.length;
          return;
        }
      }

      const worktreeRoot = useWorktrees ? worktreePath : undefined;
      const issueLifecycleOpts: DispatchLifecycleOptions = { cwd: issueCwd };

      // ── Boot per-worktree provider and agents (or use shared ones) ──
      let localInstance: ProviderInstance;
      let localPlanner: PlannerAgent | null;
      let localExecutor: ExecutorAgent;
      let localCommitAgent: CommitAgent;

      if (useWorktrees) {
        localInstance = await bootProvider(provider, { url: serverUrl, cwd: issueCwd, model });
        registerCleanup(() => localInstance.cleanup());
        if (localInstance.model && !tui.state.model) {
          tui.state.model = localInstance.model;
        }
        if (verbose && localInstance.model) log.debug(`Model: ${localInstance.model}`);
        localPlanner = noPlan ? null : await bootPlanner({ provider: localInstance, cwd: issueCwd });
        localExecutor = await bootExecutor({ provider: localInstance, cwd: issueCwd });
        localCommitAgent = await bootCommit({ provider: localInstance, cwd: issueCwd });
      } else {
        localInstance = instance!;
        localPlanner = planner;
        localExecutor = executor!;
        localCommitAgent = commitAgent!;
      }

      // ── Dispatch file's tasks ─────────────────────────────────
      const groups = groupTasksByMode(fileTasks);
      const issueResults: DispatchResult[] = [];

      for (const group of groups) {
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
              if (localPlanner) {
                tuiTask.status = "planning";
              if (verbose) log.info(`Task #${tui.state.tasks.indexOf(tuiTask) + 1}: planning — "${task.text}"`);
                const rawContent = fileContentMap.get(task.file);
                const fileContext = rawContent ? buildTaskContext(rawContent, task) : undefined;

                let planResult: AgentResult<PlannerData> | undefined;

                for (let attempt = 1; attempt <= maxPlanAttempts; attempt++) {
                  try {
                    planResult = await withTimeout(
                      localPlanner.plan(task, fileContext, issueCwd, worktreeRoot),
                      planTimeoutMs,
                      "planner.plan()",
                    );
                    break; // success — exit retry loop
                  } catch (err) {
                    if (err instanceof TimeoutError) {
                      log.warn(
                        `Planning timed out for task "${task.text}" (attempt ${attempt}/${maxPlanAttempts})`,
                      );
                      if (attempt < maxPlanAttempts) {
                        log.debug(`Retrying planning (attempt ${attempt + 1}/${maxPlanAttempts})`);
                      }
                    } else {
                      // Non-timeout error — do not retry, surface immediately
                      planResult = {
                        data: null,
                        success: false,
                        error: log.extractMessage(err),
                        durationMs: 0,
                      };
                      break;
                    }
                  }
                }

                // All attempts exhausted with timeout — produce failure result
                if (!planResult) {
                  const timeoutMin = planTimeout ?? 10;
                  planResult = {
                    data: null,
                    success: false,
                    error: `Planning timed out after ${timeoutMin}m (${maxPlanAttempts} attempts)`,
                    durationMs: 0,
                  };
                }

                if (!planResult.success) {
                  tuiTask.status = "failed";
                  tuiTask.error = `Planning failed: ${planResult.error}`;
                  tuiTask.elapsed = Date.now() - startTime;
                  if (verbose) log.error(`Task #${tui.state.tasks.indexOf(tuiTask) + 1}: failed — ${tuiTask.error} (${elapsed(tuiTask.elapsed)})`);
                  failed++;
                  return { task, success: false, error: tuiTask.error } as DispatchResult;
                }

                plan = planResult.data?.prompt;
              }

              // ── Phase B: Execute via executor agent ──────────────
              tuiTask.status = "running";
              if (verbose) log.info(`Task #${tui.state.tasks.indexOf(tuiTask) + 1}: executing — "${task.text}"`);
              const execRetries = 2;
              const execResult = await withRetry(
                async () => {
                  const result = await localExecutor.execute({
                    task,
                    cwd: issueCwd,
                    plan: plan ?? null,
                    worktreeRoot,
                  });
                  if (!result.success) {
                    throw new Error(result.error ?? "Execution failed");
                  }
                  return result;
                },
                execRetries,
                { label: `executor "${task.text}"` },
              ).catch((err): AgentResult<ExecutorData> => ({
                data: { dispatchResult: { task, success: false, error: log.extractMessage(err) } },
                success: false,
                error: log.extractMessage(err),
                durationMs: 0,
              }));

              if (execResult.success) {
                // Sync checked-off state back to the datasource
                try {
                  const parsed = parseIssueFilename(task.file);
                  if (parsed) {
                    const updatedContent = await readFile(task.file, "utf-8");
                    const issueDetails = issueDetailsByFile.get(task.file);
                    const title = issueDetails?.title ?? parsed.slug;
                    await datasource.update(parsed.issueId, title, updatedContent, fetchOpts);
                    log.success(`Synced task completion to issue #${parsed.issueId}`);
                  }
                } catch (err) {
                  log.warn(`Could not sync task completion to datasource: ${log.formatErrorChain(err)}`);
                }

                tuiTask.status = "done";
                tuiTask.elapsed = Date.now() - startTime;
                if (verbose) log.success(`Task #${tui.state.tasks.indexOf(tuiTask) + 1}: done — "${task.text}" (${elapsed(tuiTask.elapsed)})`);
                completed++;
              } else {
                tuiTask.status = "failed";
                tuiTask.error = execResult.error;
                tuiTask.elapsed = Date.now() - startTime;
                if (verbose) log.error(`Task #${tui.state.tasks.indexOf(tuiTask) + 1}: failed — "${task.text}" (${elapsed(tuiTask.elapsed)})${tuiTask.error ? `: ${tuiTask.error}` : ""}`);
                failed++;
              }

              return execResult.data!.dispatchResult;
            })
          );

          issueResults.push(...batchResults);

          // Update TUI once the provider detects the actual model (lazy detection)
          if (!tui.state.model && localInstance.model) {
            tui.state.model = localInstance.model;
          }
        }
      }

      results.push(...issueResults);

      // ── Safety-net commit (stage any uncommitted changes) ─────
      if (!noBranch && branchName && defaultBranch && details) {
        try {
          await datasource.commitAllChanges(
            `chore: stage uncommitted changes for issue #${details.number}`,
            issueLifecycleOpts,
          );
          log.debug(`Staged uncommitted changes for issue #${details.number}`);
        } catch (err) {
          log.warn(`Could not commit uncommitted changes for issue #${details.number}: ${log.formatErrorChain(err)}`);
        }
      }

      // ── Commit agent (rewrite commits + generate PR metadata) ───
      let commitAgentResult: import("../agents/commit.js").CommitResult | undefined;
      if (!noBranch && branchName && defaultBranch && details) {
        try {
          const branchDiff = await getBranchDiff(defaultBranch, issueCwd);
          if (branchDiff) {
            const result = await localCommitAgent.generate({
              branchDiff,
              issue: details,
              taskResults: issueResults,
              cwd: issueCwd,
              worktreeRoot,
            });
            if (result.success) {
              commitAgentResult = result;
              // Rewrite commit history with the generated message
              try {
                await squashBranchCommits(defaultBranch, result.commitMessage, issueCwd);
                log.debug(`Rewrote commit message for issue #${details.number}`);
              } catch (err) {
                log.warn(`Could not rewrite commit message for issue #${details.number}: ${log.formatErrorChain(err)}`);
              }
            } else {
              log.warn(`Commit agent failed for issue #${details.number}: ${result.error}`);
            }
          }
        } catch (err) {
          log.warn(`Commit agent error for issue #${details.number}: ${log.formatErrorChain(err)}`);
        }
      }

      // ── Branch teardown (push, PR, cleanup) ──────────────────
      if (!noBranch && branchName && defaultBranch && details) {
        if (datasource.supportsGit()) {
          try {
            await datasource.pushBranch(branchName, issueLifecycleOpts);
            log.debug(`Pushed branch ${branchName}`);
          } catch (err) {
            log.warn(`Could not push branch ${branchName}: ${log.formatErrorChain(err)}`);
          }
        }

        if (datasource.supportsGit()) {
          try {
            const prTitle = commitAgentResult?.prTitle
              || await buildPrTitle(details.title, defaultBranch, issueLifecycleOpts.cwd);
            const prBody = commitAgentResult?.prDescription
              || await buildPrBody(
                details,
                fileTasks,
                issueResults,
                defaultBranch,
                datasource.name,
                issueLifecycleOpts.cwd,
              );
            const prUrl = await datasource.createPullRequest(
              branchName,
              details.number,
              prTitle,
              prBody,
              issueLifecycleOpts,
            );
            if (prUrl) {
              log.success(`Created PR for issue #${details.number}: ${prUrl}`);
            }
          } catch (err) {
            log.warn(`Could not create PR for issue #${details.number}: ${log.formatErrorChain(err)}`);
          }
        }

        if (useWorktrees && worktreePath) {
          // Remove worktree (cleanup handler is also registered for crash safety)
          try {
            await removeWorktree(cwd, file);
          } catch (err) {
            log.warn(`Could not remove worktree for issue #${details.number}: ${log.formatErrorChain(err)}`);
          }
        } else if (!useWorktrees && datasource.supportsGit()) {
          try {
            await datasource.switchBranch(defaultBranch, lifecycleOpts);
            log.debug(`Switched back to ${defaultBranch}`);
          } catch (err) {
            log.warn(`Could not switch back to ${defaultBranch}: ${log.formatErrorChain(err)}`);
          }
        }
      }

      // ── Per-worktree resource cleanup ───────────────────────────
      if (useWorktrees) {
        await localExecutor.cleanup();
        await localPlanner?.cleanup();
        await localInstance.cleanup();
      }
    };

    // Execute issues: parallel via worktrees, or serial fallback
    if (useWorktrees) {
      await Promise.all(
        Array.from(tasksByFile).map(([file, fileTasks]) =>
          processIssueFile(file, fileTasks)
        )
      );
    } else {
      for (const [file, fileTasks] of tasksByFile) {
        await processIssueFile(file, fileTasks);
      }
    }

    // ── 6. Close originating issues for completed spec files ────
    try {
      await closeCompletedSpecIssues(taskFiles, results, cwd, source, org, project, workItemType);
    } catch (err) {
      log.warn(`Could not close completed spec issues: ${log.formatErrorChain(err)}`);
    }

    // ── 7. Cleanup ──────────────────────────────────────────────
    // Per-worktree resources are cleaned up inside processIssueFile.
    // Shared resources (when !useWorktrees) are cleaned up here.
    await commitAgent?.cleanup();
    await executor?.cleanup();
    await planner?.cleanup();
    await instance?.cleanup();

    tui.state.phase = "done";
    tui.stop();
    if (verbose) log.success(`Done — ${completed} completed, ${failed} failed (${elapsed(Date.now() - tui.state.startTime)})`);

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
  workItemType?: string,
): Promise<DispatchSummary> {
  if (!source) {
    log.error("No datasource configured. Use --source or run 'dispatch config' to set up defaults.");
    return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
  }

  const datasource = getDatasource(source);
  const fetchOpts: IssueFetchOptions = { cwd, org, project, workItemType };

  const lifecycleOpts = { cwd };
  let username = "";
  try {
    username = await datasource.getUsername(lifecycleOpts);
  } catch {
    // Fall back to empty prefix if username resolution fails
  }

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
    const parsed = parseIssueFilename(task.file);
    const details = parsed ? items.find((item) => item.number === parsed.issueId) : undefined;
    const branchInfo = details
      ? ` [branch: ${datasource.buildBranchName(details.number, details.title, username)}]`
      : "";
    log.task(allTasks.indexOf(task), allTasks.length, `${task.file}:${task.line} — ${task.text}${branchInfo}`);
  }

  return {
    total: allTasks.length,
    completed: 0,
    failed: 0,
    skipped: allTasks.length,
    results: [],
  };
}
