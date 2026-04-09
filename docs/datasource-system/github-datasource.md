# GitHub Datasource

## What

The GitHub datasource (`src/datasources/github.ts`) provides read/write access
to GitHub Issues using the `@octokit/rest` SDK with `@octokit/auth-oauth-device`
for OAuth device-flow authentication. It implements all 15 methods of the
`Datasource` interface.

**Source:** `src/datasources/github.ts` (345 lines)

**Related docs:**

- [Overview](./overview.md) -- interface contract and shared behaviors
- [Azure DevOps datasource](./azdevops-datasource.md)
- [Markdown datasource](./markdown-datasource.md)
- [Integrations](./integrations.md) -- authentication details
- [Testing](./testing.md) -- test patterns for this datasource

## Why

GitHub Issues is the primary issue tracker for many open-source and enterprise
projects. The Octokit SDK provides type-safe, paginated access to the GitHub
REST API without requiring the `gh` CLI to be installed, and the OAuth
device-flow allows headless authentication in terminal environments.

## How

### Authentication

Authentication is managed by `getGithubOctokit()` in `src/helpers/auth.ts`
(see [Integrations](./integrations.md#github-authentication) for details).
On first use, the user is guided through an OAuth device-code flow:

1. Dispatch requests a device code from GitHub using `GITHUB_CLIENT_ID`
   (`Ov23liUMP1Oyg811IF58`) from `src/constants.ts`.
2. The user is shown a verification code and URL; the browser is opened
   automatically via the `open` package.
3. The user authorizes in the browser; Dispatch polls for the token.
4. The token is cached at `~/.dispatch/auth.json` (mode `0o600`).
5. Subsequent calls return a cached `Octokit` instance immediately.

The OAuth flow requests the `repo` scope, which grants read/write access to
repositories, issues, and pull requests.

### Owner/repo resolution

The `getOwnerRepo(cwd)` function resolves the GitHub owner and repository name
from the git remote URL:

1. Calls `getGitRemoteUrl(cwd)` to read the `origin` remote.
2. Passes the URL to `parseGitHubRemoteUrl()` (in `src/datasources/index.ts`).
3. Caches the result in `ownerRepoCache` (a module-level `Map` keyed by `cwd`).

`parseGitHubRemoteUrl()` supports three URL formats:

- **HTTPS:** `https://[user@]github.com/{owner}/{repo}[.git]`
- **SCP-style SSH:** `git@github.com:{owner}/{repo}[.git]`
- **URL-style SSH:** `ssh://git@github.com/{owner}/{repo}[.git]`

All formats strip a trailing `.git` suffix and decode URL-encoded segments.
On parse failure, an error is thrown with the URL redacted via `redactUrl()`.

### CRUD operations

#### `list(opts?)`

Lists open issues (excluding pull requests) using `octokit.paginate()` with
`octokit.rest.issues.listForRepo`. Returns normalized `IssueDetails` objects
with empty `comments` and `acceptanceCriteria`.

#### `fetch(issueId, opts?)`

Fetches a single issue by number via `octokit.rest.issues.get()`, then fetches
all comments via `octokit.paginate()` with `octokit.rest.issues.listComments`.
Comments are formatted as `**{username}:** {body}`.

#### `create(title, body, opts?)`

Creates a new issue via `octokit.rest.issues.create()`. Returns the created
issue as an `IssueDetails` with the GitHub-assigned number.

#### `update(issueId, title, body, opts?)`

Updates the title and body via `octokit.rest.issues.update()`.

#### `close(issueId, opts?)`

Sets the issue state to `"closed"` via `octokit.rest.issues.update()`.

### Git lifecycle

#### `supportsGit()`

Returns `true`.

#### `getUsername(opts)`

Checks `opts.username` first. Falls back to `deriveShortUsername(opts.cwd, "unknown")`
from `src/datasources/index.ts`.

#### `getDefaultBranch(opts)` / `getCurrentBranch(opts)`

Shared behavior described in the [overview](./overview.md#default-branch-detection).

#### `buildBranchName(issueNumber, title, username?)`

Produces `{username}/dispatch/issue-{issueNumber}`. The `title` parameter is
unused (named `_title`). Default username is `"unknown"`.

#### `createAndSwitchBranch(branchName, opts)`

Creates and checks out the branch. Falls back to checkout if the branch already
exists, with worktree conflict recovery. See [overview](./overview.md#worktree-conflict-recovery).

#### `switchBranch(branchName, opts)`

Runs `git checkout {branchName}`.

#### `pushBranch(branchName, opts)`

Runs `git push --set-upstream origin {branchName}`.

#### `commitAllChanges(message, opts)`

Stages all changes, checks for staged content, commits if non-empty. See
[overview](./overview.md#commit-staging).

### Pull request creation

`createPullRequest()` creates a PR via `octokit.rest.pulls.create()`:

1. Resolves the target branch from `baseBranch` parameter or `getDefaultBranch()`.
2. Creates the PR with the provided title and body. If no body is given, uses
   `Closes #{issueNumber}` as a default.
3. On success, returns `pr.html_url`.

**Duplicate PR handling:** If Octokit throws a `RequestError` with HTTP status
422 (validation failure, indicating "A pull request already exists"), the method
catches it and queries for existing open PRs matching the branch via
`octokit.rest.pulls.list()` with `head: "{owner}:{branchName}"`. If found,
returns the existing PR's URL. Otherwise, re-throws the error.

### Exported utilities

#### `getCommitMessages(defaultBranch, cwd)`

Exported function that gathers commit subject lines from
`origin/{defaultBranch}..HEAD` using `git log --pretty=format:%s`. Returns an
empty array on failure. Used by the orchestrator for PR body generation.

#### `ownerRepoCache`

Exported `Map<string, { owner: string; repo: string }>` for testing purposes.
Allows tests to pre-populate or clear the cache.

### Credential redaction

The `redactUrl()` helper replaces userinfo in URLs (`//user:pass@` or
`//user@`) with `//***@` before including them in error messages. This prevents
accidental credential exposure in logs.

### Error handling

| Scenario | Behavior |
|----------|----------|
| No git remote | Throws with "Could not determine git remote URL" |
| Unparseable remote URL | Throws with redacted URL |
| Issue not found | Octokit throws `RequestError` (404) |
| Duplicate PR | Catches `RequestError` (422), returns existing PR URL |
| Auth failure | Device-flow errors propagate from `getGithubOctokit()` |

## Related documentation

- [Overview](./overview.md) — Interface contract and shared behaviors
- [Azure DevOps Datasource](./azdevops-datasource.md) — Alternative issue
  tracker integration
- [Markdown Datasource](./markdown-datasource.md) — Local file-based issue
  tracking
- [Integrations](./integrations.md) — Authentication details and SDK
  dependencies
- [Datasource Helpers](./datasource-helpers.md) — PR body building, branch
  diff, and shared utility functions
- [Testing](./testing.md) — Test patterns for datasource modules
- [GitHub Datasource Tests](../testing/datasource-tests.md) — Detailed test
  file reference for all datasource tests
- [Git & Worktree Management](../git-and-worktree/overview.md) — Git
  operations used by branch and PR lifecycle methods
