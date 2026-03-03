/**
 * Executor agent — executes a single task by dispatching it to the AI
 * provider and marking it complete on success.
 *
 * The executor consumes a plan produced by the planner (or null when
 * planning is disabled). It never calls the planner itself — the plan
 * is treated as authoritative input from the orchestrator.
 */

import type { Agent, AgentBootOptions } from "./interface.js";
import type { Task } from "../parser.js";
import { markTaskComplete } from "../parser.js";
import { dispatchTask, type DispatchResult } from "../dispatcher.js";
import { log } from "../helpers/logger.js";

/**
 * Input to the executor for a single task.
 *
 * `plan` is the planner's output prompt string, or `null` when planning
 * was skipped (--no-plan). The executor uses this to decide whether to
 * build a planned prompt or a generic prompt via the dispatcher.
 */
export interface ExecuteInput {
  /** The task to execute */
  task: Task;
  /** Working directory */
  cwd: string;
  /** Planner output prompt, or null if planning was skipped */
  plan: string | null;
  /** Worktree root directory for isolation, if operating in a worktree */
  worktreeRoot?: string;
}

/**
 * Structured result of executing a single task.
 *
 * The orchestrator maps these fields to TUI state changes — the executor
 * does not own the TUI.
 */
export interface ExecuteResult {
  /** The underlying dispatch result */
  dispatchResult: DispatchResult;
  /** Whether the task completed successfully */
  success: boolean;
  /** Error message if execution failed */
  error?: string;
  /** Elapsed wall-clock time in milliseconds */
  elapsedMs: number;
}

/**
 * A booted executor agent that can execute planned (or unplanned) tasks.
 */
export interface ExecutorAgent extends Agent {
  /**
   * Execute a single task. Dispatches to the provider, marks the task
   * complete on success, and returns a structured result.
   */
  execute(input: ExecuteInput): Promise<ExecuteResult>;
}

/**
 * Boot an executor agent backed by the given provider.
 *
 * @throws if `opts.provider` is not supplied — the executor requires a
 *         provider to create sessions and send prompts.
 */
export async function boot(opts: AgentBootOptions): Promise<ExecutorAgent> {
  const { provider } = opts;

  if (!provider) {
    throw new Error("Executor agent requires a provider instance in boot options");
  }

  return {
    name: "executor",

    async execute(input: ExecuteInput): Promise<ExecuteResult> {
      const { task, cwd, plan, worktreeRoot } = input;
      const startTime = Date.now();

      try {
        // Dispatch the task — plan being non-null triggers the planned prompt path
        // in dispatchTask, otherwise the generic prompt is used
        const result = await dispatchTask(provider, task, cwd, plan ?? undefined, worktreeRoot);

        if (result.success) {
          await markTaskComplete(task);
        }

        return {
          dispatchResult: result,
          success: result.success,
          error: result.error,
          elapsedMs: Date.now() - startTime,
        };
      } catch (err) {
        const message = log.extractMessage(err);
        return {
          dispatchResult: { task, success: false, error: message },
          success: false,
          error: message,
          elapsedMs: Date.now() - startTime,
        };
      }
    },

    async cleanup(): Promise<void> {
      // Executor has no owned resources — provider lifecycle is managed externally
    },
  };
}
