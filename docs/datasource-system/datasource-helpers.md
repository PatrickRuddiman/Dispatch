# Datasource Helpers

## What it does

The datasource helpers module (`src/orchestrator/datasource-helpers.ts`)
provides bridge functions between the orchestrator pipeline and the datasource
layer. It handles issue file I/O, git operations for commit management, and
pull request body/title generation.

**Source:** `src/orchestrator/datasource-helpers.ts` (359 lines)

**Related docs:**

- [Overview](./overview.md) -- datasource interface contract
- [GitHub datasource](./github-datasource.md) -- GitHub close references
- [Azure DevOps datasource](./azdevops-datasource.md) -- Azure DevOps close references
- [Markdown datasource](./markdown-datasource.md) -- file-path-based IDs
- [Testing](./testing.md) -- helper function tests

## Why it exists

The orchestrator needs to perform operations that span multiple datasource
concerns: writing issues to temporary files for agent processing, building PR
titles from git history, and assembling PR bodies with datasource-specific
close references. These functions are extracted into a dedicated module to keep
the orchestrator focused on pipeline logic and the datasources focused on
tracker access.

## How it works

### Exports

The module exports 10 functions and 1 interface:

| Export | Type | Purpose |
|--------|------|---------|
| `parseIssueFilename` | function | Extract ID + slug from `{id}-{slug}.md` filenames |
| `fetchItemsById` | function | Fetch multiple issues, skip failures with warnings |
| `writeItemsToTempDir` | function | Write issues to temp dir as markdown files |
| `getBranchDiff` | function | Get git diff with 10 MB buffer |
| `amendCommitMessage` | function | Amend most recent commit message |
| `squashBranchCommits` | function | Squash branch commits via soft reset |
| `buildPrBody` | function | Assemble PR body with commit summary, tasks, labels |
| `buildPrTitle` | function | Generate PR title from commit messages |
| `buildFeaturePrTitle` | function | Aggregated PR title for multi-issue feature mode |
| `buildFeaturePrBody` | function | Aggregated PR body for multi-issue feature mode |
| `WriteItemsResult` | interface | Return type of `writeItemsToTempDir` |

There is also 1 private helper:

| Helper | Purpose |
|--------|---------|
| `getCommitSummaries` | Get commit subject lines from `{default}..HEAD` |

### Issue file operations

#### `parseIssueFilename(filePath)`

Extracts the issue ID and slug from a `{id}-{slug}.md` filename pattern. Takes
a full file path, extracts the basename, and matches against `/^(\d+)-(.+)\.md$/`.
Returns `{ issueId, slug }` or `null` if the filename does not match.

This function is re-exported from `runner.ts` as a public API for external
consumers.

#### `fetchItemsById(issueIds, datasource, fetchOpts)`

Fetches multiple issues from a datasource by ID:

1. Splits comma-separated IDs (e.g. `"1,2,3"` becomes `["1", "2", "3"]`).
2. Fetches each ID individually via `datasource.fetch()`.
3. On failure, logs a warning and skips the ID.

**Smart `#` prefix logic:** Warning messages for failed fetches use `#` before
the ID for numeric IDs (e.g. `Could not fetch issue #123`) but omit it for
file-path-based IDs (containing `/`, `\`, or ending in `.md`). This produces
natural-looking messages for both GitHub-style (`#123`) and file-path-style
(`path/to/spec.md`) references.

#### `writeItemsToTempDir(items)`

Writes `IssueDetails` items to a temporary directory:

1. Creates a temp directory with prefix `dispatch-` via `mkdtemp()`.
2. For each item, generates `{id}-{slugified-title}.md`.
3. When `item.number` is a file path (contains `/` or `\`), extracts just the
   basename without extension for the ID portion.
4. Sorts files numerically by the leading digits in the filename, falling back
   to lexicographic order for non-numeric prefixes.

Returns a `WriteItemsResult` with `files` (sorted paths) and
`issueDetailsByFile` (Map from path to original `IssueDetails`).

### Git operations

#### `getBranchDiff(defaultBranch, cwd)`

Runs `git diff {defaultBranch}..HEAD` with a `maxBuffer` of 10 MB. Returns the
diff output as a string, or an empty string on failure (errors are silently
caught). Diffs exceeding 10 MB are silently discarded. Uses `shell: true` on
Windows for compatibility.

#### `amendCommitMessage(message, cwd)`

Runs `git commit --amend -m {message}` to change the most recent commit's
message without modifying its content. Errors propagate to the caller.

#### `squashBranchCommits(defaultBranch, message, cwd)`

Squashes all commits on the current branch relative to the default branch into
a single commit:

1. Finds the merge-base via `git merge-base {defaultBranch} HEAD`.
2. Soft-resets to the merge-base: `git reset --soft {mergeBase}`.
3. Creates a new commit: `git commit -m {message}`.

Errors propagate to the caller. This approach avoids interactive rebase
complexity.

#### `getCommitSummaries(defaultBranch, cwd)` (private)

Runs `git log {defaultBranch}..HEAD --pretty=format:%s` to get one-line commit
subject strings. Returns an empty array on failure.

Note: This is distinct from `getCommitMessages()` in `src/datasources/github.ts`,
which uses `origin/{defaultBranch}..HEAD` (includes the `origin/` prefix).

### PR title generation

#### `buildPrTitle(issueTitle, defaultBranch, cwd)`

Generates a PR title from the commit history on the branch:

| Commits | Title |
|---------|-------|
| 0 | Issue title (fallback) |
| 1 | The single commit message |
| 2+ | Newest commit message + ` (+N more)` |

Note: The newest commit is `commits[0]` (git log returns most recent first).

#### `buildFeaturePrTitle(featureBranchName, issues)`

Generates an aggregated PR title for feature mode (multi-issue branches):

| Issues | Title |
|--------|-------|
| 1 | The single issue's title |
| 2+ | `feat: {featureBranchName} (#{num1}, #{num2}, ...)` |

### PR body generation

#### `buildPrBody(details, tasks, results, defaultBranch, datasourceName, cwd)`

Assembles a PR body with the following sections:

1. **Summary:** Commit messages from `getCommitSummaries()`, formatted as a
   bullet list.
2. **Tasks:** Completed tasks shown as `- [x] {text}`, failed tasks as
   `- [ ] {text}`.
3. **Labels:** If the issue has labels, shown as `**Labels:** {labels}`.
4. **Close reference:** Datasource-specific:
   - GitHub: `Closes #{number}`
   - Azure DevOps: `Resolves AB#{number}`
   - Markdown: no close reference

#### `buildFeaturePrBody(issues, tasks, results, datasourceName)`

Assembles an aggregated PR body for feature mode:

1. **Issues:** Lists all issues as `- #{number}: {title}`.
2. **Tasks:** Same checkbox format as `buildPrBody`.
3. **Close references:** One per issue, using the datasource-specific format.

Unlike `buildPrBody()`, the feature body does not include commit summaries
(since the feature branch contains merge commits from multiple issues).

### Cross-pipeline usage

| Function | Dispatch pipeline | Spec pipeline | Runner |
|----------|-------------------|---------------|--------|
| `fetchItemsById()` | Yes | No | Yes |
| `writeItemsToTempDir()` | Yes | No | No |
| `parseIssueFilename()` | Yes | Yes | Re-exported |
| `getBranchDiff()` | Yes | No | No |
| `squashBranchCommits()` | Yes | No | No |
| `buildPrBody()` | Yes | No | No |
| `buildPrTitle()` | Yes | No | No |
| `buildFeaturePrTitle()` | Yes | No | No |
| `buildFeaturePrBody()` | Yes | No | No |

### Dependencies

The module imports from:

- `src/datasources/interface.ts` -- `Datasource`, `DatasourceName`, `IssueDetails`,
  `IssueFetchOptions`
- `src/parser.ts` -- `Task` type
- `src/dispatcher.ts` -- `DispatchResult` type
- `src/helpers/slugify.ts` -- `slugify()`, `MAX_SLUG_LENGTH`
- `src/helpers/logger.ts` -- `log` for warnings and error formatting

## Related documentation

- [Datasource System Overview](./overview.md) -- datasource interface contract
  and auto-detection logic
- [GitHub Datasource](./github-datasource.md) -- GitHub-specific close
  references and PR creation
- [Azure DevOps Datasource](./azdevops-datasource.md) -- Azure DevOps-specific
  close references and PR creation
- [Markdown Datasource](./markdown-datasource.md) -- file-path-based IDs and
  local git lifecycle
- [Orchestrator Pipeline](../cli-orchestration/orchestrator.md) -- how the
  dispatch pipeline uses these helper functions
- [Feature Branch Mode](../dispatch-pipeline/feature-branch-mode.md) -- how
  `buildFeaturePrTitle()` and `buildFeaturePrBody()` are used in multi-issue
  feature branches
- [Commit Agent](../agent-system/commit-agent.md) -- produces `CommitResult`
  consumed by `amendCommitMessage()` and `squashBranchCommits()`
- [Slugify Utility](../shared-utilities/slugify.md) -- filename generation
  used by `writeItemsToTempDir()`
- [Datasource Helpers Tests](../testing/datasource-helpers-tests.md) -- unit
  tests for PR body/title builders, issue filename parsing, and temp file
  writing
- [Integration & E2E Tests](../testing/tests-integration-e2e.md) -- end-to-end
  tests exercising git lifecycle and PR creation across all datasources
