# Worktree Management

The worktree module (`src/helpers/worktree.ts`) manages the full lifecycle of
git worktrees used for parallel task execution. It provides four exported
functions — `worktreeName`, `createWorktree`, `removeWorktree`, and
`listWorktrees` — plus an internal `git()` helper that wraps `execFile`.

## Directory layout

All worktrees are created under a single base directory relative to the
repository root:

```
<repoRoot>/
├── .dispatch/
│   └── worktrees/
│       ├── 123-fix-auth-bug/      ← worktree for issue 123
│       ├── 456-add-search/        ← worktree for issue 456
│       └── ...
├── .gitignore                     ← contains ".dispatch/worktrees/"
└── (rest of repository)
```

The constant `WORKTREE_DIR = ".dispatch/worktrees"` defines this path. It is
not configurable at runtime.

## Worktree name derivation

`worktreeName(issueFilename)` converts an issue filename into a directory name:

1. Extract the basename (strip any leading path components via `path.basename`).
2. Remove the `.md` extension (case-insensitive regex `\.md$`).
3. Pass the result through [`slugify()`](../shared-utilities/slugify.md), which
   lowercases, replaces non-alphanumeric runs with hyphens, and trims edge
   hyphens.

Examples:

| Input | After basename | After .md strip | After slugify |
|-------|---------------|-----------------|---------------|
| `123-fix-auth-bug.md` | `123-fix-auth-bug.md` | `123-fix-auth-bug` | `123-fix-auth-bug` |
| `path/to/456-Add Search!.MD` | `456-Add Search!.MD` | `456-Add Search!` | `456-add-search` |
| `no-extension` | `no-extension` | `no-extension` | `no-extension` |

The slugify call does **not** pass a `maxLength` argument, so the default
`MAX_SLUG_LENGTH` of 60 from `slugify.ts` is **not** applied. The slug is
unbounded. In practice, issue filenames are short enough that this does not
cause filesystem path-length issues.

## Creating a worktree

`createWorktree(repoRoot, issueFilename, branchName)` creates a worktree and
returns its absolute path.

### Normal path

Executes `git worktree add <path> -b <branchName>` in the repository root.
The `-b` flag tells git to create a new branch at `HEAD` and check it out in
the worktree. On success, the worktree directory is created and the branch
points to the same commit as the current `HEAD` of the main working tree.

### Branch-exists fallback

If the `git worktree add -b` command fails with an error message containing
`"already exists"`, the function retries with
`git worktree add <path> <branchName>` (without `-b`). This handles the case
where a previous run created the branch but the worktree was cleaned up or the
run was interrupted before the branch was deleted.

This means the branch **must not be checked out** in another worktree when the
fallback runs. If it is, git will reject the add with a different error
(`"already checked out"`) and that error will propagate as an unhandled
exception.

### What happens to the branch after removal

Git worktree removal (`git worktree remove`) does **not** delete the associated
branch. The branch persists in the repository's ref namespace. Dispatch does
not explicitly delete worktree branches after removal. Over many runs, stale
branches may accumulate and require manual cleanup:

```bash
# List branches created by Dispatch
git branch --list '*/dispatch/*'

# Delete a stale branch
git branch -d john-doe/dispatch/123-fix-auth-bug
```

### Minimum Git version

`git worktree add` has been available since Git 2.5 (July 2015).
`git worktree remove` requires Git 2.17 (April 2018). Dispatch does not check
the git version at runtime. If the installed git is older than 2.17, the
`removeWorktree` calls will fail (non-fatally, since removal errors are logged
as warnings).

The [prerequisite checks](../../src/helpers/prereqs.ts) verify that the `git`
binary is available but do not assert a minimum version.

## Removing a worktree

`removeWorktree(repoRoot, issueFilename)` uses a three-stage strategy:

1. **Normal remove**: `git worktree remove <path>`. Succeeds if the worktree
   directory is clean (no untracked files or uncommitted modifications).

2. **Force remove**: If normal remove fails (for any reason), retries with
   `git worktree remove --force <path>`. This removes the worktree even if it
   contains untracked files or uncommitted changes.

3. **Warn on failure**: If force remove also fails, the error is logged as a
   warning and the function returns normally. This is a deliberate design
   choice — a removal failure should not abort an otherwise successful run.

After a successful removal (either normal or forced), the function runs
`git worktree prune` to clean up stale administrative files in
`$GIT_DIR/worktrees/`. If pruning itself fails, a warning is logged and
execution continues.

### When normal remove fails

`git worktree remove` (without `--force`) refuses to remove a worktree that
has:

- Uncommitted modifications to tracked files
- Untracked files in the worktree directory
- Submodules checked out in the worktree

In Dispatch's usage, the most common cause of a normal-remove failure is
untracked files left by an AI agent (e.g., build artifacts, editor temp files).
The force fallback handles this gracefully.

### Stale worktree cleanup

If Dispatch is killed with `SIGKILL` (which cannot be caught) or suffers a
system crash, worktree directories may be left on disk. These can be cleaned up
manually:

```bash
# List all worktrees (including stale ones)
git worktree list

# Prune stale administrative references
git worktree prune

# Remove a stale directory manually
rm -rf .dispatch/worktrees/<name>
git worktree prune
```

The registered cleanup handler (via `registerCleanup`) ensures that `SIGINT`
and `SIGTERM` both trigger worktree removal. See
[Cleanup Registry](../shared-types/cleanup.md) for details.

## Listing worktrees

`listWorktrees(repoRoot)` returns the raw output of `git worktree list`.
Each line has the format:

```
<path>  <commit-hash>  [<branch>]
```

This function is intended for diagnostics. If the command fails, it returns an
empty string and logs a warning.

## Error handling philosophy

All four exported functions follow the same principle: **worktree operations are
best-effort and non-fatal**. The functions either succeed or log a warning. This
is because:

- Worktree operations are infrastructure supporting the real work (task
  execution). A cleanup failure should not mask a successful task result.
- The orchestrator registers cleanup handlers as a safety net. The explicit
  `removeWorktree` call after task completion is the happy path; the cleanup
  handler catches the unhappy path.
- Git worktree state is self-healing: `git worktree prune` can always clean up
  stale references, and stale directories can be manually removed.

## Concurrency considerations

When `useWorktrees` is enabled, the orchestrator runs `processIssueFile` for
each issue file concurrently via `Promise.all`. Each invocation calls
`createWorktree` with a different issue filename, so worktree paths never
collide (assuming issue filenames are unique, which is guaranteed by the
filesystem).

The internal `git()` helper executes `git` as a child process. Multiple
concurrent git commands targeting the **same repository** are generally safe for
worktree operations because each worktree has its own index and working
directory. However, operations that modify shared refs (e.g., branch creation)
use git's internal locking (`$GIT_DIR/refs/` lock files) to serialize access.

## Related documentation

- [Overview](./overview.md) — Group-level summary and worktree lifecycle
  flowchart
- [Integrations](./integrations.md) — Git CLI and `child_process.execFile`
  details
- [Gitignore Helper](./gitignore-helper.md) — Keeps `.dispatch/worktrees/`
  out of version control
- [Shared Utilities — Slugify](../shared-utilities/slugify.md) — The slug
  algorithm used by `worktreeName`
- [Planning and Dispatch — Git](../planning-and-dispatch/git.md) — Post-task
  git commit operations (distinct from worktree lifecycle)
- [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md) —
  Read-modify-write patterns and concurrent file I/O concerns that parallel
  worktree concurrency
- [Cleanup Registry](../shared-types/cleanup.md) — Safety-net cleanup on
  signals and errors
