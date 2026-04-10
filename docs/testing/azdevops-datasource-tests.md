# Azure DevOps Datasource Tests

Tests for the Azure DevOps datasource implementation (`src/datasources/azdevops.ts`), covering WIQL-based work item querying, work item CRUD operations, process template detection, git branch lifecycle management, pull request creation with recovery, and credential redaction.

**Test file:** `src/tests/azdevops-datasource.test.ts` (1374 lines, 14 describe blocks)

## What is tested

The Azure DevOps datasource communicates with Azure DevOps Services through the `azure-devops-node-api` SDK. It translates the generic `Datasource` interface into Azure DevOps Work Item Tracking API calls and Git API calls. The test suite validates every public method plus the exported helper functions `detectWorkItemType` and `detectDoneState`.

## How authentication works in tests

Authentication is fully mocked. The test file uses `vi.mock("../helpers/auth.js")` to replace `getAzureConnection` with a stub that returns a mock `WebApi` connection. This mock connection provides:

- `getWorkItemTrackingApi()` -- returns mock WIT API with stubs for `queryByWiql`, `getWorkItems`, `getWorkItem`, `updateWorkItem`, `createWorkItem`, `getWorkItemTypes`, `getWorkItemTypeStates`, and `getComments`
- `getGitApi()` -- returns mock Git API with stubs for `getRepositories`, `createPullRequest`, and `getPullRequests`

The real auth module (`src/helpers/auth.ts`) uses Azure's `DeviceCodeCredential` for interactive OAuth device-code flow. Tokens are cached at `~/.dispatch/auth.json` with mode `0o600`. The `getAzureConnection` function checks cached tokens against a 5-minute expiry buffer and re-authenticates only when needed.

See: `src/helpers/auth.ts:118-167`

## WIQL query construction

The `list` method builds a Work Item Query Language (WIQL) query to find open work items. The base query filters out items in "Closed", "Done", or "Removed" states. Optional filters for iteration path and area path are appended conditionally.

### Iteration and area path filtering

Tests verify the following WIQL filter behaviors:

| Scenario | WIQL clause added |
|----------|-------------------|
| `iteration: "MyProject\\Sprint 1"` | `[System.IterationPath] UNDER 'MyProject\\Sprint 1'` |
| `area: "MyProject\\Team A"` | `[System.AreaPath] UNDER 'MyProject\\Team A'` |
| `iteration: "@CurrentIteration"` | `[System.IterationPath] UNDER @CurrentIteration` (no quotes -- macro syntax) |
| Both set | Both clauses appended |
| Neither set | No iteration/area clauses; base state filters only |

See: `src/tests/azdevops-datasource.test.ts:161-200`

### Batch vs. fallback fetching

The `list` method first queries WIQL for matching work item IDs, then batch-fetches details via `getWorkItems([id1, id2, ...])`. If the batch call fails (e.g., API version mismatch), the method falls back to individual `fetch()` calls per item.

See: `src/tests/azdevops-datasource.test.ts:72-120`

## Process template detection

Azure DevOps supports multiple process templates (Agile, Scrum, CMMI, Basic), each with different work item types and state names. Dispatch dynamically detects the correct types and terminal states.

### detectWorkItemType

Determines the primary work item type for creating new items. The priority order is:

1. **User Story** (Agile)
2. **Product Backlog Item** (Scrum)
3. **Requirement** (CMMI)
4. **Issue** (Basic)
5. First type in the list (custom template fallback)
6. `null` on API failure or empty type list

See: `src/tests/azdevops-datasource.test.ts:655-723`

### detectDoneState

Determines the correct terminal state for closing a work item. The detection strategy:

1. Query `getWorkItemTypeStates` for the work item's type
2. Find the state with `category: "Completed"`
3. If no `Completed` category, fall back through: Done, Closed, Resolved, Completed
4. Default to "Closed" if no known terminal state exists
5. Default to "Closed" on API error
6. Cache results per work item type (subsequent calls skip the API)

```mermaid
flowchart TD
    A[detectDoneState called] --> B{States API succeeds?}
    B -->|No| H[Default: Closed]
    B -->|Yes| C{Has Completed category?}
    C -->|Yes| D[Use that state name]
    C -->|No| E{Done exists?}
    E -->|Yes| F[Use Done]
    E -->|No| G{Closed exists?}
    G -->|Yes| H2[Use Closed]
    G -->|No| I{Resolved exists?}
    I -->|Yes| J[Use Resolved]
    I -->|No| K{Completed exists?}
    K -->|Yes| L[Use Completed]
    K -->|No| H
```

See: `src/tests/azdevops-datasource.test.ts:726-873`

### Story points field fallback across templates

Different process templates store effort estimates in different fields. The fetch method falls back across:

1. `Microsoft.VSTS.Scheduling.StoryPoints` (Agile)
2. `Microsoft.VSTS.Scheduling.Effort` (Scrum)
3. `Microsoft.VSTS.Scheduling.Size` (CMMI)

See: `src/tests/azdevops-datasource.test.ts:322-361`

## Work item CRUD operations

### fetch

Returns `IssueDetails` with:
- `number` as string, `title`, `body` (from `System.Description`), `labels` (split from `System.Tags` on semicolons), `state`, `url` (from `_links.html.href`), `comments` (formatted as `**DisplayName:** text`), `acceptanceCriteria`
- Extended fields: `iterationPath`, `areaPath`, `assignee` (from `System.AssignedTo.displayName`), `priority`, `storyPoints`, `workItemType`
- Gracefully returns empty comments array when comment fetch fails

See: `src/tests/azdevops-datasource.test.ts:211-361`

### update

Sends a JSON Patch document with two operations:
- `{ op: "add", path: "/fields/System.Title", value: title }`
- `{ op: "add", path: "/fields/System.Description", value: body }`

See: `src/tests/azdevops-datasource.test.ts:364-387`

### close

Uses `detectDoneState` to find the correct terminal state, then patches `System.State`. Accepts optional `opts.workItemType` to skip the extra `getWorkItem` call when the type is already known.

See: `src/tests/azdevops-datasource.test.ts:389-498`

### create

Detects the work item type (or uses `opts.workItemType`), creates via the SDK, and returns `IssueDetails`. Falls back `workItemType` to the locally detected value when the API response omits `System.WorkItemType`.

See: `src/tests/azdevops-datasource.test.ts:501-653`

## Username derivation

The `getUsername` method resolves a short, branch-safe username:

1. Use `opts.username` if provided
2. Multi-word `git user.name` (e.g., "Alice Smith") -- take first 2 chars of first name + last name, lowercased: "alsmith"
3. Single-word name -- fall back to `git user.email`, take local part before `@`, truncate to 7 chars: "alicesmi"
4. All failures -- return "unknown"

See: `src/tests/azdevops-datasource.test.ts:875-915`

## Default branch detection

Uses `git symbolic-ref refs/remotes/origin/HEAD` to detect the default branch. Falls back to "main" (checking if refs exist), then "master". Supports slashed branch names like `release/2024` and deeply nested names like `feature/team/sprint-1` by joining everything after `refs/remotes/origin/`.

See: `src/tests/azdevops-datasource.test.ts:917-956`

## Branch naming convention

Branch names follow the pattern `{username}/dispatch/issue-{number}`. The title is not incorporated into the branch name (unlike some other tools). Special characters in titles are irrelevant since only the issue number is used.

See: `src/tests/azdevops-datasource.test.ts:958-1271`

## Branch lifecycle and worktree recovery

### createAndSwitchBranch

1. Attempt `git checkout -b {branch}`
2. If branch already exists, fall back to `git checkout {branch}`
3. If checkout fails because the branch is locked by a stale worktree, run `git worktree prune` and retry checkout
4. Throw for other errors (e.g., permission denied)

### Branch name validation

All branch operations validate names before executing git commands using `isValidBranchName` from `src/helpers/branch-validation.ts`. Invalid names throw `InvalidBranchNameError` without invoking git. Rejected patterns include:

- Spaces (shell injection risk)
- Shell metacharacters (`$(whoami)`)
- Reflog syntax (`@{0}`)
- Parent traversal (`..`)
- Lock suffix (`.lock`)
- Empty names
- Names exceeding 255 characters

See: `src/tests/azdevops-datasource.test.ts:1187-1310`

## Pull request creation

Creates PRs via the Azure DevOps Git API:
- Source ref: `refs/heads/{branchName}`
- Target ref: `refs/heads/{defaultBranch}`
- Links work item via `workItemRefs: [{ id: issueNumber }]`
- Default description when body is empty: `"Resolves AB#{issueNumber}"`
- Repository matching strips embedded credentials from the remote URL before comparing with `REPO.webUrl`

### PR recovery

When `createPullRequest` throws an "already exists" error, the method queries for existing active PRs on the same source branch and returns the first match's URL. Returns empty string if no existing PR is found.

See: `src/tests/azdevops-datasource.test.ts:1071-1185`

## Credential redaction in error messages

When the remote URL contains embedded credentials (e.g., `https://user:secret-pat@host/...`), error messages replace the credentials with `***@`. Tests verify:

1. The raw secret never appears in `String(err)`
2. The redacted form `***@` is present
3. Redaction applies to both `list()` parse failures and `createPullRequest()` repo-not-found errors

See: `src/tests/azdevops-datasource.test.ts:1312-1356`

## Empty string fallback with || operator

The `getOrgAndProject` function uses JavaScript's `||` operator (not `??`) for org/project options. This means empty strings are treated as falsy and fall back to parsed values from the remote URL, which is the intended behavior.

See: `src/tests/azdevops-datasource.test.ts:1358-1374`

## Related documentation

- [Datasource test suite overview](./datasource-tests.md)
- [GitHub datasource tests](./github-datasource-tests.md)
- [Markdown datasource tests](./md-datasource-tests.md)
- [URL parsing tests](./datasource-url-parsing-tests.md)
- [Datasource system architecture](../datasource-system/) — production modules
  these tests verify
- [Azure DevOps Datasource](../datasource-system/azdevops-datasource.md) —
  production implementation of the Azure DevOps datasource
- [Datasource Testing](../datasource-system/testing.md) — test patterns
  and mock strategies for all datasource modules
- [Datasource Integrations](../datasource-system/integrations.md) —
  authentication and SDK dependency details
