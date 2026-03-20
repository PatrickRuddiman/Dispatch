/**
 * Dispatch pipeline — the core execution pipeline that discovers tasks,
 * optionally plans them via the planner agent, executes them via the
 * executor agent, syncs completion state back to the datasource, and
 * cleans up resources.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { parseTaskFile, buildTaskContext, groupTasksByMode, type TaskFile, type Task } from "../parser.js";
import type { DispatchResult } from "../dispatcher.js";
import { boot as bootPlanner, type PlannerAgent } from "../agents/planner.js";
import type { AgentResult, PlannerData, ExecutorData } from "../agents/types.js";
import { boot as bootExecutor, type ExecutorAgent } from "../agents/executor.js";
import { boot as bootCommit, type CommitAgent } from "../agents/commit.js";
import { log } from "../helpers/logger.js";
import { registerCleanup } from "../helpers/cleanup.js";
import { createWorktree, removeWorktree, worktreeName, generateFeatureBranchName } from "../helpers/worktree.js";
import { isValidBranchName } from "../helpers/branch-validation.js";
import { createTui, type TuiState } from "../tui.js";
import type { ProviderName, ProviderInstance } from "../providers/interface.js";
import { bootProvider } from "../providers/index.js";
import { getDatasource } from "../datasources/index.js";
import type { DatasourceName, DispatchLifecycleOptions, IssueDetails, IssueFetchOptions } from "../datasources/interface.js";
import { ensureAuthReady, setAuthPromptHandler } from "../helpers/auth.js";
import type { OrchestrateRunOptions, DispatchSummary } from "./runner.js";
import {
  fetchItemsById,
  writeItemsToTempDir,
  parseIssueFilename,
  buildPrBody,
  buildPrTitle,
  buildFeaturePrTitle,
  buildFeaturePrBody,
  getBranchDiff,
  squashBranchCommits,
} from "./datasource-helpers.js";
import { DEFAULT_PLAN_TIMEOUT_MIN, withTimeout, TimeoutError } from "../helpers/timeout.js";
import { DEFAULT_RETRY_COUNT, withRetry } from "../helpers/retry.js";
import { runWithConcurrency } from "../helpers/concurrency.js";
import { isGlobOrFilePath } from "../spec-generator.js";
import { extractTitle } from "../datasources/md.js";
import chalk from "chalk";
import { elapsed, renderHeaderLines } from "../helpers/format.js";
import { FileLogger, fileLoggerStorage } from "../helpers/file-logger.js";

const exec = promisify(execFile);

/**
 * Expand glob patterns / file paths into IssueDetails[].
 * Mirrors resolveFileItems() from the spec pipeline.
 */
async function resolveGlobItems(
  patterns: string[],
  cwd: string,
): Promise<IssueDetails[]> {
  const files = await glob(patterns, { cwd, absolute: true });

  if (files.length === 0) {
    log.warn(`No files matched the pattern(s): ${patterns.join(", ")}`);
    return [];
  }

  log.info(`Matched ${files.length} file(s) from glob pattern(s)`);

  const items: IssueDetails[] = [];
  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf-8");
      const title = extractTitle(content, filePath);
      items.push({
        number: filePath,
        title,
        body: content,
        labels: [],
        state: "open",
        url: filePath,
        comments: [],
        acceptanceCriteria: "",
      });
    } catch (err) {
      log.warn(`Could not read file ${filePath}: ${log.formatErrorChain(err)}`);
    }
  }
  return items;
}

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
    concurrency = 1,
    dryRun,
    serverUrl,
    noPlan,
    noBranch: noBranchOpt,
    noWorktree,
    feature,
    provider = "opencode",
    model,
    source,
    org,
    project,
    workItemType,
    iteration,
    area,
    planTimeout,
    planRetries,
    retries,
    username: usernameOverride,
  } = opts;
  let noBranch = noBranchOpt;

  // Planning timeout/retry defaults
  const resolvedRetries = retries ?? DEFAULT_RETRY_COUNT;
  const resolvedPlanTimeoutMin = planTimeout ?? DEFAULT_PLAN_TIMEOUT_MIN;
  const planTimeoutMs = resolvedPlanTimeoutMin * 60_000;
  const resolvedPlanRetries = planRetries ?? resolvedRetries;
  const maxPlanAttempts = resolvedPlanRetries + 1; // retries + initial attempt

  log.debug(`Plan timeout: ${resolvedPlanTimeoutMin}m (${planTimeoutMs}ms), max attempts: ${maxPlanAttempts}`);

  // Dry-run mode uses simple log output
  if (dryRun) {
    return dryRunMode(issueIds, cwd, source, org, project, workItemType, iteration, area, usernameOverride);
  }

  // Pre-authenticate before TUI starts so device codes are visible in the terminal.
  // For cached tokens this is instant; for new auth it runs the device flow
  // while stdout is still free.
  await ensureAuthReady(source, cwd, org);

  // ── Start TUI (or inline logging for verbose mode) ──────────
  const verbose = log.verbose;
  const canRecoverInteractively = !verbose && process.stdin.isTTY === true && process.stdout.isTTY === true;
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
    tui = {
      state,
      update: () => {},
      stop: () => {},
      waitForRecoveryAction: async () => "quit",
    };
  } else {
    tui = createTui();
    tui.state.provider = provider;
    tui.state.source = source;

    // Route auth device-code prompts into the TUI notification banner
    setAuthPromptHandler((msg) => {
      tui.state.notification = msg;
      tui.update();
    });
  }

  try {
    // ── 1. Discover task files ──────────────────────────────────
    tui.state.phase = "discovering";

    if (!source) {
      tui.state.phase = "done";
      setAuthPromptHandler(null);
      tui.stop();
      log.error("No datasource configured. Use --source or run 'dispatch config' to set up defaults.");
      return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
    }

    const datasource = getDatasource(source);

    // When using the md datasource, git operations are optional — they only
    // work when dispatch is run from inside a git repository. If no repo is
    // found, disable branching so the pipeline can still complete its work.
    if (source === "md" && !noBranch) {
      try {
        await exec("git", ["rev-parse", "--git-dir"], { cwd, shell: process.platform === "win32" });
      } catch {
        noBranch = true;
        if (verbose) log.debug("No git repository found — skipping git operations for md datasource");
      }
    }

    const fetchOpts: IssueFetchOptions = { cwd, org, project, workItemType, iteration, area };
    let items: IssueDetails[];
    if (issueIds.length > 0 && source === "md" && issueIds.some(id => isGlobOrFilePath(id))) {
      items = await resolveGlobItems(issueIds, cwd);
    } else if (issueIds.length > 0) {
      items = await fetchItemsById(issueIds, datasource, fetchOpts);
    } else {
      items = await datasource.list(fetchOpts);
    }

    // Auth is complete — clear the notification banner and handler
    tui.state.notification = undefined;
    setAuthPromptHandler(null);

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
    const useWorktrees = !noWorktree && (feature || (!noBranch && tasksByFile.size > 1));

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
    let halted = false;

    const lifecycleOpts: DispatchLifecycleOptions = { cwd, username: usernameOverride };

    // ── Capture the branch the user is currently on ────────────────
    // This is used as the base for new branches, PR targets, and the
    // branch to return to after completion.  When the user is on main
    // this naturally resolves to main; when on release/1.4.3 it uses
    // that branch instead.
    const startingBranch = await datasource.getCurrentBranch(lifecycleOpts);

    // ── Feature-branch setup (when --feature) ──────────────────────
    let featureBranchName: string | undefined;
    let featureDefaultBranch: string | undefined;

    if (feature) {
      // Resolve the feature branch name
      if (typeof feature === "string") {
        if (!isValidBranchName(feature)) {
          log.error(`Invalid feature branch name: "${feature}"`);
          tui.state.phase = "done";
          tui.stop();
          return { total: allTasks.length, completed: 0, failed: allTasks.length, skipped: 0, results: [] };
        }
        featureBranchName = feature.includes("/") ? feature : `dispatch/${feature}`;
      } else {
        featureBranchName = generateFeatureBranchName();
      }

      try {
        featureDefaultBranch = startingBranch;

        // Ensure we are on the starting branch so the feature branch starts from the correct commit
        await datasource.switchBranch(featureDefaultBranch, lifecycleOpts);

        // Create the feature branch from the starting branch (or switch to it if it already exists)
        try {
          await datasource.createAndSwitchBranch(featureBranchName, lifecycleOpts);
          log.debug(`Created feature branch ${featureBranchName} from ${featureDefaultBranch}`);
        } catch (createErr) {
          const message = log.extractMessage(createErr);
          if (message.includes("already exists")) {
            await datasource.switchBranch(featureBranchName, lifecycleOpts);
            log.debug(`Switched to existing feature branch ${featureBranchName}`);
          } else {
            throw createErr;
          }
        }

        // Register cleanup for the feature branch
        registerCleanup(async () => {
          try {
            await datasource.switchBranch(featureDefaultBranch!, lifecycleOpts);
          } catch { /* swallow */ }
        });

        // Switch back to starting branch so worktrees can be created from the main repo
        await datasource.switchBranch(featureDefaultBranch, lifecycleOpts);
        log.debug(`Switched back to ${featureDefaultBranch} for worktree creation`);
      } catch (err) {
        log.error(`Feature branch creation failed: ${log.extractMessage(err)}`);
        tui.state.phase = "done";
        tui.stop();
        return { total: allTasks.length, completed: 0, failed: allTasks.length, skipped: 0, results: [] };
      }
    }

    // Resolve git username once for branch naming
    let username = "";
    try {
      username = await datasource.getUsername(lifecycleOpts);
    } catch (err) {
      log.warn(`Could not resolve git username for branch naming: ${log.formatErrorChain(err)}`);
    }

    // Process a single issue file's tasks — handles both worktree and
    // serial branch modes, parameterised by useWorktrees.
    const processIssueFile = async (file: string, fileTasks: typeof allTasks): Promise<{ halted: boolean }> => {
      const details = issueDetailsByFile.get(file);
      const fileLogger = verbose && details ? new FileLogger(details.number, cwd) : null;

      const body = async () => {
        let defaultBranch: string | undefined;
        let branchName: string | undefined;
        let worktreePath: string | undefined;
        let issueCwd = cwd;
        let preserveContext = false;

        const upsertResult = (collection: DispatchResult[], result: DispatchResult) => {
          const index = collection.findIndex((entry) => entry.task === result.task);
          if (index >= 0) {
            collection[index] = result;
          } else {
            collection.push(result);
          }
        };

        // ── Branch / worktree setup (unless --no-branch) ────────────
        if (!noBranch && details) {
          fileLogger?.phase("Branch/worktree setup");
          try {
            defaultBranch = feature ? featureBranchName! : startingBranch;
            branchName = datasource.buildBranchName(details.number, details.title, username);

            if (useWorktrees) {
              worktreePath = await createWorktree(cwd, file, branchName, ...(feature && featureBranchName ? [featureBranchName] : []));
              registerCleanup(async () => { await removeWorktree(cwd, file); });
              issueCwd = worktreePath;
              log.debug(`Created worktree for issue #${details.number} at ${worktreePath}`);
              fileLogger?.info(`Worktree created at ${worktreePath}`);

              const wtName = worktreeName(file);
              for (const task of fileTasks) {
                const tuiTask = tui.state.tasks.find((t) => t.task === task);
                if (tuiTask) tuiTask.worktree = wtName;
              }
            } else if (datasource.supportsGit()) {
              await datasource.createAndSwitchBranch(branchName, lifecycleOpts);
              log.debug(`Switched to branch ${branchName}`);
              fileLogger?.info(`Switched to branch ${branchName}`);
            }
          } catch (err) {
            const errorMsg = `Branch creation failed for issue #${details.number}: ${log.extractMessage(err)}`;
            fileLogger?.error(`Branch creation failed: ${log.extractMessage(err)}${err instanceof Error && err.stack ? `\n${err.stack}` : ""}`);
            log.error(errorMsg);
            for (const task of fileTasks) {
              const tuiTask = tui.state.tasks.find((t) => t.task === task);
              if (tuiTask) {
                tuiTask.status = "failed";
                tuiTask.error = errorMsg;
              }
              upsertResult(results, { task, success: false, error: errorMsg });
            }
            return { halted: false };
          }
        }

        const worktreeRoot = useWorktrees ? worktreePath : undefined;
        const issueLifecycleOpts: DispatchLifecycleOptions = { cwd: issueCwd, username: usernameOverride };

        fileLogger?.phase("Provider/agent boot");
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
          fileLogger?.info(`Provider booted: ${localInstance.model ?? provider}`);
        } else {
          localInstance = instance!;
          localPlanner = planner;
          localExecutor = executor!;
          localCommitAgent = commitAgent!;
        }

        const issueResults: DispatchResult[] = [];

        const pauseTask = (task: Task, error: string) => {
          const tuiTask = tui.state.tasks.find((entry) => entry.task === task)!;
          tuiTask.status = "paused";
          tuiTask.error = error;
          tui.state.phase = "paused";
          tui.state.recovery = {
            taskIndex: tui.state.tasks.indexOf(tuiTask),
            taskText: task.text,
            error,
            issue: details ? { number: details.number, title: details.title } : undefined,
            worktree: tuiTask.worktree ?? worktreeRoot,
            selectedAction: "rerun",
          };
          tui.update();
          return tuiTask;
        };

        const clearRecovery = () => {
          tui.state.recovery = undefined;
          tui.state.phase = "dispatching";
          tui.update();
        };

        const runTaskLifecycle = async (task: Task): Promise<
          | { kind: "success"; result: DispatchResult }
          | { kind: "paused"; error: string }
        > => {
          const tuiTask = tui.state.tasks.find((entry) => entry.task === task)!;
          const startTime = Date.now();
          let plan: string | undefined;

          tuiTask.elapsed = startTime;
          tuiTask.error = undefined;

          if (localPlanner) {
            tuiTask.status = "planning";
            fileLogger?.phase(`Planning task: ${task.text}`);
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
                break;
              } catch (err) {
                if (err instanceof TimeoutError) {
                  log.warn(`Planning timed out for task "${task.text}" (attempt ${attempt}/${maxPlanAttempts})`);
                  fileLogger?.warn(`Planning timeout (attempt ${attempt}/${maxPlanAttempts})`);
                  if (attempt < maxPlanAttempts) {
                    log.debug(`Retrying planning (attempt ${attempt + 1}/${maxPlanAttempts})`);
                    fileLogger?.info(`Retrying planning (attempt ${attempt + 1}/${maxPlanAttempts})`);
                  }
                } else {
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

            if (!planResult) {
              planResult = {
                data: null,
                success: false,
                error: `Planning timed out after ${resolvedPlanTimeoutMin}m (${maxPlanAttempts} attempts)`,
                durationMs: 0,
              };
            }

            if (!planResult.success) {
              const error = `Planning failed: ${planResult.error}`;
              fileLogger?.error(error);
              tuiTask.elapsed = Date.now() - startTime;
              pauseTask(task, error);
              if (verbose) log.error(`Task #${tui.state.tasks.indexOf(tuiTask) + 1}: paused — ${error} (${elapsed(tuiTask.elapsed)})`);
              return { kind: "paused", error };
            }

            plan = planResult.data.prompt;
            fileLogger?.info(`Planning completed (${planResult.durationMs ?? 0}ms)`);
          }

          tuiTask.status = "running";
          fileLogger?.phase(`Executing task: ${task.text}`);
          if (verbose) log.info(`Task #${tui.state.tasks.indexOf(tuiTask) + 1}: executing — "${task.text}"`);
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
            resolvedRetries,
            { label: `executor "${task.text}"` },
          ).catch((err): AgentResult<ExecutorData> => ({
            data: null,
            success: false,
            error: log.extractMessage(err),
            durationMs: 0,
          }));

          if (!execResult.success) {
            const error = execResult.error ?? "Executor failed without returning a dispatch result.";
            fileLogger?.error(`Execution failed: ${error}`);
            tuiTask.elapsed = Date.now() - startTime;
            pauseTask(task, error);
            if (verbose) log.error(`Task #${tui.state.tasks.indexOf(tuiTask) + 1}: paused — "${task.text}" (${elapsed(tuiTask.elapsed)})${error ? `: ${error}` : ""}`);
            return { kind: "paused", error };
          }

          fileLogger?.info(`Execution completed successfully (${Date.now() - startTime}ms)`);
          try {
            const parsed = parseIssueFilename(task.file);
            const updatedContent = await readFile(task.file, "utf-8");
            if (parsed) {
              const issueDetails = issueDetailsByFile.get(task.file);
              const title = issueDetails?.title ?? parsed.slug;
              await datasource.update(parsed.issueId, title, updatedContent, fetchOpts);
              log.success(`Synced task completion to issue #${parsed.issueId}`);
            } else {
              const issueDetails = issueDetailsByFile.get(task.file);
              if (issueDetails) {
                await datasource.update(issueDetails.number, issueDetails.title, updatedContent, fetchOpts);
                log.success(`Synced task completion to issue #${issueDetails.number}`);
              }
            }
          } catch (err) {
            log.warn(`Could not sync task completion to datasource: ${log.formatErrorChain(err)}`);
          }

          tuiTask.status = "done";
          tuiTask.error = undefined;
          tuiTask.elapsed = Date.now() - startTime;
          if (verbose) log.success(`Task #${tui.state.tasks.indexOf(tuiTask) + 1}: done — "${task.text}" (${elapsed(tuiTask.elapsed)})`);
          return { kind: "success", result: execResult.data.dispatchResult };
        };

        const recoverPausedTask = async (task: Task, error: string): Promise<{ halted: boolean; result: DispatchResult }> => {
          while (true) {
            const tuiTask = pauseTask(task, error);

            if (!canRecoverInteractively) {
              log.warn("Manual rerun requires an interactive terminal; verbose or non-TTY runs will not wait for input, and the current branch/worktree will be left intact.");
              tuiTask.status = "failed";
              clearRecovery();
              return { halted: true, result: { task, success: false, error } };
            }

            const action = await tui.waitForRecoveryAction();
            if (action === "quit") {
              tuiTask.status = "failed";
              clearRecovery();
              return { halted: true, result: { task, success: false, error } };
            }

            clearRecovery();
            const rerun = await runTaskLifecycle(task);
            if (rerun.kind === "success") {
              return { halted: false, result: rerun.result };
            }
            error = rerun.error;
          }
        };

        const groups = groupTasksByMode(fileTasks);
        let stopAfterIssue = false;

        for (const group of groups) {
          const groupResults = await runWithConcurrency({
            items: group,
            concurrency,
            worker: async (task) => runTaskLifecycle(task),
            shouldStop: () => stopAfterIssue,
          });

          const pausedTasks: Array<{ task: Task; error: string }> = [];

          for (let i = 0; i < group.length; i++) {
            const result = groupResults[i];
            if (result.status === "rejected") {
              // Unexpected rejection — treat as a paused task
              pausedTasks.push({ task: group[i], error: String(result.reason) });
              continue;
            }
            const outcome = result.value;
            if (outcome.kind === "success") {
              upsertResult(issueResults, outcome.result);
              upsertResult(results, outcome.result);
            } else {
              pausedTasks.push({ task: group[i], error: outcome.error });
            }
          }

          for (const pausedTask of pausedTasks) {
            const resolution = await recoverPausedTask(pausedTask.task, pausedTask.error);
            upsertResult(issueResults, resolution.result);
            upsertResult(results, resolution.result);
            if (resolution.halted) {
              preserveContext = true;
              stopAfterIssue = true;
              halted = true;
              break;
            }
          }

          if (!tui.state.model && localInstance.model) {
            tui.state.model = localInstance.model;
          }

          if (stopAfterIssue) break;
        }

        if (!preserveContext) {
          if (!noBranch && branchName && defaultBranch && details && datasource.supportsGit()) {
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

          fileLogger?.phase("Commit generation");
          let commitAgentResult: import("../agents/commit.js").CommitResult | undefined;
          if (!noBranch && branchName && defaultBranch && details && datasource.supportsGit()) {
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
                  fileLogger?.info(`Commit message generated for issue #${details.number}`);
                  try {
                    await squashBranchCommits(defaultBranch, result.commitMessage, issueCwd);
                    log.debug(`Rewrote commit message for issue #${details.number}`);
                    fileLogger?.info(`Rewrote commit history for issue #${details.number}`);
                  } catch (err) {
                    log.warn(`Could not rewrite commit message for issue #${details.number}: ${log.formatErrorChain(err)}`);
                  }
                } else {
                  log.warn(`Commit agent failed for issue #${details.number}: ${result.error}`);
                  fileLogger?.warn(`Commit agent failed: ${result.error}`);
                }
              }
            } catch (err) {
              log.warn(`Commit agent error for issue #${details.number}: ${log.formatErrorChain(err)}`);
            }
          }

          fileLogger?.phase("PR lifecycle");
          if (!noBranch && branchName && defaultBranch && details) {
            if (feature && featureBranchName) {
              if (worktreePath) {
                try {
                  await removeWorktree(cwd, file);
                } catch (err) {
                  log.warn(`Could not remove worktree for issue #${details.number}: ${log.formatErrorChain(err)}`);
                }
              }

              try {
                await datasource.switchBranch(featureBranchName, lifecycleOpts);
                await exec("git", ["merge", branchName, "--no-ff", "-m", `merge: issue #${details.number}`], { cwd, shell: process.platform === "win32" });
                log.debug(`Merged ${branchName} into ${featureBranchName}`);
              } catch (err) {
                const mergeError = `Could not merge ${branchName} into feature branch: ${log.formatErrorChain(err)}`;
                log.warn(mergeError);
                try {
                  await exec("git", ["merge", "--abort"], { cwd, shell: process.platform === "win32" });
                } catch { }
                for (const task of fileTasks) {
                  const tuiTask = tui.state.tasks.find((t) => t.task === task);
                  if (tuiTask) {
                    tuiTask.status = "failed";
                    tuiTask.error = mergeError;
                  }
                  upsertResult(results, { task, success: false, error: mergeError });
                }
                return { halted: false };
              }

              try {
                await exec("git", ["branch", "-d", branchName], { cwd, shell: process.platform === "win32" });
                log.debug(`Deleted local branch ${branchName}`);
              } catch (err) {
                log.warn(`Could not delete local branch ${branchName}: ${log.formatErrorChain(err)}`);
              }

              try {
                await datasource.switchBranch(featureDefaultBranch!, lifecycleOpts);
              } catch (err) {
                log.warn(`Could not switch back to ${featureDefaultBranch}: ${log.formatErrorChain(err)}`);
              }
            } else {
              if (datasource.supportsGit()) {
                try {
                  await datasource.pushBranch(branchName, issueLifecycleOpts);
                  log.debug(`Pushed branch ${branchName}`);
                  fileLogger?.info(`Pushed branch ${branchName}`);
                } catch (err) {
                  log.warn(`Could not push branch ${branchName}: ${log.formatErrorChain(err)}`);
                }
              }

              if (datasource.supportsGit()) {
                try {
                  const prTitle = commitAgentResult?.prTitle || await buildPrTitle(details.title, defaultBranch, issueLifecycleOpts.cwd);
                  const prBody = commitAgentResult?.prDescription || await buildPrBody(
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
                    startingBranch,
                  );
                  if (prUrl) {
                    log.success(`Created PR for issue #${details.number}: ${prUrl}`);
                    fileLogger?.info(`Created PR: ${prUrl}`);
                  }
                } catch (err) {
                  log.warn(`Could not create PR for issue #${details.number}: ${log.formatErrorChain(err)}`);
                  fileLogger?.warn(`PR creation failed: ${log.extractMessage(err)}`);
                }
              }

              if (useWorktrees && worktreePath) {
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
          }
        }

        fileLogger?.phase("Resource cleanup");
        if (useWorktrees) {
          await localExecutor.cleanup();
          await localPlanner?.cleanup();
          await localInstance.cleanup();
        }

        return { halted: stopAfterIssue };
      };

      if (fileLogger) {
        return fileLoggerStorage.run(fileLogger, async () => {
          try {
            return await body();
          } finally {
            fileLogger.close();
          }
        });
      }

      return body();
    };

    // Execute issues: parallel via worktrees, or serial fallback
    // Feature mode forces serial execution to avoid merge conflicts
    if (useWorktrees && !feature) {
      // Sliding-window concurrency: up to `concurrency` issues in parallel
      const issueEntries = Array.from(tasksByFile.entries());
      const concurrencyResults = await runWithConcurrency({
        items: issueEntries,
        concurrency,
        worker: async ([file, fileTasks]) => processIssueFile(file, fileTasks),
        shouldStop: () => halted,
      });
      for (const result of concurrencyResults) {
        if (result?.status === "fulfilled" && result.value?.halted) {
          halted = true;
        }
      }
    } else {
      // Sequential: non-worktree mode or feature mode
      for (const [file, fileTasks] of tasksByFile) {
        const issueResult = await processIssueFile(file, fileTasks);
        if (issueResult?.halted) {
          halted = true;
          break;
        }
      }
    }

    // ── Feature branch finalization (push + aggregated PR) ──────
    if (!halted && feature && featureBranchName && featureDefaultBranch) {
      try {
        await datasource.switchBranch(featureBranchName, lifecycleOpts);
        log.debug(`Switched to feature branch ${featureBranchName}`);
      } catch (err) {
        log.warn(`Could not switch to feature branch: ${log.formatErrorChain(err)}`);
      }

      try {
        await datasource.pushBranch(featureBranchName, lifecycleOpts);
        log.debug(`Pushed feature branch ${featureBranchName}`);
      } catch (err) {
        log.warn(`Could not push feature branch: ${log.formatErrorChain(err)}`);
      }

      try {
        const allIssueDetails = Array.from(issueDetailsByFile.values());
        const prTitle = buildFeaturePrTitle(featureBranchName, allIssueDetails);
        const prBody = buildFeaturePrBody(allIssueDetails, allTasks, results, source!);
        const primaryIssue = allIssueDetails[0]?.number ?? "";
        const prUrl = await datasource.createPullRequest(
          featureBranchName,
          primaryIssue,
          prTitle,
          prBody,
          lifecycleOpts,
          startingBranch,
        );
        if (prUrl) {
          log.success(`Created feature PR: ${prUrl}`);
        }
      } catch (err) {
        log.warn(`Could not create feature PR: ${log.formatErrorChain(err)}`);
      }

      try {
        await datasource.switchBranch(featureDefaultBranch, lifecycleOpts);
      } catch (err) {
        log.warn(`Could not switch back to ${featureDefaultBranch}: ${log.formatErrorChain(err)}`);
      }
    }

    // ── 6. Cleanup ──────────────────────────────────────────────
    // Per-worktree resources are cleaned up inside processIssueFile.
    // Shared resources (when !useWorktrees) are cleaned up here.
    await commitAgent?.cleanup();
    await executor?.cleanup();
    await planner?.cleanup();
    await instance?.cleanup();

    const completed = results.filter((result) => result.success).length;
    const failed = results.filter((result) => !result.success).length;

    tui.state.phase = "done";
    setAuthPromptHandler(null);
    tui.stop();
    if (verbose) log.success(`Done — ${completed} completed, ${failed} failed (${elapsed(Date.now() - tui.state.startTime)})`);

    return { total: allTasks.length, completed, failed, skipped: 0, results };
  } catch (err) {
    setAuthPromptHandler(null);
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
  iteration?: string,
  area?: string,
  username?: string,
): Promise<DispatchSummary> {
  if (!source) {
    log.error("No datasource configured. Use --source or run 'dispatch config' to set up defaults.");
    return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
  }

  const datasource = getDatasource(source);
  const fetchOpts: IssueFetchOptions = { cwd, org, project, workItemType, iteration, area };

  const lifecycleOpts: DispatchLifecycleOptions = { cwd, username };
  let resolvedUsername = "";
  try {
    resolvedUsername = await datasource.getUsername(lifecycleOpts);
  } catch {
    // Fall back to empty prefix if username resolution fails
  }

  let items: IssueDetails[];
  if (issueIds.length > 0 && source === "md" && issueIds.some(id => isGlobOrFilePath(id))) {
    items = await resolveGlobItems(issueIds, cwd);
  } else if (issueIds.length > 0) {
    items = await fetchItemsById(issueIds, datasource, fetchOpts);
  } else {
    items = await datasource.list(fetchOpts);
  }

  if (items.length === 0) {
    const label = issueIds.length > 0 ? `issue(s) ${issueIds.join(", ")}` : `datasource: ${source}`;
    log.warn("No work items found from " + label);
    return { total: 0, completed: 0, failed: 0, skipped: 0, results: [] };
  }

  const { files, issueDetailsByFile } = await writeItemsToTempDir(items);

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
    const details = parsed
      ? items.find((item) => item.number === parsed.issueId)
      : issueDetailsByFile.get(task.file);
    const branchInfo = details
      ? ` [branch: ${datasource.buildBranchName(details.number, details.title, resolvedUsername)}]`
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
