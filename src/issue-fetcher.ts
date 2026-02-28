/**
 * Issue fetcher interface — abstracts how work items / issues are retrieved
 * so that new issue trackers (GitHub, Azure DevOps, Jira, Linear, etc.)
 * can be added by implementing a single interface.
 *
 * Each fetcher handles authentication and CLI tool interaction for its
 * platform. The plan generator interacts exclusively through this contract.
 *
 * To add a new issue source:
 *   1. Create `src/issue-fetchers/<name>.ts`
 *   2. Export a `fetcher` that satisfies `IssueFetcher`
 *   3. Register it in `src/issue-fetchers/index.ts`
 */

export type IssueSourceName = "github" | "azdevops";

/**
 * Structured representation of a work item / issue from any tracker.
 */
export interface IssueDetails {
  /** Issue / work-item number or ID */
  number: string;
  /** Title of the issue */
  title: string;
  /** Full description / body (may contain HTML or markdown) */
  body: string;
  /** Labels, tags, or categories */
  labels: string[];
  /** Current state (open, closed, active, resolved, etc.) */
  state: string;
  /** URL to the issue in the tracker's web UI */
  url: string;
  /** Discussion comments */
  comments: string[];
  /** Acceptance criteria (if the tracker supports it) */
  acceptanceCriteria: string;
}

/**
 * Options passed when fetching an issue.
 */
export interface IssueFetchOptions {
  /** Working directory (for CLI repo context) */
  cwd?: string;
  /** Organization URL (e.g. Azure DevOps org) */
  org?: string;
  /** Project name (e.g. Azure DevOps project) */
  project?: string;
}

/**
 * Interface that all issue fetcher implementations must satisfy.
 *
 * Each fetcher is responsible for communicating with a single issue
 * tracker and returning a normalized `IssueDetails` object.
 */
export interface IssueFetcher {
  /** Human-readable name (e.g. "github", "azdevops") */
  readonly name: string;

  /**
   * Fetch a single issue / work item by its number or ID.
   *
   * @param issueId - The issue number or work item ID
   * @param opts    - Platform-specific options (org, project, cwd)
   * @returns Normalized issue details
   * @throws If the issue cannot be found or the CLI tool fails
   */
  fetch(issueId: string, opts?: IssueFetchOptions): Promise<IssueDetails>;

  /**
   * Update the title and/or body of an issue / work item.
   * Optional — not all backends need to implement this.
   *
   * @param issueId - The issue number or work item ID
   * @param title   - New title (omit to leave unchanged)
   * @param body    - New body/description
   * @param opts    - Platform-specific options
   */
  update?(issueId: string, title: string, body: string, opts?: IssueFetchOptions): Promise<void>;

  /**
   * Close / resolve an issue / work item.
   * Optional — not all backends need to implement this.
   *
   * @param issueId - The issue number or work item ID
   * @param opts    - Platform-specific options
   */
  close?(issueId: string, opts?: IssueFetchOptions): Promise<void>;
}
