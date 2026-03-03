# Azure DevOps Datasource

The Azure DevOps datasource reads and writes work items using the `az` CLI with
the `azure-devops` extension. It is implemented in
`src/datasources/azdevops.ts` and registered under the name `"azdevops"` in
the datasource registry.

## What it does

The Azure DevOps datasource translates the [`Datasource`](./overview.md#the-datasource-interface) interface operations
into `az boards` and `az repos` CLI commands, plus `git` commands for lifecycle
operations. It provides five CRUD operations for work item management, one
identity method (`getUsername`), and seven git lifecycle operations for
branching, committing, pushing, and pull request creation.

### CRUD operations

| Operation | `az` command | JSON output? |
|-----------|-------------|-------------|
| `list()` | `az boards query --wiql <WIQL>` + N × `fetch()` | Yes |
| `fetch()` | `az boards work-item show --id <id>` + comment fetch | Yes |
| `update()` | `az boards work-item update --id <id> --title <t> --description <b>` | No |
| `close()` | `az boards work-item update --id <id> --state Closed` | No |
| `create()` | `az boards work-item create --type <detected-or-specified> --title <t> --description <b>` | Yes |

### Git lifecycle operations

| Operation | Command(s) | Purpose |
|-----------|-----------|---------|
| `getDefaultBranch()` | `git symbolic-ref refs/remotes/origin/HEAD`, fallback chain | Detect `main` or `master` |
| `getUsername()` | `git config user.name`, slugified | Resolve branch-safe username; falls back to `"unknown"` |
| `buildBranchName()` | _(pure function)_ | Returns `<username>/dispatch/<number>-<slug>` |
| `createAndSwitchBranch()` | `git checkout -b <branch>`, fallback to `git checkout <branch>` | Create or switch to branch |
| `switchBranch()` | `git checkout <branch>` | Switch to existing branch |
| `pushBranch()` | `git push --set-upstream origin <branch>` | Push branch to remote |
| `commitAllChanges()` | `git add -A` + `git diff --cached --stat` + `git commit -m <msg>` | Stage and commit; no-ops if nothing staged |
| `createPullRequest()` | `az repos pr create --title <t> --description <body> --source-branch <branch> --work-items <n>` | Create PR; uses `"Resolves AB#<n>"` as description when `body` param is empty |

All commands are executed via `execFile("az", [...args], { cwd })` with no
shell interpolation. The `--org` and `--project` flags are appended when the
corresponding [`IssueFetchOptions`](../issue-fetching/overview.md) fields are provided.

## Why it shells out to `az`

See the [overview](./overview.md#why-it-exists) for the rationale behind using
CLI tools instead of REST APIs or the `azure-devops-node-api` SDK. The `az`
CLI handles Azure AD/Entra ID authentication, token refresh, and multi-tenant
access. The `azure-devops` extension provides `az boards` commands specifically
for Azure DevOps operations.

## Authentication

### Interactive authentication

```sh
az login
```

This opens a browser for Azure AD/Entra ID authentication. The `az` CLI stores
credentials in `~/.azure/` and manages token refresh automatically.

### Service principal authentication (CI/CD)

```sh
az login --service-principal -u <app-id> -p <password-or-cert> --tenant <tenant-id>
```

For CI/CD pipelines, use a service principal with appropriate Azure DevOps
permissions. The service principal must be added to the Azure DevOps
organization with at least "Basic" access level.

### Personal access token authentication

```sh
export AZURE_DEVOPS_EXT_PAT="your-pat-here"
```

The `azure-devops` extension checks this environment variable for
authentication. The PAT must have "Work Items (Read, write, & manage)" scope.

### Installing the azure-devops extension

The `az boards` commands require the `azure-devops` extension:

```sh
az extension add --name azure-devops
```

Without this extension, all `az boards` commands will fail with an "az boards
is not a recognized command" error.

### Verifying authentication

```sh
az account show
az devops configure --list
```

## Organization and project resolution

Every `az boards` command requires an organization and project context. These
are resolved in order of precedence:

1. **Explicit options:** `opts.org` and `opts.project` from `IssueFetchOptions`,
   which map to the dispatch [`--org` and `--project` CLI flags](../cli-orchestration/cli.md).
2. **az CLI defaults:** Configured via `az devops configure --defaults
   organization=https://dev.azure.com/myorg project=myproject`. If defaults
   are set, the `--org` and `--project` flags can be omitted.
3. **No context:** If neither is provided and no defaults are configured, the
   `az` CLI will return an error asking for organization/project.

The `--org` flag expects a full organization URL (e.g.,
`https://dev.azure.com/myorg`), not just the organization name.

## Operation details

### `list()`

Lists active work items using a WIQL (Work Item Query Language) query.

**WIQL query** (hardcoded at `src/datasources/azdevops.ts:23`):

```sql
SELECT [System.Id] FROM workitems
WHERE [System.State] <> 'Closed'
  AND [System.State] <> 'Removed'
ORDER BY [System.CreatedDate] DESC
```

This query excludes work items in "Closed" and "Removed" states, ordered by
creation date descending. The query is not configurable -- you cannot filter by
work item type, area path, iteration, or assignee through the datasource
interface.

**N+1 fetch pattern:** The WIQL query returns only work item IDs. The `list()`
method then calls `fetch()` individually for each ID to retrieve full details.
This is an N+1 query pattern: 1 WIQL query + N individual work item fetches.

For repositories with many active work items, this can be slow and may
approach Azure DevOps API rate limits. There is no pagination, batching, or
caching.

**Why WIQL instead of `az boards work-item list`:** The `az boards` extension
does not provide a direct "list all work items" command. WIQL is the Azure
DevOps query language that provides filtering and ordering capabilities. The
alternative would be the REST API's batch endpoint
(`_apis/wit/workitemsbatch`), but the `az` CLI does not expose this directly.

### `fetch()`

Fetches a single work item by ID, including comments.

**Field mapping:**

| Azure DevOps field | `IssueDetails` field | Transformation |
|-------------------|---------------------|----------------|
| `id` | `number` | Converted to string via `String()` |
| `fields["System.Title"]` | `title` | Falls back to `""` |
| `fields["System.Description"]` | `body` | Falls back to `""` (may contain HTML) |
| `fields["System.Tags"]` | `labels` | Split on `;`, trimmed, empty strings removed |
| `fields["System.State"]` | `state` | Falls back to `""` |
| `_links.html.href` or `url` | `url` | Prefers the HTML link; falls back to API URL |
| _(separate call)_ | `comments` | See below |
| `fields["Microsoft.VSTS.Common.AcceptanceCriteria"]` | `acceptanceCriteria` | Falls back to `""` |

**Note on the `body` field:** Azure DevOps stores descriptions as HTML, not
markdown. The `body` field in `IssueDetails` may contain HTML tags. Consumers
should be aware of this when processing the body content.

**Note on `acceptanceCriteria`:** This is the only datasource that populates
the `acceptanceCriteria` field. The GitHub and markdown datasources always
return `""` for this field.

**Comments:** Comments are fetched via a separate `fetchComments()` helper
function (`src/datasources/azdevops.ts:294`) that calls `az boards work-item
relation list-comment`. Comments are formatted as `**<displayName>:** <text>`
strings, using the `createdBy.displayName` field for the author name (falling
back to `"unknown"`).

**Comment fetching is non-fatal:** The `fetchComments()` function wraps the
entire comment fetch -- including the `execFile` call and `JSON.parse` -- in a
`try/catch` block (`src/datasources/azdevops.ts:298`). If comments cannot be
retrieved for any reason (permission denied, extension not installed, API error,
malformed JSON response), the function silently returns an empty array. This
means the work item itself will still be returned successfully, just without
comments.

**Consequence of silent failure:** There is no way to distinguish "the work
item has no comments" from "comment fetching failed" in the returned
`IssueDetails`. Both cases produce `comments: []`. If you suspect comments are
missing, check the Azure DevOps web UI to verify whether comments exist and
ensure the authenticated user has read access to comments.

### `update()`

Updates the title and description of a work item using `az boards work-item
update`. Both `--title` and `--description` are always sent.

### `close()`

Closes a work item by setting its state to `"Closed"` via `az boards work-item
update --state Closed`. This uses the standard Azure DevOps state transition.

**Process template consideration:** The "Closed" state is valid in all default
Azure DevOps process templates (Basic, Agile, Scrum, CMMI). However, custom
process templates with different state names will cause the close operation to
fail with a state transition error.

### `create()`

Creates a new work item and returns the created `IssueDetails`.

**Work item type resolution:** The `create()` method determines the work item
type using a two-step resolution:

1. **Explicit option:** If `opts.workItemType` is provided (via the
   `IssueFetchOptions.workItemType` field, mapped from the dispatch config or
   CLI), that type is used directly.
2. **Auto-detection:** If no explicit type is provided, `create()` calls the
   exported `detectWorkItemType()` function (`src/datasources/azdevops.ts:19-43`),
   which queries the Azure DevOps project for available work item types using
   `az boards work-item type list`. It then selects from a priority list:

   | Priority | Work item type | Process template |
   |----------|---------------|-----------------|
   | 1st | User Story | Agile |
   | 2nd | Product Backlog Item | Scrum |
   | 3rd | Requirement | CMMI |
   | 4th | Issue | Basic |

   If none of the preferred types are available, it falls back to the first
   type returned by the API. If no types are available at all (or the API call
   fails), `detectWorkItemType()` returns `null`.

3. **Error on failure:** If neither the explicit option nor auto-detection
   yields a type, `create()` throws an error:
   `"Could not determine work item type. Set workItemType in your config."`

This replaces the previous behavior of hardcoding `"User Story"`, making
`create()` work across all Azure DevOps process templates without manual
configuration.

**Return value:** Unlike GitHub's `create()`, the Azure DevOps `create()`
fetches the response JSON and extracts fields from the created work item,
providing accurate field values in the returned `IssueDetails`.

## Git lifecycle operation details

The Azure DevOps datasource implements all seven git lifecycle methods. The
branching, committing, and pushing operations use `git` directly (identical to
the GitHub implementation). Pull request creation uses `az repos pr create`.

### `getDefaultBranch()`

Uses the same detection strategy as the GitHub datasource:

1. `git symbolic-ref refs/remotes/origin/HEAD` -- extract branch from remote
   HEAD reference.
2. Fallback: `git rev-parse --verify main` -- check if `main` exists.
3. Final fallback: returns `"master"`.

### `getUsername()`

Resolves the current developer's git username for branch namespacing
(`src/datasources/azdevops.ts:245-254`). Reads `git config user.name`,
slugifies the result, and falls back to `"unknown"` if the name is empty or
the git command fails. Identical behavior to the GitHub datasource.

### `buildBranchName()`

Same convention as all datasources: `<username>/dispatch/<number>-<slug>`. See the
[branch naming convention](./overview.md#branch-naming-convention) in the
overview.

### `createAndSwitchBranch()`

Attempts `git checkout -b <branchName>`. If the branch already exists, falls
back to `git checkout <branchName>`. Identical behavior to the GitHub
implementation.

### `switchBranch()`

Runs `git checkout <branchName>`.

### `pushBranch()`

Runs `git push --set-upstream origin <branchName>`.

### `commitAllChanges()`

Three-step process identical to the GitHub implementation:

1. `git add -A` -- stage all changes.
2. `git diff --cached --stat` -- check if anything is staged.
3. If non-empty, `git commit -m <message>`. Otherwise, no-op.

### `createPullRequest()`

Creates a pull request using `az repos pr create`
(`src/datasources/azdevops.ts:291`) with:

- `--title <title>` -- PR title.
- `--description <body>` -- PR description. When the caller provides a
  non-empty `body` parameter, it is used as-is. When `body` is empty or falsy,
  it defaults to `"Resolves AB#<issueNumber>"`, which is the Azure Boards
  integration prefix that triggers automatic work item resolution when the PR
  is completed.
- `--source-branch <branchName>` -- the feature branch.
- `--work-items <issueNumber>` -- creates a formal link between the PR and the
  work item in Azure DevOps, independent of the description keyword. This
  link appears in the work item's "Development" section.
- `--output json` -- the response is parsed to extract the PR URL.

**Existing PR handling:** If `az repos pr create` fails with "already exists",
the method falls back to
`az repos pr list --source-branch <branch> --status active --output json` to
find and return the first active PR's URL. If no active PR is found, returns
`""`.

## Rate limits

Azure DevOps REST API (which the `az` CLI uses internally) has the following
rate limits:

- **Authenticated requests:** Varies by organization plan. Typically 200
  requests per minute for personal access tokens.
- **Global limit:** 600 requests per minute per IP address.

The N+1 fetch pattern in `list()` is the most rate-limit-sensitive operation.
A workspace with 100 active work items will make 101 API calls (1 WIQL query +
100 individual fetches).

The datasource does not implement rate-limit awareness, backoff, or retry
logic.

## Error handling

| Failure mode | Error type | Example |
|-------------|-----------|---------|
| `az` not installed | `ENOENT` from `execFile` | `Error: spawn az ENOENT` |
| `azure-devops` extension missing | Non-zero exit code | `az boards is not a recognized command` |
| Not authenticated | Non-zero exit code | `Please run 'az login'` |
| Missing org/project | Non-zero exit code | `--organization is required` |
| Work item not found | Non-zero exit code | `TF401232: Work item does not exist` |
| Invalid state transition | Non-zero exit code | `The field 'System.State' contains value 'Closed' that is not in the list of supported values` |
| Malformed JSON output | `Error` with truncated context | `Failed to parse Azure CLI output: <first 200 chars>` |

The `JSON.parse(stdout)` calls in `list()`, `fetch()`, `create()`, and
`createPullRequest()` are wrapped in `try/catch` blocks
(`src/datasources/azdevops.ts:61-64`, `:107-110`, `:207-210`, `:319-322`).
If the `az` CLI produces non-JSON output, the catch block throws a descriptive
`Error` that includes the first 200 characters of the unexpected output for
debugging context.

Comment fetch failures are the one exception -- they are caught silently (see
[comments behavior](#fetch) above).

There is no subprocess timeout on any `az` command.

## Troubleshooting

### "spawn az ENOENT"

The `az` CLI is not installed or not on PATH. Install it from
<https://learn.microsoft.com/en-us/cli/azure/install-azure-cli>.

### "az boards is not a recognized command"

The `azure-devops` extension is not installed. Run:
```sh
az extension add --name azure-devops
```

### "Please run 'az login' to setup account"

Run `az login` to authenticate. In CI, use a service principal or set
`AZURE_DEVOPS_EXT_PAT`.

### "--organization is required"

Either pass `--org` to dispatch, or configure `az` CLI defaults:
```sh
az devops configure --defaults organization=https://dev.azure.com/myorg project=myproject
```

### `list()` is slow

The N+1 fetch pattern means `list()` time scales linearly with the number of
active work items. For projects with many open work items, consider:
- Using the WIQL query directly via `az boards query` to get just IDs
- Narrowing the query scope (not currently supported by the datasource)
- Using [`--source md`](./markdown-datasource.md) with local markdown files for faster iteration

### Work item type error on `create()`

The `create()` method auto-detects the work item type by querying available
types from the Azure DevOps project and selecting from a priority list (User
Story, Product Backlog Item, Requirement, Issue). If auto-detection fails
(e.g., due to permissions or network issues), `create()` throws an error. To
resolve this, set `workItemType` explicitly in your dispatch config:

```sh
dispatch config --workItemType "Product Backlog Item"
```

Alternatively, ensure the authenticated user has permission to list work item
types in the project (`az boards work-item type list`).

### visualstudio.com vs dev.azure.com

Auto-detection matches both `dev.azure.com` and `visualstudio.com` patterns
for Azure DevOps. The `visualstudio.com` pattern exists for backward
compatibility -- Azure DevOps was formerly Visual Studio Team Services (VSTS),
and many organizations still use `{org}.visualstudio.com` URLs. Microsoft
migrated to `dev.azure.com/{org}` URLs in September 2018, but both formats
remain functional.

## Related documentation

- [Datasource Overview](./overview.md) -- Interface definitions, registry,
  and auto-detection
- [GitHub Datasource](./github-datasource.md) -- The GitHub counterpart
- [Markdown Datasource](./markdown-datasource.md) -- Offline alternative
- [Datasource Helpers](./datasource-helpers.md) -- Orchestration bridge that
  consumes datasource operations for temp file writing and auto-close
- [Integrations & Troubleshooting](./integrations.md) -- Cross-cutting
  subprocess and error-handling concerns
- [Issue Fetching Overview](../issue-fetching/overview.md) -- Deprecated
  fetching layer that delegates to this datasource
- [Azure DevOps Fetcher (Deprecated)](../issue-fetching/azdevops-fetcher.md) --
  Legacy shim that delegates to this datasource
- [Spec Generation](../spec-generation/overview.md) -- Pipeline that consumes
  datasource output for spec file generation
- [Slugify Utility](../shared-utilities/slugify.md) -- Used by `buildBranchName()` for slug generation
- [Prerequisites](../prereqs-and-safety/prereqs.md) -- Prereq validation
  checks for `az` CLI dependency availability
