/**
 * Issue fetcher registry — maps source names to their fetcher implementations
 * and provides auto-detection of the issue source from the git remote URL.
 *
 * To add a new issue tracker:
 *   1. Create `src/issue-fetchers/<name>.ts` exporting a `fetcher` object
 *   2. Import and register it in the `FETCHERS` map below
 *   3. Add the name to the `IssueSourceName` union in `src/issue-fetcher.ts`
 *   4. Add a URL pattern to `detectIssueSource` if auto-detection is possible
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IssueSourceName, IssueFetcher } from "../issue-fetcher.js";
import { fetcher as githubFetcher } from "./github.js";
import { fetcher as azdevopsFetcher } from "./azdevops.js";

const exec = promisify(execFile);

const FETCHERS: Record<IssueSourceName, IssueFetcher> = {
  github: githubFetcher,
  azdevops: azdevopsFetcher,
};

/**
 * All registered issue source names — useful for CLI help and validation.
 */
export const ISSUE_SOURCE_NAMES = Object.keys(FETCHERS) as IssueSourceName[];

/**
 * Get a fetcher by name.
 *
 * @throws if the source name is not registered.
 */
export function getIssueFetcher(name: IssueSourceName): IssueFetcher {
  const fetcher = FETCHERS[name];
  if (!fetcher) {
    throw new Error(
      `Unknown issue source "${name}". Available: ${ISSUE_SOURCE_NAMES.join(", ")}`
    );
  }
  return fetcher;
}

/**
 * URL patterns used to detect the issue tracker from a git remote.
 *
 * Each entry maps a regex (tested against the remote URL) to the
 * corresponding `IssueSourceName`. Patterns are tested in order;
 * the first match wins.
 */
const SOURCE_PATTERNS: { pattern: RegExp; source: IssueSourceName }[] = [
  { pattern: /github\.com/i, source: "github" },
  { pattern: /dev\.azure\.com/i, source: "azdevops" },
  { pattern: /visualstudio\.com/i, source: "azdevops" },
];

/**
 * Auto-detect the issue source by inspecting the `origin` remote URL.
 *
 * Returns the detected `IssueSourceName`, or `null` if the remote URL
 * does not match any known pattern.
 */
export async function detectIssueSource(
  cwd: string
): Promise<IssueSourceName | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["remote", "get-url", "origin"],
      { cwd }
    );

    const url = stdout.trim();
    for (const { pattern, source } of SOURCE_PATTERNS) {
      if (pattern.test(url)) {
        return source;
      }
    }

    return null;
  } catch {
    return null;
  }
}
