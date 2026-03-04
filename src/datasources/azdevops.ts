/**
 * Azure DevOps datasource — reads and writes work items using the `az` CLI.
 *
 * Requires:
 *   - `az` CLI installed with the `azure-devops` extension
 *   - User authenticated via `az login`
 *   - Organization and project specified via --org / --project flags
 *     or configured as defaults in the az CLI
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Datasource, IssueDetails, IssueFetchOptions, DispatchLifecycleOptions } from "./interface.js";
import { slugify } from "../helpers/slugify.js";
import { log } from "../helpers/logger.js";
import { InvalidBranchNameError, isValidBranchName } from "../helpers/branch-validation.js";

const exec = promisify(execFile);
const doneStateCache = new Map<string, string>();

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
    const args = ["boards", "work-item", "type", "list", "--output", "json"];
    if (opts.project) args.push("--project", opts.project);
    if (opts.org) args.push("--org", opts.org);

    const { stdout } = await exec("az", args, {
      cwd: opts.cwd || process.cwd(),
    });

    const types: { name: string }[] = JSON.parse(stdout);
    if (!Array.isArray(types) || types.length === 0) return null;

    const names = types.map((t) => t.name);
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
  const cacheKey = `${opts.org ?? ""}|${opts.project ?? ""}|${workItemType}`;
  const cached = doneStateCache.get(cacheKey);
  if (cached) return cached;

  try {
    const args = [
      "boards", "work-item", "type", "state", "list",
      "--type", workItemType,
      "--output", "json",
    ];
    if (opts.project) args.push("--project", opts.project);
    if (opts.org) args.push("--org", opts.org);

    const { stdout } = await exec("az", args, {
      cwd: opts.cwd || process.cwd(),
    });

    const states: { name: string; category?: string }[] = JSON.parse(stdout);

    // Primary: find state with "Completed" category
    if (Array.isArray(states)) {
      const completed = states.find((s) => s.category === "Completed");
      if (completed) {
        doneStateCache.set(cacheKey, completed.name);
        return completed.name;
      }

      // Fallback: check for known terminal states in priority order
      const names = states.map((s) => s.name);
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

  // Don't cache the default — a transient CLI/parse error should not
  // prevent subsequent calls from retrying the detection.
  return "Closed";
}

export const datasource: Datasource = {
  name: "azdevops",

  supportsGit(): boolean {
    return true;
  },

  async list(opts: IssueFetchOptions = {}): Promise<IssueDetails[]> {
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

    const args = ["boards", "query", "--wiql", wiql, "--output", "json"];
    if (opts.org) args.push("--org", opts.org);
    if (opts.project) args.push("--project", opts.project);

    const { stdout } = await exec("az", args, {
      cwd: opts.cwd || process.cwd(),
    });

    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new Error(`Failed to parse Azure CLI output: ${stdout.slice(0, 200)}`);
    }

    if (!Array.isArray(data)) return [];

    const ids = data
      .map((row) => String(row.id ?? row.ID ?? ""))
      .filter(Boolean);

    if (ids.length === 0) return [];

    try {
      const batchArgs = [
        "boards", "work-item", "show",
        "--id", ...ids,
        "--output", "json",
      ];
      if (opts.org) batchArgs.push("--org", opts.org);
      if (opts.project) batchArgs.push("--project", opts.project);

      const { stdout: batchStdout } = await exec("az", batchArgs, {
        cwd: opts.cwd || process.cwd(),
      });

      let batchItems;
      try {
        batchItems = JSON.parse(batchStdout);
      } catch {
        throw new Error(`Failed to parse Azure CLI output: ${batchStdout.slice(0, 200)}`);
      }

      const itemsArray = Array.isArray(batchItems) ? batchItems : [batchItems];

      // Fetch comments with bounded concurrency (batches of 5)
      const commentsArray: string[][] = [];
      const CONCURRENCY = 5;
      for (let i = 0; i < itemsArray.length; i += CONCURRENCY) {
        const batch = itemsArray.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map((item) => fetchComments(String(item.id), opts))
        );
        commentsArray.push(...batchResults);
      }

      return itemsArray.map((item, i) =>
        mapWorkItemToIssueDetails(item, String(item.id), commentsArray[i])
      );
    } catch (err) {
      log.debug(`Batch work-item show failed, falling back to individual fetches: ${log.extractMessage(err)}`);
      // Fallback: fetch items individually in parallel
      const results = await Promise.all(
        ids.map((id) => datasource.fetch(id, opts))
      );
      return results;
    }
  },

  async fetch(
    issueId: string,
    opts: IssueFetchOptions = {}
  ): Promise<IssueDetails> {
    const args = [
      "boards",
      "work-item",
      "show",
      "--id",
      issueId,
      "--output",
      "json",
    ];

    if (opts.org) {
      args.push("--org", opts.org);
    }
    if (opts.project) {
      args.push("--project", opts.project);
    }

    const { stdout } = await exec("az", args, {
      cwd: opts.cwd || process.cwd(),
    });

    let item;
    try {
      item = JSON.parse(stdout);
    } catch {
      throw new Error(`Failed to parse Azure CLI output: ${stdout.slice(0, 200)}`);
    }
    const comments = await fetchComments(issueId, opts);

    return mapWorkItemToIssueDetails(item, issueId, comments);
  },

  async update(
    issueId: string,
    title: string,
    body: string,
    opts: IssueFetchOptions = {}
  ): Promise<void> {
    const args = [
      "boards",
      "work-item",
      "update",
      "--id",
      issueId,
      "--title",
      title,
      "--description",
      body,
    ];
    if (opts.org) args.push("--org", opts.org);
    if (opts.project) args.push("--project", opts.project);
    await exec("az", args, { cwd: opts.cwd || process.cwd() });
  },

  async close(
    issueId: string,
    opts: IssueFetchOptions = {}
  ): Promise<void> {
    let workItemType = opts.workItemType;
    if (!workItemType) {
      const showArgs = [
        "boards",
        "work-item",
        "show",
        "--id",
        issueId,
        "--output",
        "json",
      ];
      if (opts.org) showArgs.push("--org", opts.org);
      if (opts.project) showArgs.push("--project", opts.project);
      const { stdout } = await exec("az", showArgs, {
        cwd: opts.cwd || process.cwd(),
      });
      try {
        const item = JSON.parse(stdout);
        workItemType = item.fields?.["System.WorkItemType"] ?? undefined;
      } catch {
        workItemType = undefined;
      }
    }

    const state = workItemType
      ? await detectDoneState(workItemType, opts)
      : "Closed";

    const args = [
      "boards",
      "work-item",
      "update",
      "--id",
      issueId,
      "--state",
      state,
    ];
    if (opts.org) args.push("--org", opts.org);
    if (opts.project) args.push("--project", opts.project);
    await exec("az", args, { cwd: opts.cwd || process.cwd() });
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

    const args = [
      "boards",
      "work-item",
      "create",
      "--type",
      workItemType,
      "--title",
      title,
      "--description",
      body,
      "--output",
      "json",
    ];
    if (opts.org) args.push("--org", opts.org);
    if (opts.project) args.push("--project", opts.project);

    const { stdout } = await exec("az", args, {
      cwd: opts.cwd || process.cwd(),
    });

    let item;
    try {
      item = JSON.parse(stdout);
    } catch {
      throw new Error(`Failed to parse Azure CLI output: ${stdout.slice(0, 200)}`);
    }
    return mapWorkItemToIssueDetails(item, String(item.id), [], {
      title,
      body,
      state: "New",
      workItemType: workItemType,
    });
  },

  async getDefaultBranch(opts: DispatchLifecycleOptions): Promise<string> {
    try {
      const { stdout } = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: opts.cwd });
      const parts = stdout.trim().split("/");
      const branch = parts[parts.length - 1];
      if (!isValidBranchName(branch)) {
        throw new InvalidBranchNameError(branch, "from symbolic-ref output");
      }
      return branch;
    } catch (err) {
      if (err instanceof InvalidBranchNameError) {
        throw err;
      }
      try {
        await exec("git", ["rev-parse", "--verify", "main"], { cwd: opts.cwd });
        return "main";
      } catch {
        return "master";
      }
    }
  },

  async getUsername(opts: DispatchLifecycleOptions): Promise<string> {
    try {
      const { stdout } = await exec("git", ["config", "user.name"], { cwd: opts.cwd });
      const name = slugify(stdout.trim());
      if (name) return name;
    } catch {
      // fall through
    }

    try {
      const { stdout } = await exec("az", ["account", "show", "--query", "user.name", "-o", "tsv"], { cwd: opts.cwd });
      const name = slugify(stdout.trim());
      if (name) return name;
    } catch {
      // fall through
    }

    try {
      const { stdout } = await exec("az", ["account", "show", "--query", "user.principalName", "-o", "tsv"], { cwd: opts.cwd });
      const principal = stdout.trim();
      const prefix = principal.split("@")[0];
      const name = slugify(prefix);
      if (name) return name;
    } catch {
      // fall through
    }

    return "unknown";
  },

  buildBranchName(issueNumber: string, title: string, username: string): string {
    const slug = slugify(title, 50);
    const branch = `${username}/dispatch/${issueNumber}-${slug}`;
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
      await exec("git", ["checkout", "-b", branchName], { cwd: opts.cwd });
    } catch (err) {
      const message = log.extractMessage(err);
      if (message.includes("already exists")) {
        await exec("git", ["checkout", branchName], { cwd: opts.cwd });
      } else {
        throw err;
      }
    }
  },

  async switchBranch(branchName: string, opts: DispatchLifecycleOptions): Promise<void> {
    await exec("git", ["checkout", branchName], { cwd: opts.cwd });
  },

  async pushBranch(branchName: string, opts: DispatchLifecycleOptions): Promise<void> {
    await exec("git", ["push", "--set-upstream", "origin", branchName], { cwd: opts.cwd });
  },

  async commitAllChanges(message: string, opts: DispatchLifecycleOptions): Promise<void> {
    await exec("git", ["add", "-A"], { cwd: opts.cwd });
    const { stdout } = await exec("git", ["diff", "--cached", "--stat"], { cwd: opts.cwd });
    if (!stdout.trim()) {
      return; // nothing to commit
    }
    await exec("git", ["commit", "-m", message], { cwd: opts.cwd });
  },

  async createPullRequest(
    branchName: string,
    issueNumber: string,
    title: string,
    body: string,
    opts: DispatchLifecycleOptions,
  ): Promise<string> {
    try {
      const { stdout } = await exec(
        "az",
        [
          "repos",
          "pr",
          "create",
          "--title",
          title,
          "--description",
          body || `Resolves AB#${issueNumber}`,
          "--source-branch",
          branchName,
          "--work-items",
          issueNumber,
          "--output",
          "json",
        ],
        { cwd: opts.cwd },
      );
      let pr;
      try {
        pr = JSON.parse(stdout);
      } catch {
        throw new Error(`Failed to parse Azure CLI output: ${stdout.slice(0, 200)}`);
      }
      return pr.url ?? "";
    } catch (err) {
      // If a PR already exists for this branch, retrieve its URL
      const message = log.extractMessage(err);
      if (message.includes("already exists")) {
        const { stdout } = await exec(
          "az",
          [
            "repos",
            "pr",
            "list",
            "--source-branch",
            branchName,
            "--status",
            "active",
            "--output",
            "json",
          ],
          { cwd: opts.cwd },
        );
        let prs;
        try {
          prs = JSON.parse(stdout);
        } catch {
          throw new Error(`Failed to parse Azure CLI output: ${stdout.slice(0, 200)}`);
        }
        if (Array.isArray(prs) && prs.length > 0) {
          return prs[0].url ?? "";
        }
        return "";
      }
      throw err;
    }
  },
};

/**
 * Fetch comments for an Azure DevOps work item.
 * Non-fatal — returns empty array on failure.
 */
async function fetchComments(
  workItemId: string,
  opts: IssueFetchOptions
): Promise<string[]> {
  try {
    const args = [
      "boards",
      "work-item",
      "relation",
      "list-comment",
      "--work-item-id",
      workItemId,
      "--output",
      "json",
    ];

    if (opts.org) {
      args.push("--org", opts.org);
    }
    if (opts.project) {
      args.push("--project", opts.project);
    }

    const { stdout } = await exec("az", args, {
      cwd: opts.cwd || process.cwd(),
    });

    const data = JSON.parse(stdout);
    if (data.comments && Array.isArray(data.comments)) {
      return data.comments.map(
        (c: { text?: string; createdBy?: { displayName?: string } }) => {
          const author = c.createdBy?.displayName ?? "unknown";
          return `**${author}:** ${c.text ?? ""}`;
        }
      );
    }
    return [];
  } catch {
    return [];
  }
}
