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

const exec = promisify(execFile);

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

/**
 * Build a branch name from an issue number and title.
 * Produces: `dispatch/<number>-<slugified-title>`
 */
function buildBranchName(issueNumber: string, title: string): string {
  const slug = slugify(title, 50);
  return `dispatch/${issueNumber}-${slug}`;
}

/**
 * Detect the default branch of the repository.
 * Tries `git symbolic-ref refs/remotes/origin/HEAD` first,
 * falls back to checking if "main" or "master" exists.
 */
async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    const ref = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
    // ref looks like "refs/remotes/origin/main"
    const parts = ref.trim().split("/");
    return parts[parts.length - 1];
  } catch {
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

    const issues = JSON.parse(stdout);

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

    const issue = JSON.parse(stdout);

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

  getDefaultBranch(opts) {
    return getDefaultBranch(opts.cwd);
  },

  buildBranchName(issueNumber, title) {
    return buildBranchName(issueNumber, title);
  },

  async createAndSwitchBranch(branchName, opts) {
    const cwd = opts.cwd;
    try {
      await git(["checkout", "-b", branchName], cwd);
    } catch (err) {
      // Branch may already exist — switch to it instead
      const message = err instanceof Error ? err.message : String(err);
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
      const message = err instanceof Error ? err.message : String(err);
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
