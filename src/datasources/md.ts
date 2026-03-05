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
import { basename, dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { promisify } from "node:util";
import { glob } from "glob";
import type { Datasource, IssueDetails, IssueFetchOptions, DispatchLifecycleOptions } from "./interface.js";
import { slugify } from "../helpers/slugify.js";
import { loadConfig, saveConfig } from "../config.js";
import { log } from "../helpers/logger.js";
import { InvalidBranchNameError, isValidBranchName } from "../helpers/branch-validation.js";

const exec = promisify(execFile);

/** Execute a git command and return stdout. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, shell: process.platform === "win32" });
  return stdout;
}

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
 * Normalize an issue ID to a `.md` filename and resolve its full path.
 * - Absolute paths → returned as-is
 * - Relative paths (contain `/`, `\`, or start with `./` / `../`) → resolved
 *   relative to `opts.cwd` (or `process.cwd()`)
 * - Plain filenames → joined with the specs directory (existing behavior)
 */
function resolveFilePath(issueId: string, opts?: IssueFetchOptions): string {
  const filename = issueId.endsWith(".md") ? issueId : `${issueId}.md`;
  if (isAbsolute(filename)) return filename;
  if (/[/\\]/.test(filename)) {
    const cwd = opts?.cwd ?? process.cwd();
    return resolve(cwd, filename);
  }
  return join(resolveDir(opts), filename);
}

/**
 * Resolve a potentially numeric issue ID to its full file path.
 * If `issueId` is purely numeric (e.g. "1"), scans the specs directory for
 * a file matching `{id}-*.md` and returns its path. Falls back to the
 * standard `resolveFilePath` when no match is found or the ID is not numeric.
 */
async function resolveNumericFilePath(issueId: string, opts?: IssueFetchOptions): Promise<string> {
  if (/^\d+$/.test(issueId)) {
    const dir = resolveDir(opts);
    const entries = await readdir(dir);
    const match = entries.find((f) => f.startsWith(`${issueId}-`) && f.endsWith(".md"));
    if (match) {
      return join(dir, match);
    }
  }
  return resolveFilePath(issueId, opts);
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
  const idMatch = /^(\d+)-/.exec(filename);
  return {
    number: idMatch ? idMatch[1] : filename,
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

  supportsGit(): boolean {
    return true;
  },

  async list(opts?: IssueFetchOptions): Promise<IssueDetails[]> {
    if (opts?.pattern) {
      const cwd = opts.cwd ?? process.cwd();
      const files = await glob(opts.pattern, { cwd, absolute: true });
      const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
      const results: IssueDetails[] = [];

      for (const filePath of mdFiles) {
        const content = await readFile(filePath, "utf-8");
        const filename = basename(filePath);
        const dir = dirname(filePath);
        results.push(toIssueDetails(filename, content, dir));
      }

      return results;
    }

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
    if (/^\d+$/.test(issueId)) {
      const dir = resolveDir(opts);
      const entries = await readdir(dir);
      const match = entries.find((f) => f.startsWith(`${issueId}-`) && f.endsWith(".md"));
      if (match) {
        const content = await readFile(join(dir, match), "utf-8");
        return toIssueDetails(match, content, dir);
      }
    }
    const filePath = resolveFilePath(issueId, opts);
    const content = await readFile(filePath, "utf-8");
    const filename = basename(filePath);
    const dir = dirname(filePath);
    return toIssueDetails(filename, content, dir);
  },

  async update(issueId: string, _title: string, body: string, opts?: IssueFetchOptions): Promise<void> {
    const filePath = await resolveNumericFilePath(issueId, opts);
    await writeFile(filePath, body, "utf-8");
  },

  async close(issueId: string, opts?: IssueFetchOptions): Promise<void> {
    const filePath = await resolveNumericFilePath(issueId, opts);
    const filename = basename(filePath);
    const archiveDir = join(dirname(filePath), "archive");
    await mkdir(archiveDir, { recursive: true });
    await rename(filePath, join(archiveDir, filename));
  },

  async create(title: string, body: string, opts?: IssueFetchOptions): Promise<IssueDetails> {
    const cwd = opts?.cwd ?? process.cwd();
    const configDir = join(cwd, ".dispatch");
    const config = await loadConfig(configDir);
    const id = config.nextIssueId ?? 1;

    const dir = resolveDir(opts);
    await mkdir(dir, { recursive: true });
    const filename = `${id}-${slugify(title)}.md`;
    const filePath = join(dir, filename);
    await writeFile(filePath, body, "utf-8");

    config.nextIssueId = id + 1;
    await saveConfig(config, configDir);

    return {
      ...toIssueDetails(filename, body, dir),
      number: String(id),
    };
  },

  async getDefaultBranch(opts: DispatchLifecycleOptions): Promise<string> {
    const PREFIX = "refs/remotes/origin/";
    try {
      const ref = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], opts.cwd);
      const trimmed = ref.trim();
      const branch = trimmed.startsWith(PREFIX)
        ? trimmed.slice(PREFIX.length)
        : trimmed;
      if (!isValidBranchName(branch)) {
        throw new InvalidBranchNameError(branch, "from symbolic-ref output");
      }
      return branch;
    } catch (err) {
      if (err instanceof InvalidBranchNameError) {
        throw err;
      }
      try {
        await git(["rev-parse", "--verify", "main"], opts.cwd);
        return "main";
      } catch {
        return "master";
      }
    }
  },

  async getUsername(opts: DispatchLifecycleOptions): Promise<string> {
    try {
      const { stdout } = await exec("git", ["config", "user.name"], { cwd: opts.cwd, shell: process.platform === "win32" });
      const name = stdout.trim();
      if (!name) return "local";
      return slugify(name);
    } catch {
      return "local";
    }
  },

  buildBranchName(issueNumber: string, title: string, username: string): string {
    const slug = slugify(title, 50);
    return `${username}/dispatch/${issueNumber}-${slug}`;
  },

  async createAndSwitchBranch(branchName: string, opts: DispatchLifecycleOptions): Promise<void> {
    try {
      await git(["checkout", "-b", branchName], opts.cwd);
    } catch (err) {
      const message = log.extractMessage(err);
      if (message.includes("already exists")) {
        await git(["checkout", branchName], opts.cwd);
      } else {
        throw err;
      }
    }
  },

  async switchBranch(branchName: string, opts: DispatchLifecycleOptions): Promise<void> {
    await git(["checkout", branchName], opts.cwd);
  },

  async pushBranch(_branchName: string, _opts: DispatchLifecycleOptions): Promise<void> {
    // No-op: MD datasource does not push to a remote
  },

  async commitAllChanges(message: string, opts: DispatchLifecycleOptions): Promise<void> {
    const cwd = opts.cwd;
    await git(["add", "-A"], cwd);
    const status = await git(["diff", "--cached", "--stat"], cwd);
    if (!status.trim()) {
      return;
    }
    await git(["commit", "-m", message], cwd);
  },

  async createPullRequest(
    _branchName: string,
    _issueNumber: string,
    _title: string,
    _body: string,
    _opts: DispatchLifecycleOptions,
  ): Promise<string> {
    // No-op: MD datasource does not create pull requests
    return "";
  },
};
