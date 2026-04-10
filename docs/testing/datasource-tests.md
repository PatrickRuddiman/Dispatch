# Datasource Test Suite

The datasource test suite validates all three datasource backends (GitHub, Azure DevOps, and Markdown), their shared helper functions, and the URL parsing utilities that detect which backend to use. Together, these tests ensure that Dispatch can reliably list, fetch, create, update, and close work items across all supported platforms, manage the git branch lifecycle, and generate correct pull request content.

## What this suite covers

The datasource tests exercise the full datasource contract defined in
`src/datasources/interface.ts`. Every method on the `Datasource` interface
is tested for each backend, along with cross-cutting concerns such as:

- Authentication mocking and credential handling
- Remote URL parsing and datasource auto-detection
- Branch name validation and sanitization
- Credential redaction in error messages
- PR body generation with platform-specific close references
- Git lifecycle operations (branch, commit, push, PR)
- Worktree recovery for stale branch locks
- Process template detection for Azure DevOps

## Test files

| File | Lines | Description |
|------|-------|-------------|
| `src/tests/azdevops-datasource.test.ts` | 1374 | Azure DevOps datasource: WIQL queries, work item CRUD, process template detection, branch lifecycle, credential redaction |
| `src/tests/github-datasource.test.ts` | 593 | GitHub datasource: Octokit-based issue CRUD, PR creation with recovery, label filtering, credential redaction |
| `src/tests/md-datasource.test.ts` | 634 | Markdown file datasource: filesystem CRUD, glob pattern expansion, numeric ID resolution, path handling |
| `src/tests/datasource.test.ts` | 680 | Cross-cutting: MD datasource integration tests, `extractTitle`, config validation, datasource registry, `parseAzDevOpsRemoteUrl` |
| `src/tests/datasource-helpers.test.ts` | 1024 | Orchestrator helpers: `parseIssueFilename`, `fetchItemsById`, `writeItemsToTempDir`, PR title/body builders, git diff and squash |
| `src/tests/datasource-url.test.ts` | 202 | URL parsing: `parseAzDevOpsRemoteUrl` and `parseGitHubRemoteUrl` across HTTPS, SSH, legacy, and credential-embedded formats |

## Architecture

```mermaid
graph TD
    subgraph "Test Files"
        AZ[azdevops-datasource.test.ts]
        GH[github-datasource.test.ts]
        MD_TEST[md-datasource.test.ts]
        DS_TEST[datasource.test.ts]
        HELPERS[datasource-helpers.test.ts]
        URL_TEST[datasource-url.test.ts]
    end

    subgraph "Source Under Test"
        AZ_SRC[datasources/azdevops.ts]
        GH_SRC[datasources/github.ts]
        MD_SRC[datasources/md.ts]
        IDX[datasources/index.ts]
        IFACE[datasources/interface.ts]
        AUTH[helpers/auth.ts]
        BRANCH[helpers/branch-validation.ts]
        DSH[orchestrator/datasource-helpers.ts]
    end

    AZ --> AZ_SRC
    AZ --> AUTH
    AZ --> IDX
    AZ --> BRANCH
    GH --> GH_SRC
    GH --> AUTH
    GH --> IDX
    GH --> BRANCH
    MD_TEST --> MD_SRC
    DS_TEST --> IDX
    DS_TEST --> MD_SRC
    HELPERS --> DSH
    URL_TEST --> IDX

    AZ_SRC --> IFACE
    GH_SRC --> IFACE
    MD_SRC --> IFACE
    IDX --> IFACE
```

## Integration points

### Azure DevOps Node API SDK

The Azure DevOps tests mock the `azure-devops-node-api` SDK entirely. The mock
connection (`WebApi`) exposes `getWorkItemTrackingApi()` and `getGitApi()`,
which return stubs for WIQL queries, work item CRUD, work item type/state
introspection, repository listing, and pull request management. Authentication
is handled through `src/helpers/auth.ts`, which is mocked to return a
pre-configured connection.

See: [Azure DevOps datasource tests](./azdevops-datasource-tests.md)

### Octokit / GitHub REST API

The GitHub tests mock Octokit's `rest.issues` and `rest.pulls` endpoints, plus
the `paginate` helper for listing. The `@octokit/request-error` `RequestError`
class is used directly (not mocked) to test PR-already-exists recovery paths.

See: [GitHub datasource tests](./github-datasource-tests.md)

### Git CLI

All datasources shell out to `git` via `child_process.execFile` for branch
management, commits, pushes, and default branch detection. Every test file
mocks `execFile` to validate the exact command arguments, including the
`shell: true` flag on Windows.

### glob

The Markdown datasource uses the `glob` package to expand user-provided
patterns when `opts.pattern` is set, allowing specs to live outside the
default `.dispatch/specs/` directory.

See: [Markdown datasource tests](./md-datasource-tests.md)

### Vitest

All test files use Vitest's `describe`/`it`/`expect` API with `vi.mock` for
module-level mocking and `vi.hoisted` for mock declarations that must be
available before module evaluation. The shared test fixtures in
`src/tests/fixtures.ts` provide reusable `createMockDatasource`,
`createMockIssueDetails`, and `mockExecFile` helpers.

## Cross-cutting patterns

### Credential redaction

Both the Azure DevOps and GitHub datasources redact credentials from error
messages when remote URLs contain embedded userinfo (e.g.,
`https://user:token@host/...`). Tests verify that secrets are replaced with
`***@` and never appear in stringified error output.

See: `src/tests/azdevops-datasource.test.ts:1312-1374`,
`src/tests/github-datasource.test.ts:578-593`

### Branch name validation

All datasources share validation logic from `src/helpers/branch-validation.ts`.
The `isValidBranchName` function enforces git refname rules: no spaces, no
shell metacharacters, no `..` traversal, no `.lock` suffix, no `@{` reflog
syntax, and a 255-character limit. Both `getDefaultBranch` and
`createAndSwitchBranch` validate their inputs before executing git commands,
throwing `InvalidBranchNameError` for violations.

See: `src/tests/azdevops-datasource.test.ts:1187-1310`,
`src/tests/github-datasource.test.ts:256-287`

### Worktree recovery

When `createAndSwitchBranch` encounters a branch locked by a stale worktree,
both the Azure DevOps and GitHub datasources automatically run
`git worktree prune` and retry the checkout. Tests verify the exact three-step
recovery sequence: create fails, checkout fails with worktree error, prune,
retry checkout.

See: `src/tests/azdevops-datasource.test.ts:986-1019`,
`src/tests/github-datasource.test.ts:330-363`

## Related documentation

- [Datasource system architecture](../datasource-system/) -- contract and registry
- [Test fixtures and mocks](./test-fixtures.md) -- shared test helpers
- [Git and worktree management](../git-and-worktree/) -- git lifecycle details
- [Azure DevOps datasource tests](./azdevops-datasource-tests.md)
- [GitHub datasource tests](./github-datasource-tests.md)
- [Markdown datasource tests](./md-datasource-tests.md)
- [Datasource helpers tests](./datasource-helpers-tests.md)
- [URL parsing tests](./datasource-url-parsing-tests.md)
