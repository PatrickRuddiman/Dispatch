# Datasource System Testing

The datasource system has three test suites:

1. **`src/tests/datasource.test.ts`** (680 lines) -- Uses Vitest with real
   filesystem I/O (no mocks). Covers the [markdown datasource](./markdown-datasource.md)
   CRUD operations, extensive [`extractTitle()`](./markdown-datasource.md#title-extraction)
   unit tests (25+ cases), [configuration validation](../cli-orchestration/configuration.md)
   for datasource names, the [datasource registry](./overview.md#the-datasource-registry),
   and `parseAzDevOpsRemoteUrl` tests (including username prefix URLs).
2. **`src/tests/md-datasource.test.ts`** (98 lines) -- Uses Vitest with
   `vi.mock()` for `node:child_process`. Covers
   [`getUsername()`](./markdown-datasource.md#getusername),
   [`buildBranchName()`](./markdown-datasource.md#buildbranchname-format),
   `getDefaultBranch()`, and all five git lifecycle no-op methods.
3. **`src/tests/datasource-url.test.ts`** (76 lines) -- Uses Vitest to test
   the [`parseAzDevOpsRemoteUrl()`](./integrations.md#azure-devops-remote-url-parsing)
   function. Covers HTTPS, SSH, legacy visualstudio.com, negative cases
   (GitHub URLs, non-Azure URLs, malformed URLs, empty strings), and names
   with hyphens and numbers.

## What is tested

### Markdown datasource -- `list()`

Five tests cover the `list()` operation:

| Test | What it verifies |
|------|-----------------|
| Returns empty array when specs directory does not exist | Graceful handling of missing directory |
| Returns empty array when specs directory is empty | No false positives on empty directory |
| Lists all .md files sorted alphabetically | Alphabetical sort order and correct file discovery |
| Ignores non-.md files | Filter excludes `.txt` and other formats |
| Populates IssueDetails fields correctly | Field mapping: `number`, `title`, `body`, `labels`, `state`, `comments`, `acceptanceCriteria` |

### Markdown datasource -- `fetch()`

Five tests cover the `fetch()` operation:

| Test | What it verifies |
|------|-----------------|
| Fetches a file by name with .md extension | Extension-inclusive ID lookup |
| Fetches a file by name without .md extension | Automatic `.md` extension appending |
| Extracts title from first H1 heading | `extractTitle()` H1 regex matching |
| Falls back to first meaningful line or filename as title when no H1 heading | Three-tier fallback: H1 → first line → filename stem |
| Throws when file does not exist | `ENOENT` propagation for missing files |

### Markdown datasource -- `update()`

Two tests cover the `update()` operation:

| Test | What it verifies |
|------|-----------------|
| Writes new body content to the file | Content replacement |
| Appends .md extension when not provided | Automatic extension handling |

Note: There is no test explicitly verifying that the `_title` parameter is
ignored. This behavior is observable from the "writes new body content" test
(the title parameter is `"ignored title"` / `"ignored"`, but the test only
checks the body content).

### Markdown datasource -- `close()`

Two tests cover the `close()` operation:

| Test | What it verifies |
|------|-----------------|
| Moves file to archive subdirectory | File is removed from source, present in `archive/` with preserved content |
| Creates archive directory if it does not exist | `mkdir({ recursive: true })` behavior |

### Configuration validation -- datasource names

Five tests validate the `validateConfigValue()` function for datasource name
validation:

| Test | What it verifies |
|------|-----------------|
| Accepts 'md' as a valid source | `"md"` passes validation |
| Accepts 'github' as a valid source | `"github"` passes validation |
| Accepts 'azdevops' as a valid source | `"azdevops"` passes validation |
| Rejects unknown source names | `"jira"`, `"linear"`, `"bitbucket"` fail with "Invalid source" |
| Rejects empty string as source | Empty string fails validation |

### DatasourceName and registry

Five tests validate the registry in `src/datasources/index.ts`:

| Test | What it verifies |
|------|-----------------|
| DATASOURCE_NAMES includes all three datasource types | Registry completeness |
| DATASOURCE_NAMES has exactly three entries | No unexpected entries |
| getDatasource returns an object with the correct name for each datasource | Name field matches registration key |
| getDatasource returns objects that satisfy the Datasource interface | All five CRUD methods (`list`, `fetch`, `update`, `close`, `create`) are functions; git lifecycle methods are also present |
| getDatasource throws for unknown datasource name | Error message includes "Unknown datasource" |

### Markdown datasource -- `getUsername()` (md-datasource.test.ts)

Three tests in `src/tests/md-datasource.test.ts` cover the
[`getUsername()`](./markdown-datasource.md#getusername) method using `vi.mock()`
to mock `node:child_process`:

| Test | What it verifies |
|------|-----------------|
| Returns slugified git user name | `"John Doe\n"` becomes `"john-doe"` |
| Returns `"local"` when git returns empty string | Whitespace-only stdout falls back to `"local"` |
| Returns `"local"` when git command fails | Error from `execFile` is caught, returns `"local"` |

### Markdown datasource -- `buildBranchName()` (md-datasource.test.ts)

Two tests cover the branch name construction:

| Test | What it verifies |
|------|-----------------|
| Builds branch name with `username/dispatch/issueNumber-slug` pattern | `buildBranchName("42", "My Feature", "john-doe")` returns `"john-doe/dispatch/42-my-feature"` |
| Builds branch name with provided username | `buildBranchName("99", "Some Task", "local")` returns `"local/dispatch/99-some-task"` |

### Markdown datasource -- `getDefaultBranch()` (md-datasource.test.ts)

One test verifies the hardcoded return value:

| Test | What it verifies |
|------|-----------------|
| Returns `"main"` | Always returns `"main"` without git inspection |

### Markdown datasource -- git lifecycle no-ops (md-datasource.test.ts)

Five tests verify that all git lifecycle methods are no-ops:

| Test | What it verifies |
|------|-----------------|
| `createAndSwitchBranch` resolves to `undefined` | No-op, returns void |
| `switchBranch` resolves to `undefined` | No-op, returns void |
| `pushBranch` resolves to `undefined` | No-op, returns void |
| `commitAllChanges` resolves to `undefined` | No-op, returns void |
| `createPullRequest` resolves to `""` | No-op, returns empty string (5-param signature: branchName, issueNumber, title, body, opts) |

### Azure DevOps URL parsing tests (datasource-url.test.ts)

Eight tests in `src/tests/datasource-url.test.ts` cover the
`parseAzDevOpsRemoteUrl()` function exported from `src/datasources/index.ts`.
These tests validate URL parsing without any mocking or filesystem I/O:

| Test | What it verifies |
|------|-----------------|
| Parses HTTPS dev.azure.com URL | Extracts org and project from `https://dev.azure.com/myorg/my-project/_git/my-repo` |
| Parses SSH dev.azure.com URL | Extracts org and project from `git@ssh.dev.azure.com:v3/myorg/my-project/my-repo` |
| Parses legacy visualstudio.com URL | Extracts org and project from `https://myorg.visualstudio.com/my-project/_git/my-repo` |
| Returns null for GitHub URLs | `https://github.com/user/repo.git` returns `null` |
| Returns null for non-Azure DevOps URLs | `https://gitlab.com/user/repo.git` returns `null` |
| Returns null for malformed Azure DevOps URL missing project | `https://dev.azure.com/orgonly` returns `null` |
| Returns null for empty string | `""` returns `null` |
| Handles org and project names with hyphens and numbers | `my-org` and `my-project-123` are preserved correctly |

Additionally, the normalizing test verifies that legacy `visualstudio.com`
URLs are normalized to `https://dev.azure.com/{org}` org URLs.

#### Test coverage gaps in datasource-url.test.ts

The following scenarios are covered in `datasource.test.ts` but **not** in
`datasource-url.test.ts`:

- **Username prefix HTTPS URL** (`https://user@dev.azure.com/org/project/_git/repo`)
    -- this test exists in `src/tests/datasource.test.ts` but not in the
    dedicated URL test file.

The following scenarios are **not tested anywhere**:

- **Legacy `DefaultCollection` segment** (`https://org.visualstudio.com/DefaultCollection/project/_git/repo`)
    -- the regex supports it via `(?:DefaultCollection\/)?` but no test
    exercises this path.
- **Percent-encoded names** (`https://dev.azure.com/My%20Org/My%20Project/_git/repo`)
    -- `decodeURIComponent` is applied but no test verifies decoding
    behavior.

## What is NOT tested

### GitHub datasource

The [GitHub datasource](./github-datasource.md) has **no unit tests**. All five operations (`list`,
`fetch`, `update`, `close`, `create`) are untested. This is because the
GitHub datasource shells out to the `gh` CLI, which would require either:
- A real GitHub repository with `gh` authenticated (integration test)
- Mocking `execFile` (which the test suite does not do)

### Azure DevOps datasource

The [Azure DevOps datasource](./azdevops-datasource.md) has **no unit tests** for the same reason -- it
requires the `az` CLI with the `azure-devops` extension and a real Azure DevOps
organization.

### Auto-detection (`detectDatasource()`)

The [`detectDatasource()`](./overview.md#auto-detection) function is not
directly unit-tested. It is tested **indirectly** via mocked git remotes in
`src/tests/cli-config.test.ts` and other orchestrator test files, but these
tests mock at the `detectDatasource` import level rather than testing the
function's internal logic (pattern matching, error handling).

### `getGitRemoteUrl()`

The [`getGitRemoteUrl()`](./integrations.md#getgitremoteurl-behavior) function
has **no tests anywhere** in the codebase. Its error-swallowing behavior
(returning `null` on any failure) is untested. Adding tests would require
either a real git repository with a known remote or mocking `execFile`.

### Edge cases not covered

- Markdown `create()` filename collision (overwrite behavior)
- Markdown `close()` archive collision (overwrite behavior)
- Markdown `update()` with non-existent file (ENOENT behavior)
- Markdown `list()` with files that have no `.md` extension but are markdown
- Large file handling (buffer limits)
- Concurrent access to the same spec file

## Test infrastructure

### Temporary directory pattern

All markdown datasource tests follow the same pattern:

1. Create a temporary directory via `mkdtemp(join(tmpdir(), "dispatch-test-"))`.
2. Set up the `.dispatch/specs/` subdirectory structure.
3. Write test fixture files.
4. Run the datasource operation with `{ cwd: tmpDir }`.
5. Assert on the result.
6. Clean up via `rm(tmpDir, { recursive: true, force: true })` in `afterEach`.

This pattern uses real filesystem I/O rather than mocks, which tests the actual
`fs/promises` calls and path resolution logic.

### Mocking strategy

The two test suites use different mocking strategies:

- **`datasource.test.ts`** does not use `vi.mock()`, `vi.spyOn()`, or any
  other mocking mechanism. All tests operate against the real filesystem.
- **`md-datasource.test.ts`** uses `vi.mock("node:child_process")` to mock
  `execFile`, enabling tests for `getUsername()` without requiring a real git
  repository. It uses `vi.clearAllMocks()` in `beforeEach` to reset mocks
  between tests.

The GitHub and Azure DevOps datasources are only tested indirectly through
the registry tests (verifying they are registered and have the correct
interface shape).

## Running the tests

```sh
npx vitest run src/tests/datasource.test.ts
npx vitest run src/tests/md-datasource.test.ts
npx vitest run src/tests/datasource-url.test.ts
```

Or run all three together:

```sh
npx vitest run src/tests/datasource.test.ts src/tests/md-datasource.test.ts src/tests/datasource-url.test.ts
```

Or run all tests:

```sh
npx vitest run
```

The `datasource.test.ts` tests do not require any external tools, network
access, or special configuration -- they rely solely on the local filesystem
via temporary directories. The `md-datasource.test.ts` tests use mocks and
have no external dependencies either. The `datasource-url.test.ts` tests are
pure unit tests with no I/O, mocking, or external dependencies.

## Related documentation

- [Datasource Overview](./overview.md) -- Interface and registry being tested
- [Markdown Datasource](./markdown-datasource.md) -- Implementation details
  for the primary tested datasource
- [GitHub Datasource](./github-datasource.md) -- Untested GitHub
  implementation (shells out to `gh` CLI)
- [Azure DevOps Datasource](./azdevops-datasource.md) -- Untested Azure DevOps
  implementation (shells out to `az` CLI)
- [Testing Overview](../testing/overview.md) -- Project-wide test suite
  documentation
- [Configuration Tests](../testing/config-tests.md) -- Config validation tests
  that also cover datasource name validation
- [Datasource Helpers](./datasource-helpers.md) -- Helper utilities used by
  datasource implementations
- [Shared Utilities Testing](../shared-utilities/testing.md) -- Test patterns
  for the slugify and timeout utilities used by datasources
- [Spec Generator Tests](../testing/spec-generator-tests.md) -- Tests for the
  spec pipeline that consumes datasource output
