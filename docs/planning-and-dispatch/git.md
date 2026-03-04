# Git Operations

The git module (`src/git.ts`) handles post-completion version control: staging
all changes, checking for modifications, and creating a conventional commit
message inferred from the task text.

## What it does

After the [dispatcher](./dispatcher.md) reports a successful task and the [parser
marks the task complete](../task-parsing/api-reference.md#marktaskcomplete), `commitTask()` stages all working directory changes
with `git add -A`, checks whether anything was staged, and if so, creates a
commit with an automatically generated
[Conventional Commits](https://www.conventionalcommits.org/) message. For the
final branch-level commit message, PR title, and PR description, see the
[Commit Agent](../agent-system/commit-agent.md) which runs after all tasks
complete. Branch
creation and management are handled separately by the
[datasource layer](../datasource-system/overview.md#git-lifecycle-operations).

## Why it exists

Automated commits after each task serve two purposes:

1. **Auditability**: Each task produces exactly one commit (or zero, if the
   agent made no changes), creating a 1:1 mapping between tasks and commit
   history.
2. **Isolation**: By committing after each task, subsequent tasks start from a
   clean working directory, and `git add -A` captures exactly that task's
   changes (assuming serial execution).

## How it works

### The `commitTask` function

```
commitTask(task, cwd) → Promise<void>
```

1. **Stage all changes**: `git add -A` in the working directory
2. **Check for staged changes**: `git diff --cached --stat` -- if output is
   empty, return without committing (the agent made no changes)
3. **Build commit message**: Infer type from task text, truncate subject to
   72 characters
4. **Commit**: `git commit -m <message>`

### Commit type inference

The `buildCommitMessage()` function scans the lowercase task text against a
cascade of regex patterns to infer a
[Conventional Commits](https://www.conventionalcommits.org/) type. The patterns
are evaluated in order; **the first match wins**.

| Priority | Type | Regex pattern | Example matches |
|----------|------|---------------|-----------------|
| 1 | `fix` | `/\bfix(es\|ed\|ing)?\b/` or `/\bbug\b/` | "fix login bug", "fixing tests" |
| 2 | `docs` | `/\bdoc(s\|ument)?\b/` or `/\breadme\b/` | "update docs", "add readme" |
| 3 | `refactor` | `/\brefactor\b/` or `/\bclean\s?up\b/` | "refactor auth module", "cleanup" |
| 4 | `test` | `/\btest(s\|ing)?\b/` | "add tests for parser", "testing utils" |
| 5 | `chore` | `/\b(chore\|config\|setup\|install\|upgrade\|bump\|dep)\b/` | "bump deps", "setup CI" |
| 6 | `style` | `/\bstyle\b/` or `/\bformat\b/` | "format code", "fix style" |
| 7 | `perf` | `/\bperf(ormance)?\b/` | "improve performance" |
| 8 | `ci` | `/\b(ci\|pipeline\|workflow\|action)\b/` | "update CI pipeline" |
| 9 | `feat` | `/\badd\b/` or `/\bcreate\b/` or `/\bimplement\b/` | "add user API", "implement search" |
| default | `feat` | (no match) | anything else |

#### Ambiguous task text

**How does the inference handle ambiguous text like "fix test for config
setup"?**

Because the patterns use a cascading `if/else-if` structure, the **first
matching pattern wins**. In the example "fix test for config setup":

1. Pattern 1 (`fix`) matches `fix` -- result is `fix`
2. Patterns 4 (`test`), 5 (`config`, `setup`) are never evaluated

This means:

- `fix` always takes priority over `test`, `chore`, etc.
- `docs` takes priority over `refactor`, `test`, etc.
- The generic `feat` patterns (`add`, `create`, `implement`) are evaluated
  last, just before the default

**Can the inferred type be overridden by the task author?**

No. There is no mechanism for the task author to specify a commit type. The
type is always inferred from the task text. If you need a specific commit type,
word the task text to match the desired pattern (e.g., start with "fix:" or
"docs:").

The commit type inference follows the spirit of the
[Conventional Commits specification](https://www.conventionalcommits.org/),
which defines `fix` and `feat` as the two required types, with additional types
like `docs`, `refactor`, `test`, `chore`, `style`, `perf`, and `ci` being
common extensions (as recommended by
[@commitlint/config-conventional](https://github.com/conventional-changelog/commitlint)).

#### Subject line truncation

The commit subject is truncated to 72 characters total (60 characters of task
text + `...` suffix if truncated, plus the `type: ` prefix). This follows the
Git convention of keeping the subject line under 72 characters for readability
in `git log` output.

### Git command execution

All git commands are executed via Node.js `child_process.execFile()` (promisified),
which spawns the `git` binary directly without a shell. The helper function:

```
git(args, cwd) → Promise<string>
```

Passes the `cwd` option to `execFile` to execute git commands in the correct
working directory.

### Concurrency and `git add -A`

**If tasks run concurrently, could one task's commit accidentally include
another task's changes?**

**Yes, this is a real risk with `--concurrency > 1`.** The `git add -A` command
stages **all** changes in the working directory, not just changes made by a
specific task. If two tasks in the same batch both modify files and complete at
nearly the same time:

1. Task A finishes, calls `git add -A` -- stages Task A's changes
2. Task B finishes, calls `git add -A` -- stages Task A's remaining unstaged
   files AND Task B's changes
3. Task B calls `git commit` -- commits changes from both tasks under Task B's
   commit message

The [orchestrator](../cli-orchestration/orchestrator.md) (`src/orchestrator.ts:113-115`) processes tasks in batches
using `Promise.all()`. Within a batch, the [`markTaskComplete`](../task-parsing/api-reference.md#marktaskcomplete) → [`commitTask`](#the-committask-function)
sequence for each task runs concurrently. There is no locking or sequencing
of git operations between tasks in the same batch.

**Mitigation**:

- Use `--concurrency 1` (the default) to ensure tasks are processed serially.
  See [CLI options](../cli-orchestration/cli.md#options-reference).
- With concurrent execution, accept that commit boundaries may not perfectly
  align with task boundaries
- A future improvement could use a sequential commit queue that serializes
  git operations even when task execution is parallel

### Interaction with `.gitignore`

`git add -A` respects the repository's `.gitignore` file. Files matching
`.gitignore` patterns will not be staged. This means:

- Agent-generated files that match `.gitignore` patterns (e.g., build outputs,
  `node_modules/`) will be correctly excluded
- Agent-generated files that should be tracked but are accidentally covered by
  `.gitignore` will be silently excluded
- Files the agent creates in ignored directories will not appear in the commit

There is no override or special handling -- standard Git ignore rules apply.

## Troubleshooting

### Git commit failures

**What happens if the git commit fails?**

The `git()` helper function does not catch errors. If `execFile` fails (non-zero
exit code from git), the promise rejects with an error containing the stderr
output. This error propagates up through `commitTask()` to the orchestrator's
`Promise.all()` batch handler.

The orchestrator (`src/orchestrator.ts:144-146`) does **not** wrap the
`commitTask()` call in a try/catch separate from the batch. A git commit failure
will cause the batch promise to reject, which propagates to the outer try/catch
at `src/orchestrator.ts:171-173`, stopping the entire pipeline. See the
[orchestrator error recovery](../cli-orchestration/orchestrator.md#error-recovery-and-provider-cleanup)
for details.

Common git commit failures:

| Cause | Error message | Resolution |
|-------|--------------|------------|
| Pre-commit hook failure | `husky - pre-commit hook exited with code 1` | Fix hook issues or use `--no-verify` (requires code change) |
| GPG signing failure | `error: gpg failed to sign the data` | Configure GPG key or disable `commit.gpgsign` |
| Lock file conflict | `fatal: Unable to create '.git/index.lock'` | Remove stale lock file or wait for other git process |
| Empty commit (no changes) | (handled -- returns early) | Normal behavior when agent made no changes |

**Is a failed commit retried?**

No. There is no retry mechanism for git operations. A failed commit stops
processing for that task (and potentially the entire batch).

### Dirty working directory

**What happens if the git working directory is in a dirty state (e.g., merge
conflict) when the dispatch pipeline starts?**

The pipeline does **not** check the git state before starting. If the working
directory has:

- **Uncommitted changes**: They will be included in the first task's commit
  via `git add -A`
- **Merge conflicts**: `git commit` will fail, causing the pipeline to error
- **Detached HEAD**: Commits will be created on the detached HEAD (may be
  lost on checkout)

**Recommendation**: Ensure a clean working directory before running `dispatch`.
Use `git status` to verify there are no uncommitted changes or unresolved
conflicts.

### Maximum buffer size

**Could large git output cause `execFile` to fail?**

Yes. Node.js `execFile` has a default `maxBuffer` of 1 MB (1024 * 1024 bytes)
for both stdout and stderr. If a git command produces more than 1 MB of output
(e.g., `git diff --cached --stat` on a very large changeset), `execFile` will
kill the child process and reject with a `maxBuffer exceeded` error.

In practice, this is unlikely because:

- `git add -A` produces no stdout
- `git diff --cached --stat` produces a summary, not full diffs
- `git commit -m` produces minimal output

If this becomes an issue, the `git()` helper can be modified to pass a larger
`maxBuffer` option to `execFile`.

## Related documentation

- [Pipeline Overview](./overview.md) -- Where git fits in the pipeline
- [Dispatcher](./dispatcher.md) -- The execution phase that precedes commit
- [Task Context & Lifecycle](./task-context-and-lifecycle.md) -- The
  `markTaskComplete()` call that precedes commit
- [Planner Agent](./planner.md) -- The planning phase that precedes dispatch
  and commit
- [Integrations & Troubleshooting](./integrations.md) -- Node.js `execFile`
  details
- [Orchestrator](../cli-orchestration/orchestrator.md) -- How the orchestrator
  sequences `markTaskComplete` and `commitTask`
- [CLI Options](../cli-orchestration/cli.md#options-reference) -- `--concurrency`
  flag that affects git safety
- [Configuration System](../cli-orchestration/configuration.md) -- Persistent
  `--concurrency` defaults and three-tier merge logic
- [Run State Persistence](../git-and-worktree/run-state.md) -- Task status
  tracking that complements the per-task commit model
- [Markdown Syntax Reference](../task-parsing/markdown-syntax.md) -- Checkbox
  format that the parser uses to identify tasks before commit
- [Datasource Overview](../datasource-system/overview.md) -- Branch naming
  convention and git lifecycle operations managed by the datasource layer
- [Datasource Helpers](../datasource-system/datasource-helpers.md) -- Issue
  ID extraction from filenames used alongside git operations
- [Cleanup Registry](../shared-types/cleanup.md) -- Process-level cleanup
  that runs on signal exit alongside git operations
- [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md) --
  Concurrent write safety analysis relevant to git add races
- [Commit Agent](../agent-system/commit-agent.md) -- AI-generated conventional
  commit messages and PR metadata produced after all tasks complete
- [Worktree Management](../git-and-worktree/worktree-management.md) -- Worktree
  lifecycle for parallel issue isolation (distinct from per-task commits)
