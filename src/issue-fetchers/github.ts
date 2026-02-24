/**
 * GitHub issue fetcher — retrieves issues using the `gh` CLI.
 *
 * Requires:
 *   - `gh` CLI installed and authenticated
 *   - Working directory inside a GitHub repository (or GITHUB_REPOSITORY set)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IssueFetcher, IssueDetails, IssueFetchOptions } from "../issue-fetcher.js";

const exec = promisify(execFile);

export const fetcher: IssueFetcher = {
  name: "github",

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
};
