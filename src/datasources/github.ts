/**
 * GitHub datasource — reads and writes issues using the `gh` CLI.
 *
 * Requires:
 *   - `gh` CLI installed and authenticated
 *   - Working directory inside a GitHub repository (or GITHUB_REPOSITORY set)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Datasource, IssueDetails, IssueFetchOptions } from "../datasource.js";

const exec = promisify(execFile);

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

    const { stdout } = await exec(
      "gh",
      [
        "issue",
        "create",
        "--title",
        title,
        "--body",
        body,
        "--json",
        "number,title,body,labels,state,url",
      ],
      { cwd }
    );

    const issue = JSON.parse(stdout);

    return {
      number: String(issue.number),
      title: issue.title ?? title,
      body: issue.body ?? body,
      labels: (issue.labels ?? []).map((l: { name: string }) => l.name),
      state: issue.state ?? "OPEN",
      url: issue.url ?? "",
      comments: [],
      acceptanceCriteria: "",
    };
  },
};
