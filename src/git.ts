/**
 * Git operations — conventional commits after each task completes.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task } from "./parser.js";

const exec = promisify(execFile);

/**
 * Stage all changes and create a conventional commit for a completed task.
 */
export async function commitTask(task: Task, cwd: string): Promise<void> {
  // Stage all changes made by the agent
  await git(["add", "-A"], cwd);

  // Check if there are staged changes
  const status = await git(["diff", "--cached", "--stat"], cwd);
  if (!status.trim()) {
    return; // nothing to commit
  }

  const message = buildCommitMessage(task);
  await git(["commit", "-m", message], cwd);
}

/**
 * Build a conventional commit message from the task.
 *
 * Uses the task text to infer a type (feat, fix, docs, chore, refactor, test)
 * and produces a short, descriptive commit message.
 */
function buildCommitMessage(task: Task): string {
  const text = task.text.toLowerCase();
  let type = "feat";

  if (/\bfix(es|ed|ing)?\b/.test(text) || /\bbug\b/.test(text)) {
    type = "fix";
  } else if (/\bdoc(s|ument)?\b/.test(text) || /\breadme\b/.test(text)) {
    type = "docs";
  } else if (/\brefactor\b/.test(text) || /\bclean\s?up\b/.test(text)) {
    type = "refactor";
  } else if (/\btest(s|ing)?\b/.test(text)) {
    type = "test";
  } else if (
    /\b(chore|config|setup|install|upgrade|bump|dep)\b/.test(text)
  ) {
    type = "chore";
  } else if (/\bstyle\b/.test(text) || /\bformat\b/.test(text)) {
    type = "style";
  } else if (/\bperf(ormance)?\b/.test(text)) {
    type = "perf";
  } else if (/\b(ci|pipeline|workflow|action)\b/.test(text)) {
    type = "ci";
  } else if (/\badd\b/.test(text) || /\bcreate\b/.test(text) || /\bimplement\b/.test(text)) {
    type = "feat";
  }

  // Truncate to 72 chars for the subject line
  const subject = task.text.length > 60
    ? task.text.slice(0, 57) + "..."
    : task.text;

  return `${type}: ${subject}`;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout;
}
