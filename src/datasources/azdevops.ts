/**
 * Azure DevOps datasource — reads and writes work items using the
 * `azure-devops-node-api` SDK with OAuth device-flow authentication.
 *
 * Requires:
 *   - Working directory inside an Azure DevOps git repository with an
 *     `origin` remote
 *   - User will be prompted to authenticate via device code on first use
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Datasource, IssueDetails, IssueFetchOptions, DispatchLifecycleOptions } from "./interface.js";
import { slugify } from "../helpers/slugify.js";
import { log } from "../helpers/logger.js";
import { InvalidBranchNameError, isValidBranchName } from "../helpers/branch-validation.js";
import { getAzureConnection } from "../helpers/auth.js";
import { getGitRemoteUrl, parseAzDevOpsRemoteUrl } from "./index.js";
import type { WebApi } from "azure-devops-node-api";
import type { TeamContext } from "azure-devops-node-api/interfaces/CoreInterfaces.js";
import type { JsonPatchDocument } from "azure-devops-node-api/interfaces/common/VSSInterfaces.js";
import { PullRequestStatus } from "azure-devops-node-api/interfaces/GitInterfaces.js";

const exec = promisify(execFile);
const doneStateCache = new Map<string, string>();

/** Execute a git command and return stdout. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, shell: process.platform === "win32" });
  return stdout;
}

/**
 * Redact userinfo (credentials) from a URL for safe inclusion in error messages.
 * Replaces `https://user:pass@host/...` or `https://user@host/...` with `https://***@host/...`.
 */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/, "//***@");
}

/**
 * Resolve the Azure DevOps org URL, project name, and an authenticated
 * WebApi connection from the git remote URL.
 *
 * If `opts.org` and `opts.project` are already provided they are used
 * directly; otherwise they are parsed from the `origin` remote.
 */
async function getOrgAndProject(
  opts: IssueFetchOptions = {}
): Promise<{ orgUrl: string; project: string; connection: WebApi }> {
  let orgUrl = opts.org;
  let project = opts.project;

  if (!orgUrl || !project) {
    const cwd = opts.cwd || process.cwd();
    const remoteUrl = await getGitRemoteUrl(cwd);
    if (!remoteUrl) {
      throw new Error(
        "Could not determine git remote URL. Is this a git repository with an origin remote?"
      );
    }
    const parsed = parseAzDevOpsRemoteUrl(remoteUrl);
    if (!parsed) {
      throw new Error(
        `Could not parse Azure DevOps org/project from remote URL: ${redactUrl(remoteUrl)}`
      );
    }
    orgUrl = orgUrl || parsed.orgUrl;
    project = project || parsed.project;
  }

  const connection = await getAzureConnection(orgUrl);
  return { orgUrl, project, connection };
}

/**
 * Map a raw Azure DevOps work item JSON object to an IssueDetails.
 */
function mapWorkItemToIssueDetails(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any,
  id: string,
  comments: string[],
  defaults?: { title?: string; body?: string; state?: string; workItemType?: string }
): IssueDetails {
  const fields = item.fields ?? {};
  return {
    number: String(item.id ?? id),
    title: fields["System.Title"] ?? defaults?.title ?? "",
    body: fields["System.Description"] ?? defaults?.body ?? "",
    labels: (fields["System.Tags"] ?? "")
      .split(";")
      .map((t: string) => t.trim())
      .filter(Boolean),
    state: fields["System.State"] ?? defaults?.state ?? "",
    url: item._links?.html?.href ?? item.url ?? "",
    comments,
    acceptanceCriteria:
      fields["Microsoft.VSTS.Common.AcceptanceCriteria"] ?? "",
    iterationPath: fields["System.IterationPath"] || undefined,
    areaPath: fields["System.AreaPath"] || undefined,
    assignee: fields["System.AssignedTo"]?.displayName || undefined,
    priority: fields["Microsoft.VSTS.Common.Priority"] ?? undefined,
    storyPoints:
      fields["Microsoft.VSTS.Scheduling.StoryPoints"] ??
      fields["Microsoft.VSTS.Scheduling.Effort"] ??
      fields["Microsoft.VSTS.Scheduling.Size"] ??
      undefined,
    workItemType: fields["System.WorkItemType"] || defaults?.workItemType || undefined,
  };
}

export async function detectWorkItemType(
  opts: IssueFetchOptions = {}
): Promise<string | null> {
  try {
    const { project, connection } = await getOrgAndProject(opts);
    const witApi = await connection.getWorkItemTrackingApi();
    const types = await witApi.getWorkItemTypes(project);

    if (!Array.isArray(types) || types.length === 0) return null;

    const names = types.map((t) => t.name).filter((n): n is string => !!n);
    const preferred = ["User Story", "Product Backlog Item", "Requirement", "Issue"];
    for (const p of preferred) {
      if (names.includes(p)) return p;
    }
    return names[0] ?? null;
  } catch {
    return null;
  }
}

export async function detectDoneState(
  workItemType: string,
  opts: IssueFetchOptions = {}
): Promise<string> {
  const { orgUrl, project, connection } = await getOrgAndProject(opts);
  const cacheKey = `${orgUrl}|${project}|${workItemType}`;
  const cached = doneStateCache.get(cacheKey);
  if (cached) return cached;

  try {
    const witApi = await connection.getWorkItemTrackingApi();
    const states = await witApi.getWorkItemTypeStates(project, workItemType);

    // Primary: find state with "Completed" category
    if (Array.isArray(states)) {
      const completed = states.find((s) => s.category === "Completed");
      if (completed?.name) {
        doneStateCache.set(cacheKey, completed.name);
        return completed.name;
      }

      // Fallback: check for known terminal states in priority order
      const names = states.map((s) => s.name).filter((n): n is string => !!n);
      const fallbacks = ["Done", "Closed", "Resolved", "Completed"];
      for (const f of fallbacks) {
        if (names.includes(f)) {
          doneStateCache.set(cacheKey, f);
          return f;
        }
      }
    }
  } catch {
    // Fall through to default
  }

  // Don't cache the default — a transient error should not
  // prevent subsequent calls from retrying the detection.
  return "Closed";
}

/**
 * Fetch comments for an Azure DevOps work item.
 * Non-fatal — returns empty array on failure.
 */
async function fetchComments(
  workItemId: number,
  project: string,
  connection: WebApi
): Promise<string[]> {
  try {
    const witApi = await connection.getWorkItemTrackingApi();
    const commentList = await witApi.getComments(project, workItemId);

    if (commentList.comments && Array.isArray(commentList.comments)) {
      return commentList.comments.map((c) => {
        const author = c.createdBy?.displayName ?? "unknown";
        return `**${author}:** ${c.text ?? ""}`;
      });
    }
    return [];
  } catch {
    return [];
  }
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

export const datasource: Datasource = {
  name: "azdevops",

  supportsGit(): boolean {
    return true;
  },

  async list(opts: IssueFetchOptions = {}): Promise<IssueDetails[]> {
    const { project, connection } = await getOrgAndProject(opts);
    const witApi = await connection.getWorkItemTrackingApi();

    const conditions = [
      "[System.State] <> 'Closed'",
      "[System.State] <> 'Done'",
      "[System.State] <> 'Removed'",
    ];

    if (opts.iteration) {
      const iterValue = String(opts.iteration).trim();
      if (iterValue === "@CurrentIteration") {
        conditions.push(`[System.IterationPath] UNDER @CurrentIteration`);
      } else {
        const escaped = iterValue.replace(/'/g, "''");
        if (escaped) conditions.push(`[System.IterationPath] UNDER '${escaped}'`);
      }
    }

    if (opts.area) {
      const area = String(opts.area).trim().replace(/'/g, "''");
      if (area) {
        conditions.push(`[System.AreaPath] UNDER '${area}'`);
      }
    }

    const wiql = `SELECT [System.Id] FROM workitems WHERE ${conditions.join(" AND ")} ORDER BY [System.CreatedDate] DESC`;

    const queryResult = await witApi.queryByWiql({ query: wiql }, { project } as TeamContext);
    const workItemRefs = queryResult.workItems ?? [];
    if (workItemRefs.length === 0) return [];

    const ids = workItemRefs
      .map((ref) => ref.id)
      .filter((id): id is number => id != null);

    if (ids.length === 0) return [];

    try {
      const items = await witApi.getWorkItems(ids);
      const itemsArray = Array.isArray(items) ? items : [items];

      // Fetch comments with bounded concurrency (batches of 5)
      const commentsArray: string[][] = [];
      const CONCURRENCY = 5;
      for (let i = 0; i < itemsArray.length; i += CONCURRENCY) {
        const batch = itemsArray.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map((item) => fetchComments(item.id!, project, connection))
        );
        commentsArray.push(...batchResults);
      }

      return itemsArray.map((item, i) =>
        mapWorkItemToIssueDetails(item, String(item.id), commentsArray[i])
      );
    } catch (err) {
      log.debug(`Batch getWorkItems failed, falling back to individual fetches: ${log.extractMessage(err)}`);
      // Fallback: fetch items individually in parallel
      const results = await Promise.all(
        ids.map((id) => datasource.fetch(String(id), opts))
      );
      return results;
    }
  },

  async fetch(
    issueId: string,
    opts: IssueFetchOptions = {}
  ): Promise<IssueDetails> {
    const { project, connection } = await getOrgAndProject(opts);
    const witApi = await connection.getWorkItemTrackingApi();

    const item = await witApi.getWorkItem(Number(issueId));
    const comments = await fetchComments(Number(issueId), project, connection);

    return mapWorkItemToIssueDetails(item, issueId, comments);
  },

  async update(
    issueId: string,
    title: string,
    body: string,
    opts: IssueFetchOptions = {}
  ): Promise<void> {
    const { connection } = await getOrgAndProject(opts);
    const witApi = await connection.getWorkItemTrackingApi();

    const document = [
      { op: "add", path: "/fields/System.Title", value: title },
      { op: "add", path: "/fields/System.Description", value: body },
    ];
    // customHeaders is the first arg (pass null), document second, id third
    await witApi.updateWorkItem(null as any, document as JsonPatchDocument, Number(issueId));
  },

  async close(
    issueId: string,
    opts: IssueFetchOptions = {}
  ): Promise<void> {
    const { connection } = await getOrgAndProject(opts);
    const witApi = await connection.getWorkItemTrackingApi();

    let workItemType = opts.workItemType;
    if (!workItemType) {
      const item = await witApi.getWorkItem(Number(issueId));
      workItemType = item.fields?.["System.WorkItemType"] ?? undefined;
    }

    const state = workItemType
      ? await detectDoneState(workItemType, opts)
      : "Closed";

    const document = [
      { op: "add", path: "/fields/System.State", value: state },
    ];
    await witApi.updateWorkItem(null as any, document as JsonPatchDocument, Number(issueId));
  },

  async create(
    title: string,
    body: string,
    opts: IssueFetchOptions = {}
  ): Promise<IssueDetails> {
    const workItemType =
      opts.workItemType ?? (await detectWorkItemType(opts));

    if (!workItemType) {
      throw new Error(
        "Could not determine work item type. Set workItemType in your config (for example via `dispatch config`)."
      );
    }

    const { project, connection } = await getOrgAndProject(opts);
    const witApi = await connection.getWorkItemTrackingApi();

    const document = [
      { op: "add", path: "/fields/System.Title", value: title },
      { op: "add", path: "/fields/System.Description", value: body },
    ];

    const item = await witApi.createWorkItem(
      null as any,
      document as JsonPatchDocument,
      project,
      workItemType
    );

    return mapWorkItemToIssueDetails(item, String(item.id), [], {
      title,
      body,
      state: "New",
      workItemType,
    });
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

  async getCurrentBranch(opts: DispatchLifecycleOptions): Promise<string> {
    try {
      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], opts.cwd)).trim();
      if (branch && branch !== "HEAD") return branch;
    } catch { /* fall through */ }
    return this.getDefaultBranch(opts);
  },

  async getUsername(opts: DispatchLifecycleOptions): Promise<string> {
    if (opts.username) return opts.username;
    return deriveShortUsername(opts.cwd, "unknown");
  },

  buildBranchName(issueNumber: string, _title: string, username: string): string {
    const branch = `${username}/dispatch/issue-${issueNumber}`;
    if (!isValidBranchName(branch)) {
      throw new InvalidBranchNameError(branch);
    }
    return branch;
  },

  async createAndSwitchBranch(branchName: string, opts: DispatchLifecycleOptions): Promise<void> {
    if (!isValidBranchName(branchName)) {
      throw new InvalidBranchNameError(branchName);
    }
    try {
      await git(["checkout", "-b", branchName], opts.cwd);
    } catch (err) {
      const message = log.extractMessage(err);
      if (message.includes("already exists")) {
        try {
          await git(["checkout", branchName], opts.cwd);
        } catch (checkoutErr) {
          const checkoutMessage = log.extractMessage(checkoutErr);
          if (checkoutMessage.includes("already used by worktree")) {
            await git(["worktree", "prune"], opts.cwd);
            await git(["checkout", branchName], opts.cwd);
          } else {
            throw checkoutErr;
          }
        }
      } else {
        throw err;
      }
    }
  },

  async switchBranch(branchName: string, opts: DispatchLifecycleOptions): Promise<void> {
    await git(["checkout", branchName], opts.cwd);
  },

  async pushBranch(branchName: string, opts: DispatchLifecycleOptions): Promise<void> {
    await git(["push", "--set-upstream", "origin", branchName], opts.cwd);
  },

  async commitAllChanges(message: string, opts: DispatchLifecycleOptions): Promise<void> {
    await git(["add", "-A"], opts.cwd);
    const status = await git(["diff", "--cached", "--stat"], opts.cwd);
    if (!status.trim()) {
      return; // nothing to commit
    }
    await git(["commit", "-m", message], opts.cwd);
  },

  async createPullRequest(
    branchName: string,
    issueNumber: string,
    title: string,
    body: string,
    opts: DispatchLifecycleOptions,
    baseBranch?: string,
  ): Promise<string> {
    const cwd = opts.cwd;
    const { orgUrl, project, connection } = await getOrgAndProject(opts);
    const gitApi = await connection.getGitApi();

    // Resolve the remote URL for repo matching
    const remoteUrl = await getGitRemoteUrl(cwd);
    if (!remoteUrl) {
      throw new Error("Could not determine git remote URL.");
    }

    // Find the repository by matching remote URL
    const repos = await gitApi.getRepositories(project);
    const normalizeUrl = (u: string) => u.replace(/\/\/[^@/]+@/, "//").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
    const normalizedRemote = normalizeUrl(remoteUrl);
    const repo = repos.find(
      (r) =>
        (r.remoteUrl && normalizeUrl(r.remoteUrl) === normalizedRemote) ||
        (r.sshUrl && normalizeUrl(r.sshUrl) === normalizedRemote) ||
        (r.webUrl && normalizeUrl(r.webUrl) === normalizedRemote)
    );

    if (!repo || !repo.id) {
      throw new Error(`Could not find Azure DevOps repository matching remote URL: ${redactUrl(remoteUrl)}`);
    }

    const target = baseBranch ?? await this.getDefaultBranch(opts);

    try {
      const pr = await gitApi.createPullRequest(
        {
          sourceRefName: `refs/heads/${branchName}`,
          targetRefName: `refs/heads/${target}`,
          title,
          description: body || `Resolves AB#${issueNumber}`,
          workItemRefs: [{ id: issueNumber }],
        },
        repo.id,
        project
      );

      // Construct web UI URL (SDK url is REST API URL, not browser URL)
      const webUrl = repo.webUrl
        ? `${repo.webUrl}/pullrequest/${pr.pullRequestId}`
        : pr.url ?? "";
      return webUrl;
    } catch (err) {
      // If a PR already exists for this branch, retrieve its URL
      const message = log.extractMessage(err);
      if (message.includes("already exists")) {
        const prs = await gitApi.getPullRequests(
          repo.id,
          {
            sourceRefName: `refs/heads/${branchName}`,
            status: PullRequestStatus.Active,
          },
          project
        );
        if (Array.isArray(prs) && prs.length > 0) {
          const existingPr = prs[0];
          const webUrl = repo.webUrl
            ? `${repo.webUrl}/pullrequest/${existingPr.pullRequestId}`
            : existingPr.url ?? "";
          return webUrl;
        }
        return "";
      }
      throw err;
    }
  },
};
