import { basename, join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../helpers/logger.js";
import { getDatasource, detectDatasource } from "../datasources/index.js";
import type { Datasource, DatasourceName, IssueDetails, IssueFetchOptions } from "../datasources/interface.js";
import type { Task, TaskFile } from "../parser.js";
import type { DispatchResult } from "../dispatcher.js";
import { slugify } from "../helpers/slugify.js";

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
      log.warn(`Could not fetch issue #${id}: ${log.formatErrorChain(err)}`);
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
    const slug = slugify(item.title, 60);
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
 * For each spec file where all tasks completed successfully, extract the
 * issue number from the filename (`<id>-<slug>.md`) and close the originating
 * issue on the tracker.
 */
export async function closeCompletedSpecIssues(
  taskFiles: TaskFile[],
  results: DispatchResult[],
  cwd: string,
  source?: DatasourceName,
  org?: string,
  project?: string,
  workItemType?: string,
): Promise<void> {
  // Resolve the datasource — use explicit source or auto-detect
  let datasourceName = source;
  if (!datasourceName) {
    datasourceName = await detectDatasource(cwd) ?? undefined;
  }
  if (!datasourceName) return;

  const datasource = getDatasource(datasourceName);

  // Build a set of tasks that succeeded
  const succeededTasks = new Set(
    results.filter((r) => r.success).map((r) => r.task)
  );

  const fetchOpts: IssueFetchOptions = { cwd, org, project, workItemType };

  for (const taskFile of taskFiles) {
    const fileTasks = taskFile.tasks;
    if (fileTasks.length === 0) continue;

    // Only close if every task in this file completed successfully
    const allSucceeded = fileTasks.every((t) => succeededTasks.has(t));
    if (!allSucceeded) continue;

    // Extract the issue ID from the filename: "<id>-<slug>.md"
    const parsed = parseIssueFilename(taskFile.path);
    if (!parsed) continue;

    const { issueId } = parsed;
    const filename = basename(taskFile.path);
    try {
      await datasource.close(issueId, fetchOpts);
      log.success(`Closed issue #${issueId} (all tasks in ${filename} completed)`);
    } catch (err) {
      log.warn(`Could not close issue #${issueId}: ${log.formatErrorChain(err)}`);
    }
  }
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
