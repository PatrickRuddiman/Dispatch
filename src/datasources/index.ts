/**
 * Datasource registry — maps datasource names to their implementations
 * and provides auto-detection of the datasource from the git remote URL.
 *
 * To add a new datasource:
 *   1. Create `src/datasources/<name>.ts` exporting a `datasource` object
 *   2. Import and register it in the `DATASOURCES` map below
 *   3. Add the name to the `DatasourceName` type in `src/datasources/interface.ts`
 *   4. Add a URL pattern to `detectDatasource` if auto-detection is possible
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Datasource, DatasourceName } from "./interface.js";
import { DATASOURCE_NAMES } from "./interface.js";
import { datasource as githubDatasource } from "./github.js";
import { datasource as azdevopsDatasource } from "./azdevops.js";
import { datasource as mdDatasource } from "./md.js";
export type { Datasource, DatasourceName, IssueDetails, IssueFetchOptions, DispatchLifecycleOptions } from "./interface.js";

const exec = promisify(execFile);

const DATASOURCES: Partial<Record<DatasourceName, Datasource>> = {
  github: githubDatasource,
  azdevops: azdevopsDatasource,
  md: mdDatasource,
};

/**
 * All registered datasource names — re-exported from the canonical definition in interface.ts.
 */
export { DATASOURCE_NAMES } from "./interface.js";

/**
 * Get a datasource by name.
 *
 * @throws if the datasource name is not registered.
 */
export function getDatasource(name: DatasourceName): Datasource {
  const datasource = DATASOURCES[name];
  if (!datasource) {
    throw new Error(
      `Unknown datasource "${name}". Available: ${DATASOURCE_NAMES.join(", ")}`
    );
  }
  return datasource;
}

/**
 * Get the git remote URL for the `origin` remote.
 *
 * @param cwd - Working directory to run the git command in
 * @returns The remote URL string, or `null` if unavailable
 */
export async function getGitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["remote", "get-url", "origin"], {
      cwd,
      shell: process.platform === "win32",
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
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
  const url = await getGitRemoteUrl(cwd);
  if (!url) return null;

  for (const { pattern, source } of SOURCE_PATTERNS) {
    if (pattern.test(url)) {
      return source;
    }
  }

  return null;
}

/**
 * Parse an Azure DevOps git remote URL and extract the organization URL and project name.
 *
 * Supports all three Azure DevOps remote URL formats:
 * - **HTTPS:** `https://dev.azure.com/{org}/{project}/_git/{repo}`
 * - **SSH:** `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`
 * - **Legacy HTTPS:** `https://{org}.visualstudio.com/{project}/_git/{repo}`
 *
 * The org URL is always normalized to `https://dev.azure.com/{org}`.
 *
 * @param url - The git remote URL to parse
 * @returns The parsed org URL and project name, or `null` if the URL is not a recognized Azure DevOps format
 */
export function parseAzDevOpsRemoteUrl(
  url: string
): { orgUrl: string; project: string } | null {
  // HTTPS: https://[user@]dev.azure.com/{org}/{project}/_git/{repo}
  const httpsMatch = url.match(
    /^https?:\/\/(?:[^@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\//i
  );
  if (httpsMatch) {
    return {
      orgUrl: `https://dev.azure.com/${decodeURIComponent(httpsMatch[1])}`,
      project: decodeURIComponent(httpsMatch[2]),
    };
  }

  // SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  const sshMatch = url.match(
    /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\//i
  );
  if (sshMatch) {
    return {
      orgUrl: `https://dev.azure.com/${decodeURIComponent(sshMatch[1])}`,
      project: decodeURIComponent(sshMatch[2]),
    };
  }

  // Legacy: https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
  const legacyMatch = url.match(
    /^https?:\/\/([^.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\//i
  );
  if (legacyMatch) {
    return {
      orgUrl: `https://dev.azure.com/${decodeURIComponent(legacyMatch[1])}`,
      project: decodeURIComponent(legacyMatch[2]),
    };
  }

  return null;
}

/**
 * Parse a GitHub git remote URL and extract the owner and repository name.
 *
 * Supports both GitHub remote URL formats:
 * - **HTTPS:** `https://github.com/{owner}/{repo}[.git]`
 * - **SSH:** `git@github.com:{owner}/{repo}[.git]`
 *
 * @param url - The git remote URL to parse
 * @returns The parsed owner and repo, or `null` if the URL is not a recognized GitHub format
 */
export function parseGitHubRemoteUrl(
  url: string
): { owner: string; repo: string } | null {
  // HTTPS: https://[user@]github.com/{owner}/{repo}[.git]
  const httpsMatch = url.match(
    /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)\/?$/i
  );
  if (httpsMatch) {
    const owner = decodeURIComponent(httpsMatch[1]);
    const rawRepo = decodeURIComponent(httpsMatch[2]);
    const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
    return { owner, repo };
  }

  // SSH (scp-style): git@github.com:{owner}/{repo}[.git]
  const sshMatch = url.match(
    /^git@github\.com:([^/]+)\/([^/]+?)\/?$/i
  );
  if (sshMatch) {
    const owner = decodeURIComponent(sshMatch[1]);
    const rawRepo = decodeURIComponent(sshMatch[2]);
    const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
    return { owner, repo };
  }

  // SSH (url-style): ssh://git@github.com/{owner}/{repo}[.git]
  const sshUrlMatch = url.match(
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)\/?$/i
  );
  if (sshUrlMatch) {
    const owner = decodeURIComponent(sshUrlMatch[1]);
    const rawRepo = decodeURIComponent(sshUrlMatch[2]);
    const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
    return { owner, repo };
  }

  return null;
}
