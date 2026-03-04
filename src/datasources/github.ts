/**
 * GitHub datasource — reads and writes issues using the `gh` CLI.
 *
 * Requires:
 *   - `gh` CLI installed and authenticated
 *   - Working directory inside a GitHub repository (or GITHUB_REPOSITORY set)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Datasource, IssueDetails, IssueFetchOptions, DispatchLifecycleOptions } from "./interface.js";
import { slugify } from "../helpers/slugify.js";
import { log } from "../helpers/logger.js";

const exec = promisify(execFile);

/**
 * Thrown when a branch name fails validation.
 * Provides reliable `instanceof` detection instead of brittle message-string checks.
 */
export class InvalidBranchNameError extends Error {
  constructor(branch: string, reason?: string) {
    const detail = reason ? ` (${reason})` : "";
    super(`Invalid branch name: "${branch}"${detail}`);
    this.name = "InvalidBranchNameError";
  }
}

/** Execute a git command and return stdout. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout;
}

/** Execute a gh CLI command and return stdout. */
async function gh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("gh", args, { cwd });
  return stdout;
}

/** Strict pattern for valid git branch name character set. */
const VALID_BRANCH_NAME_RE = /^[a-zA-Z0-9._\-/]+$/;

/**
 * Check whether a branch name is safe to use in git/gh commands.
 * Enforces git refname rules beyond simple character validation:
 *  - Must be 1–255 characters of allowed characters
 *  - Cannot start or end with "/"
 *  - Cannot contain ".." (parent traversal)
 *  - Cannot end with ".lock"
 *  - Cannot contain "@{" (reflog syntax)
 *  - Cannot contain "//" (empty path component)
 */
function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (!VALID_BRANCH_NAME_RE.test(name)) return false;
  if (name.startsWith("/") || name.endsWith("/")) return false;
  if (name.includes("..")) return false;
  if (name.endsWith(".lock")) return false;
  if (name.includes("@{")) return false;
  if (name.includes("//")) return false;
  return true;
}

/**
 * Build a branch name from an issue number, title, and username.
 * Produces: `<username>/dispatch/<number>-<slugified-title>`
 *
 * @param issueNumber - The issue number/ID
 * @param title       - The issue title (will be slugified)
 * @param username    - The slugified git username to namespace the branch
 */
function buildBranchName(issueNumber: string, title: string, username: string = "unknown"): string {
  const slug = slugify(title, 50);
  return `${username}/dispatch/${issueNumber}-${slug}`;
}

/**
 * Detect the default branch of the repository.
 * Tries `git symbolic-ref refs/remotes/origin/HEAD` first,
 * falls back to checking if "main" or "master" exists.
 */
async function getDefaultBranch(cwd: string): Promise<string> {
  const PREFIX = "refs/remotes/origin/";
  try {
    const ref = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
    // ref looks like "refs/remotes/origin/main" or "refs/remotes/origin/release/2024"
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
    // Fallback: check if "main" branch exists
    try {
      await git(["rev-parse", "--verify", "main"], cwd);
      return "main";
    } catch {
      return "master";
    }
  }
}

/**
 * Gather commit messages from the current branch relative to the default branch.
 * Uses `git log` to list commits that exist on the current branch but not on
 * the default branch, returning each commit's subject line.
 *
 * @param defaultBranch - The default branch name to compare against (e.g. "main")
 * @param cwd - The working directory (git repo root)
 * @returns An array of commit message subject lines
 */
export async function getCommitMessages(defaultBranch: string, cwd: string): Promise<string[]> {
  try {
    const output = await git(
      ["log", `origin/${defaultBranch}..HEAD`, "--pretty=format:%s"],
      cwd,
    );
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export const datasource: Datasource = {
  name: "github",

  async list(opts: IssueFetchOptions = {}): Promise<IssueDetails[]> {
    const cwd = opts.cwd || process.cwd();

    const { stdout } = await exec(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--json",
        "number,title,body,labels,state,url",
      ],
      { cwd }
    );

    let issues;
    try {
      issues = JSON.parse(stdout);
    } catch {
      throw new Error(`Failed to parse GitHub CLI output: ${stdout.slice(0, 200)}`);
    }

    return issues.map(
      (issue: {
        number: number;
        title?: string;
        body?: string;
        labels?: { name: string }[];
        state?: string;
        url?: string;
      }): IssueDetails => ({
        number: String(issue.number),
        title: issue.title ?? "",
        body: issue.body ?? "",
        labels: (issue.labels ?? []).map((l) => l.name),
        state: issue.state ?? "OPEN",
        url: issue.url ?? "",
        comments: [],
        acceptanceCriteria: "",
      })
    );
  },

  async fetch(issueId: string, opts: IssueFetchOptions = {}): Promise<IssueDetails> {
    const cwd = opts.cwd || process.cwd();

    const { stdout } = await exec(
      "gh",
      [
        "issue",
        "view",
        issueId,
        "--json",
        "number,title,body,labels,state,url,comments",
      ],
      { cwd }
    );

    let issue;
    try {
      issue = JSON.parse(stdout);
    } catch {
      throw new Error(`Failed to parse GitHub CLI output: ${stdout.slice(0, 200)}`);
    }

    const comments: string[] = [];
    if (issue.comments && Array.isArray(issue.comments)) {
      for (const c of issue.comments) {
        const author = c.author?.login ?? "unknown";
        comments.push(`**${author}:** ${c.body}`);
      }
    }

    return {
      number: String(issue.number),
      title: issue.title ?? "",
      body: issue.body ?? "",
      labels: (issue.labels ?? []).map((l: { name: string }) => l.name),
      state: issue.state ?? "OPEN",
      url: issue.url ?? "",
      comments,
      acceptanceCriteria: "",
    };
  },

  async update(issueId: string, title: string, body: string, opts: IssueFetchOptions = {}): Promise<void> {
    const cwd = opts.cwd || process.cwd();
    await exec("gh", ["issue", "edit", issueId, "--title", title, "--body", body], { cwd });
  },

  async close(issueId: string, opts: IssueFetchOptions = {}): Promise<void> {
    const cwd = opts.cwd || process.cwd();
    await exec("gh", ["issue", "close", issueId], { cwd });
  },

  async create(title: string, body: string, opts: IssueFetchOptions = {}): Promise<IssueDetails> {
    const cwd = opts.cwd || process.cwd();

    // gh issue create outputs the URL of the created issue on stdout.
    // It does not support --json (unlike gh issue view / gh issue list).
    const { stdout } = await exec(
      "gh",
      ["issue", "create", "--title", title, "--body", body],
      { cwd }
    );

    const url = stdout.trim();
    const match = url.match(/\/issues\/(\d+)$/);
    const number = match ? match[1] : "0";

    return {
      number,
      title,
      body,
      labels: [],
      state: "open",
      url,
      comments: [],
      acceptanceCriteria: "",
    };
  },

  async getUsername(opts: DispatchLifecycleOptions): Promise<string> {
    try {
      const name = await git(["config", "user.name"], opts.cwd);
      const slug = slugify(name.trim());
      return slug || "unknown";
    } catch {
      return "unknown";
    }
  },

  getDefaultBranch(opts) {
    return getDefaultBranch(opts.cwd);
  },

  buildBranchName(issueNumber: string, title: string, username?: string): string {
    return buildBranchName(issueNumber, title, username ?? "unknown");
  },

  async createAndSwitchBranch(branchName, opts) {
    const cwd = opts.cwd;
    try {
      await git(["checkout", "-b", branchName], cwd);
    } catch (err) {
      // Branch may already exist — switch to it instead
      const message = log.extractMessage(err);
      if (message.includes("already exists")) {
        await git(["checkout", branchName], cwd);
      } else {
        throw err;
      }
    }
  },

  async switchBranch(branchName, opts) {
    await git(["checkout", branchName], opts.cwd);
  },

  async pushBranch(branchName, opts) {
    await git(["push", "--set-upstream", "origin", branchName], opts.cwd);
  },

  async commitAllChanges(message, opts) {
    const cwd = opts.cwd;
    await git(["add", "-A"], cwd);
    const status = await git(["diff", "--cached", "--stat"], cwd);
    if (!status.trim()) {
      return; // nothing to commit
    }
    await git(["commit", "-m", message], cwd);
  },

  async createPullRequest(branchName, issueNumber, title, body, opts) {
    const cwd = opts.cwd;
    const prBody = body || `Closes #${issueNumber}`;
    try {
      const url = await gh(
        [
          "pr",
          "create",
          "--title",
          title,
          "--body",
          prBody,
          "--head",
          branchName,
        ],
        cwd,
      );
      return url.trim();
    } catch (err) {
      // If a PR already exists for this branch, retrieve its URL
      const message = log.extractMessage(err);
      if (message.includes("already exists")) {
        const existing = await gh(
          ["pr", "view", branchName, "--json", "url", "--jq", ".url"],
          cwd,
        );
        return existing.trim();
      }
      throw err;
    }
  },
};
