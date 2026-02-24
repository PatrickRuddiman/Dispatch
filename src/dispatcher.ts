/**
 * OpenCode SDK dispatcher — creates a fresh session per task to keep
 * contexts isolated and avoid context rot.
 */

import { createOpencode, createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { Task } from "./parser.js";

export interface DispatchResult {
  task: Task;
  success: boolean;
  error?: string;
}

export interface OpencodeInstance {
  client: OpencodeClient;
  cleanup?: () => Promise<void>;
}

/**
 * Boot an OpenCode instance — either connect to a running server
 * or start a new one.
 */
export async function bootOpencode(opts?: {
  url?: string;
}): Promise<OpencodeInstance> {
  if (opts?.url) {
    const client = createOpencodeClient({ baseUrl: opts.url });
    return { client };
  }

  const oc = await createOpencode();
  return {
    client: oc.client,
    cleanup: async () => {
      oc.server.close();
    },
  };
}

/**
 * Dispatch a single task to OpenCode in its own session.
 * Uses the synchronous `session.prompt()` which blocks until the
 * agent finishes — each task gets a fresh session for context isolation.
 *
 * When a `plan` is provided (from the planner agent), it replaces the
 * generic prompt with the planner's context-rich execution instructions.
 */
export async function dispatchTask(
  instance: OpencodeInstance,
  task: Task,
  cwd: string,
  plan?: string
): Promise<DispatchResult> {
  const { client } = instance;

  try {
    // Create a fresh session for this task — isolated context
    const { data: session } = await client.session.create();
    if (!session) {
      return { task, success: false, error: "Failed to create session" };
    }

    const prompt = plan ? buildPlannedPrompt(task, cwd, plan) : buildPrompt(task, cwd);

    // session.prompt() is synchronous — blocks until the agent completes
    const { data: response, error } = await client.session.prompt({
      path: { id: session.id },
      body: {
        parts: [{ type: "text", text: prompt }],
      },
    });

    if (error) {
      return { task, success: false, error: `Prompt failed: ${JSON.stringify(error)}` };
    }

    if (!response) {
      return { task, success: false, error: "No response from agent" };
    }

    return { task, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
