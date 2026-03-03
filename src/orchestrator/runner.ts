/**
 * Runner — thin coordinator that delegates to extracted pipeline modules.
 */

import type { DispatchResult } from "../dispatcher.js";
import type { AgentBootOptions } from "../agents/interface.js";
import type { ProviderName } from "../providers/interface.js";
import type { DatasourceName } from "../datasources/interface.js";
import type { SpecOptions, SpecSummary } from "../spec-generator.js";
import { defaultConcurrency, resolveSource } from "../spec-generator.js";
import { getDatasource } from "../datasources/index.js";
import { log } from "../helpers/logger.js";
import { confirmLargeBatch } from "../helpers/confirm-large-batch.js";
import { resolveCliConfig } from "./cli-config.js";
import { runSpecPipeline } from "./spec-pipeline.js";
import { runDispatchPipeline } from "./dispatch-pipeline.js";

/** Runtime options passed to `orchestrate()`. */
export interface OrchestrateRunOptions {
  issueIds: string[];
  concurrency?: number;
  dryRun: boolean;
  noPlan?: boolean;
  noBranch?: boolean;
  provider?: ProviderName;
  serverUrl?: string;
  source?: DatasourceName;
  org?: string;
  project?: string;
  workItemType?: string;
  planTimeout?: number;
  planRetries?: number;
}

/** Raw CLI arguments before config resolution. */
export interface RawCliArgs {
  issueIds: string[];
  dryRun: boolean;
  noPlan: boolean;
  noBranch: boolean;
  concurrency?: number;
  provider: ProviderName;
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
  planTimeout?: number;
  planRetries?: number;
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

export interface FixTestsSummary {
  mode: "fix-tests";
  success: boolean;
  error?: string;
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
        return runFixTestsPipeline({ cwd, provider: "opencode", serverUrl: undefined, verbose: false });
      }
      const { mode: _, ...rest } = opts;
      return runner.orchestrate(rest);
    },

    async runFromCli(args: RawCliArgs): Promise<RunResult> {
      const m = await resolveCliConfig(args);

      // ── Mutual exclusion: --spec, --respec, --fix-tests ────
      const modeFlags = [
        m.spec !== undefined && "--spec",
        m.respec !== undefined && "--respec",
        m.fixTests && "--fix-tests",
      ].filter(Boolean) as string[];

      if (modeFlags.length > 1) {
        log.error(`${modeFlags.join(" and ")} are mutually exclusive`);
        process.exit(1);
      }

      // --fix-tests is mutually exclusive with positional issue IDs
      if (m.fixTests && m.issueIds.length > 0) {
        log.error("--fix-tests cannot be combined with issue IDs");
        process.exit(1);
      }

      if (m.fixTests) {
        const { runFixTestsPipeline } = await import("./fix-tests-pipeline.js");
        return runFixTestsPipeline({ cwd: m.cwd, provider: m.provider, serverUrl: m.serverUrl, verbose: m.verbose });
      }

      if (m.spec) {
        return this.generateSpecs({
          issues: m.spec, issueSource: m.issueSource, provider: m.provider,
          serverUrl: m.serverUrl, cwd: m.cwd, outputDir: m.outputDir,
          org: m.org, project: m.project, workItemType: m.workItemType, concurrency: m.concurrency,
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
          const existing = await datasource.list({ cwd: m.cwd, org: m.org, project: m.project, workItemType: m.workItemType });
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
          serverUrl: m.serverUrl, cwd: m.cwd, outputDir: m.outputDir,
          org: m.org, project: m.project, workItemType: m.workItemType, concurrency: m.concurrency,
        });
      }

      return this.orchestrate({
        issueIds: m.issueIds, concurrency: m.concurrency ?? defaultConcurrency(),
        dryRun: m.dryRun, noPlan: m.noPlan, noBranch: m.noBranch, provider: m.provider,
        serverUrl: m.serverUrl, source: m.issueSource, org: m.org, project: m.project,
        workItemType: m.workItemType, planTimeout: m.planTimeout, planRetries: m.planRetries,
      });
    },
  };

  return runner;
}

export { parseIssueFilename } from "./datasource-helpers.js";
