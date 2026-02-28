# Datasource System Testing

The datasource system test suite is located at `src/tests/datasource.test.ts`
(300 lines). It uses Vitest with real filesystem I/O (no mocks) and covers
three areas: the [markdown datasource](./markdown-datasource.md) operations, configuration validation for
datasource names, and the [datasource registry](./overview.md#the-datasource-registry).

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
| Extracts title from first H1 heading | `extractTitle()` regex matching |
| Falls back to filename as title when no H1 heading | Fallback to filename stem |
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
| getDatasource returns objects that satisfy the Datasource interface | All five methods (`list`, `fetch`, `update`, `close`, `create`) are functions |
| getDatasource throws for unknown datasource name | Error message includes "Unknown datasource" |

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

The [`detectDatasource()`](./overview.md#auto-detection) function is not directly tested. It would require
either a git repository with a known remote URL or mocking of the `git`
subprocess.

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

### No mocking

The test suite does not use `vi.mock()`, `vi.spyOn()`, or any other mocking
mechanism. All tests operate against the real filesystem. The GitHub and Azure
DevOps datasources are only tested indirectly through the registry tests
(verifying they are registered and have the correct interface shape).

## Running the tests

```sh
npx vitest run src/tests/datasource.test.ts
```

Or run all tests:

```sh
npx vitest run
```

The datasource tests do not require any external tools, network access, or
special configuration. They rely solely on the local filesystem via temporary
directories.

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
- [Spec Generator Tests](../testing/spec-generator-tests.md) -- Tests for the
  spec pipeline that consumes datasource output
