/**
 * GitHub datasource — reads and writes issues using the Octokit SDK.
 *
 * Requires:
 *   - A GitHub OAuth token (obtained via device flow on first use)
 *   - Working directory inside a GitHub repository with an `origin` remote
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Datasource, IssueDetails, IssueFetchOptions, DispatchLifecycleOptions } from "./interface.js";
import { slugify } from "../helpers/slugify.js";
import { log } from "../helpers/logger.js";
import { InvalidBranchNameError, isValidBranchName } from "../helpers/branch-validation.js";
import { getGithubOctokit } from "../helpers/auth.js";
import { getGitRemoteUrl, parseGitHubRemoteUrl } from "./index.js";
import { RequestError } from "@octokit/request-error";

export { InvalidBranchNameError } from "../helpers/branch-validation.js";

const exec = promisify(execFile);

/** Execute a git command and return stdout. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, shell: process.platform === "win32" });
  return stdout;
}

/**
 * Redact userinfo (credentials) from a URL for safe inclusion in error messages.
 */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/, "//***@");
}

/** Resolve the GitHub owner and repo from the git remote URL. */
async function getOwnerRepo(cwd: string): Promise<{ owner: string; repo: string }> {
  const remoteUrl = await getGitRemoteUrl(cwd);
  if (!remoteUrl) {
    throw new Error("Could not determine git remote URL. Is this a git repository with an origin remote?");
  }
  const parsed = parseGitHubRemoteUrl(remoteUrl);
  if (!parsed) {
    throw new Error(`Could not parse GitHub owner/repo from remote URL: ${redactUrl(remoteUrl)}`);
  }
  return parsed;
}

/**
 * Build a branch name from an issue number, title, and username.
 * Produces: `<username>/dispatch/<number>-<slugified-title>`
 *
 * @param issueNumber - The issue number/ID
 * @param title       - The issue title (will be slugified)
 * @param username    - The slugified git username to namespace the branch
 */
function buildBranchName(issueNumber: string, _title: string, username: string = "unknown"): string {
  return `${username}/dispatch/issue-${issueNumber}`;
}

/**
 * Derive a short username from git config.
 * - Multi-word name: first 2 chars of first name + first 6 of last name
 * - Single word or no name: first 8 chars of email local part
 * - Falls back to the provided `fallback` value
 */
async function deriveShortUsername(cwd: string, fallback: string): Promise<string> {
  try {
    const raw = (await git(["config", "user.name"], cwd)).trim();
    if (raw) {
      const parts = raw.toLowerCase().replace(/[^a-z\s]/g, "").trim().split(/\s+/);
      if (parts.length >= 2) {
        return (parts[0].slice(0, 2) + parts[parts.length - 1].slice(0, 6)) || fallback;
      }
    }
  } catch {
    // fall through to email
  }

  try {
    const raw = (await git(["config", "user.email"], cwd)).trim();
    if (raw) {
      const localPart = raw.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
      if (localPart) {
        return localPart.slice(0, 8);
      }
    }
  } catch {
    // fall through
  }

  return fallback;
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

  supportsGit(): boolean {
    return true;
  },

  async list(opts: IssueFetchOptions = {}): Promise<IssueDetails[]> {
    const cwd = opts.cwd || process.cwd();
    const { owner, repo } = await getOwnerRepo(cwd);
    const octokit = await getGithubOctokit();

    const issues = await octokit.paginate(
      octokit.rest.issues.listForRepo,
      {
        owner,
        repo,
        state: "open",
      },
    );

    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue): IssueDetails => ({
        number: String(issue.number),
        title: issue.title ?? "",
        body: issue.body ?? "",
        labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
        state: issue.state ?? "open",
        url: issue.html_url ?? "",
        comments: [],
        acceptanceCriteria: "",
      }));
  },

  async fetch(issueId: string, opts: IssueFetchOptions = {}): Promise<IssueDetails> {
    const cwd = opts.cwd || process.cwd();
    const { owner, repo } = await getOwnerRepo(cwd);
    const octokit = await getGithubOctokit();

    const { data: issue } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: Number(issueId),
    });

    const issueComments = await octokit.paginate(
      octokit.rest.issues.listComments,
      {
        owner,
        repo,
        issue_number: Number(issueId),
      },
    );

    const comments: string[] = issueComments.map(
      (c) => `**${c.user?.login ?? "unknown"}:** ${c.body ?? ""}`
    );

    return {
      number: String(issue.number),
      title: issue.title ?? "",
      body: issue.body ?? "",
      labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
      state: issue.state ?? "open",
      url: issue.html_url ?? "",
      comments,
      acceptanceCriteria: "",
    };
  },

  async update(issueId: string, title: string, body: string, opts: IssueFetchOptions = {}): Promise<void> {
    const cwd = opts.cwd || process.cwd();
    const { owner, repo } = await getOwnerRepo(cwd);
    const octokit = await getGithubOctokit();

    await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: Number(issueId),
      title,
      body,
    });
  },

  async close(issueId: string, opts: IssueFetchOptions = {}): Promise<void> {
    const cwd = opts.cwd || process.cwd();
    const { owner, repo } = await getOwnerRepo(cwd);
    const octokit = await getGithubOctokit();

    await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: Number(issueId),
      state: "closed",
    });
  },

  async create(title: string, body: string, opts: IssueFetchOptions = {}): Promise<IssueDetails> {
    const cwd = opts.cwd || process.cwd();
    const { owner, repo } = await getOwnerRepo(cwd);
    const octokit = await getGithubOctokit();

    const { data: issue } = await octokit.rest.issues.create({
      owner,
      repo,
      title,
      body,
    });

    return {
      number: String(issue.number),
      title: issue.title ?? "",
      body: issue.body ?? "",
      labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
      state: issue.state ?? "open",
      url: issue.html_url ?? "",
      comments: [],
      acceptanceCriteria: "",
    };
  },

  async getUsername(opts: DispatchLifecycleOptions): Promise<string> {
    if (opts.username) return opts.username;
    return deriveShortUsername(opts.cwd, "unknown");
  },

  getDefaultBranch(opts) {
    return getDefaultBranch(opts.cwd);
  },

  async getCurrentBranch(opts) {
    try {
      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], opts.cwd)).trim();
      // Detached HEAD returns the literal string "HEAD"
      if (branch && branch !== "HEAD") return branch;
    } catch { /* fall through */ }
    return this.getDefaultBranch(opts);
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
        try {
          await git(["checkout", branchName], cwd);
        } catch (checkoutErr) {
          const checkoutMessage = log.extractMessage(checkoutErr);
          if (checkoutMessage.includes("already used by worktree")) {
            await git(["worktree", "prune"], cwd);
            await git(["checkout", branchName], cwd);
          } else {
            throw checkoutErr;
          }
        }
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

  async createPullRequest(branchName, issueNumber, title, body, opts, baseBranch?) {
    const cwd = opts.cwd;
    const { owner, repo } = await getOwnerRepo(cwd);
    const octokit = await getGithubOctokit();
    const prBody = body || `Closes #${issueNumber}`;

    try {
      const target = baseBranch ?? await getDefaultBranch(cwd);
      const { data: pr } = await octokit.rest.pulls.create({
        owner,
        repo,
        title,
        body: prBody,
        head: branchName,
        base: target,
      });
      return pr.html_url;
    } catch (err: unknown) {
      // If a PR already exists for this branch, retrieve its URL.
      // Octokit throws a RequestError with status 422 for validation
      // failures, including "A pull request already exists".
      const isValidationError = err instanceof RequestError && err.status === 422;

      if (isValidationError) {
        const { data: prs } = await octokit.rest.pulls.list({
          owner,
          repo,
          head: `${owner}:${branchName}`,
          state: "open",
        });
        if (prs.length > 0) {
          return prs[0].html_url;
        }
      }
      throw err;
    }
  },
};
