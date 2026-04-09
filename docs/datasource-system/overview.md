# Datasource System Overview

## What it does

The datasource system is the data-access layer of Dispatch. It provides a
unified `Datasource` interface (15 methods) that abstracts communication with
three backends -- GitHub Issues, Azure DevOps Work Items, and local Markdown
files -- so that the plan generator and orchestrator never depend on a specific
tracker.

All three implementations live under `src/datasources/` and share a common
registration and auto-detection mechanism defined in `src/datasources/index.ts`.
Authentication is handled by the shared helpers in `src/helpers/auth.ts` using
OAuth device-code flows with tokens cached at `~/.dispatch/auth.json`.

**Source files:**

| File | Purpose |
|------|---------|
| `src/datasources/interface.ts` | `Datasource` interface, `IssueDetails`, option types |
| `src/datasources/index.ts` | Registry, auto-detection, URL parsers, `deriveShortUsername()` |
| `src/datasources/github.ts` | GitHub implementation (Octokit SDK) |
| `src/datasources/azdevops.ts` | Azure DevOps implementation (`azure-devops-node-api` SDK) |
| `src/datasources/md.ts` | Markdown file implementation (fs/promises + glob) |
| `src/helpers/auth.ts` | Device-code authentication, token caching |
| `src/helpers/branch-validation.ts` | Branch name validation |
| `src/constants.ts` | OAuth client IDs, Azure tenant/scope |
| `src/orchestrator/datasource-helpers.ts` | Orchestration bridge functions |

**Related docs:**

- [GitHub datasource](./github-datasource.md)
- [Azure DevOps datasource](./azdevops-datasource.md)
- [Markdown datasource](./markdown-datasource.md)
- [External integrations](./integrations.md)
- [Datasource helpers](./datasource-helpers.md)
- [Testing](./testing.md)

## Why it exists

Different teams use different issue trackers. The datasource abstraction lets
Dispatch work with any of them through a single contract, keeping the core
pipeline logic tracker-agnostic. Adding a new backend requires only:

1. Creating a new file under `src/datasources/` that satisfies `Datasource`.
2. Registering it in the `DATASOURCES` map in `src/datasources/index.ts`.
3. Adding the name to the `DatasourceName` union in `src/datasources/interface.ts`.

## How it works

### Datasource interface

The `Datasource` interface (`src/datasources/interface.ts`) defines 15 methods
organized into three groups:

**CRUD operations (5 methods):**

| Method | Signature | Description |
|--------|-----------|-------------|
| `list` | `(opts?) => Promise<IssueDetails[]>` | List open issues/specs |
| `fetch` | `(issueId, opts?) => Promise<IssueDetails>` | Fetch a single issue by ID |
| `create` | `(title, body, opts?) => Promise<IssueDetails>` | Create a new issue |
| `update` | `(issueId, title, body, opts?) => Promise<void>` | Update title and body |
| `close` | `(issueId, opts?) => Promise<void>` | Close or resolve an issue |

**Git lifecycle operations (8 methods):**

| Method | Signature | Description |
|--------|-----------|-------------|
| `getDefaultBranch` | `(opts) => Promise<string>` | Resolve default branch (symbolic-ref or fallback) |
| `getCurrentBranch` | `(opts) => Promise<string>` | Current branch, falls back to default on detached HEAD |
| `getUsername` | `(opts) => Promise<string>` | Slugified username for branch namespacing |
| `buildBranchName` | `(issueNumber, title, username?) => string` | Build branch name from issue data |
| `createAndSwitchBranch` | `(branchName, opts) => Promise<void>` | Create and checkout branch (with worktree recovery) |
| `switchBranch` | `(branchName, opts) => Promise<void>` | Switch to an existing branch |
| `pushBranch` | `(branchName, opts) => Promise<void>` | Push branch to origin |
| `commitAllChanges` | `(message, opts) => Promise<void>` | Stage all and commit (skips if nothing staged) |

**Pull request creation (1 method):**

| Method | Signature | Description |
|--------|-----------|-------------|
| `createPullRequest` | `(branchName, issueNumber, title, body, opts, baseBranch?) => Promise<string>` | Create PR; returns URL of created or existing PR |

**Capability query (1 method):**

| Method | Signature | Description |
|--------|-----------|-------------|
| `supportsGit` | `() => boolean` | Whether git operations are functional (returns `true` for all 3 datasources) |

### Data types

**`IssueDetails`** -- the normalized work item returned by all datasources:

| Field | Type | Notes |
|-------|------|-------|
| `number` | `string` | Issue number, work item ID, or filename |
| `title` | `string` | Issue title |
| `body` | `string` | Full description (markdown or HTML) |
| `labels` | `string[]` | Tags/labels/categories |
| `state` | `string` | Current state (open, closed, active, etc.) |
| `url` | `string` | Web UI URL |
| `comments` | `string[]` | Discussion comments |
| `acceptanceCriteria` | `string` | Acceptance criteria (Azure DevOps) |
| `iterationPath?` | `string` | Sprint path (Azure DevOps) |
| `areaPath?` | `string` | Team path (Azure DevOps) |
| `assignee?` | `string` | Assignee display name |
| `priority?` | `number` | 1 = Critical ... 4 = Low |
| `storyPoints?` | `number` | Story points / effort / size |
| `workItemType?` | `string` | Work item type (e.g. "User Story", "Bug") |

**`IssueFetchOptions`** -- options passed to CRUD methods:

| Field | Type | Notes |
|-------|------|-------|
| `cwd?` | `string` | Working directory for repo context |
| `org?` | `string` | Organization URL (Azure DevOps) |
| `project?` | `string` | Project name (Azure DevOps) |
| `workItemType?` | `string` | Work item type filter |
| `iteration?` | `string` | Iteration path or `@CurrentIteration` macro |
| `area?` | `string` | Area path filter |
| `pattern?` | `string \| string[]` | Glob pattern(s) for `list()` filtering (Markdown) |

**`DispatchLifecycleOptions`** -- options for git lifecycle methods:

| Field | Type | Notes |
|-------|------|-------|
| `cwd` | `string` | Working directory (git repo root) |
| `username?` | `string` | Optional short username, overrides git-derived value |

### Auto-detection

The registry in `src/datasources/index.ts` provides `detectDatasource(cwd)`,
which reads the `origin` remote URL and matches it against known patterns:

```mermaid
flowchart TD
    A[detectDatasource] --> B[getGitRemoteUrl]
    B -->|null| C[return null]
    B -->|url| D{Match patterns}
    D -->|github.com| E[return 'github']
    D -->|dev.azure.com| F[return 'azdevops']
    D -->|visualstudio.com| F
    D -->|no match| C
```

Pattern matching is done in order; the first match wins. If no remote URL is
available or no pattern matches, `null` is returned and the caller must either
fall back to the `md` datasource or prompt the user.

### Branch naming convention

All three datasources produce branch names in the format:

```
{username}/dispatch/issue-{number}
```

The `title` parameter is accepted by `buildBranchName()` for interface
compatibility but is unused (parameter named `_title` in all implementations).

The `username` is derived by `deriveShortUsername()` in `src/datasources/index.ts`:

- **Multi-word git name:** first 2 chars of first name + first 6 chars of last
  name (e.g. "Jane Smith" becomes `jasmith`)
- **Single-word or no name:** first 8 chars of the email local part
- **Fallback:** `"unknown"` for GitHub/Azure DevOps, `"local"` for Markdown

The `username` field in `DispatchLifecycleOptions` can override the derived
value. All datasources check `opts.username` before calling
`deriveShortUsername()`.

### Default branch detection

All three datasources share identical logic for `getDefaultBranch()`:

1. Run `git symbolic-ref refs/remotes/origin/HEAD` and extract the branch name
   after the `refs/remotes/origin/` prefix.
2. Validate the result with `isValidBranchName()`.
3. If symbolic-ref fails, check if `main` exists via `git rev-parse --verify main`.
4. Fall back to `master` if `main` does not exist.

### Current branch detection

`getCurrentBranch()` runs `git rev-parse --abbrev-ref HEAD`. When in detached
HEAD state (returns the literal string `"HEAD"`), it falls back to
`getDefaultBranch()`.

### Worktree conflict recovery

All three datasources share identical logic in `createAndSwitchBranch()`:

1. Attempt `git checkout -b {branch}` to create and switch.
2. If the branch already exists, fall back to `git checkout {branch}`.
3. If checkout fails with "already used by worktree", run `git worktree prune`
   then retry the checkout.

Azure DevOps additionally validates the branch name with `isValidBranchName()`
before any git operations and throws `InvalidBranchNameError` on failure.

### Commit staging

`commitAllChanges()` in all three datasources:

1. Runs `git add -A` to stage everything.
2. Runs `git diff --cached --stat` to check if anything is staged.
3. Skips the commit silently if nothing is staged.
4. Runs `git commit -m {message}` otherwise.

### Authentication flow

GitHub and Azure DevOps use device-code OAuth flows managed by
`src/helpers/auth.ts`. See [integrations.md](./integrations.md) for the full
authentication sequence diagram.

```mermaid
sequenceDiagram
    participant User
    participant Dispatch
    participant AuthCache as ~/.dispatch/auth.json
    participant Provider as GitHub / Azure AD

    Dispatch->>AuthCache: Load cached token
    alt Valid token exists
        AuthCache-->>Dispatch: Return token
    else No token or expired
        Dispatch->>Provider: Initiate device-code flow
        Provider-->>Dispatch: Return device code + URL
        Dispatch->>User: Display code and URL
        User->>Provider: Authorize in browser
        Provider-->>Dispatch: Return access token
        Dispatch->>AuthCache: Save token (mode 0o600)
    end
    Dispatch->>Provider: Authenticated API calls
```

### SDK architecture

The datasource system uses SDK-based integrations rather than CLI tools:

| Datasource | SDK | Authentication |
|------------|-----|----------------|
| GitHub | `@octokit/rest` + `@octokit/auth-oauth-device` | OAuth device-flow, `repo` scope |
| Azure DevOps | `azure-devops-node-api` + `@azure/identity` | `DeviceCodeCredential`, work/school accounts only |
| Markdown | `fs/promises` + `glob` | None (local filesystem) |

The only CLI dependency is `git` itself, invoked via `child_process.execFile`
for branch operations, commits, and pushes.

### Credential redaction

Both GitHub and Azure DevOps datasources include a `redactUrl()` helper that
strips userinfo from URLs before including them in error messages, replacing
`https://user:pass@host/...` with `https://***@host/...`.

### URL parsing

Two URL parser functions in `src/datasources/index.ts` extract owner/repo
or org/project from git remote URLs:

**`parseGitHubRemoteUrl()`** supports 3 formats:

- HTTPS: `https://[user@]github.com/{owner}/{repo}[.git]`
- SCP-style SSH: `git@github.com:{owner}/{repo}[.git]`
- URL-style SSH: `ssh://git@github.com/{owner}/{repo}[.git]`

**`parseAzDevOpsRemoteUrl()`** supports 3 formats:

- HTTPS: `https://[user@]dev.azure.com/{org}/{project}/_git/{repo}`
- SSH: `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`
- Legacy: `https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}`

All parsers decode URL-encoded segments and normalize Azure DevOps org URLs to
`https://dev.azure.com/{org}`.

## Related documentation

- [Datasource Helpers](./datasource-helpers.md) -- bridge functions between
  the orchestrator and datasource layer (PR bodies, temp files, issue parsing)
- [GitHub Datasource](./github-datasource.md) -- GitHub-specific implementation
  details
- [Azure DevOps Datasource](./azdevops-datasource.md) -- Azure DevOps-specific
  implementation details
- [Markdown Datasource](./markdown-datasource.md) -- local markdown file
  datasource
- [Configuration](../cli-orchestration/configuration.md) -- `--source` option
  and datasource selection
- [Orchestrator Pipeline](../cli-orchestration/orchestrator.md) -- how the
  pipeline discovers and dispatches work items from datasources
- [Authentication](../cli-orchestration/authentication.md) -- device-code OAuth
  flows for GitHub and Azure DevOps
- [Datasource URL Parsing Tests](../testing/datasource-url-parsing-tests.md) --
  tests for `parseGitHubRemoteUrl()` and `parseAzDevOpsRemoteUrl()`
- [GitHub Datasource Tests](../testing/github-datasource-tests.md) -- tests
  for the GitHub datasource implementation
- [Datasource Tests](../testing/datasource-tests.md) -- interface-level
  datasource tests
