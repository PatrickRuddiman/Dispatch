/**
 * Planner skill — explores the codebase and researches the implementation
 * for a task, then produces a focused system prompt for the executor.
 *
 * Stateless data object: defines prompt construction and result parsing
 * without coupling to any provider. The dispatcher handles execution.
 */

import type { Skill } from "./interface.js";
import type { Task } from "../parser.js";
import type { PlannerData } from "./types.js";
import { formatEnvironmentPrompt } from "../helpers/environment.js";

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/** Runtime input for the planner skill. */
export interface PlannerInput {
  task: Task;
  cwd: string;
  fileContext?: string;
  worktreeRoot?: string;
}

// ---------------------------------------------------------------------------
// Stateless skill definition
// ---------------------------------------------------------------------------

/** The planner skill — stateless, no provider coupling. */
export const plannerSkill: Skill<PlannerInput, PlannerData> = {
  name: "planner",

  buildPrompt(input: PlannerInput): string {
    return buildPlannerPrompt(input.task, input.cwd, input.fileContext, input.worktreeRoot);
  },

  parseResult(response: string | null): PlannerData {
    if (!response?.trim()) {
      throw new Error("Planner returned empty plan");
    }
    return { prompt: response };
  },
};

// ---------------------------------------------------------------------------
// Prompt builder (private)
// ---------------------------------------------------------------------------

function buildPlannerPrompt(task: Task, cwd: string, fileContext?: string, worktreeRoot?: string): string {
  const sections: string[] = [
    `Explore the codebase, understand the task below, and produce a detailed execution prompt that will be followed to implement the changes.`,
    ``,
    `## Task`,
    `- **Working directory:** ${cwd}`,
    `- **Source file:** ${task.file}`,
    `- **Task (line ${task.line}):** ${task.text}`,
  ];

  if (fileContext) {
    sections.push(
      ``,
      `## Task File Contents`,
      ``,
      `The task comes from a markdown file that may contain important implementation`,
      `details, requirements, and context in its non-task content (headings, prose,`,
      `notes). Review this carefully — it may describe conventions, constraints, or`,
      `technical details that are critical for the implementation.`,
      ``,
      `\`\`\`markdown`,
      fileContext,
      `\`\`\``,
    );
  }

  if (worktreeRoot) {
    sections.push(
      ``,
      `## Worktree Isolation`,
      ``,
      `You are operating inside a git worktree. All file operations MUST be confined`,
      `to the following directory tree:`,
      ``,
      `    ${worktreeRoot}`,
      ``,
      `- Do NOT read, write, or execute commands that access files outside this directory.`,
      `- Do NOT reference or modify files in the main repository working tree or other worktrees.`,
      `- All relative paths must resolve within the worktree root above.`,
    );
  }

  sections.push(
    ``,
    formatEnvironmentPrompt(),
  );

  sections.push(
    ``,
    `## Instructions`,
    ``,
    `1. **Explore the codebase** — read relevant files, search for symbols, and understand the project structure, conventions, and patterns.`,
    `2. **Review the task file contents above** — pay close attention to non-task text (headings, prose, notes) as it often contains important implementation details, requirements, and constraints.`,
    `3. **Identify the files** that need to be created or modified to complete this task.`,
    `4. **Research the implementation** — understand the existing code patterns, imports, types, and APIs involved.`,
    `5. **DO NOT make any changes** — you are only planning, not executing.`,
    ``,
    `## Output Format`,
    ``,
    `Produce your response as a **system prompt for the executor**. The executor will receive your output verbatim as its instructions. Write it in second person ("You will...", "Modify the file...").`,
    ``,
    `Your output MUST include:`,
    ``,
    `1. **Context** — A brief summary of the relevant project structure, conventions, and patterns the executor needs to know. Include any important details from the task file's non-task content.`,
    `2. **Files to modify** — The exact file paths that need to be created or changed, with the rationale for each.`,
    `3. **Step-by-step implementation** — Precise, ordered steps the executor should follow. Include:`,
    `   - Exact file paths`,
    `   - What to add, change, or remove`,
    `   - Code snippets, type signatures, or patterns to follow (based on existing code you read)`,
    `   - Import statements needed`,
    `4. **Constraints** — Any important constraints:`,
    `   - If the task description includes a commit instruction, include a final step in the plan to commit the changes using conventional commit conventions (supported types: feat, fix, docs, refactor, test, chore, style, perf, ci). If the task does not mention committing, instruct the executor to NOT commit changes.`,
    `   - Make minimal, correct changes — do not refactor unrelated code.`,
    `   - Follow existing code style and conventions found in the project.`,
    ``,
    `Be specific and concrete. Reference actual code you found during exploration. The executor has no prior context about this codebase — your prompt is all it gets.`,
  );

  return sections.join("\n");
}
