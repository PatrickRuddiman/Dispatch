# Markdown Datasource

## What it does

The Markdown datasource (`src/datasources/md.ts`) reads and writes `.md` files
from a local directory (default: `.dispatch/specs/`), treating each file as a
work item or spec. It enables fully offline, local-first workflows where
markdown files are the source of truth.

**Source:** `src/datasources/md.ts` (348 lines)

**Related docs:**

- [Overview](./overview.md) -- interface contract and shared behaviors
- [GitHub datasource](./github-datasource.md)
- [Azure DevOps datasource](./azdevops-datasource.md)
- [Integrations](./integrations.md) -- git lifecycle details
- [Testing](./testing.md) -- test patterns for this datasource

## Why it exists

Not every project uses a cloud issue tracker. The Markdown datasource allows
Dispatch to operate entirely from local files, making it suitable for personal
projects, prototyping, or air-gapped environments. It uses the same interface
as the cloud datasources, so the pipeline logic works identically.

## How it works

### Directory layout

Specs live in `.dispatch/specs/` relative to the working directory. The
directory is created automatically on `create()`. Closed specs are moved to
`.dispatch/specs/archive/`.

```
.dispatch/
  config.json       # Contains nextIssueId for auto-incrementing
  specs/
    1-add-login.md
    2-fix-bug.md
    archive/
      3-old-feature.md
```

### File naming

Files follow the pattern `{id}-{slugified-title}.md` where `id` is an
auto-incrementing integer managed by `nextIssueId` in `.dispatch/config.json`.

The `toIssueDetails()` helper extracts the numeric ID from the filename using
the pattern `/^(\d+)-/`. If the filename does not match, the full filename is
used as the `number` field.

### CRUD operations

#### `list(opts?)`

Lists all `.md` files in the specs directory, sorted alphabetically.

**Glob pattern support:** If `opts.pattern` is set (string or string array),
the `glob` package is used to match files against the pattern(s) relative to
`opts.cwd`. Only `.md` files from the results are included. This allows
filtering by arbitrary paths outside the default specs directory.

When no pattern is specified, the method reads the default specs directory. If
the directory does not exist, an empty array is returned.

#### `fetch(issueId, opts?)`

Fetches a single spec by its ID or filename:

1. **Numeric ID lookup:** If `issueId` is purely numeric (e.g. `"1"`), scans
   the specs directory for a file matching `{id}-*.md`.
2. **File path resolution:** Falls back to `resolveFilePath()` which handles
   absolute paths, relative paths (containing `/` or `\`), and plain filenames.

#### `create(title, body, opts?)`

Creates a new spec file using `withCreateLock()` to prevent race conditions:

1. Loads `nextIssueId` from `.dispatch/config.json` (defaults to `1`).
2. Generates filename: `{id}-{slugified-title}.md`.
3. Writes the file to the specs directory.
4. Increments `nextIssueId` in the config and saves it.

The `withCreateLock()` function implements an async mutex by chaining promises,
ensuring that concurrent `create()` calls are serialized and never produce
duplicate IDs.

#### `update(issueId, title, body, opts?)`

Resolves the file path via `resolveNumericFilePath()` and writes the new body.
Note: the `_title` parameter is accepted for interface compatibility but is
unused -- only the file body is updated.

#### `close(issueId, opts?)`

Moves the spec file to the `archive/` subdirectory within its parent directory:

1. Resolves the file path via `resolveNumericFilePath()`.
2. Creates the `archive/` directory if it does not exist.
3. Renames (moves) the file into `archive/`.

### File path resolution

Three resolution functions handle the various ways an issue ID can be specified:

**`resolveFilePath(issueId, opts?)`:**

- Appends `.md` if not already present.
- **Absolute paths** (e.g. `/home/user/spec.md`) are returned as-is.
- **Relative paths** containing `/` or `\` are resolved relative to `opts.cwd`
  or `process.cwd()`.
- **Plain filenames** are joined with the specs directory.

**`resolveNumericFilePath(issueId, opts?)`:**

- If `issueId` is purely numeric, scans the specs directory for a file
  matching `{id}-*.md` and returns its path.
- Falls back to `resolveFilePath()` if no match is found or the ID is
  not numeric.

**`resolveDir(opts?)`:**

- Returns `{cwd}/.dispatch/specs`.

### Title extraction

`extractTitle(content, filename)` (exported) extracts a title from markdown
content using a three-tier fallback:

1. **H1 heading:** Matches the first `# Heading` line.
2. **First meaningful content line:** Strips leading markdown prefixes
   (`#`, `>`, `*`, `-`), truncates to approximately 80 characters at a word
   boundary.
3. **Filename:** Uses the filename without the `.md` extension.

### Git lifecycle

#### `supportsGit()`

Returns `true`. The Markdown datasource supports local git operations for
branching, committing, and switching branches.

#### `getUsername(opts)`

Checks `opts.username` first. Falls back to `deriveShortUsername(opts.cwd, "local")`.
Note: the fallback is `"local"` (not `"unknown"` as in GitHub/Azure DevOps).

#### `getDefaultBranch(opts)` / `getCurrentBranch(opts)`

Shared behavior described in the [overview](./overview.md#default-branch-detection).
`getCurrentBranch()` uses `exec` directly rather than the `git()` helper but
has identical logic.

#### `buildBranchName(issueNumber, title, username)`

Produces `{username}/dispatch/issue-{issueNumber}` for simple IDs. Has special
handling for file-path-based issue numbers:

- If `issueNumber` contains `/` or `\`, extracts the basename.
- If the basename matches `{digits}-{slug}.md`, uses
  `{username}/dispatch/issue-{digits}`.
- Otherwise, uses `{username}/dispatch/file-{slugified-basename}` (slug
  limited to 50 characters).

#### `createAndSwitchBranch(branchName, opts)`

Shared worktree recovery logic. See
[overview](./overview.md#worktree-conflict-recovery). Unlike Azure DevOps, does
NOT pre-validate the branch name.

#### `switchBranch(branchName, opts)`

Runs `git checkout {branchName}`.

#### `pushBranch(branchName, opts)`

**No-op:** returns silently without pushing. The Markdown datasource operates
locally and has no remote to push to.

#### `commitAllChanges(message, opts)`

Shared staging behavior. See [overview](./overview.md#commit-staging).

#### `createPullRequest(...)`

**No-op:** returns an empty string `""`. The Markdown datasource does not
create pull requests.

### Error handling

| Scenario | Behavior |
|----------|----------|
| Specs directory does not exist | `list()` returns empty array |
| File not found | `readFile` throws `ENOENT` |
| Numeric ID not found | Falls back to `resolveFilePath()` |
| Concurrent `create()` calls | Serialized via `withCreateLock()` mutex |
| No `config.json` | `loadConfig()` returns defaults; `nextIssueId` starts at 1 |

## Related Documentation

- [Datasource System Overview](./overview.md) — interface contract and shared behaviors
- [GitHub Datasource](./github-datasource.md) — cloud datasource using GitHub Issues/PRs
- [Azure DevOps Datasource](./azdevops-datasource.md) — cloud datasource using Azure DevOps Work Items
- [Datasource Integrations](./integrations.md) — git lifecycle and authentication details
- [Datasource Helpers](./datasource-helpers.md) — shared git and PR utilities used across datasources
- [Datasource Testing](./testing.md) — test patterns for datasources
- [Config Tools](../mcp-tools/config-tools.md) — MCP tools that read/write `.dispatch/config.json` (including `nextIssueId`)
- [Configuration](../cli-orchestration/configuration.md) — full config system documentation
- [Git & Worktree Overview](../git-and-worktree/overview.md) — worktree conflict recovery referenced in `createAndSwitchBranch`
- [Task Parsing Overview](../task-parsing/overview.md) — how spec files are parsed into tasks for the dispatch pipeline
- [Shared Utilities Overview](../shared-utilities/overview.md) — `slugify()` and other helpers used by this datasource
- [Datasource Tests](../testing/datasource-tests.md) — test suite covering datasource behaviors
