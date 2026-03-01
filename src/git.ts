/**
 * Git operations — conventional commits, branch management, and PR creation.
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
 * Stage all changes and commit with the given message.
 *
 * Acts as a safety-net commit after all tasks in an issue complete.
 * If there are no uncommitted changes, this is a no-op.
 */
export async function commitAllChanges(message: string, cwd: string): Promise<void> {
  await git(["add", "-A"], cwd);

  const status = await git(["diff", "--cached", "--stat"], cwd);
  if (!status.trim()) {
    return; // nothing to commit
  }

  await git(["commit", "-m", message], cwd);
}

/**
 * Return the name of the currently checked-out branch.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return branch.trim();
}

/**
 * Detect the default branch of the repository (e.g. main or master).
 *
 * Checks `git symbolic-ref refs/remotes/origin/HEAD` first, then falls back
 * to checking whether `main` or `master` exists locally.
 */
export async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    const ref = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
    // ref looks like "refs/remotes/origin/main\n"
    const parts = ref.trim().split("/");
    return parts[parts.length - 1];
  } catch {
    // Fallback: check if 'main' branch exists, otherwise assume 'master'
    try {
      await git(["rev-parse", "--verify", "main"], cwd);
      return "main";
    } catch {
      return "master";
    }
  }
}

/**
 * Create a new branch from `baseBranch` and switch to it.
 *
 * If the branch already exists (e.g. from a previous interrupted run),
 * switches to it and resets it to `baseBranch`.
 */
export async function createAndSwitchBranch(
  name: string,
  baseBranch: string,
  cwd: string,
): Promise<void> {
  try {
    await git(["checkout", "-b", name, baseBranch], cwd);
  } catch {
    // Branch already exists — switch to it and reset to the base
    await git(["checkout", name], cwd);
    await git(["reset", "--hard", baseBranch], cwd);
  }
}

/**
 * Switch to an existing branch.
 */
export async function switchBranch(name: string, cwd: string): Promise<void> {
  await git(["checkout", name], cwd);
}

/**
 * Push a branch to origin, setting the upstream tracking reference.
 */
export async function pushBranch(branchName: string, cwd: string): Promise<void> {
  await git(["push", "--set-upstream", "origin", branchName], cwd);
}

/**
 * Build a branch name from an issue number and title.
 *
 * Produces `dispatch/<number>-<slug>` where the slug is a lowercase,
 * hyphen-separated, truncated version of the title.
 */
export function buildBranchName(issueNumber: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `dispatch/${issueNumber}-${slug}`;
}

/**
 * Open a pull request from `branchName` into `baseBranch` using the `gh` CLI.
 *
 * Returns the URL of the created PR. If a PR already exists for the branch,
 * returns an empty string instead of throwing.
 */
export async function createPullRequest(
  branchName: string,
  baseBranch: string,
  title: string,
  body: string,
  cwd: string,
): Promise<string> {
  try {
    const url = await gh(
      [
        "pr",
        "create",
        "--head", branchName,
        "--base", baseBranch,
        "--title", title,
        "--body", body,
      ],
      cwd,
    );
    return url.trim();
  } catch (err) {
    // gh pr create fails if a PR already exists for the branch
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("already exists")) {
      return "";
    }
    throw err;
  }
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

async function gh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("gh", args, { cwd });
  return stdout;
}
