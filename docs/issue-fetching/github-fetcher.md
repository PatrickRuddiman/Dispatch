# GitHub Fetcher

> **Deprecated.** The file `src/issue-fetchers/github.ts` is now a thin shim
> that delegates all calls to the [GitHub datasource](../datasource-system/github-datasource.md) (`src/datasources/github.ts`) via `.bind()`. It
> contains no business logic. The actual GitHub implementation lives in the
> datasource layer. See the
> [Deprecated Compatibility Layer](../deprecated-compat/overview.md) for
> details. The prerequisites, field mappings, and troubleshooting guidance
> below remain accurate because the underlying datasource uses the same
> `gh` CLI commands.

The GitHub fetcher (`src/issue-fetchers/github.ts`) retrieves issue details
from GitHub repositories by shelling out to the
[GitHub CLI (`gh`)](https://cli.github.com/manual/). It normalizes the JSON
output into the common [`IssueDetails`](./overview.md#the-issuedetails-interface)
interface.

## Prerequisites

> **Note:** The [prerequisite checker](../prereqs-and-safety/prereqs.md)
> validates `gh` availability at startup when the datasource is `github`,
> but does not enforce a minimum version.

### Install the `gh` CLI

The `gh` CLI must be installed and available on `PATH`:

```bash
# macOS (Homebrew)
brew install gh

# Windows (WinGet)
winget install --id GitHub.cli

# Windows (Scoop)
scoop install gh

# Linux (apt)
sudo apt install gh

# Linux (dnf)
sudo dnf install gh

# Cross-platform (npm — not recommended for production)
npm install -g @github/gh
```

Verify installation:

```bash
gh --version
```

**Minimum version:** There is no strict minimum version requirement in the
code. The fetcher uses `gh issue view <id> --json <fields>`, which has been
available since `gh` v2.0.0. Any current release of `gh` (2.x) is compatible.

### Authenticate

Authenticate the `gh` CLI before running dispatch:

```bash
gh auth login
```

This launches an interactive flow (browser-based OAuth or device code).
Once authenticated, the token is stored locally and reused for all `gh`
commands.

**Verify authentication:**

```bash
gh auth status
```

**CI environments:** Set the `GH_TOKEN` or `GITHUB_TOKEN` environment variable
with a personal access token that has `repo` scope (for private repositories)
or `public_repo` scope (for public repositories):

```bash
export GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
dispatch --spec 42 --source github
```

### GitHub Enterprise Server

The `gh` CLI supports GitHub Enterprise Server (GHES) hosts. To authenticate
with a GHES instance:

```bash
gh auth login --hostname github.mycompany.com
```

After authentication, `gh` commands automatically route to the correct host
based on the repository's remote URL.

**Important:** The [auto-detection](./overview.md#auto-detection-of-issue-source)
logic only matches `github.com` in the remote URL. For GHES hosts, you must
use `--source github` explicitly:

```bash
dispatch --spec 42 --source github
```

## How it works

The fetcher executes a single CLI command per issue:

```
gh issue view <issueId> --json number,title,body,labels,state,url,comments
```

The `--json` flag requests structured JSON output with the specified fields.
The command is executed via `execFile('gh', [...args], { cwd })`, where `cwd`
provides the repository context (the `gh` CLI infers the repository from the
git remote in the working directory). For subprocess behavior details and
error-handling patterns, see
[Datasource Integrations](../datasource-system/integrations.md).

### Field mapping

| `gh` JSON field | `IssueDetails` field | Transformation |
|-----------------|---------------------|----------------|
| `number` | `number` | Cast to string: `String(issue.number)` |
| `title` | `title` | Direct, defaults to `""` |
| `body` | `body` | Direct (markdown format), defaults to `""` |
| `labels` | `labels` | Mapped from `[{ name: "bug" }]` to `["bug"]` |
| `state` | `state` | Direct (e.g., `"OPEN"`, `"CLOSED"`), defaults to `"OPEN"` |
| `url` | `url` | Direct, defaults to `""` |
| `comments` | `comments` | Each comment formatted as `**author:** body` |
| (none) | `acceptanceCriteria` | Always `""` -- see [design note](./overview.md#acceptance-criteria-on-github) |

### Comment formatting

Each comment in the `comments` array is formatted as:

```
**author_login:** comment body text
```

If the comment author's `login` is not available, it defaults to `"unknown"`.
Comments preserve their original markdown formatting from GitHub.

### Issue ID format

The `issueId` parameter is passed directly to `gh issue view`. The `gh` CLI
accepts:

- **Numeric IDs:** `42` -- the most common format
- **URLs:** `https://github.com/owner/repo/issues/42` -- useful for
  cross-repository references

Prefixes like `#42` are **not stripped** by the fetcher. If you pass `#42`,
the `gh` CLI may interpret it differently depending on shell escaping. Use
bare numbers for reliability:

```bash
dispatch --spec 42,43,44
```

## Troubleshooting

### `gh` CLI not installed

**Symptom:** The fetch call fails with an error containing `ENOENT` (file not
found).

**Cause:** Node.js `execFile` cannot find the `gh` binary on `PATH`.

**Resolution:**

1. Install the `gh` CLI (see [Prerequisites](#install-the-gh-cli)).
2. Verify it is on PATH: `which gh` (Unix) or `where gh` (Windows).
3. Restart your terminal to pick up PATH changes.

**Error behavior:** The `execFile` call rejects its promise with a Node.js
`Error` that has `code: 'ENOENT'`. This error propagates to the spec
generator, which catches it and logs:
`Failed to fetch #42: spawn gh ENOENT`. The issue is marked as failed; other
issues in the batch continue processing.

### Authentication errors

**Symptom:** Error message containing `authentication` or `401`.

**Resolution:**

1. Run `gh auth status` to check your authentication state.
2. Re-authenticate: `gh auth login`.
3. For CI, verify `GH_TOKEN` or `GITHUB_TOKEN` is set and has appropriate
   scopes.
4. For GHES, ensure you authenticated against the correct hostname:
   `gh auth login --hostname github.mycompany.com`.

### Permission errors (403)

**Symptom:** Error containing `403` or `forbidden`.

**Resolution:**

1. Verify your token has `repo` scope for private repositories.
2. Check that the repository is accessible to the authenticated user.
3. For organization repositories, ensure the token is authorized for
   the organization (GitHub may require SSO authorization).

### Rate limiting

**Symptom:** Error containing `rate limit` or `429`.

The `gh` CLI uses the GitHub API, which has rate limits:
- **Authenticated requests:** 5,000 requests/hour
- **Token-based:** Varies by token type

Each `dispatch --spec` call makes one API request per issue. A batch of 100
issues consumes 100 requests.

**Resolution:**

1. Wait for the rate limit window to reset (check
   `gh api rate_limit --jq '.rate.reset'`).
2. Use a token with higher rate limits if available.
3. Reduce the number of issues per batch.

### Issue not found (404)

**Symptom:** Error containing `not found` or `Could not resolve`.

**Resolution:**

1. Verify the issue number exists in the repository.
2. Check that `cwd` points to a directory within the correct repository.
3. For cross-repository issues, use the full URL format:
   `dispatch --spec https://github.com/owner/repo/issues/42`.

### Repository context

The `gh` CLI determines the target repository from the git remote in the
working directory. If you run dispatch from a directory that is not inside a
git repository with a GitHub remote, the `gh` command fails.

**Resolution:**

1. Ensure `--cwd` points to a directory inside the target repository.
2. Or set `GH_REPO=owner/repo` to override repository detection.

## Related documentation

- [Overview](./overview.md) -- Architecture, data flow, and IssueDetails
  interface
- [Azure DevOps Fetcher](./azdevops-fetcher.md) -- The alternative fetcher
  for Azure DevOps work items
- [GitHub Datasource](../datasource-system/github-datasource.md) -- The actual
  implementation this shim delegates to
- [Datasource Overview](../datasource-system/overview.md) -- Datasource
  interface, registry, and auto-detection
- [Integrations & Troubleshooting](../datasource-system/integrations.md) -- Subprocess behavior,
  timeouts, and error handling patterns
- [Adding a Fetcher](./adding-a-fetcher.md) -- Guide for implementing new
  tracker integrations
- [Deprecated Compatibility Layer](../deprecated-compat/overview.md) -- How the
  `IssueFetcher` interface maps to the `Datasource` interface
- [Testing Overview](../testing/overview.md) -- Test suite structure (note: the
  GitHub fetcher has no unit tests; see [Datasource Testing](../datasource-system/testing.md))
- [CLI argument parser](../cli-orchestration/cli.md) -- `--spec` and `--source`
  flag documentation
- [Configuration System](../cli-orchestration/configuration.md) -- Persistent
  `--source` defaults and three-tier merge logic
- [Spec Generation](../spec-generation/overview.md) -- The `--spec` pipeline
  that invokes issue fetchers
- [Datasource Testing](../datasource-system/testing.md) -- Test coverage
  (note: the GitHub datasource/fetcher has no unit tests)

## External references

- [GitHub CLI manual](https://cli.github.com/manual/) -- Official `gh`
  documentation
- [`gh issue view` reference](https://cli.github.com/manual/gh_issue_view) --
  Command syntax, JSON fields, and examples
- [`gh auth login`](https://cli.github.com/manual/gh_auth_login) --
  Authentication setup
- [GitHub API rate limits](https://docs.github.com/en/rest/rate-limit) --
  Rate limiting policies
