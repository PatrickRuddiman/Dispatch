/**
 * Runner — thin coordinator that delegates to extracted pipeline modules.
 */

import { randomUUID } from "node:crypto";
import type { DispatchResult } from "../dispatcher.js";
import type { ProviderModelConfig, DispatchConfig } from "../config.js";
import { CONFIG_BOUNDS } from "../config.js";
import type { ProviderName } from "../providers/interface.js";
import type { DatasourceName } from "../datasources/interface.js";
import type { SpecOptions, SpecSummary } from "../spec-generator.js";
import { defaultConcurrency, DEFAULT_SPEC_TIMEOUT_MIN, resolveSource } from "../spec-generator.js";
import { getDatasource } from "../datasources/index.js";
import { log } from "../helpers/logger.js";
import { confirmLargeBatch } from "../helpers/confirm-large-batch.js";
import { checkPrereqs } from "../helpers/prereqs.js";
import { ensureGitignoreEntry } from "../helpers/gitignore.js";
import { openDatabase } from "../mcp/state/database.js";
import {
  createRun, createSpecRun, getRun, getTasksForRun,
  markOrphanedRunsFailed, listResumableSessions, requeueSessionRuns,
  waitForRunCompletion,
} from "../mcp/state/manager.js";
import { initRunQueue, getRunQueue } from "../queue/run-queue.js";
import { resolveCliConfig } from "./cli-config.js";
import { runSpecPipeline } from "./spec-pipeline.js";
import { runDispatchPipeline } from "./dispatch-pipeline.js";

/** Progress event emitted by the dispatch pipeline for MCP monitoring. */
export type DispatchProgressEvent =
  | { type: "task_start"; runId?: string; taskId: string; taskText: string; phase?: string; file?: string; line?: number }
  | { type: "task_done";  runId?: string; taskId: string; taskText: string }
  | { type: "task_failed"; runId?: string; taskId: string; taskText: string; error: string }
  | { type: "phase_change"; runId?: string; phase: string; message?: string }
  | { type: "log"; runId?: string; message: string };

/** Runtime options passed to `orchestrate()`. */
export interface OrchestrateRunOptions {
  issueIds: string[];
  concurrency?: number;
  dryRun: boolean;
  noPlan?: boolean;
  noBranch?: boolean;
  noWorktree?: boolean;
  force?: boolean;
  /** Force a specific provider for all roles (CLI --provider override). */
  provider?: ProviderName;
  /** Authenticated providers from config — router uses these for auto-selection. */
  enabledProviders?: ProviderName[];
  /** Per-provider model overrides from config. */
  providerModels?: Partial<Record<ProviderName, ProviderModelConfig>>;
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
  /** Force a specific provider for all roles (CLI --provider override). */
  provider?: ProviderName;
  /** Authenticated providers from config. */
  enabledProviders?: ProviderName[];
  /** Per-provider model overrides from config. */
  providerModels?: Partial<Record<ProviderName, ProviderModelConfig>>;
  serverUrl?: string;
  cwd: string;
  verbose: boolean;
  spec?: string | string[];
  respec?: string | string[];
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
  retries?: number;
  feature?: string | boolean;
  resume?: string | boolean;
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

/** Dispatch-mode run options with explicit mode discriminator. */
export interface DispatchRunOptions extends OrchestrateRunOptions {
  mode: "dispatch";
}

/** Spec-mode run options with explicit mode discriminator. */
export interface SpecRunOptions extends Omit<SpecOptions, "cwd"> {
  mode: "spec";
}

/** Discriminated union of all runner run options. */
export type UnifiedRunOptions = DispatchRunOptions | SpecRunOptions;

/** Unified result type — DispatchSummary or SpecSummary depending on mode. */
export type RunResult = DispatchSummary | SpecSummary;

/** A booted runner that coordinates dispatch and spec pipelines. */
export interface OrchestratorAgent {
  orchestrate(opts: OrchestrateRunOptions): Promise<DispatchSummary>;
  generateSpecs(opts: SpecOptions): Promise<SpecSummary>;
  run(opts: UnifiedRunOptions): Promise<RunResult>;
  runFromCli(args: RawCliArgs): Promise<RunResult>;
}

/** Boot a runner. */
export async function boot(opts: { cwd: string }): Promise<OrchestratorAgent> {
  const { cwd } = opts;

  const runner: OrchestratorAgent = {
    orchestrate: (runOpts) => runDispatchPipeline(runOpts, cwd),

    generateSpecs: (specOpts) => runSpecPipeline(specOpts),

    async run(opts: UnifiedRunOptions): Promise<RunResult> {
      switch (opts.mode) {
        case "spec": {
          const { mode: _, ...rest } = opts;
          return runner.generateSpecs({ ...rest, cwd });
        }
        case "dispatch": {
          const { mode: _, ...rest } = opts;
          return runner.orchestrate(rest);
        }
        default: {
          const _exhaustive: never = opts;
          throw new Error(`Unhandled run mode: ${JSON.stringify(_exhaustive)}`);
        }
      }
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

      // ── Mutual exclusion: --spec, --respec, --feature ──────
      const modeFlags = [
        m.spec !== undefined && "--spec",
        m.respec !== undefined && "--respec",
        m.feature && "--feature",
      ].filter((f): f is string => typeof f === "string");

      if (modeFlags.length > 1) {
        log.error(`${modeFlags.join(" and ")} are mutually exclusive`);
        process.exit(1);
      }

      // --feature requires branching — mutually exclusive with --no-branch
      if (m.feature && m.noBranch) {
        log.error("--feature and --no-branch are mutually exclusive");
        process.exit(1);
      }

      // ── Dry-run: run in-process without queue ─────────────────
      if (m.dryRun) {
        if (m.spec || m.respec) {
          // Resolve respec issues if needed
          let issues: string | string[];
          if (m.spec) {
            issues = m.spec;
          } else {
            const respecArgs = m.respec!;
            const isEmpty = Array.isArray(respecArgs) && respecArgs.length === 0;
            if (isEmpty) {
              const source = await resolveSource(respecArgs, m.issueSource, m.cwd);
              if (!source) process.exit(1);
              const datasource = getDatasource(source);
              const existing = await datasource.list({ cwd: m.cwd, org: m.org, project: m.project, workItemType: m.workItemType, iteration: m.iteration, area: m.area });
              if (existing.length === 0) { log.error("No existing specs found to regenerate"); process.exit(1); }
              const identifiers = existing.map((item) => item.number);
              const allNumeric = identifiers.every((id) => /^\d+$/.test(id));
              issues = allNumeric ? identifiers.join(",") : identifiers;
              const confirmed = await confirmLargeBatch(existing.length);
              if (!confirmed) process.exit(0);
            } else {
              issues = respecArgs;
            }
          }
          return this.generateSpecs({
            issues, issueSource: m.issueSource, provider: m.provider,
            enabledProviders: m.enabledProviders, providerModels: m.providerModels,
            serverUrl: m.serverUrl, cwd: m.cwd, outputDir: m.outputDir,
            org: m.org, project: m.project, workItemType: m.workItemType, iteration: m.iteration, area: m.area, concurrency: m.concurrency,
            dryRun: true, retries: m.retries,
            specTimeout: m.specTimeout ?? DEFAULT_SPEC_TIMEOUT_MIN,
            specWarnTimeout: m.specWarnTimeout,
            specKillTimeout: m.specKillTimeout,
          });
        }
        return this.orchestrate({
          issueIds: m.issueIds, concurrency: m.concurrency ?? defaultConcurrency(),
          dryRun: true, noPlan: m.noPlan, noBranch: m.noBranch, noWorktree: m.noWorktree,
          provider: m.provider, enabledProviders: m.enabledProviders, providerModels: m.providerModels,
          serverUrl: m.serverUrl, source: m.issueSource, org: m.org, project: m.project,
          workItemType: m.workItemType, iteration: m.iteration, area: m.area, planTimeout: m.planTimeout, planRetries: m.planRetries, retries: m.retries,
          force: m.force, feature: m.feature, username: m.username,
        });
      }

      // ── Queue-based execution ─────────────────────────────────
      openDatabase(cwd);
      const concurrency = m.concurrency ?? defaultConcurrency();
      const maxRuns = Math.min(Math.max(4, defaultConcurrency() * 2), CONFIG_BOUNDS.maxRuns.max);

      // Handle --resume
      if (m.resume !== undefined) {
        return runResumeFlow(m.resume, cwd, maxRuns);
      }

      const sessionId = randomUUID();
      markOrphanedRunsFailed({ exceptSessionId: sessionId });
      initRunQueue(maxRuns);

      if (m.spec || m.respec) {
        // Resolve spec issues (same as before)
        let issues: string | string[];
        if (m.spec) {
          issues = m.spec;
        } else {
          const respecArgs = m.respec!;
          const isEmpty = Array.isArray(respecArgs) && respecArgs.length === 0;
          if (isEmpty) {
            const source = await resolveSource(respecArgs, m.issueSource, m.cwd);
            if (!source) process.exit(1);
            const datasource = getDatasource(source);
            const existing = await datasource.list({ cwd: m.cwd, org: m.org, project: m.project, workItemType: m.workItemType, iteration: m.iteration, area: m.area });
            if (existing.length === 0) { log.error("No existing specs found to regenerate"); process.exit(1); }
            const identifiers = existing.map((item) => item.number);
            const allNumeric = identifiers.every((id) => /^\d+$/.test(id));
            issues = allNumeric ? identifiers.join(",") : identifiers;
            const confirmed = await confirmLargeBatch(existing.length);
            if (!confirmed) process.exit(0);
          } else {
            issues = respecArgs;
          }
        }

        const workerMessage = {
          type: "spec",
          cwd,
          opts: {
            issues,
            enabledProviders: m.enabledProviders, providerModels: m.providerModels,
            issueSource: m.issueSource,
            org: m.org, project: m.project, workItemType: m.workItemType, iteration: m.iteration, area: m.area,
            concurrency,
            specTimeout: m.specTimeout ?? DEFAULT_SPEC_TIMEOUT_MIN,
            specWarnTimeout: m.specWarnTimeout, specKillTimeout: m.specKillTimeout,
            dryRun: false, cwd,
          },
        };

        const runId = createSpecRun({
          cwd, issues, sessionId, status: "queued",
          workerMessage: JSON.stringify(workerMessage),
        });

        return awaitQueuedRuns([runId], sessionId, cwd, "spec");
      }

      // Dispatch mode
      const workerMessage = {
        type: "dispatch",
        cwd,
        opts: {
          issueIds: m.issueIds, dryRun: false,
          provider: m.provider,
          enabledProviders: m.enabledProviders, providerModels: m.providerModels,
          source: m.issueSource, org: m.org, project: m.project,
          workItemType: m.workItemType, iteration: m.iteration, area: m.area,
          username: m.username, planTimeout: m.planTimeout,
          concurrency,
          noPlan: m.noPlan, noBranch: m.noBranch, noWorktree: m.noWorktree,
          retries: m.retries, feature: m.feature, planRetries: m.planRetries,
          force: m.force,
        },
      };

      const runId = createRun({
        cwd, issueIds: m.issueIds, sessionId, status: "queued",
        workerMessage: JSON.stringify(workerMessage),
      });

      return awaitQueuedRuns([runId], sessionId, cwd, "dispatch");
    },
  };

  return runner;
}

// ── CLI queue helpers ────────────────────────────────────────

/** CLI log callback that writes progress to the logger. */
function cliLogCallback(message: string, level?: "info" | "warn" | "error"): void {
  if (level === "error") log.error(message);
  else if (level === "warn") log.warn(message);
  else log.info(message);
}

/**
 * Enqueue runs and block until all reach a terminal status.
 * Returns a summary derived from the DB state.
 */
async function awaitQueuedRuns(
  runIds: string[],
  sessionId: string,
  cwd: string,
  mode: "dispatch" | "spec",
): Promise<RunResult> {
  const queue = getRunQueue();

  // Enqueue all runs
  for (const runId of runIds) {
    queue.enqueue(runId, cliLogCallback);
  }

  // Wait for all runs to reach terminal status
  await Promise.all(runIds.map((runId) =>
    waitForRunCompletion(runId, 600_000, () => getRun(runId)?.status ?? null),
  ));

  // Build summary from DB
  if (mode === "spec") {
    let total = 0, generated = 0, failed = 0;
    for (const runId of runIds) {
      const { getSpecRun } = await import("../mcp/state/manager.js");
      const run = getSpecRun(runId);
      if (run) {
        total += run.total;
        generated += run.generated;
        failed += run.failed;
      }
    }
    return { total, generated, failed } as SpecSummary;
  }

  // Dispatch summary
  let total = 0, completed = 0, failed = 0;
  const results: DispatchResult[] = [];
  for (const runId of runIds) {
    const run = getRun(runId);
    if (run) {
      total += run.total;
      completed += run.completed;
      failed += run.failed;
    }
    const tasks = getTasksForRun(runId);
    for (const task of tasks) {
      results.push({
        task: { file: task.file, line: task.line, text: task.taskText },
        success: task.status === "success",
        error: task.error ?? undefined,
      } as DispatchResult);
    }
  }
  return { total, completed, failed, skipped: 0, results };
}

/**
 * Handle --resume flow: list resumable sessions, prompt if needed, requeue.
 */
async function runResumeFlow(
  resumeArg: string | boolean,
  cwd: string,
  maxRuns: number,
): Promise<RunResult> {
  const sessions = listResumableSessions(cwd);

  if (sessions.length === 0) {
    log.info("No incomplete sessions found to resume.");
    process.exit(0);
  }

  let sessionId: string;

  if (typeof resumeArg === "string") {
    // Specific session ID provided
    const match = sessions.find((s) => s.sessionId === resumeArg);
    if (!match) {
      log.error(`Session ${resumeArg} not found or has no incomplete runs.`);
      log.info("Available sessions:");
      for (const s of sessions) {
        const date = new Date(s.startedAt).toLocaleString();
        log.info(`  ${s.sessionId}  (${date}, ${s.incompleteRuns} incomplete)`);
      }
      process.exit(1);
    }
    sessionId = resumeArg;
  } else if (sessions.length === 1) {
    // Auto-select the only session
    sessionId = sessions[0].sessionId;
    log.info(`Resuming session ${sessionId} (${sessions[0].incompleteRuns} incomplete run(s))`);
  } else {
    // Prompt user to pick
    const { select } = await import("../helpers/ink-prompts.js");
    sessionId = await select<string>({
      message: "Multiple incomplete sessions found. Which one would you like to resume?",
      choices: sessions.map((s) => {
        const date = new Date(s.startedAt).toLocaleString();
        let issueLabel = "";
        try {
          const ids = JSON.parse(s.issueIds) as string[];
          issueLabel = ids.length > 3 ? `issues ${ids.slice(0, 3).join(", ")}...` : `issues ${ids.join(", ")}`;
        } catch { issueLabel = "unknown issues"; }
        return {
          name: `${s.sessionId.slice(0, 8)}  ${date}  ${issueLabel}  (${s.incompleteRuns} incomplete)`,
          value: s.sessionId,
        };
      }),
    });
  }

  markOrphanedRunsFailed({ exceptSessionId: sessionId });
  initRunQueue(maxRuns);

  const runIds = requeueSessionRuns(sessionId);
  if (runIds.length === 0) {
    log.info("No runs to resume in this session.");
    process.exit(0);
  }

  log.info(`Resuming ${runIds.length} run(s) from session ${sessionId.slice(0, 8)}...`);
  return awaitQueuedRuns(runIds, sessionId, cwd, "dispatch");
}

export { parseIssueFilename } from "./datasource-helpers.js";
