import { basename, join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../helpers/logger.js";
import type { Datasource, DatasourceName, IssueDetails, IssueFetchOptions } from "../datasources/interface.js";
import type { Task } from "../parser.js";
import type { DispatchResult } from "../dispatcher.js";
import { slugify, MAX_SLUG_LENGTH } from "../helpers/slugify.js";

const exec = promisify(execFile);

/** Result of writing issue items to a temp directory. */
export interface WriteItemsResult {
  /** Sorted list of written file paths */
  files: string[];
  /** Mapping from file path to the original IssueDetails */
  issueDetailsByFile: Map<string, IssueDetails>;
}

/**
 * Parse an issue ID and slug from a `<id>-<slug>.md` filename.
 *
 * Returns the numeric issue ID and slug, or `null` if the filename
 * does not match the expected `<id>-<slug>.md` pattern.
 */
export function parseIssueFilename(filePath: string): { issueId: string; slug: string } | null {
  const filename = basename(filePath);
  const match = /^(\d+)-(.+)\.md$/.exec(filename);
  if (!match) return null;
  return { issueId: match[1], slug: match[2] };
}

/**
 * Fetch specific issues by ID from a datasource.
 * Logs a warning and skips any ID that fails to fetch.
 */
export async function fetchItemsById(
  issueIds: string[],
  datasource: Datasource,
  fetchOpts: IssueFetchOptions,
): Promise<IssueDetails[]> {
  const ids = issueIds.flatMap((id) =>
    id.split(",").map((s) => s.trim()).filter(Boolean)
  );
  const items = [];
  for (const id of ids) {
    try {
      const item = await datasource.fetch(id, fetchOpts);
      items.push(item);
    } catch (err) {
      const prefix = id.includes("/") || id.includes("\\") || id.endsWith(".md") ? "" : "#";
      log.warn(`Could not fetch issue ${prefix}${id}: ${log.formatErrorChain(err)}`);
    }
  }
  return items;
}

/**
 * Write a list of IssueDetails to a temp directory as `{number}-{slug}.md` files.
 * Returns the sorted file paths and a mapping from each path to its original IssueDetails.
 */
export async function writeItemsToTempDir(items: IssueDetails[]): Promise<WriteItemsResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "dispatch-"));
  const files: string[] = [];
  const issueDetailsByFile = new Map<string, IssueDetails>();

  for (const item of items) {
    const slug = slugify(item.title, MAX_SLUG_LENGTH);
    const filename = `${item.number}-${slug}.md`;
    const filepath = join(tempDir, filename);
    await writeFile(filepath, item.body, "utf-8");
    files.push(filepath);
    issueDetailsByFile.set(filepath, item);
  }

  files.sort((a, b) => {
    const numA = parseInt(basename(a).match(/^(\d+)/)?.[1] ?? "0", 10);
    const numB = parseInt(basename(b).match(/^(\d+)/)?.[1] ?? "0", 10);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b);
  });

  return { files, issueDetailsByFile };
}

/**
 * Retrieve one-line commit summaries for commits on the current branch
 * that are not on the given default branch.
 *
 * @param defaultBranch - The base branch to compare against (e.g. "main")
 * @param cwd - Working directory (git repo root)
 * @returns Array of commit summary strings, one per commit
 */
async function getCommitSummaries(defaultBranch: string, cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["log", `${defaultBranch}..HEAD`, "--pretty=format:%s"],
      { cwd },
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Retrieve the full diff of the current branch relative to the default branch.
 *
 * @param defaultBranch - The base branch to compare against (e.g. "main")
 * @param cwd - Working directory (git repo root)
 * @returns The diff output as a string, or an empty string on failure
 */
export async function getBranchDiff(defaultBranch: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await exec(
      "git",
      ["diff", `${defaultBranch}..HEAD`],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Amend the most recent commit's message without changing its content.
 *
 * @param message - The new commit message
 * @param cwd - Working directory (git repo root)
 */
export async function amendCommitMessage(message: string, cwd: string): Promise<void> {
  await exec(
    "git",
    ["commit", "--amend", "-m", message],
    { cwd },
  );
}

/**
 * Squash all commits on the current branch (relative to the default branch)
 * into a single commit with the given message.
 *
 * Uses a soft reset to the merge-base followed by a fresh commit, which
 * avoids interactive rebase complexity.
 *
 * @param defaultBranch - The base branch to compare against (e.g. "main")
 * @param message - The commit message for the squashed commit
 * @param cwd - Working directory (git repo root)
 */
export async function squashBranchCommits(
  defaultBranch: string,
  message: string,
  cwd: string,
): Promise<void> {
  const { stdout } = await exec(
    "git",
    ["merge-base", defaultBranch, "HEAD"],
    { cwd },
  );
  const mergeBase = stdout.trim();
  await exec("git", ["reset", "--soft", mergeBase], { cwd });
  await exec("git", ["commit", "-m", message], { cwd });
}

/**
 * Assemble a descriptive pull request body from pipeline data.
 *
 * Includes:
 * - A summary section with commit messages from the branch
 * - The list of completed tasks
 * - Labels from the issue (if any)
 * - An issue-close reference appropriate for the datasource
 *
 * @param details - The issue details (title, body, labels, number)
 * @param tasks - The tasks that were dispatched for this issue
 * @param results - The dispatch results for all tasks
 * @param defaultBranch - The base branch to compare commits against
 * @param datasourceName - The datasource backend name ("github", "azdevops", "md")
 * @param cwd - Working directory (git repo root)
 * @returns The assembled PR body as a markdown string
 */
export async function buildPrBody(
  details: IssueDetails,
  tasks: Task[],
  results: DispatchResult[],
  defaultBranch: string,
  datasourceName: DatasourceName,
  cwd: string,
): Promise<string> {
  const sections: string[] = [];

  // ── Commit summary section ──────────────────────────────────
  const commits = await getCommitSummaries(defaultBranch, cwd);
  if (commits.length > 0) {
    sections.push("## Summary\n");
    for (const commit of commits) {
      sections.push(`- ${commit}`);
    }
    sections.push("");
  }

  // ── Completed tasks section ─────────────────────────────────
  const taskResults = new Map(
    results
      .filter((r) => tasks.includes(r.task))
      .map((r) => [r.task, r]),
  );

  const completedTasks = tasks.filter((t) => taskResults.get(t)?.success);
  const failedTasks = tasks.filter((t) => {
    const r = taskResults.get(t);
    return r && !r.success;
  });

  if (completedTasks.length > 0 || failedTasks.length > 0) {
    sections.push("## Tasks\n");
    for (const task of completedTasks) {
      sections.push(`- [x] ${task.text}`);
    }
    for (const task of failedTasks) {
      sections.push(`- [ ] ${task.text}`);
    }
    sections.push("");
  }

  // ── Labels section ──────────────────────────────────────────
  if (details.labels.length > 0) {
    sections.push(`**Labels:** ${details.labels.join(", ")}\n`);
  }

  // ── Issue-close reference ───────────────────────────────────
  if (datasourceName === "github") {
    sections.push(`Closes #${details.number}`);
  } else if (datasourceName === "azdevops") {
    sections.push(`Resolves AB#${details.number}`);
  }

  return sections.join("\n");
}

/**
 * Generate a descriptive PR title from commit messages on the branch.
 *
 * If a single commit exists, its message is used as the title.
 * If multiple commits exist, a summary title is generated that
 * captures the scope, prefixed with the issue title.
 * Falls back to the issue title if no commits are found.
 *
 * @param issueTitle - The original issue title (used as fallback)
 * @param defaultBranch - The base branch to compare commits against
 * @param cwd - Working directory (git repo root)
 * @returns A descriptive PR title string
 */
export async function buildPrTitle(
  issueTitle: string,
  defaultBranch: string,
  cwd: string,
): Promise<string> {
  const commits = await getCommitSummaries(defaultBranch, cwd);

  if (commits.length === 0) {
    return issueTitle;
  }

  if (commits.length === 1) {
    return commits[0];
  }

  // Multiple commits — use the first commit message with a count suffix
  return `${commits[commits.length - 1]} (+${commits.length - 1} more)`;
}

/**
 * Build an aggregated PR title for feature mode.
 *
 * When a single issue is processed, the PR title is just that issue's title.
 * For multiple issues, the title includes the feature branch name and
 * references to all issues.
 *
 * @param featureBranchName - The feature branch name (e.g. "dispatch/feature-a1b2c3d4")
 * @param issues - All issue details processed in this feature run
 * @returns An aggregated PR title string
 */
export function buildFeaturePrTitle(featureBranchName: string, issues: IssueDetails[]): string {
  if (issues.length === 1) {
    return issues[0].title;
  }
  const issueRefs = issues.map((d) => `#${d.number}`).join(", ");
  return `feat: ${featureBranchName} (${issueRefs})`;
}

/**
 * Build an aggregated PR body for feature mode that references all issues,
 * their tasks, and completion status.
 *
 * Includes:
 * - An issues section listing all issues addressed
 * - A tasks section with completion checkboxes
 * - Issue-close references appropriate for the datasource
 *
 * @param issues - All issue details processed in this feature run
 * @param tasks - All tasks dispatched across all issues
 * @param results - The dispatch results for all tasks
 * @param datasourceName - The datasource backend name ("github", "azdevops", "md")
 * @returns The assembled aggregated PR body as a markdown string
 */
export function buildFeaturePrBody(
  issues: IssueDetails[],
  tasks: Task[],
  results: DispatchResult[],
  datasourceName: DatasourceName,
): string {
  const sections: string[] = [];

  sections.push("## Issues\n");
  for (const issue of issues) {
    sections.push(`- #${issue.number}: ${issue.title}`);
  }
  sections.push("");

  const taskResults = new Map(results.map((r) => [r.task, r]));
  const completedTasks = tasks.filter((t) => taskResults.get(t)?.success);
  const failedTasks = tasks.filter((t) => {
    const r = taskResults.get(t);
    return r && !r.success;
  });

  if (completedTasks.length > 0 || failedTasks.length > 0) {
    sections.push("## Tasks\n");
    for (const task of completedTasks) {
      sections.push(`- [x] ${task.text}`);
    }
    for (const task of failedTasks) {
      sections.push(`- [ ] ${task.text}`);
    }
    sections.push("");
  }

  for (const issue of issues) {
    if (datasourceName === "github") {
      sections.push(`Closes #${issue.number}`);
    } else if (datasourceName === "azdevops") {
      sections.push(`Resolves AB#${issue.number}`);
    }
  }

  return sections.join("\n");
}
