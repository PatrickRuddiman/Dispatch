# Integrations

The orchestrator modules depend on several external libraries and Node.js
built-in APIs. This page documents each integration, its role in the
orchestrator, and operational considerations.

## External dependencies

### Git (via `child_process.execFile`)

**Used by**: `datasource-helpers.ts`, `dispatch-pipeline.ts`

Git is invoked via `child_process.execFile()` (promisified) for:

- `git log` — retrieving commit summaries for PR bodies
- `git diff` — capturing branch diffs for the commit agent
- `git merge-base` — finding the common ancestor for squash operations
- `git reset --soft` — staging squash commits
- `git commit` — creating squash and amend commits
- `git merge --no-ff` — merging issue branches into feature branches
- `git branch -d` — deleting merged issue branches
- `git merge --abort` — aborting failed merges
- `git rev-parse --git-dir` — detecting whether cwd is a git repo

**Operational notes**:

- All git commands use `shell: true` on Windows (`process.platform === "win32"`)
  for compatibility with Windows paths.
- The `maxBuffer` for `git diff` is set to 10 MB. Diffs exceeding this limit
  cause `execFile` to throw, which is silently caught and returns an empty
  string. This means very large diffs (e.g., generated code, binary files)
  are lost without warning.
- Git operations in worktrees use the worktree's `cwd`, not the main repo root.

### glob (npm package)

**Used by**: `dispatch-pipeline.ts`, `spec-pipeline.ts`

The `glob` package expands file patterns (e.g., `*.md`, `specs/**/*.md`) into
matching file paths. It is used in two contexts:

- **Dispatch pipeline**: `resolveGlobItems()` expands glob patterns from issue
  IDs when the md datasource is active.
- **Spec pipeline**: `resolveFileItems()` expands glob patterns for file-mode
  spec generation.

Both callers use `{ cwd, absolute: true }` options to resolve relative patterns
against the working directory and return absolute paths.

### chalk (npm package)

**Used by**: `dispatch-pipeline.ts`, `spec-pipeline.ts`

Chalk provides terminal color formatting. The orchestrator uses it for:

- Rendering the header banner divider (`chalk.dim("  ─".repeat(24))`)
- The TUI and spec pipeline header output

Chalk auto-detects color support and degrades gracefully in non-color terminals.

### AsyncLocalStorage (Node.js `node:async_hooks`)

**Used by**: `spec-pipeline.ts`, `dispatch-pipeline.ts`

`AsyncLocalStorage` (via `fileLoggerStorage`) provides request-scoped file
logging. Each pipeline run (or per-issue worktree) gets its own `FileLogger`
instance stored in async local storage, enabling concurrent pipeline runs to
maintain isolated log files. See [File Logger](../shared-types/file-logger.md).

## Internal integrations

### Provider system

**Used by**: `dispatch-pipeline.ts`, `spec-pipeline.ts`

- **Dispatch**: Uses [`ProviderPool`](../provider-system/pool-and-failover.md)
  (from `src/providers/pool.ts`) for priority-based failover across configured
  providers. Creates separate pools for planner, executor, and commit agents.
- **Spec**: Uses `bootProvider()` directly (single provider instance).

All pipelines register provider cleanup via [`registerCleanup()`](../shared-types/cleanup.md).

### Agent system

**Used by**: `dispatch-pipeline.ts`, `spec-pipeline.ts`

- **Dispatch**: Boots three agents — planner, executor, and commit — each
  with their own provider pool. Agents are booted per-worktree (when using
  worktrees) or once for all issues (serial mode).
- **Spec**: Boots a single spec agent via `bootSpecAgent()`.

### Datasource system

**Used by**: All pipeline modules

The pipelines use the datasource abstraction for:

- `list()` / `fetch()` — discovering and fetching issues
- `update()` / `create()` — syncing specs and task completion
- `buildBranchName()` — constructing branch names from issue metadata
- `getCurrentBranch()` / `switchBranch()` / `createAndSwitchBranch()` — git
  branch lifecycle
- `commitAllChanges()` / `pushBranch()` / `createPullRequest()` — git publish
  lifecycle
- `getUsername()` — resolving the git username for branch naming
- `supportsGit()` — gating git operations for datasources that may not have
  a git repo (md datasource outside a repo)

### Task parsing

**Used by**: `dispatch-pipeline.ts`

- [`parseTaskFile()`](../task-parsing/overview.md) — extracts unchecked tasks from markdown files
- [`groupTasksByMode()`](../task-parsing/overview.md) — groups tasks by `(P)`/`(S)`/`(I)` mode prefixes
- [`buildTaskContext()`](../planning-and-dispatch/task-context-and-lifecycle.md) — extracts surrounding context from the spec file for
  the planner agent

### Helper utilities

**Used by**: All pipeline modules

| Utility | Module | Usage |
|---------|--------|-------|
| [`withTimeout()`](../shared-utilities/overview.md) | `helpers/timeout.ts` | Bounds planning and fetch durations |
| [`withRetry()`](../shared-utilities/overview.md) | `helpers/retry.ts` | Retries agent calls on failure |
| [`runWithConcurrency()`](../shared-utilities/overview.md) | `helpers/concurrency.ts` | Sliding-window task/issue processing |
| `createWorktree()` / `removeWorktree()` | [`helpers/worktree.ts`](../git-and-worktree/overview.md) | Worktree lifecycle |
| [`registerCleanup()`](../shared-types/cleanup.md) | `helpers/cleanup.ts` | Signal-aware resource teardown |
| [`checkPrereqs()`](../prereqs-and-safety/prereqs.md) | `helpers/prereqs.ts` | Prerequisite validation |
| `confirmLargeBatch()` | `helpers/confirm-large-batch.ts` | User confirmation for large batches |
| `ensureGitignoreEntry()` | `helpers/gitignore.ts` | `.gitignore` management |
| [`ensureAuthReady()`](../git-and-worktree/authentication.md) | `helpers/auth.ts` | Pre-authentication before TUI |
| [`slugify()`](../shared-utilities/slugify.md) | `helpers/slugify.ts` | Filename slug generation |
| [`elapsed()`](../shared-types/format.md) / [`renderHeaderLines()`](../shared-types/format.md) | `helpers/format.ts` | Duration formatting and banner rendering |

## Configuration system integration

The orchestrator integrates with the configuration system at two levels:

1. **CLI config resolution** (`cli-config.ts`): Loads `{cwd}/.dispatch/config.json`
   and merges values beneath CLI flags. See [CLI Config](cli-config.md).
2. **Per-agent config resolution** (`config.ts`): The dispatch pipeline calls
   `resolveAgentProviderConfig()` to determine each agent's provider and model
   using the three-tier priority: `agents.<role>` > `fastProvider`/`fastModel`
   (planner/commit) > top-level `provider`/`model`.

## File system paths

| Path | Purpose |
|------|---------|
| `{cwd}/.dispatch/config.json` | Persistent project config |
| `{cwd}/.dispatch/specs/` | Default output directory for generated specs |
| `{cwd}/.dispatch/worktrees/` | Worktree directory (gitignored) |
| `{cwd}/.dispatch/dispatch.db` | SQLite database for run state |
| `~/.dispatch/auth.json` | Authentication tokens (user-level) |
| `{tmpdir}/dispatch-{random}/` | Temp directory for fetched issue files |

## Related documentation

- [Orchestrator Overview](overview.md) -- architecture and module map for the
  orchestrator layer
- [Dispatch Pipeline Lifecycle](../dispatch-pipeline/pipeline-lifecycle.md) --
  end-to-end dispatch pipeline flow that consumes these integrations
- [Spec Generation Overview](../spec-generation/overview.md) -- spec pipeline
  that uses provider, agent, and datasource integrations
- [Provider System Overview](../provider-system/overview.md) -- provider
  interface and pool/failover architecture
- [Provider Pool & Failover](../provider-system/pool-and-failover.md) --
  `ProviderPool` priority-based failover used by the dispatch pipeline
- [Agent System Overview](../agent-system/overview.md) -- agent boot and
  lifecycle framework
- [Datasource System Overview](../datasource-system/overview.md) -- datasource
  abstraction layer consumed by all pipelines
- [Task Parsing Overview](../task-parsing/overview.md) -- `parseTaskFile`,
  `groupTasksByMode`, and `buildTaskContext` used by the dispatch pipeline
- [Shared Utilities Overview](../shared-utilities/overview.md) -- `withTimeout`,
  `withRetry`, `runWithConcurrency`, `slugify`, and other helpers
- [Shared Utilities: Errors](../shared-utilities/errors.md) -- custom error
  types used across helper modules
- [Git & Worktree Overview](../git-and-worktree/overview.md) -- git CLI
  integration and worktree lifecycle
- [Git Authentication](../git-and-worktree/authentication.md) -- pre-auth
  flow referenced by `ensureAuthReady()`
- [CLI Config](cli-config.md) -- configuration resolution layer
- [Prerequisites & Safety](../prereqs-and-safety/prereqs.md) -- `checkPrereqs`
  validation
- [Cleanup Registry](../shared-types/cleanup.md) -- `registerCleanup` teardown
  system
- [File Logger](../shared-types/file-logger.md) -- `AsyncLocalStorage`-based
  per-run logging
- [Format Utilities](../shared-types/format.md) -- `elapsed` and
  `renderHeaderLines` formatting helpers
- [Architecture Overview](../architecture.md) -- system-wide design context
