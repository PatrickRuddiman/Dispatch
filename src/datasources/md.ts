/**
 * Local markdown datasource — reads and writes `.md` files from a configurable
 * directory, treating each file as a work item / spec.
 *
 * Default directory: `.dispatch/specs/` (relative to the working directory).
 *
 * This datasource enables fully offline operation and local-first workflows
 * where markdown files serve as the source of truth.
 */

import { readFile, writeFile, readdir, mkdir, rename } from "node:fs/promises";
import { join, parse as parsePath } from "node:path";
import type { Datasource, IssueDetails, IssueFetchOptions } from "../datasource.js";

/** Default directory for markdown specs, relative to cwd. */
const DEFAULT_DIR = ".dispatch/specs";

/**
 * Resolve the specs directory from options.
 * Uses `opts.cwd` joined with `DEFAULT_DIR`, or just `DEFAULT_DIR`
 * relative to `process.cwd()`.
 */
function resolveDir(opts?: IssueFetchOptions): string {
  const cwd = opts?.cwd ?? process.cwd();
  return join(cwd, DEFAULT_DIR);
}

/**
 * Extract a title from markdown content.
 * Looks for the first `# Heading` line; falls back to the filename.
 */
function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : parsePath(filename).name;
}

/**
 * Build an `IssueDetails` object from a markdown file's content and filename.
 */
function toIssueDetails(filename: string, content: string, dir: string): IssueDetails {
  return {
    number: filename,
    title: extractTitle(content, filename),
    body: content,
    labels: [],
    state: "open",
    url: join(dir, filename),
    comments: [],
    acceptanceCriteria: "",
  };
}

export const datasource: Datasource = {
  name: "md",

  async list(opts?: IssueFetchOptions): Promise<IssueDetails[]> {
    const dir = resolveDir(opts);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
    const results: IssueDetails[] = [];

    for (const filename of mdFiles) {
      const filePath = join(dir, filename);
      const content = await readFile(filePath, "utf-8");
      results.push(toIssueDetails(filename, content, dir));
    }

    return results;
  },

  async fetch(issueId: string, opts?: IssueFetchOptions): Promise<IssueDetails> {
    const dir = resolveDir(opts);
    const filename = issueId.endsWith(".md") ? issueId : `${issueId}.md`;
    const filePath = join(dir, filename);
    const content = await readFile(filePath, "utf-8");
    return toIssueDetails(filename, content, dir);
  },

  async update(issueId: string, _title: string, body: string, opts?: IssueFetchOptions): Promise<void> {
    const dir = resolveDir(opts);
    const filename = issueId.endsWith(".md") ? issueId : `${issueId}.md`;
    const filePath = join(dir, filename);
    await writeFile(filePath, body, "utf-8");
  },

  async close(issueId: string, opts?: IssueFetchOptions): Promise<void> {
    const dir = resolveDir(opts);
    const filename = issueId.endsWith(".md") ? issueId : `${issueId}.md`;
    const filePath = join(dir, filename);
    const archiveDir = join(dir, "archive");
    await mkdir(archiveDir, { recursive: true });
    await rename(filePath, join(archiveDir, filename));
  },

  async create(title: string, body: string, opts?: IssueFetchOptions): Promise<IssueDetails> {
    const dir = resolveDir(opts);
    await mkdir(dir, { recursive: true });
    const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
    const filePath = join(dir, filename);
    await writeFile(filePath, body, "utf-8");
    return toIssueDetails(filename, body, dir);
  },
};
