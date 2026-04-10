# Architecture & Concurrency

This document addresses the architectural decisions and concurrency concerns in
the task parser, including the read-modify-write pattern, line-number staleness,
file I/O safety, and how the orchestrator mitigates these risks.

## The read-modify-write pattern

`markTaskComplete` follows a classic read-modify-write pattern:

1. **Read** the file from disk (`readFile`)
2. **Modify** the target line in memory (regex replace)
3. **Write** the entire file back to disk (`writeFile`)

This pattern is used in `src/parser.ts:121-144`.

### Why markTaskComplete re-reads the file from disk

A natural question is: why does `markTaskComplete` call `readFile` again instead
of using the content already cached in the `TaskFile` object?

The answer is **freshness**. Between the time a file was parsed and the time a
task is marked complete, the file may have changed:

- Another agent running concurrently may have already marked a different task
  complete in the same file
- An external editor or process may have modified the file
- The orchestrator processes tasks in batches, so elapsed time can be
  significant

Re-reading the file ensures `markTaskComplete` operates on the **current** file
state rather than a potentially stale snapshot. This is a deliberate trade-off:
a small performance cost (one extra `readFile`) in exchange for reduced risk of
writing stale data.

## Concurrent task completion

### The problem

When the orchestrator runs with [`--concurrency > 1`](../cli-orchestration/cli.md), multiple agents may attempt
to mark tasks complete in the **same file** simultaneously. The sequence of
concern is:

```
Agent A: readFile("tasks.md")    → sees original content
Agent B: readFile("tasks.md")    → sees same original content
Agent A: writeFile("tasks.md")   → writes with task 1 checked
Agent B: writeFile("tasks.md")   → writes with task 2 checked, OVERWRITES task 1's check
```

This is a classic TOCTOU (time-of-check-time-of-use) race condition.

### How Node.js writeFile behaves

According to the [Node.js fs documentation](https://nodejs.org/api/fs.html),
`fsPromises.writeFile` is **not atomic**. It truncates the file and writes the
new content. If two `writeFile` calls overlap, the result is the content from
whichever call completes last -- the other's changes are silently lost.

Node.js does not provide built-in file locking. The `writeFile` operation
replaces the file content entirely; it does not merge changes.

### Current mitigation in the orchestrator

Looking at `src/agents/orchestrator.ts:165-220`, the [orchestrator](../cli-orchestration/orchestrator.md) first
partitions tasks into execution groups via
[`groupTasksByMode()`](./api-reference.md#grouptasksbymode), then processes each
group using a batch-sequential `Promise.all` loop:

```typescript
const groups = groupTasksByMode(allTasks);
for (const group of groups) {
  const groupQueue = [...group];
  while (groupQueue.length > 0) {
    const batch = groupQueue.splice(0, concurrency);
    const batchResults = await Promise.all(
      batch.map(async (task) => { /* ... */ })
    );
  }
}
```

Within a batch, tasks run concurrently. However, the `markTaskComplete` call
happens **after** each task's agent execution completes (`src/agents/orchestrator.ts:203`),
and the orchestrator does **not** re-parse the file between completions within
the same batch.

Serial `(S)` and isolated `(I)` groups always contain exactly one task, so they
never produce concurrent `markTaskComplete` calls. The race condition risk is
limited to parallel `(P)` groups running with `--concurrency > 1`.

See the [Orchestrator concurrency model](../cli-orchestration/orchestrator.md#concurrency-model)
for full details on the group-aware batch-sequential algorithm.

**Risk assessment:**

- **Low risk when concurrency = 1** (the default, see [CLI `--concurrency`](../cli-orchestration/cli.md)): Tasks are processed
  sequentially, so no concurrent writes occur.
- **Moderate risk when concurrency > 1 and tasks share a file**: Two agents
  finishing at roughly the same time could produce the race condition described
  above. However, since agent execution typically takes seconds to minutes, the
  window for collision on the `markTaskComplete` call is narrow.
- **The parser detects conflicts**: If the file was modified between the read
  and the regex match, `markTaskComplete` throws an error at
  `src/parser.ts:137-140` ("does not match expected unchecked pattern"). This
  acts as a safety net -- a corrupted write would cause the line to no longer
  match `UNCHECKED_RE`, and the error would surface rather than silently
  corrupting data.

### Potential improvements

For production use with high concurrency, consider:

1. **File-level mutex**: Use a per-file lock (e.g., `proper-lockfile` or an
   in-process `Map<string, Promise>`) to serialize `markTaskComplete` calls
   for the same file.
2. **Re-parse after each completion**: After marking a task complete, re-parse
   the file to get fresh line numbers before marking the next task.
3. **Atomic write**: Use a write-to-temp-then-rename pattern for safer file
   updates.

## Line-number staleness

### The problem

Each `Task` object stores a `line` number (1-based) that corresponds to the
task's position in the file at parse time. When `markTaskComplete` checks off a
task, it writes back to the file. If the write changes the number of lines (it
does not in this case -- replacing `[ ]` with `[x]` preserves line count), or
if another process modifies the file, the stored line numbers for remaining
tasks become stale.

### Current behavior

In the current implementation, **line numbers remain valid after marking a task
complete** because:

1. `markTaskComplete` replaces content on a single line without adding or
   removing lines
2. The `lines.join(eol)` at `src/parser.ts:144` preserves the line structure

However, if the file is modified externally (e.g., a user adds or removes
lines), the stored line numbers will be wrong. The parser's safety check at
`src/parser.ts:113-117` catches this: if the line at the stored offset does not
match `UNCHECKED_RE`, it throws an error rather than checking off the wrong
line.

### Does the orchestrator re-parse after each completion?

No. Looking at `src/orchestrator.ts:77-83`, the orchestrator parses all files
once, builds the task list, and then processes all tasks from that initial parse.
It does **not** re-parse files after marking a task complete.

This is safe as long as:

- No external process modifies the task files during execution
- The `markTaskComplete` function preserves line count (which it does)

If these assumptions are violated, the line-number mismatch error provides a
clear diagnostic.

## File I/O error handling

### File permission errors

The parser does not catch or wrap `readFile`/`writeFile` errors. If the file
lacks read permissions, `parseTaskFile` throws a Node.js `EACCES` error. If it
lacks write permissions, `markTaskComplete` throws `EACCES` on the `writeFile`
call. These errors propagate to the orchestrator, which catches them and marks
the task as failed in the [TUI](../cli-orchestration/tui.md) (`src/orchestrator.ts:171-173`).

### File deleted or moved between operations

If a task file is deleted between parsing and marking complete:

- `markTaskComplete` calls `readFile` on the stored `task.file` path
- Node.js throws an `ENOENT` error ("file not found")
- The error propagates to the orchestrator, which catches it

There is no special handling for this case -- it results in a failed task.

### External modification detection

When `markTaskComplete` re-reads the file, it checks that the target line still
matches the unchecked pattern (`src/parser.ts:134-140`). If the file was
externally modified and the target line has changed, the function throws a
descriptive error:

```
Line 5 in tasks.md does not match expected unchecked pattern: "some other content"
```

This error is caught by the [orchestrator's](../cli-orchestration/orchestrator.md) `try/catch` and the task is marked as
failed in the [TUI](../cli-orchestration/tui.md) with the error message.

## File encoding and line endings

### Encoding

Both `readFile` and `writeFile` use explicit `"utf-8"` encoding
(`src/parser.ts:114`, `src/parser.ts:122`, `src/parser.ts:144`). This means:

- Files are assumed to be UTF-8
- Non-UTF-8 files (e.g., UTF-16, Latin-1) will be read without error but
  produce garbled content
- The parser does not detect or handle BOM (byte order mark) characters

### Line endings on write

`markTaskComplete` detects and preserves the original line ending style
(`src/parser.ts:123`). Before processing, it checks whether the raw file
content contains `\r\n` sequences:

```typescript
const eol = content.includes("\r\n") ? "\r\n" : "\n";
```

After modifying the target line, it rejoins with the detected EOL style
(`src/parser.ts:144`):

```typescript
await writeFile(task.file, lines.join(eol), "utf-8");
```

This means:

- **LF files**: Preserved as LF
- **CRLF files**: Preserved as CRLF — the original `\r\n` endings are
  maintained through the round-trip

This behavior is verified by tests at `src/tests/parser.test.ts:730-770`
which confirm both CRLF and LF round-trip correctly.

## How TaskFile.content is consumed downstream

The `TaskFile.content` field stores the **original, un-normalized** file content
as passed to [`parseTaskContent`](./api-reference.md#parsetaskcontent) (`src/parser.ts:85`). In the [orchestrator](../cli-orchestration/orchestrator.md):

1. `parseTaskFile` is called, which reads the file and passes content to
   `parseTaskContent`
2. The orchestrator stores `TaskFile.content` in a `Map<string, string>` keyed
   by file path (`src/orchestrator.ts:80-83`)
3. When planning a task, the orchestrator passes this content through
   `buildTaskContext` to produce a filtered view (`src/orchestrator.ts:125-126`)
4. The planner receives only this filtered context, not the raw `content` field

The [planner](../agent-system/planner-agent.md) never sees `TaskFile.content` directly -- it always goes through
[`buildTaskContext`](./api-reference.md#buildtaskcontext) first. This is a deliberate design: the filtered context
strips sibling unchecked tasks so the planner focuses on a single unit of work.
See [Planner — File Context Filtering](../agent-system/planner-agent.md#file-context-filtering) for how
this context is incorporated into the planner prompt.

## Why buildTaskContext strips sibling tasks

The `buildTaskContext` function (`src/parser.ts:36-60`) removes all unchecked
task lines except the one being planned. This design serves several purposes:

1. **Focus**: The [planner](../agent-system/planner-agent.md) agent should implement one task at a time. Showing
   sibling tasks risks the planner attempting to address multiple tasks or
   making incorrect assumptions about task ordering.

2. **Context preservation**: All non-task content is preserved -- headings,
   prose, notes, already-checked tasks. This gives the planner full access to
   implementation guidance without the noise of unrelated work items.

3. **Agent isolation**: Each task is dispatched to an independent agent session
   via the [dispatcher](../agent-system/executor-agent.md).
   The planner's context should match the scope of work for that session.

Looking at `src/planner.ts:72-85`, the filtered context is embedded in the
[planner prompt](../agent-system/planner-agent.md#planner-prompt-structure) as a "Task File Contents" section, where the planner is
instructed to review non-task prose for implementation details.

## Type sharing across modules

The [`Task`](./api-reference.md#task) and [`TaskFile`](./api-reference.md#taskfile) interfaces are exported directly from `src/parser.ts`
(`src/parser.ts:11-29`) and imported by consumers using standard ES module
imports:

```typescript
// src/orchestrator.ts:12
import { parseTaskFile, markTaskComplete, buildTaskContext, type Task, type TaskFile } from "./parser.js";

// src/dispatcher.ts:7
import type { Task } from "./parser.js";

// src/planner.ts:12
import type { Task } from "./parser.js";

// src/tui.ts:7
import type { Task } from "./parser.js";

// src/git.ts:7
import type { Task } from "./parser.js";
```

Types are imported directly from the parser module -- there is no intermediate
re-export layer or shared types barrel file. The `type` keyword is used for
type-only imports, ensuring the parser module's runtime code is not bundled into
modules that only need the types.

## Related documentation

- [Overview](./overview.md) -- high-level summary and data flow diagram
- [Markdown Syntax Reference](./markdown-syntax.md) -- accepted and rejected
  checkbox formats
- [API Reference](./api-reference.md) -- function signatures and contracts
- [Testing Guide](./testing-guide.md) -- test coverage and how to run tests
- [Orchestrator](../cli-orchestration/orchestrator.md) -- how the orchestrator
  processes tasks in batches and calls `markTaskComplete`
- [Task Context & Lifecycle](../planning-and-dispatch/task-context-and-lifecycle.md) --
  the pipeline perspective on parsing, filtering, and mutation
- [Shared Parser Types](../shared-types/parser.md) -- summary of exported types
  and functions
- [Dispatcher](../agent-system/executor-agent.md) -- concurrent task
  dispatch that interacts with the concurrency model
- [Planner](../agent-system/planner-agent.md) -- plan generation that
  consumes `buildTaskContext` output
- [CLI Reference](../cli-orchestration/cli.md) -- `--concurrency` flag that
  controls parallel execution
- [Worktree Management](../git-and-worktree/worktree-management.md) -- Git
  worktree concurrency considerations that parallel the file I/O concerns here
- [Gitignore Helper](../git-and-worktree/gitignore-helper.md) -- Another
  read-modify-write pattern with similar race condition analysis
- [Timeout Utility](../shared-utilities/timeout.md) -- deadline enforcement
  used alongside the concurrency model
- [Provider Interface](../shared-types/provider.md) -- the `ProviderInstance`
  lifecycle driven by the orchestrator batching loop
- [Run State](../git-and-worktree/run-state.md) -- Atomic write comparison
  with the read-modify-write pattern discussed here
- [Parser Tests](../testing/parser-tests.md) -- Comprehensive test suite
  (62 tests) covering the parsing and mutation functions described here
- [Testing Overview](../testing/overview.md) -- Project-wide test framework
  and coverage map
- [Concurrency Utility](../shared-utilities/concurrency.md) --
  `runWithConcurrency()` sliding-window implementation used by the dispatch
  pipeline
- [Cleanup Registry](../shared-types/cleanup.md) -- Process-level cleanup
  that runs when concurrent tasks fail or signals interrupt execution
- [Troubleshooting](../dispatch-pipeline/troubleshooting.md) -- Common
  concurrency-related failure scenarios and diagnostic steps
