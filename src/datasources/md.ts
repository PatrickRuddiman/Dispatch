/**
 * Local markdown datasource — reads and writes `.md` files from a configurable
 * directory, treating each file as a work item / spec.
 *
 * Default directory: `.dispatch/specs/` (relative to the working directory).
 *
 * This datasource enables fully offline operation and local-first workflows
 * where markdown files serve as the source of truth.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, readdir, mkdir, rename } from "node:fs/promises";
import { join, parse as parsePath } from "node:path";
import { promisify } from "node:util";
import type { Datasource, IssueDetails, IssueFetchOptions, DispatchLifecycleOptions } from "./interface.js";
import { slugify } from "../helpers/slugify.js";

const exec = promisify(execFile);

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
 * Looks for the first `# Heading` line; if not found, derives a title from the
 * first meaningful line of content (stripping markdown formatting and truncating
 * to ~80 characters at a word boundary). Falls back to the filename when the
 * content has no usable text.
 */
export function extractTitle(content: string, filename: string): string {
  // Primary: H1 heading
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();

  // Secondary: first meaningful content line
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Strip leading markdown prefixes (##, -, *, >, or combinations)
    const cleaned = trimmed.replace(/^[#>*\-]+\s*/, "").trim();
    if (!cleaned) continue;

    // Truncate to ~80 chars at a word boundary
    if (cleaned.length <= 80) return cleaned;
    const truncated = cleaned.slice(0, 80);
    const lastSpace = truncated.lastIndexOf(" ");
    return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  }

  // Fallback: filename without extension
  return parsePath(filename).name;
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
    const filename = `${slugify(title)}.md`;
    const filePath = join(dir, filename);
    await writeFile(filePath, body, "utf-8");
    return toIssueDetails(filename, body, dir);
  },

  async getDefaultBranch(_opts: DispatchLifecycleOptions): Promise<string> {
    return "main";
  },

  async getUsername(opts: DispatchLifecycleOptions): Promise<string> {
    try {
      const { stdout } = await exec("git", ["config", "user.name"], { cwd: opts.cwd });
      const name = stdout.trim();
      if (!name) return "local";
      return slugify(name);
    } catch {
      return "local";
    }
  },

  buildBranchName(issueNumber: string, username?: string): string {
    return `${(username ?? "local")}/dispatch/${issueNumber}`;
  },

  async createAndSwitchBranch(_branchName: string, _opts: DispatchLifecycleOptions): Promise<void> {
    // No-op for local markdown datasource
  },

  async switchBranch(_branchName: string, _opts: DispatchLifecycleOptions): Promise<void> {
    // No-op for local markdown datasource
  },

  async pushBranch(_branchName: string, _opts: DispatchLifecycleOptions): Promise<void> {
    // No-op for local markdown datasource
  },

  async commitAllChanges(_message: string, _opts: DispatchLifecycleOptions): Promise<void> {
    // No-op for local markdown datasource
  },

  async createPullRequest(
    _branchName: string,
    _issueNumber: string,
    _title: string,
    _body: string,
    _opts: DispatchLifecycleOptions,
  ): Promise<string> {
    // No-op for local markdown datasource
    return "";
  },
};
