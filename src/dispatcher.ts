/**
 * Task dispatcher — creates a fresh session per task to keep contexts
 * isolated and avoid context rot. Works with any registered provider.
 */

import type { ProviderInstance } from "./provider.js";
import type { Task } from "./parser.js";
import { log } from "./logger.js";

export interface DispatchResult {
  task: Task;
  success: boolean;
  error?: string;
}

/**
 * Dispatch a single task to the provider in its own session.
 * Each task gets a fresh session for context isolation.
 *
 * When a `plan` is provided (from the planner agent), it replaces the
 * generic prompt with the planner's context-rich execution instructions.
 */
export async function dispatchTask(
  instance: ProviderInstance,
  task: Task,
  cwd: string,
  plan?: string
): Promise<DispatchResult> {
  try {
    log.debug(`Dispatching task: ${task.file}:${task.line} — ${task.text.slice(0, 80)}`);
    const sessionId = await instance.createSession();
    const prompt = plan ? buildPlannedPrompt(task, cwd, plan) : buildPrompt(task, cwd);
    log.debug(`Prompt built (${prompt.length} chars, ${plan ? "with plan" : "no plan"})`);

    const response = await instance.prompt(sessionId, prompt);

    if (response === null) {
      log.debug("Task dispatch returned null response");
      return { task, success: false, error: "No response from agent" };
    }

    log.debug(`Task dispatch completed (${response.length} chars response)`);
    return { task, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`Task dispatch failed: ${log.formatErrorChain(err)}`);
    return { task, success: false, error: message };
  }
}

/**
 * Build a focused prompt for a single task. Includes context about the
 * project but scopes the work to just this one unit.
 */
function buildPrompt(task: Task, cwd: string): string {
  return [
    `You are completing a task from a markdown task file.`,
    ``,
    `**Working directory:** ${cwd}`,
    `**Source file:** ${task.file}`,
    `**Task (line ${task.line}):** ${task.text}`,
    ``,
    `Instructions:`,
    `- Complete ONLY this specific task — do not work on other tasks.`,
    `- Make the minimal, correct changes needed.`,
    `- Do NOT commit changes — the orchestrator handles commits.`,
    `- When finished, confirm by saying "Task complete."`,
  ].join("\n");
}

/**
 * Build a prompt for the executor when a planner has already explored
 * the codebase and produced a detailed execution plan.
 */
function buildPlannedPrompt(task: Task, cwd: string, plan: string): string {
  return [
    `You are an **executor agent** completing a task that has been pre-planned by a planner agent.`,
    `The planner has already explored the codebase and produced detailed instructions below.`,
    ``,
    `**Working directory:** ${cwd}`,
    `**Source file:** ${task.file}`,
    `**Task (line ${task.line}):** ${task.text}`,
    ``,
    `---`,
    ``,
    `## Execution Plan`,
    ``,
    plan,
    ``,
    `---`,
    ``,
    `## Executor Constraints`,
    `- Follow the plan above precisely.`,
    `- Complete ONLY this specific task — do not work on other tasks.`,
    `- Make the minimal, correct changes needed.`,
    `- Do NOT commit changes — the orchestrator handles commits.`,
    `- When finished, confirm by saying "Task complete."`,
  ].join("\n");
}
