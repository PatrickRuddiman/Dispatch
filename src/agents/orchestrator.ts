/**
 * Orchestrator — thin coordinator that delegates to extracted pipeline modules.
 */

import type { DispatchResult } from "../dispatcher.js";
import type { AgentBootOptions } from "./interface.js";
import type { ProviderName } from "../providers/interface.js";
import type { DatasourceName } from "../datasources/interface.js";
import type { SpecOptions, SpecSummary } from "../spec-generator.js";
import { defaultConcurrency } from "../spec-generator.js";
import { resolveCliConfig } from "../orchestrator/cli-config.js";
import { runSpecPipeline } from "../orchestrator/spec-pipeline.js";
import { runDispatchPipeline } from "../orchestrator/dispatch-pipeline.js";

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
  issueSource?: DatasourceName;
  org?: string;
  project?: string;
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

/** Dispatch-mode run options with explicit mode discriminator. */
export interface DispatchRunOptions extends OrchestrateRunOptions {
  mode: "dispatch";
}

/** Spec-mode run options with explicit mode discriminator. */
export interface SpecRunOptions extends Omit<SpecOptions, "cwd"> {
  mode: "spec";
}

/** Discriminated union of all orchestrator run options. */
export type UnifiedRunOptions = DispatchRunOptions | SpecRunOptions;

/** Unified result type — DispatchSummary or SpecSummary depending on mode. */
export type RunResult = DispatchSummary | SpecSummary;

/** A booted orchestrator that coordinates dispatch and spec pipelines. */
export interface OrchestratorAgent {
  orchestrate(opts: OrchestrateRunOptions): Promise<DispatchSummary>;
  generateSpecs(opts: SpecOptions): Promise<SpecSummary>;
  run(opts: UnifiedRunOptions): Promise<RunResult>;
  runFromCli(args: RawCliArgs): Promise<RunResult>;
}

/** Boot an orchestrator agent. */
export async function boot(opts: AgentBootOptions): Promise<OrchestratorAgent> {
  const { cwd } = opts;

  const agent: OrchestratorAgent = {
    orchestrate: (runOpts) => runDispatchPipeline(runOpts, cwd),

    generateSpecs: (specOpts) => runSpecPipeline(specOpts),

    async run(opts: UnifiedRunOptions): Promise<RunResult> {
      if (opts.mode === "spec") {
        const { mode: _, ...rest } = opts;
        return agent.generateSpecs({ ...rest, cwd });
      }
      const { mode: _, ...rest } = opts;
      return agent.orchestrate(rest);
    },

    async runFromCli(args: RawCliArgs): Promise<RunResult> {
      const m = await resolveCliConfig(args);
      if (m.spec) {
        return this.generateSpecs({
          issues: m.spec, issueSource: m.issueSource, provider: m.provider,
          serverUrl: m.serverUrl, cwd: m.cwd, outputDir: m.outputDir,
          org: m.org, project: m.project, concurrency: m.concurrency,
        });
      }
      return this.orchestrate({
        issueIds: m.issueIds, concurrency: m.concurrency ?? defaultConcurrency(),
        dryRun: m.dryRun, noPlan: m.noPlan, noBranch: m.noBranch, provider: m.provider,
        serverUrl: m.serverUrl, source: m.issueSource, org: m.org, project: m.project,
        planTimeout: m.planTimeout, planRetries: m.planRetries,
      });
    },
  };

  return agent;
}

export { parseIssueFilename } from "../orchestrator/datasource-helpers.js";
