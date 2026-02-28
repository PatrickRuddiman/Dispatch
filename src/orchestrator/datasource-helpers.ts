import { basename, join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { log } from "../logger.js";
import { getDatasource, detectDatasource } from "../datasources/index.js";
import type { Datasource, DatasourceName, IssueDetails, IssueFetchOptions } from "../datasource.js";
import type { TaskFile } from "../parser.js";
import type { DispatchResult } from "../dispatcher.js";

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
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Could not fetch issue #${id}: ${message}`);
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
    const slug = item.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
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

  const fetchOpts: IssueFetchOptions = { cwd, org, project };

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
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Could not close issue #${issueId}: ${message}`);
    }
  }
}
