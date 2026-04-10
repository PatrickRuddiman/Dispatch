# Testing

## What it does

The datasource system has comprehensive test coverage across 8 test files
in `src/tests/`. Tests use Vitest with mock-based isolation -- SDK clients
are mocked at the module level so no network calls or git commands are
executed during tests.

**Test files:**

| File | Lines | Coverage |
|------|-------|----------|
| `src/tests/datasource.test.ts` | 680 | MD datasource CRUD, extractTitle, registry, URL parsing |
| `src/tests/github-datasource.test.ts` | 594 | GitHub datasource (Octokit mocks) |
| `src/tests/azdevops-datasource.test.ts` | 1374 | Azure DevOps datasource (SDK mocks) |
| `src/tests/md-datasource.test.ts` | 634 | Markdown datasource (fs/git mocks) |
| `src/tests/auth.test.ts` | 509 | Device-flow auth, token caching |
| `src/tests/datasource-url.test.ts` | 202 | URL parser tests (GitHub + Azure DevOps) |
| `src/tests/datasource-helpers.test.ts` | 1024 | All helper functions |
| `src/tests/branch-validation.test.ts` | 175 | Branch name validation |

**Related docs:**

- [Overview](./overview.md) -- interface contract
- [GitHub datasource](./github-datasource.md)
- [Azure DevOps datasource](./azdevops-datasource.md)
- [Markdown datasource](./markdown-datasource.md)
- [Integrations](./integrations.md) -- authentication and SDK details
- [Datasource helpers](./datasource-helpers.md)
- [Datasource test file documentation](../testing/datasource-tests.md) -- test file reference in the testing section
- [Azure DevOps Datasource Tests](../testing/azdevops-datasource-tests.md) -- test coverage for Azure DevOps datasource
- [Markdown Datasource Tests](../testing/md-datasource-tests.md) -- test coverage for Markdown datasource

## Why it exists

SDK-based integrations require different mocking strategies than CLI-based
tests. Each SDK has its own mock pattern, and tests must verify that the
datasource code correctly calls SDK methods, handles pagination, processes
errors, and normalizes responses into `IssueDetails` objects.

## How it works

### Mock patterns

#### Octokit mock (GitHub)

Tests mock the `@octokit/rest` module and the auth helper:

```
vi.mock("@octokit/rest")
vi.mock("../helpers/auth.js", () => ({ getGithubOctokit: vi.fn() }))
```

The mock Octokit instance provides:

- `octokit.rest.issues.get` -- returns a single issue
- `octokit.rest.issues.listForRepo` -- returns issues for pagination
- `octokit.rest.issues.listComments` -- returns comments
- `octokit.rest.issues.create` -- returns created issue
- `octokit.rest.issues.update` -- void
- `octokit.rest.pulls.create` -- returns PR data
- `octokit.rest.pulls.list` -- returns existing PRs (duplicate handling)
- `octokit.paginate` -- wraps list calls to simulate pagination

Tests also mock `child_process.execFile` for git commands and the
`getGitRemoteUrl` / `parseGitHubRemoteUrl` functions from the index module.

Key test scenarios:

- CRUD operations with correct Octokit method calls
- Pull request creation and duplicate PR handling (422 `RequestError`)
- `ownerRepoCache` caching behavior (exported for test access)
- Branch operations (create, switch, worktree recovery)
- `getCommitMessages()` extraction
- Credential redaction in error messages

#### azure-devops-node-api mock (Azure DevOps)

Tests mock the Azure DevOps SDK and auth helper:

```
vi.mock("azure-devops-node-api")
vi.mock("../helpers/auth.js", () => ({ getAzureConnection: vi.fn() }))
```

The mock `WebApi` connection provides:

- `getWorkItemTrackingApi()` returning a mock WIT API with:
  - `getWorkItem` -- returns a single work item
  - `getWorkItems` -- returns batch of work items
  - `createWorkItem` -- returns created work item
  - `updateWorkItem` -- void
  - `queryByWiql` -- returns WIQL query results
  - `getComments` -- returns work item comments
  - `getWorkItemTypes` -- returns available types
  - `getWorkItemTypeStates` -- returns states for done-state detection
- `getGitApi()` returning a mock Git API with:
  - `getRepositories` -- returns repos for URL matching
  - `createPullRequest` -- returns PR data
  - `getPullRequests` -- returns existing PRs (duplicate handling)

Key test scenarios:

- CRUD operations with correct SDK method calls
- `null as any` for `customHeaders` parameter
- `detectWorkItemType()` with preference ordering
- `detectDoneState()` with category detection, fallback names, and caching
- `doneStateCache` behavior (not caching default "Closed")
- WIQL query construction with iteration/area filters
- `@CurrentIteration` macro handling (no quotes)
- Bounded concurrency for comment fetching (batches of 5)
- Batch `getWorkItems` failure with fallback to individual fetches
- PR creation with repo URL matching and normalization
- Branch name pre-validation with `InvalidBranchNameError`
- Duplicate PR handling ("already exists" message)
- Credential redaction

#### fs/git mock (Markdown)

Tests mock `node:fs/promises` and `child_process.execFile`:

```
vi.mock("node:fs/promises")
vi.mock("node:child_process")
```

Key test scenarios:

- File listing and reading from specs directory
- Glob pattern support in `list()`
- Numeric ID resolution (`resolveNumericFilePath`)
- `create()` with `nextIssueId` auto-increment
- `withCreateLock()` serialization of concurrent creates
- `close()` moving files to `archive/` subdirectory
- `extractTitle()` with H1, content line, and filename fallbacks
- File path resolution (absolute, relative, plain)
- `buildBranchName()` with file-path-based issue numbers
- `supportsGit()` returning `true`
- `pushBranch()` and `createPullRequest()` as no-ops

### Authentication tests

`src/tests/auth.test.ts` tests the device-flow authentication system:

- **GitHub auth:** Mocks `createOAuthDeviceAuth` and verifies token caching,
  Octokit instance creation, and `onVerification` callback behavior.
- **Azure auth:** Mocks `DeviceCodeCredential` and verifies token caching
  with expiry, `EXPIRY_BUFFER_MS` (5-minute) refresh logic, and
  `userPromptCallback` with the work/school account note.
- **`ensureAuthReady()`:** Tests pre-authentication routing for each
  datasource type (github, azdevops, md/null).
- **`setAuthPromptHandler()`:** Tests routing of prompts to custom handler
  vs. default `log.info()`.
- **Token persistence:** Verifies `~/.dispatch/auth.json` file writing with
  mode `0o600`, mkdir for `.dispatch` directory, and graceful handling of
  chmod failures.

### URL parser tests

`src/tests/datasource-url.test.ts` tests both URL parsers:

**`parseGitHubRemoteUrl()`:**

- HTTPS format with and without `.git` suffix
- HTTPS with userinfo (`user@github.com`)
- SCP-style SSH (`git@github.com:owner/repo.git`)
- URL-style SSH (`ssh://git@github.com/owner/repo`)
- URL-encoded segments
- Non-GitHub URLs return `null`

**`parseAzDevOpsRemoteUrl()`:**

- HTTPS format (`dev.azure.com/{org}/{project}/_git/{repo}`)
- HTTPS with userinfo
- SSH format (`git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`)
- Legacy format (`{org}.visualstudio.com`)
- Legacy with `DefaultCollection/` prefix
- URL-encoded segments
- Org URL normalization to `https://dev.azure.com/{org}`
- Non-Azure URLs return `null`

### Datasource helper tests

`src/tests/datasource-helpers.test.ts` tests all helper functions:

- **`parseIssueFilename()`:** Valid `{id}-{slug}.md` patterns, invalid patterns,
  full file paths (extracts basename).
- **`fetchItemsById()`:** Comma-separated ID splitting, failure skipping with
  warnings, smart `#` prefix for numeric vs. file-path IDs.
- **`writeItemsToTempDir()`:** File creation, numeric sorting, file-path-based
  `item.number` handling (basename extraction).
- **`getBranchDiff()`:** 10 MB maxBuffer, empty string on failure.
- **`amendCommitMessage()`:** Correct git args, error propagation.
- **`squashBranchCommits()`:** Merge-base resolution, soft reset, new commit.
- **`buildPrBody()`:** Commit summary section, task checkboxes, labels,
  datasource-specific close references (GitHub: `Closes #N`, Azure DevOps:
  `Resolves AB#N`, Markdown: none).
- **`buildPrTitle()`:** No commits (fallback), single commit (use message),
  multiple commits (newest + count).
- **`buildFeaturePrTitle()`:** Single issue (title), multiple issues
  (`feat: {branch} (#{refs})`).
- **`buildFeaturePrBody()`:** Issues section, tasks, per-issue close references.

### Branch validation tests

`src/tests/branch-validation.test.ts` tests `isValidBranchName()`:

- Valid names (alphanumeric, dots, hyphens, underscores, slashes)
- Rejection cases: empty string, >255 chars, leading/trailing slashes,
  `..` sequences, `.lock` suffix, `@{` reflog syntax, `//` empty component,
  spaces, special characters.
- `InvalidBranchNameError` construction and `instanceof` detection.

### Registry and auto-detection tests

`src/tests/datasource.test.ts` includes tests for:

- `getDatasource()` with valid and invalid names
- `detectDatasource()` with GitHub, Azure DevOps, and non-matching URLs
- `DATASOURCE_NAMES` constant
- `deriveShortUsername()` with multi-word names, single names, emails, and
  fallback behavior
