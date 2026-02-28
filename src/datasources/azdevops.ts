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
import type { Datasource } from "../datasource.js";
import type { IssueDetails, IssueFetchOptions } from "../issue-fetcher.js";

const exec = promisify(execFile);

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
    const args = [
      "boards",
      "work-item",
      "create",
      "--type",
      "User Story",
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
