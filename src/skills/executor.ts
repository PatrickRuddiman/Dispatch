/**
 * Executor skill — executes a single task by constructing the appropriate
 * prompt (planned or generic) and parsing the provider response.
 *
 * Stateless data object: defines prompt construction and result parsing
 * without coupling to any provider. The dispatcher handles execution.
 */

import type { Skill } from "./interface.js";
import type { Task } from "../parser.js";
import type { ExecutorData } from "./types.js";
import { getEnvironmentBlock } from "../helpers/environment.js";

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/**
 * Input to the executor for a single task.
 *
 * `plan` is the planner's output prompt string, or `null` when planning
 * was skipped (--no-plan). The executor uses this to decide whether to
 * build a planned prompt or a generic prompt.
 */
export interface ExecutorInput {
  /** The task to execute */
  task: Task;
  /** Working directory */
  cwd: string;
  /** Planner output prompt, or null if planning was skipped */
  plan: string | null;
  /** Worktree root directory for isolation, if operating in a worktree */
  worktreeRoot?: string;
}

/** @deprecated Alias for ExecutorInput — kept for backward compatibility. */
export type ExecuteInput = ExecutorInput;

// ---------------------------------------------------------------------------
// Rate-limit detection
// ---------------------------------------------------------------------------

/** Patterns that indicate the response is a rate-limit error. */
const rateLimitPatterns = [
  /you[''\u2019]?ve hit your (rate )?limit/i,
  /rate limit exceeded/i,
  /too many requests/i,
  /quota exceeded/i,
];

// ---------------------------------------------------------------------------
// Stateless skill definition
// ---------------------------------------------------------------------------

/** The executor skill — stateless, no provider coupling. */
export const executorSkill: Skill<ExecutorInput, ExecutorData> = {
  name: "executor",

  buildPrompt(input: ExecutorInput): string {
    return input.plan
      ? buildPlannedPrompt(input.task, input.cwd, input.plan, input.worktreeRoot)
      : buildPrompt(input.task, input.cwd, input.worktreeRoot);
  },

  parseResult(response: string | null, input: ExecutorInput): ExecutorData {
    if (response === null) {
      throw new Error("No response");
    }

    const isRateLimited = rateLimitPatterns.some((p) => p.test(response));
    if (isRateLimited) {
      const truncated = response.slice(0, 200);
      throw new Error(`Rate limit: ${truncated}`);
    }

    return { dispatchResult: { task: input.task, success: true } };
  },
};

// ---------------------------------------------------------------------------
// Prompt builders (private)
// ---------------------------------------------------------------------------

function buildCommitInstruction(taskText: string): string {
  if (/\bcommit\b/i.test(taskText)) {
    return (
      `- The task description includes a commit instruction. After completing the implementation, ` +
      `stage all changes and create a conventional commit. Use one of these types: ` +
      `feat, fix, docs, refactor, test, chore, style, perf, ci.`
    );
  }
  return `- Do NOT commit changes — the orchestrator handles commits.`;
}

function buildWorktreeIsolation(worktreeRoot?: string): string[] {
  if (!worktreeRoot) return [];
  return [
    `- **Worktree isolation:** You are operating inside a git worktree at \`${worktreeRoot}\`. ` +
      `You MUST NOT read, write, or execute commands that access files outside this directory. ` +
      `All file paths must resolve within \`${worktreeRoot}\`.`,
  ];
}

function buildPrompt(task: Task, cwd: string, worktreeRoot?: string): string {
  return [
    `Complete the following task from a markdown task file.`,
    ``,
    `**Working directory:** ${cwd}`,
    `**Source file:** ${task.file}`,
    `**Task (line ${task.line}):** ${task.text}`,
    ``,
    getEnvironmentBlock(),
    ``,
    `Instructions:`,
    `- Complete ONLY this specific task — do not work on other tasks.`,
    `- Make the minimal, correct changes needed.`,
    buildCommitInstruction(task.text),
    ...buildWorktreeIsolation(worktreeRoot),
    `- When finished, confirm by saying "Task complete."`,
  ].join("\n");
}

function buildPlannedPrompt(task: Task, cwd: string, plan: string, worktreeRoot?: string): string {
  return [
    `Complete the task below by following the pre-planned execution instructions. The codebase has already been explored and a detailed plan has been produced.`,
    ``,
    `**Working directory:** ${cwd}`,
    `**Source file:** ${task.file}`,
    `**Task (line ${task.line}):** ${task.text}`,
    ``,
    getEnvironmentBlock(),
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
