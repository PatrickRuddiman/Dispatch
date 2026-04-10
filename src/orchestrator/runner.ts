/**
 * Runner — thin coordinator that delegates to extracted pipeline modules.
 */

import type { DispatchResult } from "../dispatcher.js";
import type { ProviderName } from "../providers/interface.js";
import type { DatasourceName } from "../datasources/interface.js";
import type { SpecOptions, SpecSummary } from "../spec-generator.js";
import { defaultConcurrency, DEFAULT_SPEC_TIMEOUT_MIN, resolveSource } from "../spec-generator.js";
import { getDatasource } from "../datasources/index.js";
import { log } from "../helpers/logger.js";
import { confirmLargeBatch } from "../helpers/confirm-large-batch.js";
import { checkPrereqs } from "../helpers/prereqs.js";
import { ensureGitignoreEntry } from "../helpers/gitignore.js";
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

      if (m.spec) {
        return this.generateSpecs({
          issues: m.spec, issueSource: m.issueSource, provider: m.provider,
          enabledProviders: m.enabledProviders,
          serverUrl: m.serverUrl, cwd: m.cwd, outputDir: m.outputDir,
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
          enabledProviders: m.enabledProviders,
          serverUrl: m.serverUrl, cwd: m.cwd, outputDir: m.outputDir,
          org: m.org, project: m.project, workItemType: m.workItemType, iteration: m.iteration, area: m.area, concurrency: m.concurrency,
          dryRun: m.dryRun, retries: m.retries,
          specTimeout: m.specTimeout ?? DEFAULT_SPEC_TIMEOUT_MIN,
          specWarnTimeout: m.specWarnTimeout,
          specKillTimeout: m.specKillTimeout,
        });
      }

      return this.orchestrate({
        issueIds: m.issueIds, concurrency: m.concurrency ?? defaultConcurrency(),
        dryRun: m.dryRun, noPlan: m.noPlan, noBranch: m.noBranch, noWorktree: m.noWorktree,
        provider: m.provider, enabledProviders: m.enabledProviders,
        serverUrl: m.serverUrl, source: m.issueSource, org: m.org, project: m.project,
        workItemType: m.workItemType, iteration: m.iteration, area: m.area, planTimeout: m.planTimeout, planRetries: m.planRetries, retries: m.retries,
        force: m.force, feature: m.feature, username: m.username,
      });
    },
  };

  return runner;
}

export { parseIssueFilename } from "./datasource-helpers.js";
