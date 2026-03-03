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

const exec = promisify(execFile);

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

export const datasource: Datasource = {
  name: "azdevops",

  async list(opts: IssueFetchOptions = {}): Promise<IssueDetails[]> {
    const wiql =
      "SELECT [System.Id] FROM workitems WHERE [System.State] <> 'Closed' AND [System.State] <> 'Removed' ORDER BY [System.CreatedDate] DESC";

    const args = ["boards", "query", "--wiql", wiql, "--output", "json"];
    if (opts.org) args.push("--org", opts.org);
    if (opts.project) args.push("--project", opts.project);

    const { stdout } = await exec("az", args, {
      cwd: opts.cwd || process.cwd(),
    });

    const data = JSON.parse(stdout);
    const items: IssueDetails[] = [];

    if (Array.isArray(data)) {
      for (const row of data) {
        const id = String(row.id ?? row.ID ?? "");
        if (id) {
          const detail = await datasource.fetch(id, opts);
          items.push(detail);
        }
      }
    }

    return items;
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

    const item = JSON.parse(stdout);
    const fields = item.fields ?? {};

    const comments = await fetchComments(issueId, opts);

    return {
      number: String(item.id ?? issueId),
      title: fields["System.Title"] ?? "",
      body: fields["System.Description"] ?? "",
      labels: (fields["System.Tags"] ?? "")
        .split(";")
        .map((t: string) => t.trim())
        .filter(Boolean),
      state: fields["System.State"] ?? "",
      url: item._links?.html?.href ?? item.url ?? "",
      comments,
      acceptanceCriteria:
        fields["Microsoft.VSTS.Common.AcceptanceCriteria"] ?? "",
    };
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
    const args = [
      "boards",
      "work-item",
      "update",
      "--id",
      issueId,
      "--state",
      "Closed",
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

    const item = JSON.parse(stdout);
    const fields = item.fields ?? {};

    return {
      number: String(item.id),
      title: fields["System.Title"] ?? title,
      body: fields["System.Description"] ?? body,
      labels: (fields["System.Tags"] ?? "")
        .split(";")
        .map((t: string) => t.trim())
        .filter(Boolean),
      state: fields["System.State"] ?? "New",
      url: item._links?.html?.href ?? item.url ?? "",
      comments: [],
      acceptanceCriteria:
        fields["Microsoft.VSTS.Common.AcceptanceCriteria"] ?? "",
    };
  },

  async getDefaultBranch(opts: DispatchLifecycleOptions): Promise<string> {
    try {
      const { stdout } = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: opts.cwd });
      const parts = stdout.trim().split("/");
      return parts[parts.length - 1];
    } catch {
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
      const name = stdout.trim();
      if (!name) return "unknown";
      return slugify(name);
    } catch {
      return "unknown";
    }
  },

  buildBranchName(issueNumber: string, username?: string): string {
    return `${(username ?? "unknown")}/dispatch/${issueNumber}`;
  },

  async createAndSwitchBranch(branchName: string, opts: DispatchLifecycleOptions): Promise<void> {
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
      const pr = JSON.parse(stdout);
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
        const prs = JSON.parse(stdout);
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
