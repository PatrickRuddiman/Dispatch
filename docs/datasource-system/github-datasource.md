# GitHub Datasource

The GitHub datasource reads and writes issues using the `gh` CLI. It is
implemented in `src/datasources/github.ts` and registered under the name
`"github"` in the [datasource registry](./overview.md#the-datasource-registry).
The `gh` CLI must be available on PATH; see the
[Prerequisite Checker](../prereqs-and-safety/prereqs.md) for how this is
validated at startup.

## What it does

The GitHub datasource translates the [`Datasource` interface](./overview.md#the-datasource-interface) operations
into `gh` CLI and `git` commands. It provides five CRUD operations for issue
management, one identity method (`getUsername`), seven git lifecycle operations
for branching, committing, pushing, and pull request creation, and one
capability query method (`supportsGit`). It also exports a standalone
`getCommitMessages()` utility function used by the
[datasource helpers](./datasource-helpers.md) for PR body construction.

### CRUD operations

| Operation | `gh` command | JSON output? |
|-----------|-------------|-------------|
| `list()` | `gh issue list --state open --json number,title,body,labels,state,url` | Yes |
| `fetch()` | `gh issue view <id> --json number,title,body,labels,state,url,comments` | Yes |
| `update()` | `gh issue edit <id> --title <title> --body <body>` | No |
| `close()` | `gh issue close <id>` | No |
| `create()` | `gh issue create --title <title> --body <body>` | No (outputs URL) |

### Git lifecycle operations

| Operation | Command(s) | Purpose |
|-----------|-----------|---------|
| `getDefaultBranch()` | `git symbolic-ref refs/remotes/origin/HEAD`, fallback to `git rev-parse --verify main` | Detect `main` or `master` |
| `getUsername()` | `git config user.name`, slugified | Resolve branch-safe username; falls back to `"unknown"` |
| `buildBranchName()` | _(pure function)_ | Returns `<username>/dispatch/<number>-<slug>` |
| `createAndSwitchBranch()` | `git checkout -b <branch>`, fallback to `git checkout <branch>` | Create or switch to branch |
| `switchBranch()` | `git checkout <branch>` | Switch to existing branch |
| `pushBranch()` | `git push --set-upstream origin <branch>` | Push branch to remote |
| `commitAllChanges()` | `git add -A` + `git diff --cached --stat` + `git commit -m <msg>` | Stage and commit; no-ops if nothing staged |
| `createPullRequest()` | `gh pr create --title <t> --body <body> --head <branch>` | Create PR; uses `"Closes #<n>"` as body when `body` param is empty |

All commands are executed via `execFile("gh", [...args], { cwd })` with no
shell interpolation. The `cwd` option is set from `opts.cwd` or defaults to
`process.cwd()`, which allows the `gh` CLI to determine the repository context
from the working directory.

## Why it shells out to `gh`

See the [overview](./overview.md#why-it-exists) for the rationale behind using
CLI tools instead of REST APIs. In short: `gh` manages token storage and
refresh, eliminates the need for an `@octokit/rest` dependency, and reduces
implementation complexity.

## Authentication

The GitHub datasource requires the `gh` CLI to be installed and authenticated.

### Interactive authentication

```sh
gh auth login
```

This launches an interactive flow that authenticates with GitHub via browser
OAuth or a personal access token. Credentials are stored by the `gh` CLI in
`~/.config/gh/hosts.yml` (Linux/macOS) or `%APPDATA%\GitHub CLI\hosts.yml`
(Windows).

### CI/CD authentication

In CI/CD environments where interactive login is not possible, set the
`GH_TOKEN` or `GITHUB_TOKEN` environment variable:

```sh
export GH_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

The `gh` CLI checks for these environment variables automatically. `GH_TOKEN`
takes precedence over `GITHUB_TOKEN`.

### Required token scopes

The minimum scopes depend on the operations used:

| Scope | Required for |
|-------|-------------|
| `repo` | All issue operations on private repositories; PR creation |
| `public_repo` | Issue operations on public repositories (narrower alternative to `repo`) |
| `read:org` | Listing issues in organization-owned repositories |

For the full dispatch pipeline (including `createPullRequest()`), the `repo`
scope is required because PR creation needs write access. The `gh auth login`
interactive flow requests `repo`, `read:org`, and `gist` scopes by default,
which covers all dispatch operations.

When authenticating with `--with-token` (piping a PAT via stdin), ensure the
token has at least the `repo` scope. Tokens with insufficient scopes will
produce "Resource not accessible by integration" errors on PR creation.

### GitHub Enterprise Server

For GitHub Enterprise Server instances, authenticate with:

```sh
gh auth login --hostname github.mycompany.com
```

Note that the [datasource auto-detection](./overview.md#auto-detection) only matches `github.com` in the remote
URL. GitHub Enterprise hosts require explicit `--source github` on the
dispatch CLI. See the
[auto-detection limitations](./overview.md#auto-detection-limitations).

### Verifying authentication

```sh
gh auth status
```

This shows which accounts are authenticated and which hostname is active.

## Operation details

### `list()`

Lists all open issues in the repository. The `--state open` filter is
hardcoded -- there is no way to list closed or all issues through the
datasource interface.

**Fields requested:** `number`, `title`, `body`, `labels`, `state`, `url`.

**Comments behavior:** The `list()` operation does **not** fetch comments. The
returned [`IssueDetails`](./overview.md#the-issuedetails-interface) objects always have an empty `comments: []` array. This
is a deliberate choice to avoid N+1 requests when listing issues -- fetching
comments for each issue in a list would require individual `gh issue view`
calls.

To get comments for a specific issue, use `fetch()` instead.

**Field mapping:**

| GitHub JSON field | `IssueDetails` field | Transformation |
|-------------------|---------------------|----------------|
| `number` | `number` | Converted to string via `String()` |
| `title` | `title` | Falls back to `""` if missing |
| `body` | `body` | Falls back to `""` if missing |
| `labels[].name` | `labels` | Mapped from label objects to name strings |
| `state` | `state` | Falls back to `"OPEN"` if missing |
| `url` | `url` | Falls back to `""` if missing |
| _(not fetched)_ | `comments` | Always `[]` |
| _(not available)_ | `acceptanceCriteria` | Always `""` |

### `fetch()`

Fetches a single issue by its number, including comments.

**Fields requested:** `number`, `title`, `body`, `labels`, `state`, `url`,
`comments`.

**Comments behavior:** Comments are fetched and formatted as
`**<author>:** <body>` strings. The author is extracted from
`comment.author.login`, falling back to `"unknown"` if the login field is
missing. This is the same format used by the Azure DevOps datasource for
consistency.

**Field mapping:** Same as `list()` except:

| GitHub JSON field | `IssueDetails` field | Transformation |
|-------------------|---------------------|----------------|
| `comments[].author.login` + `comments[].body` | `comments` | Formatted as `**author:** body` |

### `update()`

Updates both the title and body of an issue using `gh issue edit`. Both fields
are always sent -- there is no way to update only one field through this
interface.

### `close()`

Closes an issue by calling `gh issue close <id>`. This sets the issue state to
"closed" on GitHub. The operation is reversible using `gh issue reopen <id>`
outside of dispatch.

### `create()`

Creates a new issue and returns the created `IssueDetails`.

**URL parsing:** The `gh issue create` command does not support `--json` output.
Instead, it prints the URL of the created issue to stdout (e.g.,
`https://github.com/owner/repo/issues/42`). The datasource extracts the issue
number by matching `/\/issues\/(\d+)$/` against this URL. If the regex does not
match (unexpected output format), the issue number defaults to `"0"`.

**Return value:** The returned `IssueDetails` uses the title and body passed to
`create()` rather than re-fetching from GitHub. Labels, comments, and
acceptanceCriteria are empty.

## Capability query

### `supportsGit()`

Returns `true`. This signals to the dispatch pipeline that the GitHub
datasource supports all git lifecycle operations (branching, committing,
pushing, PR creation). The pipeline checks this method to determine whether
to invoke git lifecycle methods after task completion. The
[markdown datasource](./markdown-datasource.md) returns `false`, which causes
the pipeline to skip branch creation, commits, pushes, and PR creation.

## `getCommitMessages()` export

The GitHub datasource module exports a standalone `getCommitMessages()` function
(not part of the `Datasource` interface) that retrieves commit message subject
lines from the current branch relative to a given default branch:

```
getCommitMessages(defaultBranch: string, cwd: string): Promise<string[]>
```

**How it works:** Runs `git log origin/<defaultBranch>..HEAD --pretty=format:%s`
to list commits on the current branch that are not on the default branch. Each
line of output is one commit subject.

**Error handling:** If `git log` fails (e.g., the branch has not been pushed,
or the default branch does not exist on the remote), the function silently
returns an empty array. It never throws.

**Used by:** The [`buildPrTitle()`](./datasource-helpers.md) and
[`buildPrBody()`](./datasource-helpers.md) helper functions in
`src/orchestrator/datasource-helpers.ts` call `getCommitMessages()` to
construct PR titles and bodies from the actual commits on the branch. When a
single commit exists, the PR title is that commit's subject. When multiple
commits exist, the PR title is the oldest commit's subject with a
`(+N more)` suffix.

## Git lifecycle operation details

The GitHub datasource implements all seven git lifecycle methods using the `git`
and `gh` CLI tools. These operations are used by the [dispatch pipeline](../planning-and-dispatch/overview.md) to manage
the branching, committing, and PR workflow after task completion. When worktree
isolation is enabled, each issue runs in its own
[git worktree](../git-and-worktree/overview.md). See also the
[`--no-branch` flag](../cli-orchestration/cli.md#the---no-branch-flag) for
skipping the branch lifecycle.

### `getDefaultBranch()`

Detects the repository's default branch name using a three-tier fallback chain
with branch name validation as a security measure against command injection:

```mermaid
flowchart TD
    A["getDefaultBranch(cwd)"] --> B["git symbolic-ref<br/>refs/remotes/origin/HEAD"]
    B -->|Success| C["Strip refs/remotes/origin/ prefix"]
    C --> D{"isValidBranchName(branch)?"}
    D -->|Valid| E["Return branch name"]
    D -->|Invalid| F["Throw InvalidBranchNameError"]

    B -->|Failure| G{"Is InvalidBranchNameError?"}
    G -->|Yes| F
    G -->|No| H["git rev-parse<br/>--verify main"]
    H -->|Success| I["Return 'main'"]
    H -->|Failure| J["Return 'master'"]

    style F fill:#f66,stroke:#333,color:#fff
    style E fill:#6f6,stroke:#333
    style I fill:#6f6,stroke:#333
    style J fill:#ff6,stroke:#333
```

1. Tries `git symbolic-ref refs/remotes/origin/HEAD` to read the remote HEAD
   reference. If this succeeds, extracts the branch name from the last path
   segment (e.g., `refs/remotes/origin/main` yields `"main"`). The extracted
   branch name is then validated using `isValidBranchName()` from
   `src/helpers/branch-validation.ts`.
2. If step 1 fails (common when `origin/HEAD` is not set, e.g., after a
   `git clone --bare` or when the remote HEAD has never been fetched), tries
   `git rev-parse --verify main` to check if a `main` branch exists.
3. If both fail, falls back to `"master"`.

**Repositories with neither `main` nor `master`:** If the repository uses a
non-standard default branch name (e.g., `develop`, `trunk`), step 1
(`symbolic-ref`) will detect it correctly as long as `origin/HEAD` is set.
If `origin/HEAD` is not set, the function will incorrectly fall back to
`"master"`, which may cause subsequent git operations to fail. Run
`git remote set-head origin --auto` to fix this (see
[troubleshooting](#troubleshooting) below).

**Branch name validation (security):** The `isValidBranchName()` function
enforces strict git refname rules to prevent command injection via crafted
remote HEAD references. A branch name must:

- Be 1–255 characters long
- Contain only `[a-zA-Z0-9._\-/]` characters
- Not start or end with `/`
- Not contain `..` (parent traversal), `@{` (reflog syntax), or `//`
- Not end with `.lock`

If validation fails, an `InvalidBranchNameError` is thrown. This error is
**not** caught by the fallback chain — it propagates to the caller, preventing
potentially dangerous branch names (e.g., `$(whoami)`, names with spaces)
from being used in subsequent shell commands. This is a defense-in-depth
measure since `execFile` already prevents shell injection by passing arguments
as an argv array rather than through a shell.

**Troubleshooting `symbolic-ref` failures:** Run
`git remote set-head origin --auto` to set `origin/HEAD` from the remote,
which makes step 1 work reliably.

### `getUsername()`

Resolves the current developer's git username for branch namespacing
(`src/datasources/github.ts:211-219`).

1. Reads `git config user.name` in the repository working directory.
2. Slugifies the result (lowercased, non-alphanumeric runs replaced with
   hyphens, trimmed).
3. If the result is empty or the git command fails, falls back to `"unknown"`.

The username is used by `buildBranchName()` to prefix branch names, preventing
collisions when multiple developers run dispatch on the same repository.

### `buildBranchName()`

Pure synchronous function that produces `<username>/dispatch/<number>-<slug>`.
The `username` parameter defaults to `"unknown"` if not provided. The title
is slugified (lowercased, non-alphanumeric runs replaced with hyphens, trimmed,
truncated to 50 characters) using the [`slugify()`](../shared-utilities/slugify.md) utility. See the
[branch naming convention](./overview.md#branch-naming-convention) in the
overview.

### `createAndSwitchBranch()`

Attempts `git checkout -b <branchName>`. If the branch already exists (the
error message contains `"already exists"`), falls back to
`git checkout <branchName>`. Other errors are re-thrown.

### `switchBranch()`

Runs `git checkout <branchName>`. Throws if the branch does not exist.

### `pushBranch()`

Runs `git push --set-upstream origin <branchName>`. The `--set-upstream` flag
sets the tracking reference so subsequent `git push` calls on the branch do
not require explicit remote/branch arguments.

### `commitAllChanges()`

Three-step process (`src/datasources/github.ts:269-277`):

1. `git add -A` -- stages all changes (new, modified, deleted files).
2. `git diff --cached --stat` -- checks if anything is actually staged.
3. If the diff output is non-empty, runs `git commit -m <message>`. If nothing
   is staged, the method returns without committing (no-op).

This prevents empty commits when tasks produce no file changes.

**Interaction with `.gitignore`:** The `git add -A` command respects the
repository's `.gitignore` rules. Files matching `.gitignore` patterns are not
staged. However, `git add -A` stages **everything** that is not gitignored,
including files created by other concurrent tasks or processes. This means:

- Files created by the AI agent that should not be committed (e.g., build
  artifacts, temp files) must be covered by `.gitignore` rules.
- When running with `--concurrency > 1`, one task's `commitAllChanges()` call
  can stage uncommitted changes from another task that is still in progress.
  See [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md)
  for details on this cross-contamination risk.
- The dispatch pipeline calls
  [`ensureGitignoreEntry()`](../git-and-worktree/gitignore-helper.md) to add
  `.dispatch/worktrees/` to `.gitignore` at startup, preventing worktree
  metadata from being staged.

### `createPullRequest()`

Creates a pull request using `gh pr create` with:

- `--title <title>` -- PR title (typically the issue title).
- `--body <body>` -- PR body/description. When the caller provides a non-empty
  `body` parameter, it is used as-is. When `body` is empty or falsy, it
  defaults to `"Closes #<issueNumber>"`, which triggers GitHub's auto-close
  behavior: when this PR is merged, GitHub automatically closes the linked
  issue.
- `--head <branchName>` -- the source branch.

If the `gh pr create` command fails with an "already exists" error (a PR
already exists for this branch), the method falls back to
`gh pr view <branchName> --json url --jq .url` to retrieve and return the
existing PR's URL.

## The `GITHUB_REPOSITORY` environment variable

The module's docblock mentions `GITHUB_REPOSITORY` as an alternative to
working-directory-based repository detection. This is a **`gh` CLI convention**,
not a dispatch-specific feature. The `gh` CLI uses `GITHUB_REPOSITORY` (format:
`owner/repo`) to determine the target repository when the current working
directory is not inside a git repository.

This environment variable is automatically set by
[GitHub Actions](https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables)
in all workflow runs (e.g., `GITHUB_REPOSITORY=octocat/Hello-World`). It allows
dispatch to operate correctly in CI/CD environments where the checkout directory
may not have a full git history or the remote URL may not be configured.

**In dispatch's code**, the variable is never read directly — it is consumed
entirely by the `gh` CLI binary through environment variable inheritance (the
`execFile` calls inherit the parent process environment). When `gh` detects
`GITHUB_REPOSITORY` in the environment, it uses it as the default repository
context for all operations, making `--repo` flags unnecessary.

## Rate limits

The `gh` CLI is subject to GitHub's API rate limits:

- **Authenticated requests:** 5,000 requests per hour per user.
- **Search API:** 30 requests per minute.

The datasource does not implement rate-limit awareness, backoff, or retry
logic. If you hit a rate limit, the `gh` CLI will return a non-zero exit code
and stderr output indicating the rate limit. This surfaces as an unhandled
error from `execFile`.

For large-scale operations (e.g., listing hundreds of issues), consider using
`gh` CLI's built-in `--limit` flag outside of dispatch, or paginating
manually.

## Error handling

All errors from the `gh` CLI propagate as-is:

| Failure mode | Error type | Example |
|-------------|-----------|---------|
| `gh` not installed | `ENOENT` from `execFile` | `Error: spawn gh ENOENT` |
| Not authenticated | Non-zero exit code | `gh: Not logged in` |
| Token expired or revoked | Non-zero exit code | `Your token has expired` or `Bad credentials` |
| Issue not found | Non-zero exit code | `issue not found` |
| Malformed JSON output | `Error` with truncated context | `Failed to parse GitHub CLI output: <first 200 chars>` |
| Network failure | Non-zero exit code | Connection timeout |
| Branch name injection | `InvalidBranchNameError` | `Invalid branch name: "$(whoami)"` |

### Token expiry and revocation mid-operation

The `gh` CLI does not refresh tokens automatically during a long-running
dispatch session. If a token expires or is revoked while tasks are being
processed:

- The next `gh` command will fail with an authentication error (e.g.,
  `"Bad credentials"` or `"Your token has expired"`).
- The error propagates unhandled — there is no retry or token-refresh logic
  in the datasource layer.
- The affected task is marked as failed, and the pipeline continues with
  remaining tasks (see the orchestrator's
  [catch-and-continue pattern](../architecture.md#error-handling-strategy)).
- All subsequent `gh` operations for other tasks will also fail if they use
  the same expired token.

**Mitigation:** Use long-lived tokens (PATs with no expiration) for batch
operations, or ensure the `gh` CLI's OAuth token has sufficient remaining
lifetime before starting a large dispatch run. In GitHub Actions, the
`GITHUB_TOKEN` is automatically refreshed per-job, so expiry is not a concern
for CI/CD workflows.

### JSON parsing guards

The `JSON.parse(stdout)` calls in `list()` and `fetch()`
(`src/datasources/github.ts:122-126` and `src/datasources/github.ts:164-169`)
are wrapped in `try/catch` blocks. If the `gh` CLI produces non-JSON output
(e.g., an HTML error page or a warning message), the catch block throws a
descriptive `Error` that includes the first 200 characters of the unexpected
output for debugging context.

### Minimum `gh` CLI version

No minimum `gh` CLI version is enforced by the datasource. The commands used
(`issue list`, `issue view`, `issue edit`, `issue close`, `issue create`,
`pr create`, `pr view`) are stable across all modern `gh` CLI versions (2.x+).
The `--json` output flag used by `list()` and `fetch()` was introduced in
`gh` 2.0.0 (August 2021).

There is no subprocess timeout on any `gh` command. A hung `gh` process will
block the pipeline indefinitely.

## Troubleshooting

### "spawn gh ENOENT"

The `gh` CLI is not installed or not on PATH. Install it from
<https://cli.github.com/>.

### "Not logged in to any GitHub hosts"

Run `gh auth login` to authenticate. In CI, set `GH_TOKEN` or
`GITHUB_TOKEN`.

### Empty list results

Check that:
1. The working directory is inside a GitHub repository (or `GITHUB_REPOSITORY`
   is set).
2. The repository has open issues.
3. The authenticated user has read access to the repository.

### Comments missing from list results

This is expected behavior. Use `fetch()` to retrieve comments for individual
issues. See the [comments behavior](#list) section above.

### Auto-detection picks wrong datasource

If the repository has both GitHub and Azure DevOps remotes, auto-detection
uses only the `origin` remote. Use `--source github` to force GitHub.

## Related documentation

- [Datasource Overview](./overview.md) -- Interface definitions, registry,
  and auto-detection
- [Azure DevOps Datasource](./azdevops-datasource.md) -- The Azure DevOps
  counterpart
- [Datasource Helpers](./datasource-helpers.md) -- Orchestration bridge that
  consumes datasource operations for temp file writing and auto-close
- [Integrations & Troubleshooting](./integrations.md) -- Cross-cutting
  subprocess and error-handling concerns
- [Datasource Testing](./testing.md) -- Test coverage for the datasource
  system including the GitHub datasource test suites
- [GitHub Fetcher (deprecated)](../issue-fetching/github-fetcher.md) -- The
  legacy fetcher shim that delegates to this datasource
- [Deprecated Compatibility Layer](../deprecated-compat/overview.md) -- How
  the old `IssueFetcher` interface maps to the `Datasource` interface
- [CLI Argument Parser](../cli-orchestration/cli.md) -- `--source` flag and
  `--no-branch` flag documentation
- [Slugify Utility](../shared-utilities/slugify.md) -- The `slugify()` function
  used by `buildBranchName()` to sanitize titles
- [Branch Validation](../git-and-worktree/branch-validation.md) -- The
  `isValidBranchName()` function and `InvalidBranchNameError` class used by
  `getDefaultBranch()` for security validation
- [Dispatch Pipeline](../cli-orchestration/dispatch-pipeline.md) -- The
  execution engine that invokes datasource list, fetch, update, and git
  lifecycle operations
- [Planning & Dispatch Pipeline](../planning-and-dispatch/overview.md) -- The
  pipeline that consumes datasource git lifecycle operations
- [Spec Generation](../spec-generation/overview.md) -- The `--spec` pipeline
  that fetches issues via datasources
- [Testing Overview](../testing/overview.md) -- Project-wide test suite
- [Prerequisites & Safety Checks](../prereqs-and-safety/overview.md) -- The
  `checkPrereqs()` function that validates `gh` CLI availability
- [Prerequisite Checker Details](../prereqs-and-safety/prereqs.md) --
  Detailed validation logic for the `gh` binary check that gates GitHub
  datasource operations
- [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md) --
  Concurrent write safety concerns relevant to `commitAllChanges()`
- [Gitignore Helper](../git-and-worktree/gitignore-helper.md) -- How
  `.dispatch/worktrees/` is added to `.gitignore` at startup
