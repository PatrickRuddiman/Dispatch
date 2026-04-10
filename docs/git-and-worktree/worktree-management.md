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
3. Check for a leading numeric ID (regex `/^\d+/`).
    - **If found**: Return `issue-<id>` (e.g., `123-fix-auth-bug.md` → `issue-123`).
    - **If not found**: Pass the extension-stripped name through
      [`slugify()`](../shared-utilities/slugify.md) and return the result.

The slugify fallback applies when issue filenames lack a leading numeric ID
(e.g., `feature-request.md` → `feature-request`). The `slugify()` function
lowercases the input, replaces non-alphanumeric character runs with hyphens,
and trims leading/trailing hyphens. The call does **not** pass a `maxLength`
argument, so the default `MAX_SLUG_LENGTH` of 60 from `slugify.ts` is **not**
applied — the slug is unbounded. In practice, issue filenames are short enough
that this does not cause filesystem path-length issues.

Examples:

| Input | Derivation | Output |
|-------|-----------|--------|
| `123-fix-auth-bug.md` | Leading digits `123` found | `issue-123` |
| `/tmp/dispatch-abc/123-fix.md` | basename → `123-fix.md`, digits `123` | `issue-123` |
| `456-Add Search!.MD` | basename → `456-Add Search!.MD`, digits `456` | `issue-456` |
| `no-number-here.md` | No leading digits → slugify | `no-number-here` |
| `Feature Request!.md` | No leading digits → slugify | `feature-request` |

## Creating a worktree

`createWorktree(repoRoot, issueFilename, branchName, startPoint?)` creates a
worktree and returns its absolute path.

### Normal path

Executes `git worktree add <path> -b <branchName> [startPoint]` in the
repository root. The `-b` flag tells git to create a new branch and check it
out in the worktree. When `startPoint` is provided, the new branch is created
at that commit instead of `HEAD`. When omitted, the branch points to the
current `HEAD` of the main working tree.

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

## Generating feature branch names

`generateFeatureBranchName()` produces a branch name for tasks that do not
originate from an issue tracker (e.g., the `--feature` CLI flag):

```
dispatch/feature-<8-hex-chars>
```

The 8 hex characters are the first segment of a `crypto.randomUUID()` output,
split on the first hyphen. This provides 32 bits of entropy (4.3 billion
possible values), which is sufficient to avoid collisions in practice. A
typical Dispatch session creates at most a handful of feature branches.

The generated name always passes [`isValidBranchName()`](./branch-validation.md)
because it contains only lowercase hex characters, hyphens, and a single slash.

### UUID entropy considerations

Using only the first 8 hex characters of a UUID (32 bits) rather than the full
128 bits is a deliberate tradeoff:

- **Readability**: Short branch names are easier to read in `git log` and
  `git branch` output.
- **Collision probability**: With 32 bits, collisions become likely around
  ~65,000 branches (birthday bound). Since Dispatch branches are cleaned up
  regularly, the active set is typically under 100.
- **Runtime requirement**: `crypto.randomUUID()` is available in Node.js 19+
  and is a built-in API — no polyfill is needed. The project's minimum Node.js
  version requirement covers this.

## Worktree lifecycle state diagram

The following diagram shows the states a worktree passes through from creation
to removal, including all error recovery paths:

```mermaid
stateDiagram-v2
    [*] --> Creating: createWorktree() called
    
    Creating --> TryNewBranch: git worktree add -b
    TryNewBranch --> Active: Success
    TryNewBranch --> BranchExists: "already exists" error
    TryNewBranch --> Failed: Other error (thrown)
    
    BranchExists --> TryExistingBranch: git worktree add (no -b)
    TryExistingBranch --> Active: Success (checks out at branch HEAD)
    TryExistingBranch --> Failed: Error (thrown)
    
    Active --> Removing: removeWorktree() called
    
    Removing --> TryNormalRemove: git worktree remove
    TryNormalRemove --> Pruning: Success
    TryNormalRemove --> TryForceRemove: Failure
    
    TryForceRemove --> Pruning: git worktree remove --force succeeds
    TryForceRemove --> Stale: Both removals failed (log.warn)
    
    Pruning --> Cleaned: git worktree prune succeeds
    Pruning --> Cleaned: prune fails (log.warn, non-fatal)
    
    Cleaned --> [*]
    Stale --> [*]: Manual cleanup required
    Failed --> [*]
```

**Key observations:**

- **Branch-exists fallback**: When the `-b` flag fails because the branch
  already exists, the retry uses `git worktree add <path> <branch>` which
  checks out the existing branch at **its current HEAD** — not at the commit
  where `createWorktree` was called. If the branch has been advanced by a
  previous run, the worktree will reflect those changes.

- **Non-fatal removal**: Both removal paths (normal and force) catch errors
  and log warnings rather than throwing. This ensures that a removal failure
  never masks a successful task execution result.

- **Branch persistence**: Neither `removeWorktree` nor `git worktree remove`
  deletes the branch. Branches accumulate across runs and require manual
  cleanup (see [branch cleanup](#what-happens-to-the-branch-after-removal)).

## Related documentation

- [Overview](./overview.md) — Group-level summary and worktree lifecycle
  flowchart
- [Branch Validation](./branch-validation.md) — Validation rules applied to
  branch names before worktree creation
- [Integrations](./integrations.md) — Git CLI and `child_process.execFile`
  details
- [Gitignore Helper](./gitignore-helper.md) — Keeps `.dispatch/worktrees/`
  out of version control
- [Testing](./testing.md) — 25 worktree tests covering creation, removal,
  naming, and feature branch generation
- [Shared Utilities — Slugify](../shared-utilities/slugify.md) — The slug
  algorithm used by `worktreeName`
- [Planning and Dispatch — Git](../planning-and-dispatch/git.md) — Post-task
  git commit operations (distinct from worktree lifecycle)
- [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md) —
  Read-modify-write patterns and concurrent file I/O concerns that parallel
  worktree concurrency
- [Cleanup Registry](../shared-types/cleanup.md) — Safety-net cleanup on
  signals and errors
- [Dispatch Pipeline](../cli-orchestration/dispatch-pipeline.md) — The execution
  engine that creates and removes worktrees during parallel issue processing
- [Run State Persistence](./run-state.md) — Task status persistence that
  complements the worktree lifecycle
