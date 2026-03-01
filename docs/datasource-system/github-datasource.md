# GitHub Datasource

The GitHub datasource reads and writes issues using the `gh` CLI. It is
implemented in `src/datasources/github.ts` and registered under the name
`"github"` in the [datasource registry](./overview.md#the-datasource-registry).

## What it does

The GitHub datasource translates the five [`Datasource` interface](./overview.md#the-datasource-interface) operations
into `gh` CLI commands:

| Operation | `gh` command | JSON output? |
|-----------|-------------|-------------|
| `list()` | `gh issue list --state open --json number,title,body,labels,state,url` | Yes |
| `fetch()` | `gh issue view <id> --json number,title,body,labels,state,url,comments` | Yes |
| `update()` | `gh issue edit <id> --title <title> --body <body>` | No |
| `close()` | `gh issue close <id>` | No |
| `create()` | `gh issue create --title <title> --body <body>` | No (outputs URL) |

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
takes precedence over `GITHUB_TOKEN`. The token must have the `repo` scope for
private repositories, or `public_repo` for public repositories.

### GitHub Enterprise Server

For GitHub Enterprise Server instances, authenticate with:

```sh
gh auth login --hostname github.mycompany.com
```

Note that the [datasource auto-detection](./overview.md#auto-detection) only matches `github.com` in the remote
URL. GitHub Enterprise hosts require explicit `--source github` on the
dispatch-tasks CLI. See the
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
outside of dispatch-tasks.

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

## Rate limits

The `gh` CLI is subject to GitHub's API rate limits:

- **Authenticated requests:** 5,000 requests per hour per user.
- **Search API:** 30 requests per minute.

The datasource does not implement rate-limit awareness, backoff, or retry
logic. If you hit a rate limit, the `gh` CLI will return a non-zero exit code
and stderr output indicating the rate limit. This surfaces as an unhandled
error from `execFile`.

For large-scale operations (e.g., listing hundreds of issues), consider using
`gh` CLI's built-in `--limit` flag outside of dispatch-tasks, or paginating
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
