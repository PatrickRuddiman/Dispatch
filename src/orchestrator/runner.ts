/**
 * Runner — thin coordinator that delegates to extracted pipeline modules.
 */

import type { DispatchResult } from "../dispatcher.js";
import type { AgentBootOptions } from "../agents/interface.js";
import type { ProviderName } from "../providers/interface.js";
import type { DatasourceName } from "../datasources/interface.js";
import type { SpecOptions, SpecSummary } from "../spec-generator.js";
import { defaultConcurrency, DEFAULT_SPEC_TIMEOUT_MIN, resolveSource } from "../spec-generator.js";
import { getDatasource } from "../datasources/index.js";
import { fetchItemsById } from "./datasource-helpers.js";
import { createWorktree, removeWorktree } from "../helpers/worktree.js";
import { registerCleanup } from "../helpers/cleanup.js";
import { log } from "../helpers/logger.js";
import { confirmLargeBatch } from "../helpers/confirm-large-batch.js";
import { checkPrereqs } from "../helpers/prereqs.js";
import { ensureGitignoreEntry } from "../helpers/gitignore.js";
import { resolveCliConfig } from "./cli-config.js";
import { runSpecPipeline } from "./spec-pipeline.js";
import { runDispatchPipeline } from "./dispatch-pipeline.js";

/** Progress event emitted by the dispatch pipeline for MCP monitoring. */
export interface DispatchProgressEvent {
  runId?: string;
  type: "task_start" | "task_done" | "task_failed" | "phase_change" | "log";
  taskId?: string;
  taskText?: string;
  phase?: string;
  message?: string;
  error?: string;
}

/** Runtime options passed to `orchestrate()`. */
export interface OrchestrateRunOptions {
  issueIds: string[];
  concurrency?: number;
  dryRun: boolean;
  noPlan?: boolean;
  noBranch?: boolean;
  noWorktree?: boolean;
  force?: boolean;
  provider?: ProviderName;
  /** Model override to pass to the provider (provider-specific format). */
  model?: string;
  serverUrl?: string;
  source?: DatasourceName;
  org?: string;
  project?: string;
  workItemType?: string;
  iteration?: string;
  area?: string;
  /** Configured username prefix for branch naming. */
  username?: string;
  planTimeout?: number;
  planRetries?: number;
  retries?: number;
  feature?: string | boolean;
  /** Optional callback for MCP progress notifications. */
  progressCallback?: (event: DispatchProgressEvent) => void;
}

/** Raw CLI arguments before config resolution. */
export interface RawCliArgs {
  issueIds: string[];
  dryRun: boolean;
  noPlan: boolean;
  noBranch: boolean;
  noWorktree: boolean;
  force: boolean;
  concurrency?: number;
  provider: ProviderName;
  /** Model override from config or CLI (provider-specific format). */
  model?: string;
  serverUrl?: string;
  cwd: string;
  verbose: boolean;
  spec?: string | string[];
  respec?: string | string[];
  fixTests?: boolean;
  issueSource?: DatasourceName;
  org?: string;
  project?: string;
  workItemType?: string;
  iteration?: string;
  area?: string;
  /** Configured username prefix for branch naming. */
  username?: string;
  planTimeout?: number;
  specTimeout?: number;
  specWarnTimeout?: number;
  specKillTimeout?: number;
  planRetries?: number;
  testTimeout?: number;
  retries?: number;
  feature?: string | boolean;
  outputDir?: string;
  explicitFlags: Set<string>;
}

export interface DispatchSummary {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  results: DispatchResult[];
}

/** Per-issue result for fix-tests runs targeting specific issues. */
export interface IssueResult {
  issueId: string;
  branch: string;
  success: boolean;
  error?: string;
}

export interface FixTestsSummary {
  mode: "fix-tests";
  success: boolean;
  error?: string;
  issueResults?: IssueResult[];
}

/** Dispatch-mode run options with explicit mode discriminator. */
export interface DispatchRunOptions extends OrchestrateRunOptions {
  mode: "dispatch";
}

/** Spec-mode run options with explicit mode discriminator. */
export interface SpecRunOptions extends Omit<SpecOptions, "cwd"> {
  mode: "spec";
}

/** Fix-tests-mode run options with explicit mode discriminator. */
export interface FixTestsRunOptions {
  mode: "fix-tests";
  testTimeout?: number;
  issueIds?: string[];
  provider?: ProviderName;
  serverUrl?: string;
  verbose?: boolean;
  dryRun?: boolean;
  source?: DatasourceName;
  org?: string;
  project?: string;
  cwd?: string;
}

/** Discriminated union of all runner run options. */
export type UnifiedRunOptions = DispatchRunOptions | SpecRunOptions | FixTestsRunOptions;

/** Unified result type — DispatchSummary or SpecSummary depending on mode. */
export type RunResult = DispatchSummary | SpecSummary | FixTestsSummary;

/** A booted runner that coordinates dispatch and spec pipelines. */
export interface OrchestratorAgent {
  orchestrate(opts: OrchestrateRunOptions): Promise<DispatchSummary>;
  generateSpecs(opts: SpecOptions): Promise<SpecSummary>;
  run(opts: UnifiedRunOptions): Promise<RunResult>;
  runFromCli(args: RawCliArgs): Promise<RunResult>;
}

/** Options for the multi-issue worktree fix-tests flow. */
interface MultiIssueFixTestsOptions {
  cwd: string;
  issueIds: string[];
  source: DatasourceName;
  provider: ProviderName;
  serverUrl?: string;
  verbose: boolean;
  testTimeout?: number;
  org?: string;
  project?: string;
  username?: string;
}

/**
 * Run fix-tests across multiple issues, each in its own worktree.
 *
 * Fetches the specified issues from the configured datasource,
 * creates a worktree per issue, runs `runFixTestsPipeline` inside
 * each worktree, and collects per-issue results.
 */
async function runMultiIssueFixTests(opts: MultiIssueFixTestsOptions): Promise<FixTestsSummary> {
  const { runFixTestsPipeline } = await import("./fix-tests-pipeline.js");
  const datasource = getDatasource(opts.source);
  const fetchOpts = { cwd: opts.cwd, org: opts.org, project: opts.project };
  const items = await fetchItemsById(opts.issueIds, datasource, fetchOpts);

  if (items.length === 0) {
    log.warn("No issues found for the given IDs");
    return { mode: "fix-tests", success: false, error: "No issues found" };
  }

  let username = "";
  try {
    username = await datasource.getUsername({ cwd: opts.cwd, username: opts.username });
  } catch (err) {
    log.warn(`Could not resolve git username for branch naming: ${log.formatErrorChain(err)}`);
  }

  log.info(`Running fix-tests for ${items.length} issue(s) in worktrees`);

  const issueResults: IssueResult[] = [];

  for (const item of items) {
    const branchName = datasource.buildBranchName(item.number, item.title, username);
    const issueFilename = `${item.number}-fix-tests.md`;
    let worktreePath: string | undefined;

    try {
      worktreePath = await createWorktree(opts.cwd, issueFilename, branchName);
      registerCleanup(async () => { await removeWorktree(opts.cwd, issueFilename); });
      log.info(`Created worktree for issue #${item.number} at ${worktreePath}`);

      const result = await runFixTestsPipeline({
        cwd: worktreePath,
        provider: opts.provider,
        serverUrl: opts.serverUrl,
        verbose: opts.verbose,
        testTimeout: opts.testTimeout,
      });

      issueResults.push({ issueId: item.number, branch: branchName, success: result.success, error: result.error });
    } catch (err) {
      const message = log.extractMessage(err);
      log.error(`Fix-tests failed for issue #${item.number}: ${message}`);
      issueResults.push({ issueId: item.number, branch: branchName, success: false, error: message });
    } finally {
      if (worktreePath) {
        try {
          await removeWorktree(opts.cwd, issueFilename);
        } catch (err) {
          log.warn(`Could not remove worktree for issue #${item.number}: ${log.formatErrorChain(err)}`);
        }
      }
    }
  }

  const allSuccess = issueResults.length > 0 && issueResults.every((r) => r.success);
  return { mode: "fix-tests", success: allSuccess, issueResults };
}

/** Boot a runner. */
export async function boot(opts: AgentBootOptions): Promise<OrchestratorAgent> {
  const { cwd } = opts;

  const runner: OrchestratorAgent = {
    orchestrate: (runOpts) => runDispatchPipeline(runOpts, cwd),

    generateSpecs: (specOpts) => runSpecPipeline(specOpts),

    async run(opts: UnifiedRunOptions): Promise<RunResult> {
      if (opts.mode === "spec") {
        const { mode: _, ...rest } = opts;
        return runner.generateSpecs({ ...rest, cwd });
      }
      if (opts.mode === "fix-tests") {
        const { runFixTestsPipeline } = await import("./fix-tests-pipeline.js");

        // No issue IDs — run in current cwd (existing behavior)
        if (!opts.issueIds || opts.issueIds.length === 0) {
          return runFixTestsPipeline({ cwd, provider: opts.provider ?? "opencode", serverUrl: opts.serverUrl, verbose: opts.verbose ?? false, testTimeout: opts.testTimeout });
        }

        // Multi-issue fix-tests via worktrees
        const source = opts.source;
        if (!source) {
          log.error("No datasource configured for multi-issue fix-tests.");
          return { mode: "fix-tests" as const, success: false, error: "No datasource configured" };
        }

        return runMultiIssueFixTests({
          cwd, issueIds: opts.issueIds, source,
          provider: opts.provider ?? "opencode", serverUrl: opts.serverUrl,
          verbose: opts.verbose ?? false, testTimeout: opts.testTimeout,
          org: opts.org, project: opts.project,
        });
      }
      const { mode: _, ...rest } = opts;
      return runner.orchestrate(rest);
    },

    async runFromCli(args: RawCliArgs): Promise<RunResult> {
      const m = await resolveCliConfig(args);

      // ── Prerequisite checks ───────────────────────────────────
      const prereqFailures = await checkPrereqs();
      if (prereqFailures.length > 0) {
        for (const msg of prereqFailures) {
          log.error(msg);
        }
        process.exit(1);
      }

      // Ensure .dispatch/worktrees/ is gitignored in the main repo
      await ensureGitignoreEntry(m.cwd, ".dispatch/worktrees/");

      // ── Mutual exclusion: --spec, --respec, --fix-tests ────
      const modeFlags = [
        m.spec !== undefined && "--spec",
        m.respec !== undefined && "--respec",
        m.fixTests && "--fix-tests",
        m.feature && "--feature",
      ].filter(Boolean) as string[];

      if (modeFlags.length > 1) {
        log.error(`${modeFlags.join(" and ")} are mutually exclusive`);
        process.exit(1);
      }

      // --feature requires branching — mutually exclusive with --no-branch
      if (m.feature && m.noBranch) {
        log.error("--feature and --no-branch are mutually exclusive");
        process.exit(1);
      }

      if (m.fixTests) {
        const { runFixTestsPipeline } = await import("./fix-tests-pipeline.js");

        // No issue IDs — run in current cwd (existing behavior)
        if (m.issueIds.length === 0) {
          return runFixTestsPipeline({ cwd: m.cwd, provider: m.provider, serverUrl: m.serverUrl, verbose: m.verbose, testTimeout: m.testTimeout });
        }

        // Multi-issue fix-tests via worktrees
        const source = m.issueSource;
        if (!source) {
          log.error("No datasource configured. Use --source or run 'dispatch config' to set up defaults.");
          process.exit(1);
        }

        return runMultiIssueFixTests({
          cwd: m.cwd, issueIds: m.issueIds, source,
          provider: m.provider, serverUrl: m.serverUrl,
          verbose: m.verbose, testTimeout: m.testTimeout,
          org: m.org, project: m.project, username: m.username,
        });
      }

      if (m.spec) {
        return this.generateSpecs({
          issues: m.spec, issueSource: m.issueSource, provider: m.provider,
          model: m.model, serverUrl: m.serverUrl, cwd: m.cwd, outputDir: m.outputDir,
          org: m.org, project: m.project, workItemType: m.workItemType, iteration: m.iteration, area: m.area, concurrency: m.concurrency,
          dryRun: m.dryRun, retries: m.retries,
          specTimeout: m.specTimeout ?? DEFAULT_SPEC_TIMEOUT_MIN,
          specWarnTimeout: m.specWarnTimeout,
          specKillTimeout: m.specKillTimeout,
        });
      }

      if (m.respec) {
        const respecArgs = m.respec;
        const isEmpty = Array.isArray(respecArgs) && respecArgs.length === 0;

        let issues: string | string[];
        if (isEmpty) {
          // No arguments: discover all existing specs via datasource.list()
          const source = await resolveSource(respecArgs, m.issueSource, m.cwd);
          if (!source) {
            process.exit(1);
          }
          const datasource = getDatasource(source);
          const existing = await datasource.list({ cwd: m.cwd, org: m.org, project: m.project, workItemType: m.workItemType, iteration: m.iteration, area: m.area });
          if (existing.length === 0) {
            log.error("No existing specs found to regenerate");
            process.exit(1);
          }
          const identifiers = existing.map((item) => item.number);
          const allNumeric = identifiers.every((id) => /^\d+$/.test(id));
          issues = allNumeric ? identifiers.join(",") : identifiers;

          const confirmed = await confirmLargeBatch(existing.length);
          if (!confirmed) {
            process.exit(0);
          }
        } else {
          // With arguments: pass directly (same as --spec)
          issues = respecArgs;
        }

        return this.generateSpecs({
          issues, issueSource: m.issueSource, provider: m.provider,
          model: m.model, serverUrl: m.serverUrl, cwd: m.cwd, outputDir: m.outputDir,
          org: m.org, project: m.project, workItemType: m.workItemType, iteration: m.iteration, area: m.area, concurrency: m.concurrency,
          dryRun: m.dryRun, retries: m.retries,
          specTimeout: m.specTimeout ?? DEFAULT_SPEC_TIMEOUT_MIN,
          specWarnTimeout: m.specWarnTimeout,
          specKillTimeout: m.specKillTimeout,
        });
      }

      return this.orchestrate({
        issueIds: m.issueIds, concurrency: m.concurrency ?? defaultConcurrency(),
        dryRun: m.dryRun, noPlan: m.noPlan, noBranch: m.noBranch, noWorktree: m.noWorktree, provider: m.provider,
        model: m.model, serverUrl: m.serverUrl, source: m.issueSource, org: m.org, project: m.project,
        workItemType: m.workItemType, iteration: m.iteration, area: m.area, planTimeout: m.planTimeout, planRetries: m.planRetries, retries: m.retries,
        force: m.force, feature: m.feature, username: m.username,
      });
    },
  };

  return runner;
}

export { parseIssueFilename } from "./datasource-helpers.js";
