/**
 * Datasource interface — unifies how issues and specs are read and written
 * regardless of backend (GitHub, Azure DevOps, local markdown files).
 *
 * Each datasource handles authentication and data access for its platform.
 * The plan generator and orchestrator interact exclusively through this
 * contract.
 *
 * To add a new datasource:
 *   1. Create `src/datasources/<name>.ts`
 *   2. Export an implementation that satisfies `Datasource`
 *   3. Register it in `src/datasources/index.ts`
 *   4. Add the name to the `DatasourceName` union below
 */

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
  /** Iteration path / sprint (Azure DevOps) */
  iterationPath?: string;
  /** Area path / team (Azure DevOps) */
  areaPath?: string;
  /** Assignee display name */
  assignee?: string;
  /** Priority (1 = Critical … 4 = Low) */
  priority?: number;
  /** Story points / effort / size */
  storyPoints?: number;
  /** Work item type (e.g. "User Story", "Bug") */
  workItemType?: string;
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
  /** Work item type (e.g. "User Story", "Product Backlog Item") */
  workItemType?: string;
  /** Iteration path filter (e.g. "MyProject\\Sprint 1" or "@CurrentIteration") */
  iteration?: string;
  /** Area path filter (e.g. "MyProject\\Team A") */
  area?: string;
  /** Glob pattern(s) for filtering items in list() */
  pattern?: string | string[];
}

/**
 * Options for dispatch lifecycle operations (branching, pushing, PRs).
 */
export interface DispatchLifecycleOptions {
  /** Working directory (git repo root) */
  cwd: string;
}

/** Valid datasource backend names. */
export type DatasourceName = "github" | "azdevops" | "md";

/**
 * Interface that all datasource implementations must satisfy.
 *
 * Each datasource is responsible for communicating with a single backend
 * and returning normalized `IssueDetails` objects.
 */
export interface Datasource {
  /** Human-readable datasource name (e.g. "github", "azdevops", "md") */
  readonly name: DatasourceName;

  /**
   * Whether this datasource supports git operations (branching, pushing, PRs).
   *
   * @returns `true` if git lifecycle methods are functional, `false` otherwise
   */
  supportsGit(): boolean;

  /**
   * List available issues or specs.
   *
   * @param opts - Platform-specific options (org, project, cwd)
   * @returns Array of issue details
   */
  list(opts?: IssueFetchOptions): Promise<IssueDetails[]>;

  /**
   * Fetch a single issue or spec by its identifier.
   *
   * @param issueId - The issue number, work item ID, or filename
   * @param opts    - Platform-specific options (org, project, cwd)
   * @returns Normalized issue details
   * @throws If the issue cannot be found or the underlying tool fails
   */
  fetch(issueId: string, opts?: IssueFetchOptions): Promise<IssueDetails>;

  /**
   * Update the title and/or body of an issue or spec.
   *
   * @param issueId - The issue number, work item ID, or filename
   * @param title   - New title
   * @param body    - New body/description
   * @param opts    - Platform-specific options
   */
  update(issueId: string, title: string, body: string, opts?: IssueFetchOptions): Promise<void>;

  /**
   * Close or resolve an issue or spec.
   *
   * @param issueId - The issue number, work item ID, or filename
   * @param opts    - Platform-specific options
   */
  close(issueId: string, opts?: IssueFetchOptions): Promise<void>;

  /**
   * Create a new issue or spec.
   *
   * @param title - Title of the new issue or spec
   * @param body  - Body/description content
   * @param opts  - Platform-specific options
   * @returns The created issue details
   */
  create(title: string, body: string, opts?: IssueFetchOptions): Promise<IssueDetails>;

  /**
   * Get the default branch name (e.g. "main" or "master").
   *
   * @param opts - Lifecycle options (cwd)
   * @returns The default branch name
   */
  getDefaultBranch(opts: DispatchLifecycleOptions): Promise<string>;

  /**
   * Resolve the current git username for branch namespacing.
   *
   * @param opts - Lifecycle options (cwd)
   * @returns A slugified, branch-safe username
   */
  getUsername(opts: DispatchLifecycleOptions): Promise<string>;

  /**
   * Build a branch name from an issue number, title, and username.
   *
   * @param issueNumber - The issue number/ID
   * @param title - The issue title
   * @param username - The branch-safe username prefix
   * @returns A sanitized branch name
   */
  buildBranchName(issueNumber: string, title: string, username?: string): string;

  /**
   * Create and switch to a feature branch for an issue.
   * If the branch already exists, switch to it instead.
   *
   * @param branchName - The branch name to create
   * @param opts - Lifecycle options (cwd)
   */
  createAndSwitchBranch(branchName: string, opts: DispatchLifecycleOptions): Promise<void>;

  /**
   * Switch to an existing branch.
   *
   * @param branchName - The branch name to switch to
   * @param opts - Lifecycle options (cwd)
   */
  switchBranch(branchName: string, opts: DispatchLifecycleOptions): Promise<void>;

  /**
   * Push the current branch to the remote.
   *
   * @param branchName - The branch name to push
   * @param opts - Lifecycle options (cwd)
   */
  pushBranch(branchName: string, opts: DispatchLifecycleOptions): Promise<void>;

  /**
   * Stage all changes and create a commit with the given message.
   * This is the safety-net commit after all tasks for an issue complete.
   *
   * @param message - The commit message
   * @param opts - Lifecycle options (cwd)
   */
  commitAllChanges(message: string, opts: DispatchLifecycleOptions): Promise<void>;

  /**
   * Create a pull request linking the branch to the issue.
   *
   * @param branchName - The source branch name
   * @param issueNumber - The issue number to reference
   * @param title - PR title
   * @param body - PR body/description content
   * @param opts - Lifecycle options (cwd)
   * @returns The URL of the created PR, or the existing PR URL if one already exists
   */
  createPullRequest(
    branchName: string,
    issueNumber: string,
    title: string,
    body: string,
    opts: DispatchLifecycleOptions,
  ): Promise<string>;
}
