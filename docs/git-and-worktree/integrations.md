# Integrations Reference

This document covers the external dependencies used by the git-and-worktree
helper group: the **Git CLI** for worktree operations, **Node.js
`child_process.execFile`** for subprocess management, **Node.js `fs/promises`**
for state persistence and `.gitignore` manipulation, **Node.js
`crypto.randomUUID`** for branch name generation, and **Vitest** for testing.

## Git CLI

- **Binary:** `git` (resolved from `$PATH`)
- **Used in:** `src/helpers/worktree.ts`
- **Minimum version:** Git 2.17 (for `git worktree remove`; `add` available
  since 2.5)
- **Official docs:** [git-scm.com/docs/git-worktree](https://git-scm.com/docs/git-worktree)

### Commands used

| Command | Function | Purpose |
|---------|----------|---------|
| `git worktree add <path> -b <branch>` | `createWorktree` | Create a worktree with a new branch |
| `git worktree add <path> <branch>` | `createWorktree` (fallback) | Create a worktree on an existing branch |
| `git worktree remove <path>` | `removeWorktree` | Remove a clean worktree |
| `git worktree remove --force <path>` | `removeWorktree` (fallback) | Remove a dirty worktree |
| `git worktree prune` | `removeWorktree` | Clean up stale admin files |
| `git worktree list` | `listWorktrees` | List all worktrees for diagnostics |

All commands are executed with `cwd` set to the repository root. This ensures
that git resolves the repository correctly regardless of the caller's working
directory.

### Error messages parsed

The worktree module inspects one error message string: `"already exists"`. This
is the message git outputs when `git worktree add -b <branch>` fails because
the branch already exists. The check uses `String.includes` — it is a substring
match, not an exact comparison. This is robust across git versions because the
core message text has been stable since `git worktree add` was introduced.

### Git's internal locking

When multiple worktree operations run concurrently (as happens with
`Promise.all` in the dispatch pipeline), git uses lock files in
`$GIT_DIR/worktrees/` and `$GIT_DIR/refs/` to serialize access to shared state.
This means:

- Two concurrent `git worktree add` calls with different branch names are safe.
- Two concurrent calls creating the **same** branch would race, but Dispatch
  guarantees unique branch names per issue.
- `git worktree prune` may briefly block if another worktree operation holds
  a lock.

### What happens if git is not installed

The [prerequisite checks](../prereqs-and-safety/integrations.md#git-cli) verify that the `git`
binary is on `$PATH` before the pipeline starts. If git is missing, the
pipeline exits early with an error message. The worktree module itself does not
check for git availability — it relies on the prereq check.

If the prereq check is bypassed (e.g., in tests), `execFile("git", ...)`
throws an `ENOENT` error, which propagates as an unhandled rejection from
`createWorktree`.

If the current working directory is not a git repository, `git worktree add`
fails with `fatal: not a git repository`. This error propagates from
`createWorktree` as a thrown exception. The prerequisite checks validate that
the cwd is a git repository by running `git rev-parse --git-dir` during
startup.

## Node.js child_process (execFile)

- **Module:** `node:child_process` (built-in)
- **Function used:** `execFile` (via `util.promisify`)
- **Used in:** `src/helpers/worktree.ts:10,15`
- **Official docs:** [nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)

### Why execFile instead of exec

The worktree module uses `execFile` rather than `exec`. The key differences:

| Aspect | `execFile` | `exec` |
|--------|-----------|--------|
| Shell invocation | No shell spawned | Runs command in a shell |
| Argument injection | Arguments passed as array — no injection risk | Command string is shell-interpreted |
| Performance | Slightly faster (no shell overhead) | Slightly slower |
| Quoting | Not needed — arguments are passed directly to the process | Shell quoting rules apply |

`execFile` is the correct choice here because:

- Git arguments (paths, branch names) may contain characters that require shell
  escaping. `execFile` avoids this by passing arguments as an array.
- There is no need for shell features (pipes, globbing, redirects).
- The security posture is better: no risk of shell injection via crafted branch
  names or paths.

### Promisification

The module uses `util.promisify(execFile)` to convert the callback-based
`execFile` into a promise-based function. The promisified version:

- Resolves with `{ stdout, stderr }` on exit code 0.
- Rejects with an `Error` that has `stdout`, `stderr`, `code`, and `killed`
  properties on non-zero exit.

The worktree module's internal `git()` helper extracts `stdout` from the
resolved value and returns it. Stderr is ignored on success. On failure, the
full error object (including stderr) is available to catch blocks.

### Buffer limits

`execFile` buffers the entire stdout and stderr in memory. The default
`maxBuffer` is 1 MiB (1024 * 1024 bytes). If a git command produces more
output than this, the promise rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.

For the commands used by the worktree module, this limit is not a concern:

- `git worktree add` and `remove` produce minimal output.
- `git worktree list` output scales with the number of worktrees. At ~100
  bytes per worktree, over 10,000 worktrees would be needed to exceed 1 MiB.
- `git worktree prune` produces no output on success.

### Environment inheritance

`execFile` inherits the parent process's environment by default. This means
git configuration from `$HOME/.gitconfig`, `$GIT_DIR/config`, and environment
variables like `GIT_AUTHOR_NAME` and `GIT_COMMITTER_EMAIL` are all available
to the spawned git process.

The `cwd` option is passed explicitly to ensure git operates in the correct
repository. No other `execFile` options are set — the child process inherits
the parent's `PATH`, `HOME`, and other environment variables.

## Node.js fs/promises

- **Module:** `node:fs/promises` (built-in)
- **Functions used:** `readFile`, `writeFile`, `rename`, `mkdir`
- **Used in:** `src/helpers/run-state.ts:1`, `src/helpers/gitignore.ts:5`
- **Official docs:** [nodejs.org/api/fs.html#promises-api](https://nodejs.org/api/fs.html#promises-api)

### Usage by module

| Module | Functions | Purpose |
|--------|-----------|---------|
| `run-state.ts` | `readFile`, `writeFile`, `rename`, `mkdir` | Load/save state file with atomic writes |
| `gitignore.ts` | `readFile`, `writeFile` | Read and append `.gitignore` entries |

### Atomic writes in run-state

`saveRunState` uses the write-to-temp-then-rename pattern:

1. `mkdir(dir, { recursive: true })` — Ensure `.dispatch/` exists.
2. `writeFile(tmp, data, "utf-8")` — Write to `run-state.json.tmp`.
3. `rename(tmp, target)` — Atomically replace `run-state.json`.

The `rename` system call is atomic on POSIX — it replaces the target file in a
single filesystem operation. If the process crashes between steps 2 and 3, the
`.tmp` file is left on disk but the original state file is intact. On the next
`loadRunState` call, the stale `.tmp` file is ignored (it is never read).

See [Shared Types — Integrations](../shared-types/integrations.md#data-loss-during-writefile)
for a broader discussion of `writeFile` atomicity concerns.

### Non-atomic writes in gitignore

`ensureGitignoreEntry` uses `writeFile` directly (without the temp-then-rename
pattern). This means a crash during the write could leave a truncated
`.gitignore`. The risk is acceptable because:

- `.gitignore` is under version control and can be recovered with
  `git checkout`.
- The operation is a single small write (the full file contents).
- The function is non-fatal by design — a corrupted `.gitignore` does not
  affect task execution.

See [Gitignore Helper — Race condition analysis](./gitignore-helper.md#race-condition-analysis)
for concurrency considerations.

### Error handling patterns

Both modules follow the same convention: catch errors broadly and either return
a default value or log a warning.

| Module | Read error behavior | Write error behavior |
|--------|-------------------|---------------------|
| `run-state.ts` | Returns `null` (treat as no state) | Propagates (unhandled) |
| `gitignore.ts` | Treats as empty file | Logs warning, returns normally |

The asymmetry in `run-state.ts` is intentional: a read failure is recoverable
(re-execute all tasks), but a write failure means state may be lost and should
surface as an error rather than being silently swallowed.

## Node.js crypto.randomUUID

- **Module:** `node:crypto` (built-in)
- **Function used:** `randomUUID()`
- **Used in:** `src/helpers/worktree.ts:12` (imported), `src/helpers/worktree.ts:144`
  (called in `generateFeatureBranchName`)
- **Official docs:**
  [nodejs.org/api/crypto.html#cryptorandomuuidoptions](https://nodejs.org/api/crypto.html#cryptorandomuuidoptions)

### How it is used

`generateFeatureBranchName()` calls `randomUUID()` and extracts the first
8-character hex segment (before the first hyphen) to produce branch names like
`dispatch/feature-a1b2c3d4`.

### Entropy and collisions

Only 8 hex characters (32 bits) of the full 128-bit UUID are used. The birthday
bound for 32-bit values is approximately 65,000 — meaning collisions become
likely after generating ~65,000 feature branches. Since Dispatch branches are
ephemeral and cleaned up regularly, the active set is typically well under 100,
making collisions negligible in practice.

### Runtime requirements

`crypto.randomUUID()` was added in Node.js 19.0.0 as a stable API (it was
available behind a flag since Node.js 14.17.0 via the Web Crypto API). The
project's minimum Node.js version requirement covers this. No polyfill is
needed.

## Vitest (test framework)

- **Module:** `vitest`
- **Used in:** All three test files in this group:
    - `src/tests/branch-validation.test.ts`
    - `src/tests/gitignore.test.ts`
    - `src/tests/worktree.test.ts`
- **Official docs:** [vitest.dev](https://vitest.dev/)

### How it is used

All tests import `describe`, `it`, `expect`, `vi`, `beforeEach`, and
`afterEach` from Vitest. The test files use Vitest's mocking APIs:

| API | Purpose |
|-----|---------|
| `vi.hoisted()` | Define mock implementations above imports (hoisted by Vitest) |
| `vi.mock()` | Replace modules at the module level |
| `vi.mocked()` | Type-safe access to mocked functions |
| `vi.fn()` | Create mock functions |
| `mockReset()` | Clear call history and implementation between tests |
| `vi.restoreAllMocks()` | Restore original implementations after each test |

### Running the tests

```bash
# Run all git-and-worktree tests
npx vitest run tests/branch-validation.test.ts tests/gitignore.test.ts tests/worktree.test.ts

# Run a single test file
npx vitest run tests/worktree.test.ts

# Run in watch mode for development
npx vitest tests/worktree.test.ts
```

See [Testing](./testing.md) for detailed coverage of what each test file
verifies and the mocking strategy used.

## Related documentation

- [Overview](./overview.md) — Group-level summary
- [Branch Validation](./branch-validation.md) — Branch name validation rules
  and security properties; works with `execFile`'s array-based argument passing
  to provide defense-in-depth against command injection
- [Worktree Management](./worktree-management.md) — How the Git CLI commands
  are orchestrated
- [Run State Persistence](./run-state.md) — The atomic write strategy in detail
- [Gitignore Helper](./gitignore-helper.md) — Error handling and race
  conditions
- [Testing](./testing.md) — Test coverage and mocking strategy for all
  integrations documented here
- [Shared Types — Integrations](../shared-types/integrations.md) — `fs/promises`
  patterns used across the broader codebase
- [Planning and Dispatch — Integrations](../planning-and-dispatch/integrations.md) —
  Git integration for commit operations (distinct from worktree management)
- [Dispatch Pipeline](../cli-orchestration/dispatch-pipeline.md) -- The
  execution engine that creates, uses, and removes worktrees through Git CLI
  commands documented here
- [Prerequisites — External Integrations](../prereqs-and-safety/integrations.md) —
  How the prerequisite checker validates Git CLI availability before the
  pipeline starts (the `git --version` detection pattern)
