/**
 * Datasource registry — maps datasource names to their implementations
 * and provides auto-detection of the datasource from the git remote URL.
 *
 * To add a new datasource:
 *   1. Create `src/datasources/<name>.ts` exporting a `datasource` object
 *   2. Import and register it in the `DATASOURCES` map below
 *   3. Add the name to the `DatasourceName` type
 *   4. Add a URL pattern to `detectDatasource` if auto-detection is possible
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IssueSourceName, IssueFetcher } from "../issue-fetcher.js";
import { fetcher as githubFetcher } from "../issue-fetchers/github.js";
import { fetcher as azdevopsFetcher } from "../issue-fetchers/azdevops.js";

const exec = promisify(execFile);

/**
 * Supported datasource names.
 *
 * For now this mirrors `IssueSourceName` while the datasource abstraction
 * is being built out. It will diverge once new datasource types (e.g. "md")
 * are added.
 */
export type DatasourceName = IssueSourceName;

const DATASOURCES: Record<DatasourceName, IssueFetcher> = {
  github: githubFetcher,
  azdevops: azdevopsFetcher,
};

/**
 * All registered datasource names — useful for CLI help text and validation.
 */
export const DATASOURCE_NAMES = Object.keys(DATASOURCES) as DatasourceName[];

/**
 * Get a datasource by name.
 *
 * @throws if the datasource name is not registered.
 */
export function getDatasource(name: DatasourceName): IssueFetcher {
  const datasource = DATASOURCES[name];
  if (!datasource) {
    throw new Error(
      `Unknown datasource "${name}". Available: ${DATASOURCE_NAMES.join(", ")}`
    );
  }
  return datasource;
}

/**
 * URL patterns used to detect the datasource from a git remote.
 *
 * Each entry maps a regex (tested against the remote URL) to the
 * corresponding `DatasourceName`. Patterns are tested in order;
 * the first match wins.
 */
const SOURCE_PATTERNS: { pattern: RegExp; source: DatasourceName }[] = [
  { pattern: /github\.com/i, source: "github" },
  { pattern: /dev\.azure\.com/i, source: "azdevops" },
  { pattern: /visualstudio\.com/i, source: "azdevops" },
];

/**
 * Auto-detect the datasource by inspecting the `origin` remote URL.
 *
 * Returns the detected `DatasourceName`, or `null` if the remote URL
 * does not match any known pattern.
 */
export async function detectDatasource(
  cwd: string
): Promise<DatasourceName | null> {
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
