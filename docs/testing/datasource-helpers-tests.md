# Datasource Helpers Tests

Tests for the orchestrator-level datasource helper functions (`src/orchestrator/datasource-helpers.ts`), covering issue filename parsing, batch item fetching, temporary file writing, PR title/body generation, git diff retrieval, and commit manipulation.

**Test file:** `src/tests/datasource-helpers.test.ts` (1024 lines, 10 describe blocks)

## What is tested

The datasource helpers bridge the gap between raw datasource operations and the dispatch orchestrator. They handle file I/O for temporary spec files, construct PR content with platform-specific close references, and provide git utilities for branch comparison and commit squashing.

## parseIssueFilename

Parses a file path to extract the issue ID and slug from the `{id}-{slug}.md` naming convention.

### Filename convention

Files written by Dispatch follow the pattern `{numericId}-{kebab-case-slug}.md`:

- `42-add-user-auth.md` -> `{ issueId: "42", slug: "add-user-auth" }`
- `007-bond-feature.md` -> `{ issueId: "007", slug: "bond-feature" }`
- `5-x.md` -> `{ issueId: "5", slug: "x" }`
- `42-fix-v1.2-bug.md` -> `{ issueId: "42", slug: "fix-v1.2-bug" }` (dots preserved)

Returns `null` for:
- No numeric prefix: `my-feature.md`
- No slug after ID: `42.md`
- Non-`.md` extension: `42-feature.txt`, `10-config.json`, `10-notes.markdown`
- Empty string, directory paths, missing dash separator, filename with no extension

See: `src/tests/datasource-helpers.test.ts:98-205`

## fetchItemsById

Fetches multiple issues by ID using a datasource's `fetch` method. Supports comma-separated IDs, trims whitespace, filters empty strings, and handles failures gracefully.

### Key behaviors

- Splits comma-separated input: `["10,20,30"]` becomes three separate fetches
- Trims whitespace: `"  5 , 6 "` fetches IDs "5" and "6"
- Filters empties: `"7,,"` produces one fetch for ID "7"
- Failed fetches are skipped with a warning log (not thrown)
- Non-Error rejections (e.g., string `"network timeout"`) are also handled
- Returns empty array when all fetches fail or input is empty

### Warning message formatting

The warning prefix for failed fetches depends on the ID format:

| ID format | Warning format |
|-----------|---------------|
| Numeric: `"42"` | `Could not fetch issue #42: ...` |
| File path: `/home/user/specs/task.md` | `Could not fetch issue /home/user/specs/task.md: ...` (no `#` prefix) |
| Windows path: `C:\Users\specs\task.md` | `Could not fetch issue C:\Users\specs\task.md: ...` (no `#` prefix) |
| `.md` extension: `task-name.md` | `Could not fetch issue task-name.md: ...` (no `#` prefix) |

See: `src/tests/datasource-helpers.test.ts:209-394`

## writeItemsToTempDir

Writes an array of `IssueDetails` to temporary files in a system temp directory and returns both the file paths and a mapping from file path to `IssueDetails`.

### File naming

- Slug is created by lowercasing the title and replacing non-alphanumeric characters with hyphens
- Leading/trailing hyphens are trimmed
- Slug is truncated to 60 characters
- Files are sorted by numeric prefix in the output

Examples:
- `{ number: "42", title: "Add User Auth" }` -> `42-add-user-auth.md`
- `{ number: "10", title: "Fix Bug #123 (Urgent!)" }` -> `10-fix-bug-123-urgent.md`
- `{ number: "5", title: "---Special---" }` -> `5-special.md`

### Path sanitization

When `item.number` is a file path (absolute or relative), it is sanitized to just the basename for the temp file:

| Input `number` | Resulting filename |
|---------------|--------------------|
| `"42"` | `42-some-issue.md` |
| `/home/user/.dispatch/specs/batch-updates.md` | `batch-updates-batch-updates.md` |
| `.dispatch/specs/my-spec.md` | `my-spec-my-spec.md` |
| `batch-updates.md` | `batch-updates-batch-updates.md` |

See: `src/tests/datasource-helpers.test.ts:398-665`

## PR title and body generation

### buildPrTitle

Generates the PR title from git commit history:

1. Run `git log {base}..HEAD --pretty=format:%s`
2. If no commits (error or empty output): use the issue title
3. If one commit: use that commit message as the title
4. If multiple commits: use the oldest commit message with `(+N more)` suffix

Example: Three commits `["fix edge case", "add login", "scaffold auth"]` -> `"scaffold auth (+2 more)"`

See: `src/tests/datasource-helpers.test.ts:669-710`

### buildPrBody

Generates the full PR description with sections:

```markdown
## Summary

- feat: add login
- feat: add signup

## Tasks

- [x] Task one
- [ ] Task two

**Labels:** bug, urgent

Closes #42
```

#### Platform-specific close references

| Datasource | Close reference |
|------------|-----------------|
| `github` | `Closes #42` |
| `azdevops` | `Resolves AB#42` |
| `md` | None |

#### Edge cases

- Git log failure: Summary section is omitted, Tasks section still present
- No tasks: Tasks section omitted
- Empty labels: Labels line omitted

See: `src/tests/datasource-helpers.test.ts:714-829`

### buildFeaturePrTitle

For multi-issue feature branches (dispatching multiple issues on one branch):

- Single issue: use the issue title directly
- Multiple issues: `feat: {branchName} (#10, #11, #12)`

See: `src/tests/datasource-helpers.test.ts:833-858`

### buildFeaturePrBody

For multi-issue feature branches:

- Issues section listing all issues as `- #{number}: {title}`
- Tasks section (same as single-issue)
- Multiple close references, one per issue

See: `src/tests/datasource-helpers.test.ts:862-933`

## Git utilities

### getBranchDiff

Runs `git diff {base}..HEAD` with a 10 MB `maxBuffer`. Returns empty string on failure or when there are no differences.

See: `src/tests/datasource-helpers.test.ts:937-967`

### amendCommitMessage

Runs `git commit --amend -m "{message}"`. Propagates git errors.

See: `src/tests/datasource-helpers.test.ts:971-989`

### squashBranchCommits

Squashes all commits on the current branch since diverging from the base branch:

1. `git merge-base {base} HEAD` -- find the common ancestor
2. `git reset --soft {mergeBase}` -- un-commit all branch changes while keeping them staged
3. `git commit -m "{message}"` -- create a single squashed commit

Propagates errors from any step.

See: `src/tests/datasource-helpers.test.ts:993-1024`

## Mock infrastructure

The test file creates its own `createMockDatasource` helper (separate from `src/tests/fixtures.ts`) with all `Datasource` interface methods stubbed via `vi.fn()`. It also defines a `createIssueDetails` helper for creating test fixtures with sensible defaults.

Git operations are mocked via `vi.mock("node:child_process")` and `vi.mock("node:util")`, replacing `execFile` with a controllable mock function.

## Related documentation

- [Datasource test suite overview](./datasource-tests.md) -- group overview
  for all datasource-related test files
- [Test suite overview](./overview.md) -- framework, patterns, and coverage map
- [Test fixtures and mocks](./test-fixtures.md) -- shared mock factories
  and manual mock stubs
- [Datasource system overview](../datasource-system/overview.md) -- the
  `Datasource` interface and registry these helpers bridge
- [Datasource integrations](../datasource-system/integrations.md) -- SDK
  and git CLI integration details consumed by the helpers
- [Datasource helpers](../datasource-system/datasource-helpers.md) --
  production documentation for the module under test
- [Orchestrator integrations](../orchestrator/integrations.md) -- how the
  orchestrator uses datasource helpers and git operations
- [Dispatch pipeline lifecycle](../dispatch-pipeline/pipeline-lifecycle.md) --
  the pipeline that invokes datasource helper functions
- [Commit agent tests](./commit-agent-tests.md) -- tests for the commit
  agent that consumes PR title/body from these helpers
- [Git & Worktree overview](../git-and-worktree/overview.md) -- git worktree
  context for branch diff and squash operations
