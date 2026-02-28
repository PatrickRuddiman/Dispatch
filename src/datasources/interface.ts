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
}
