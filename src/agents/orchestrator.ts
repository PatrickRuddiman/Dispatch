/**
 * Orchestrator — the core loop that drives the dispatch pipeline:
 *   1. Glob for task files
 *   2. Parse unchecked tasks
 *   3. Boot the selected provider (OpenCode, Copilot, etc.)
 *   4. Plan each task via a planner agent (optional)
 *   5. Execute each task via the executor agent
 *   6. Mark complete in markdown
 */

import type { DispatchResult } from "../dispatcher.js";
import type { AgentBootOptions } from "../agent.js";
import type { ProviderName } from "../provider.js";
import type { DatasourceName } from "../datasource.js";
import type { SpecOptions, SpecSummary } from "../spec-generator.js";
import { defaultConcurrency } from "../spec-generator.js";
import { resolveCliConfig } from "../orchestrator/cli-config.js";
import { runSpecPipeline } from "../orchestrator/spec-pipeline.js";
import { runDispatchPipeline } from "../orchestrator/dispatch-pipeline.js";

/**
 * Runtime options passed to `orchestrate()` — these control what gets
 * dispatched and how, separate from the agent's boot-time configuration.
 */
export interface OrchestrateRunOptions {
  /** Issue IDs to dispatch (empty = all open issues from datasource) */
  issueIds: string[];
  /** Max parallel dispatches (uses defaultConcurrency() if omitted) */
  concurrency?: number;
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

/**
 * Raw CLI arguments passed to the orchestrator before config resolution.
 * The orchestrator merges these with config-file defaults and validates
 * that mandatory configuration (provider + source) is present.
 */
export interface RawCliArgs {
  issueIds: string[];
  dryRun: boolean;
  noPlan: boolean;
  concurrency?: number;
  provider: ProviderName;
  serverUrl?: string;
  cwd: string;
  verbose: boolean;
  spec?: string | string[];
  issueSource?: DatasourceName;
  org?: string;
  project?: string;
  outputDir?: string;
  /** Set of CLI flag names that were explicitly provided (vs. defaults) */
  explicitFlags: Set<string>;
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

  /**
   * Entry point for the CLI — accepts raw parsed CLI arguments, loads
   * and merges config-file defaults, validates mandatory configuration
   * (provider + source), resolves default concurrency, and delegates
   * to the appropriate pipeline.
   */
  runFromCli(args: RawCliArgs): Promise<RunResult>;
}

/**
 * Boot an orchestrator agent.
 */
export async function boot(opts: AgentBootOptions): Promise<OrchestratorAgent> {
  const { cwd } = opts;

  const agent: OrchestratorAgent = {
    async orchestrate(runOpts: OrchestrateRunOptions): Promise<DispatchSummary> {
      return runDispatchPipeline(runOpts, cwd);
    },

    async generateSpecs(opts: SpecOptions): Promise<SpecSummary> {
      return runSpecPipeline(opts);
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

    async runFromCli(args: RawCliArgs): Promise<RunResult> {
      const merged = await resolveCliConfig(args);

      // ── Delegate to the appropriate pipeline ───────────────────
      if (merged.spec) {
        return this.generateSpecs({
          issues: merged.spec,
          issueSource: merged.issueSource,
          provider: merged.provider,
          serverUrl: merged.serverUrl,
          cwd: merged.cwd,
          outputDir: merged.outputDir,
          org: merged.org,
          project: merged.project,
          concurrency: merged.concurrency,
        });
      }

      return this.orchestrate({
        issueIds: merged.issueIds,
        concurrency: merged.concurrency ?? defaultConcurrency(),
        dryRun: merged.dryRun,
        noPlan: merged.noPlan,
        provider: merged.provider,
        serverUrl: merged.serverUrl,
        source: merged.issueSource,
        org: merged.org,
        project: merged.project,
      });
    },
  };

  return agent;
}

export { parseIssueFilename } from "../orchestrator/datasource-helpers.js";
