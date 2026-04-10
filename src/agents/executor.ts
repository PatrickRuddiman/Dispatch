/**
 * Executor agent — executes a single task by dispatching it to the AI
 * provider and marking it complete on success.
 *
 * The executor consumes a plan produced by the planner (or null when
 * planning is disabled). It never calls the planner itself — the plan
 * is treated as authoritative input from the orchestrator.
 */

import type { Agent, AgentBootOptions } from "./interface.js";
import type { AgentResult, ExecutorData } from "./types.js";
import type { Task } from "../parser.js";
import { markTaskComplete } from "../parser.js";
import { dispatchTask } from "../dispatcher.js";
import { log } from "../helpers/logger.js";
import { fileLoggerStorage } from "../helpers/file-logger.js";

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
 * A booted executor agent that can execute planned (or unplanned) tasks.
 */
export interface ExecutorAgent extends Agent {
  /**
   * Execute a single task. Dispatches to the provider, marks the task
   * complete on success, and returns a structured result.
   */
  execute(input: ExecuteInput): Promise<AgentResult<ExecutorData>>;
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

    async execute(input: ExecuteInput): Promise<AgentResult<ExecutorData>> {
      const { task, cwd, plan, worktreeRoot } = input;
      const startTime = Date.now();

      try {
        fileLoggerStorage.getStore()?.agentEvent("executor", "started", task.text);
        // Dispatch the task — plan being non-null triggers the planned prompt path
        // in dispatchTask, otherwise the generic prompt is used
        const result = await dispatchTask(provider, task, cwd, plan ?? undefined, worktreeRoot);

        if (result.success) {
          await markTaskComplete(task);
          fileLoggerStorage.getStore()?.agentEvent("executor", "completed", `${Date.now() - startTime}ms`);
          return { data: { dispatchResult: result }, success: true, durationMs: Date.now() - startTime };
        }

        fileLoggerStorage.getStore()?.agentEvent("executor", "failed", result.error ?? "unknown error");
        return { data: null, success: false, error: result.error, durationMs: Date.now() - startTime };
      } catch (err) {
        const message = log.extractMessage(err);
        fileLoggerStorage.getStore()?.error(`executor error: ${message}${err instanceof Error && err.stack ? `\n${err.stack}` : ""}`);
        return { data: null, success: false, error: message, durationMs: Date.now() - startTime };
      }
    },

    async cleanup(): Promise<void> {
      // Executor has no owned resources — provider lifecycle is managed externally
    },
  };
}
