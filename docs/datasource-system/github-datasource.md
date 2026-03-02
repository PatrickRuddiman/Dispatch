# GitHub Datasource

The GitHub datasource reads and writes issues using the `gh` CLI. It is
implemented in `src/datasources/github.ts` and registered under the name
`"github"` in the [datasource registry](./overview.md#the-datasource-registry).

## What it does

The GitHub datasource translates the [`Datasource` interface](./overview.md#the-datasource-interface) operations
into `gh` CLI and `git` commands. It provides five CRUD operations for issue
management and seven git lifecycle operations for branching, committing,
pushing, and pull request creation.

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
| `buildBranchName()` | _(pure function)_ | Returns `dispatch/<number>-<slug>` |
| `createAndSwitchBranch()` | `git checkout -b <branch>`, fallback to `git checkout <branch>` | Create or switch to branch |
| `switchBranch()` | `git checkout <branch>` | Switch to existing branch |
| `pushBranch()` | `git push --set-upstream origin <branch>` | Push branch to remote |
| `commitAllChanges()` | `git add -A` + `git diff --cached --stat` + `git commit -m <msg>` | Stage and commit; no-ops if nothing staged |
| `createPullRequest()` | `gh pr create --title <t> --body "Closes #<n>" --head <branch>` | Create PR with issue auto-close link |

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
returned [`IssueDetails`](../shared-types/parser.md#issuedetails) objects always have an empty `comments: []` array. This
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

## Git lifecycle operation details

The GitHub datasource implements all seven git lifecycle methods using the `git`
and `gh` CLI tools. These operations are used by the dispatch pipeline to manage
the branching, committing, and PR workflow after task completion.

### `getDefaultBranch()`

Detects the repository's default branch name using a two-step fallback:

1. Tries `git symbolic-ref refs/remotes/origin/HEAD` to read the remote HEAD
   reference. If this succeeds, extracts the branch name from the last path
   segment (e.g., `refs/remotes/origin/main` yields `"main"`).
2. If step 1 fails (common when `origin/HEAD` is not set, e.g., after a
   `git clone --bare` or when the remote HEAD has never been fetched), tries
   `git rev-parse --verify main` to check if a `main` branch exists.
3. If both fail, falls back to `"master"`.

**Troubleshooting `symbolic-ref` failures:** Run
`git remote set-head origin --auto` to set `origin/HEAD` from the remote,
which makes step 1 work reliably.

### `buildBranchName()`

Pure synchronous function that produces `dispatch/<number>-<slug>`. The title
is slugified (lowercased, non-alphanumeric runs replaced with hyphens, trimmed,
truncated to 50 characters). See the
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

Three-step process (`src/datasources/github.ts:209-217`):

1. `git add -A` -- stages all changes (new, modified, deleted files).
2. `git diff --cached --stat` -- checks if anything is actually staged.
3. If the diff output is non-empty, runs `git commit -m <message>`. If nothing
   is staged, the method returns without committing (no-op).

This prevents empty commits when tasks produce no file changes.

### `createPullRequest()`

Creates a pull request using `gh pr create` with:

- `--title <title>` -- PR title (typically the issue title).
- `--body "Closes #<issueNumber>"` -- PR body with GitHub's auto-close keyword.
  When this PR is merged, GitHub automatically closes the linked issue.
- `--head <branchName>` -- the source branch.

If the `gh pr create` command fails with an "already exists" error (a PR
already exists for this branch), the method falls back to
`gh pr view <branchName> --json url --jq .url` to retrieve and return the
existing PR's URL.

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
| Issue not found | Non-zero exit code | `issue not found` |
| Malformed JSON output | `SyntaxError` from `JSON.parse` | `Unexpected token` |
| Network failure | Non-zero exit code | Connection timeout |

There is no `try/catch` around the `JSON.parse(stdout)` calls in `list()` and
`fetch()` (`src/datasources/github.ts:34` and `src/datasources/github.ts:72`).
If the `gh` CLI produces non-JSON output (e.g., an HTML error page or a
warning message), the `SyntaxError` will propagate to the caller.

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
  system (note: the GitHub datasource has no unit tests)
- [GitHub Fetcher (deprecated)](../issue-fetching/github-fetcher.md) -- The
  legacy fetcher shim that delegates to this datasource
- [Deprecated Compatibility Layer](../deprecated-compat/overview.md) -- How
  the old `IssueFetcher` interface maps to the `Datasource` interface
- [Spec Generation](../spec-generation/overview.md) -- The `--spec` pipeline
  that fetches issues via datasources
