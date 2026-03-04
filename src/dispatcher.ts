/**
 * Task dispatcher — creates a fresh session per task to keep contexts
 * isolated and avoid context rot. Works with any registered provider.
 */

import type { ProviderInstance } from "./providers/interface.js";
import type { Task } from "./parser.js";
import { log } from "./helpers/logger.js";
import { fileLoggerStorage } from "./helpers/file-logger.js";

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
  plan?: string,
  worktreeRoot?: string,
): Promise<DispatchResult> {
  try {
    log.debug(`Dispatching task: ${task.file}:${task.line} — ${task.text.slice(0, 80)}`);
    const sessionId = await instance.createSession();
    const prompt = plan ? buildPlannedPrompt(task, cwd, plan, worktreeRoot) : buildPrompt(task, cwd, worktreeRoot);
    log.debug(`Prompt built (${prompt.length} chars, ${plan ? "with plan" : "no plan"})`);
    fileLoggerStorage.getStore()?.prompt("dispatchTask", prompt);

    const response = await instance.prompt(sessionId, prompt);

    if (response === null) {
      log.debug("Task dispatch returned null response");
      fileLoggerStorage.getStore()?.warn("dispatchTask: null response");
      return { task, success: false, error: "No response from agent" };
    }

    log.debug(`Task dispatch completed (${response.length} chars response)`);
    fileLoggerStorage.getStore()?.response("dispatchTask", response);
    return { task, success: true };
  } catch (err) {
    const message = log.extractMessage(err);
    log.debug(`Task dispatch failed: ${log.formatErrorChain(err)}`);
    fileLoggerStorage.getStore()?.error(`dispatchTask error: ${message}${err instanceof Error && err.stack ? `\n${err.stack}` : ""}`);
    return { task, success: false, error: message };
  }
}

/**
 * Build a focused prompt for a single task. Includes context about the
 * project but scopes the work to just this one unit.
 */
function buildPrompt(task: Task, cwd: string, worktreeRoot?: string): string {
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
    buildCommitInstruction(task.text),
    ...buildWorktreeIsolation(worktreeRoot),
    `- When finished, confirm by saying "Task complete."`,
  ].join("\n");
}

/**
 * Build a prompt for the executor when a planner has already explored
 * the codebase and produced a detailed execution plan.
 */
function buildPlannedPrompt(task: Task, cwd: string, plan: string, worktreeRoot?: string): string {
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
    `- Follow the plan above precisely — do not deviate, skip steps, or reorder.`,
    `- Complete ONLY this specific task — do not work on other tasks.`,
    `- Make the minimal, correct changes needed — do not refactor unrelated code.`,
    `- Do NOT explore the codebase. The planner has already done all necessary research. Only read or modify the files explicitly referenced in the plan.`,
    `- Do NOT re-plan, question, or revise the plan. Trust it as given and execute it faithfully.`,
    `- Do NOT search for additional context using grep, find, or similar tools unless the plan explicitly instructs you to.`,
    buildCommitInstruction(task.text),
    ...buildWorktreeIsolation(worktreeRoot),
    `- When finished, confirm by saying "Task complete."`,
  ].join("\n");
}

/**
 * Check whether a task description includes an instruction to commit.
 */
function taskRequestsCommit(taskText: string): boolean {
  return /\bcommit\b/i.test(taskText);
}

/**
 * Build a commit instruction line based on whether the task requests a commit.
 */
function buildCommitInstruction(taskText: string): string {
  if (taskRequestsCommit(taskText)) {
    return (
      `- The task description includes a commit instruction. After completing the implementation, ` +
      `stage all changes and create a conventional commit. Use one of these types: ` +
      `feat, fix, docs, refactor, test, chore, style, perf, ci.`
    );
  }
  return `- Do NOT commit changes — the orchestrator handles commits.`;
}

/**
 * Build worktree isolation instructions when operating inside a git worktree.
 * Returns an empty array when no worktreeRoot is provided (non-worktree mode).
 */
function buildWorktreeIsolation(worktreeRoot?: string): string[] {
  if (!worktreeRoot) return [];
  return [
    `- **Worktree isolation:** You are operating inside a git worktree at \`${worktreeRoot}\`. ` +
      `You MUST NOT read, write, or execute commands that access files outside this directory. ` +
      `All file paths must resolve within \`${worktreeRoot}\`.`,
  ];
}
