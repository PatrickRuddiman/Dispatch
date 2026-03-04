/**
 * Planner agent — explores the codebase and researches the implementation
 * for a task, then produces a focused system prompt for the executor agent.
 *
 * The planner runs in its own session with read-only intent: it reads files,
 * searches symbols, and reasons about the task without making any changes.
 * Its output is a rich, context-aware prompt that the executor can follow
 * to make precise edits.
 */

import type { Agent, AgentBootOptions } from "./interface.js";
import type { Task } from "../parser.js";
import type { AgentResult, PlannerData } from "./types.js";
import { log } from "../helpers/logger.js";
import { fileLoggerStorage } from "../helpers/file-logger.js";

/**
 * A booted planner agent that can produce execution plans for tasks.
 *
 * To add a new planner implementation:
 *   1. Create `src/agents/<name>.ts`
 *   2. Export an async `boot` function that returns a `PlannerAgent`
 *   3. Register it in `src/agents/index.ts`
 */
export interface PlannerAgent extends Agent {
  /**
   * Run the planner for a single task. Creates an isolated session,
   * sends the planning prompt, and extracts the resulting execution plan.
   *
   * When `fileContext` is provided (filtered markdown from the task file),
   * it is included so the planner can use non-task prose (headings, notes,
   * implementation details) as additional guidance.
   *
   * When `cwd` is provided, it overrides the boot-time working directory
   * in the planning prompt — use this for worktree tasks.
   *
   * When `worktreeRoot` is provided, the prompt includes directory-restriction
   * instructions that confine the agent to that worktree directory.
   */
  plan(task: Task, fileContext?: string, cwd?: string, worktreeRoot?: string): Promise<AgentResult<PlannerData>>;
}

/**
 * Boot a planner agent backed by the given provider.
 *
 * @throws if `opts.provider` is not supplied — the planner requires a
 *         provider to create sessions and send prompts.
 */
export async function boot(opts: AgentBootOptions): Promise<PlannerAgent> {
  const { provider, cwd } = opts;

  if (!provider) {
    throw new Error("Planner agent requires a provider instance in boot options");
  }

  return {
    name: "planner",

    async plan(task: Task, fileContext?: string, cwdOverride?: string, worktreeRoot?: string): Promise<AgentResult<PlannerData>> {
      const startTime = Date.now();
      try {
        const sessionId = await provider.createSession();
        const prompt = buildPlannerPrompt(task, cwdOverride ?? cwd, fileContext, worktreeRoot);
        fileLoggerStorage.getStore()?.prompt("planner", prompt);

        const plan = await provider.prompt(sessionId, prompt);
        if (plan) fileLoggerStorage.getStore()?.response("planner", plan);

        if (!plan?.trim()) {
          return { data: null, success: false, error: "Planner returned empty plan", durationMs: Date.now() - startTime };
        }

        fileLoggerStorage.getStore()?.agentEvent("planner", "completed", `${Date.now() - startTime}ms`);
        return { data: { prompt: plan }, success: true, durationMs: Date.now() - startTime };
      } catch (err) {
        const message = log.extractMessage(err);
        fileLoggerStorage.getStore()?.error(`planner error: ${message}${err instanceof Error && err.stack ? `\n${err.stack}` : ""}`);
        return { data: null, success: false, error: message, durationMs: Date.now() - startTime };
      }
    },

    async cleanup(): Promise<void> {
      // Planner has no owned resources — provider lifecycle is managed externally
    },
  };
}

/**
 * Build the prompt that instructs the planner to explore the codebase,
 * understand the task, and produce an execution plan.
 *
 * When file context is provided, it is included as a "Task File Contents"
 * section so the planner can use headings, prose, and notes from the
 * markdown file as implementation guidance.
 *
 * When `worktreeRoot` is provided, directory-restriction instructions are
 * appended to confine all agent operations within the worktree boundary.
 */
function buildPlannerPrompt(task: Task, cwd: string, fileContext?: string, worktreeRoot?: string): string {
  const sections: string[] = [
    `You are a **planning agent**. Your job is to explore the codebase, understand the task below, and produce a detailed execution prompt that another agent will follow to implement the changes.`,
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
    `Produce your response as a **system prompt for an executor agent**. The executor will receive your output verbatim as its instructions. Write it in second person ("You will...", "Modify the file...").`,
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
