# Integrations & Troubleshooting

This document covers the external integrations used by the planning and dispatch
pipeline: the Git CLI (including worktrees and squash operations), Node.js
`child_process`, Node.js `fs`, Node.js `os.tmpdir()`, the provider system,
and chalk for terminal styling. For each integration, it explains how to access,
query, monitor, and troubleshoot it.

## Git CLI

**Used in**: `src/git.ts:5-9, 14-26, 68-70`
**Official documentation**: [git-scm.com/doc](https://git-scm.com/doc)

The pipeline invokes git as an external process via Node.js `execFile`. Three
git commands are used:

| Command | Purpose | Called from |
|---------|---------|------------|
| `git add -A` | Stage all working directory changes | `src/git.ts:16` |
| `git diff --cached --stat` | Check if anything is staged | `src/git.ts:19` |
| `git commit -m <msg>` | Create a conventional commit | `src/git.ts:25` |

### How `git add -A` interacts with `.gitignore`

`git add -A` stages all tracked and untracked files in the working directory,
respecting `.gitignore` rules. Files matching `.gitignore` patterns are
excluded from staging. This means:

- Build outputs, `node_modules/`, and other ignored paths are correctly
  excluded even if the AI agent creates or modifies files in those locations
- If an agent-generated file should be tracked but matches a `.gitignore`
  pattern, it will be silently excluded from the commit
- To check what would be staged: `git status --short` before running dispatch

### Troubleshooting commit failures

#### Pre-commit hook failures

If the repository uses pre-commit hooks (e.g., via Husky, lint-staged), the
hook runs on every `git commit` call. If the hook fails:

- The commit is rejected
- The error propagates up through the pipeline
- The task is reported as failed

**To debug**:

1. Check the hook output in the error message
2. Run the hook manually: `npx husky run pre-commit`
3. Temporarily disable hooks: set `HUSKY=0` in the environment before running
   dispatch

**Note**: The current implementation does not pass `--no-verify` to
`git commit`. Adding this flag would require modifying the `commitTask`
function in `src/git.ts:25`.

#### GPG signing failures

If `commit.gpgsign` is enabled in git config:

- The commit will fail if the GPG key is not available or the passphrase
  prompt times out (no TTY in automated mode)
- Error: `error: gpg failed to sign the data`

**To resolve**:

1. Disable signing for the dispatch run: `git config --local commit.gpgsign false`
2. Or configure a GPG agent with a cached passphrase
3. Or use SSH signing which may not require interactive prompts

#### Lock file conflicts

If another git process is running (or a previous process crashed):

- Error: `fatal: Unable to create '.git/index.lock': File exists`

**To resolve**:

1. Ensure no other git processes are running
2. Remove the stale lock: `rm .git/index.lock`
3. Avoid running multiple dispatch instances on the same repository

#### Dirty working directory

If the working directory has uncommitted changes when dispatch starts, those
changes will be included in the first task's commit. If there are merge
conflicts, `git commit` will fail.

**Recommendation**: Always start from a clean working directory:

```bash
git status  # verify clean
dispatch "tasks/**/*.md"
```

### Conventional commit message format

Commit messages follow the
[Conventional Commits specification](https://www.conventionalcommits.org/):

```
<type>: <description>
```

The `<type>` is inferred from task text (see [Git Operations](./git.md#commit-type-inference)).
The `<description>` is the [task text](../task-parsing/overview.md), truncated to 60 characters with `...`
appended if necessary. No scope, body, or footer is generated.

The type cannot be overridden by the task author. To control the commit type,
word the task text to begin with the desired type keyword (e.g., "fix the login
bug" produces `fix:`, "add user endpoint" produces `feat:`).

## Node.js child_process (execFile)

**Used in**: `src/git.ts:5, 9, 68-70`
**Official documentation**: [Node.js child_process.execFile](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)

The pipeline uses `util.promisify(execFile)` to run git commands. Key
characteristics. For subprocess timeout concerns, see also the
[`withTimeout()` utility](../shared-utilities/timeout.md):

- **No shell**: `execFile` spawns the git binary directly, avoiding shell
  injection risks
- **Buffered output**: Both stdout and stderr are buffered in memory until the
  process exits
- **Default `maxBuffer`**: 1,048,576 bytes (1 MB) for both stdout and stderr

### Maximum buffer size

If a git command produces more than 1 MB of output, `execFile` will:

1. Kill the child process with `SIGTERM`
2. Reject the promise with an error: `maxBuffer length exceeded`

**In practice**, the three git commands used by the pipeline produce minimal
output:

- `git add -A`: No stdout
- `git diff --cached --stat`: Summary lines only (not full diff content)
- `git commit -m`: A one-line confirmation

A buffer overflow would require an extremely large number of changed files in
a single commit. If this becomes an issue, modify the `git()` helper in
`src/git.ts:68` to pass `{ maxBuffer: 10 * 1024 * 1024 }` (10 MB) as an
option.

### Debugging git commands

The pipeline does not log the git commands it executes. To debug:

1. **Add logging**: Modify the `git()` helper in `src/git.ts:68-70` to log
   commands before execution:
   ```typescript
   async function git(args: string[], cwd: string): Promise<string> {
     console.debug(`[git] git ${args.join(' ')} (cwd: ${cwd})`);
     const { stdout } = await exec("git", args, { cwd });
     return stdout;
   }
   ```
2. **Use GIT_TRACE**: Set `GIT_TRACE=1` in the environment before running
   dispatch to get Git's built-in trace output on stderr
3. **Check git reflog**: After a dispatch run, `git reflog` shows all commits
   created, including any that were later amended or reset

### Timeout behavior

The promisified `execFile` does **not** have a default timeout. A hung git
process (e.g., waiting for GPG passphrase input) will block the pipeline
indefinitely.

To add a timeout, modify the `git()` helper to pass the `timeout` option:

```typescript
const { stdout } = await exec("git", args, { cwd, timeout: 30000 });
```

This would kill the git process after 30 seconds with `SIGTERM`.

## Node.js fs (readFile/writeFile)

The parser uses `fs/promises` for reading task files and writing back completed tasks. For detailed coverage of fs/promises usage, edge cases (ENOENT, EACCES, non-atomic writes), troubleshooting steps, and encoding details, see [Shared Types — Node.js fs/promises](../shared-types/integrations.md#nodejs-fspromises).

## Provider system (ProviderInstance interface)

**Used in**: `src/dispatcher.ts:6, 29, 32` and `src/planner.ts:11, 38, 41`
**Interface defined in**: `src/provider.ts`

The pipeline interacts with AI agents through the `ProviderInstance` interface.
See [Provider Abstraction & Backends](../provider-system/provider-overview.md) for complete
documentation of the interface and backend implementations.

### Monitoring provider health

The pipeline does **not** include built-in health monitoring for providers.
To monitor the AI provider during a dispatch run:

- **OpenCode**: Check the OpenCode server logs (typically at
  `~/.opencode/logs/`). If using `--server-url`, ping the server health
  endpoint before running dispatch.
- **Copilot**: Check the Copilot CLI process status. The Copilot SDK starts
  a local CLI server; verify it is running with `ps aux | grep copilot`.

The TUI displays per-task status (planning, running, done, failed) and elapsed
time, which provides indirect visibility into provider responsiveness. See
[Terminal UI](../cli-orchestration/tui.md) for details on the TUI display. A task
stuck in "planning" or "running" for an extended period indicates a provider
that is slow or hung.

### Configuring provider settings

Provider configuration is passed through the [CLI](../cli-orchestration/cli.md#options-reference):

| Setting | CLI flag | Environment variable |
|---------|----------|---------------------|
| Provider selection | `--provider opencode\|copilot` | -- |
| Server URL | `--server-url <url>` | -- |
| API key (Copilot) | -- | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` |
| Working directory | `--cwd <dir>` | -- |

Model selection, timeout limits, and other provider-specific settings are
configured on the provider server side, not through Dispatch.

### In-flight session crashes

**What happens if the provider process crashes mid-task?**

If the backing provider (OpenCode server or Copilot CLI) crashes while a task
is in-flight:

1. The `instance.prompt()` call will reject with a connection error or timeout
2. The error is caught by the dispatcher/planner's try/catch
3. The task is returned as `{ success: false, error: <message> }`
4. The orchestrator marks the task as failed in the TUI
5. Remaining tasks in the batch may also fail if they attempt to use the
   crashed provider

The pipeline does **not** attempt to restart the provider or retry failed tasks.
After a provider crash, the orchestrator calls `instance.cleanup()` during
shutdown, which is designed to be safe to call even if the provider is already
stopped. See [provider cleanup](../provider-system/provider-overview.md#cleanup-and-in-flight-sessions)
for details. The [cleanup registry](../shared-types/cleanup.md) ensures this
teardown runs even if the process exits via signal or unhandled error.

**Recovery**:

1. Restart the provider process manually
2. Re-run dispatch (completed tasks are already marked `[x]` and will be
   skipped)

## Git worktree operations

**Used in**: `src/orchestrator/dispatch-pipeline.ts:16, 250-253` and
`src/helpers/worktree.ts`
**Official documentation**: [git-scm.com/docs/git-worktree](https://git-scm.com/docs/git-worktree)

Git worktrees allow multiple working directories to share a single `.git`
repository. The dispatch pipeline uses worktrees to process multiple issues
in parallel — each issue gets its own worktree with its own branch, avoiding
the branch-switching conflicts that would occur with a single working directory.

### Commands used

| Command | Purpose | Called from |
|---------|---------|------------|
| `git worktree add <path> -b <branch>` | Create a new worktree with a branch | `src/helpers/worktree.ts` (createWorktree) |
| `git worktree remove <path>` | Remove a worktree after processing | `src/helpers/worktree.ts` (removeWorktree) |

### When worktrees are used

The pipeline activates worktree mode when all three conditions are true:
`!noWorktree && !noBranch && tasksByFile.size > 1`
(`src/orchestrator/dispatch-pipeline.ts:186`). See
[Orchestrator — Worktree-based parallel execution](../cli-orchestration/orchestrator.md#worktree-based-parallel-execution)
for the full decision flowchart.

### Per-worktree resource isolation

Each worktree gets its own:

- `ProviderInstance` (booted with `cwd` set to the worktree path)
- `PlannerAgent`, `ExecutorAgent`, and `CommitAgent`
- Independent cleanup registration via `registerCleanup()`

This isolation means a provider crash in one worktree does not affect other
worktrees. However, it also means N issues require N provider instances,
which may increase memory usage and API rate limit pressure.

### Troubleshooting worktree issues

- **Stale worktrees**: If the process is killed before cleanup runs,
  orphaned worktree directories may remain. List them with `git worktree list`
  and remove with `git worktree remove <path>` or `git worktree prune`.
- **Lock conflicts**: Git uses lock files per-worktree. If a worktree
  operation fails with a lock error, check for stale `.git/worktrees/<name>/locked`
  files.
- **Disk space**: Each worktree is a full checkout. Large repositories may
  consume significant disk space when processing many issues in parallel.

## Squash via soft reset

**Used in**: `src/orchestrator/datasource-helpers.ts:210-223`

After all tasks for an issue complete, the commit agent rewrites the branch's
commit history into a single squashed commit. This uses a `git merge-base` +
`git reset --soft` + `git commit` strategy rather than interactive rebase:

| Step | Command | Purpose |
|------|---------|---------|
| 1 | `git merge-base <default> HEAD` | Find the common ancestor | 
| 2 | `git reset --soft <merge-base>` | Move HEAD back, keeping all changes staged |
| 3 | `git commit -m <message>` | Create a single commit with all changes |

### Why soft reset instead of interactive rebase

- **Simpler**: No editor interaction or todo-list processing required
- **Deterministic**: No conflict resolution needed (all changes are already
  on the branch)
- **Fast**: Three commands instead of a multi-step rebase sequence

### Troubleshooting squash failures

If the squash fails (e.g., empty diff, detached HEAD), the error is caught
and logged as a warning (`src/orchestrator/dispatch-pipeline.ts:479`). The
pipeline continues with the original commit history — the PR is still created
with the unsquashed commits.

## chalk (terminal styling)

**Used in**: `src/orchestrator/dispatch-pipeline.ts:35-36`
**Official documentation**: [github.com/chalk/chalk](https://github.com/chalk/chalk)

The dispatch pipeline imports chalk for colored terminal output. Chalk
automatically detects terminal color support and degrades gracefully:

- **True color terminals**: Full RGB colors
- **256-color terminals**: Closest ANSI 256-color approximation
- **Basic terminals**: 16-color ANSI
- **No color support** (e.g., piped output, `NO_COLOR` env var): Plain text

### Disabling colors

Set `NO_COLOR=1` or `FORCE_COLOR=0` in the environment to disable chalk
output. This is useful for CI pipelines or when piping dispatch output to a
file. Chalk respects the [NO_COLOR](https://no-color.org/) convention.

### Where chalk is used in the pipeline

Chalk is used by the `renderHeaderLines()` function
(`src/helpers/format.ts`) to style the pipeline header displayed at
startup. The TUI module (`src/tui.ts`) also uses chalk for status
coloring. The pipeline itself imports chalk at
`src/orchestrator/dispatch-pipeline.ts:35` for header rendering.

## Node.js os.tmpdir()

**Used in**: `src/orchestrator/datasource-helpers.ts` (via `mkdtemp`)
**Official documentation**: [Node.js os.tmpdir](https://nodejs.org/api/os.html#ostmpdir)

The pipeline creates temporary directories for spec files using
`mkdtemp(join(tmpdir(), "dispatch-"))`. This creates directories like
`/tmp/dispatch-abc123/` on Linux/macOS or
`C:\Users\<user>\AppData\Local\Temp\dispatch-abc123\` on Windows.

### Temp directory lifecycle

1. **Created**: At the start of the pipeline via `writeItemsToTempDir()`
   (`src/orchestrator/datasource-helpers.ts`)
2. **Populated**: Each discovered work item is written as a markdown file
   using the pattern `<issueId>-<slug>.md`
3. **Read**: The pipeline parses tasks from these files
4. **NOT cleaned up**: There is no explicit cleanup of temp directories
   anywhere in the pipeline. The OS's temp directory purging mechanism
   (e.g., `systemd-tmpfiles` on Linux, reboot on Windows) is relied upon.

### Implications of no cleanup

- Repeated dispatch runs accumulate `dispatch-*` directories in the OS
  temp directory
- On long-running servers, this may consume disk space over time
- To manually clean up: `rm -rf /tmp/dispatch-*` (Linux/macOS)

### Platform differences

| Platform | Default `tmpdir()` | Cleanup mechanism |
|----------|-------------------|-------------------|
| Linux | `/tmp` | `systemd-tmpfiles` or reboot |
| macOS | `/var/folders/.../T` | OS periodic cleanup |
| Windows | `%TEMP%` | Disk Cleanup tool or reboot |

## Related documentation

- [Pipeline Overview](./overview.md) -- How integrations fit into the pipeline
- [Dispatcher](./dispatcher.md) -- Provider interaction during execution
- [Executor Agent](./executor.md) -- Executor agent wrapping dispatch with
  task completion and timing
- [Planner Agent](./planner.md) -- Provider interaction during planning
- [Git Operations](./git.md) -- Detailed git behavior and concurrency concerns
- [Task Context & Lifecycle](./task-context-and-lifecycle.md) -- File system
  operations in the parser
- [Provider Abstraction](../provider-system/provider-overview.md) -- Full provider interface and
  backend details
- [OpenCode Backend](../provider-system/opencode-backend.md) -- OpenCode-specific troubleshooting
- [Copilot Backend](../provider-system/copilot-backend.md) -- Copilot-specific authentication and troubleshooting
- [CLI & Orchestration](../cli-orchestration/overview.md) -- CLI flags and orchestrator loop
- [Cleanup Registry](../shared-types/cleanup.md) -- Process-level cleanup
  that drains provider teardown on exit
- [Shared Types Integrations](../shared-types/integrations.md) -- chalk, Node.js
  fs/promises, and process signal details
- [Testing Overview](../testing/overview.md) -- Test coverage (the dispatch
  pipeline and datasource helpers are tested via `dispatch-pipeline.test.ts`
  and `datasource-helpers.test.ts`; the dispatcher and executor agent are
  tested via [Executor & Dispatcher Tests](../testing/executor-and-dispatcher-tests.md))
- [Datasource Integrations](../datasource-system/integrations.md) -- Similar
  subprocess patterns used by the datasource layer
- [Orchestrator — Worktree Execution](../cli-orchestration/orchestrator.md#worktree-based-parallel-execution)
  -- Decision logic and per-issue processing in worktree mode
- [Datasource Helpers](../datasource-system/datasource-helpers.md) --
  `squashBranchCommits`, `getBranchDiff`, and temp file writing
