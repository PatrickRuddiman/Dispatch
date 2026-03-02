# Task Context & Lifecycle

The parser module (`src/parser.ts`) provides the data layer for the dispatch
pipeline: it extracts tasks from markdown files, builds filtered context for the
[planner](./planner.md), and mutates task files to mark tasks as complete. This document covers
the parser's role within the pipeline context; for the full parser API and
testing details, see [Task Parsing & Markdown](../task-parsing/overview.md).

## What it does

The parser serves three functions in the pipeline:

1. **Parse**: Extract unchecked tasks from markdown files into structured
   `Task` objects
2. **Filter**: Build a filtered view of the file content that shows only one
   task (for the planner)
3. **Mutate**: Mark a specific task as complete by replacing `[ ]` with `[x]`
   in the source file

## Why it exists

The parser bridges the gap between human-authored markdown task files and the
machine-driven dispatch pipeline. It provides a clean data model ([`Task`](../task-parsing/api-reference.md#task),
[`TaskFile`](../task-parsing/api-reference.md#taskfile)) that the [orchestrator](../cli-orchestration/orchestrator.md), [planner](./planner.md), and [dispatcher](./dispatcher.md) consume, while
keeping all markdown format concerns in one place.

## Markdown task file format

The parser recognizes GFM-style checkbox tasks: lines matching `- [ ] Task text`
or `* [ ] Task text` (with optional leading whitespace). Checked tasks (`[x]`)
are treated as already completed and skipped during parsing.

For the full regex specification, accepted/rejected formats, and edge cases, see
the [Markdown Syntax Reference](../task-parsing/markdown-syntax.md).

### Recommended file structure

A well-structured task file includes prose context that the planner can use:

```markdown
# Feature: User Authentication

This module should follow the existing auth patterns in `src/auth/`.
Use JWT tokens with the existing `TokenService` for session management.

## Tasks

- [ ] Create the login endpoint in src/routes/auth.ts
- [ ] Add password hashing utility using bcrypt
- [x] Set up the user database schema (completed previously)

## Implementation Notes

The login endpoint should return a 401 for invalid credentials and a 200
with a JWT token for valid credentials. Follow the error handling pattern
in src/routes/health.ts.
```

The planner uses non-task content (headings, prose, notes) as implementation
guidance. Checked tasks (`[x]`) are preserved in context as documentation of
completed work.

## How context filtering works

### The `buildTaskContext` function

When the planner processes a task, it receives a filtered view of the markdown
file, not the raw content. The `buildTaskContext()` function
(`src/parser.ts:46-60`) produces this filtered view:

**Input**: Full file content + the specific `Task` being planned

**Logic**:

1. Normalize CRLF to LF
2. Split into lines
3. For each line:
    - If it is the current task's line (by line number) -- **keep**
    - If it matches the unchecked task pattern (`UNCHECKED_RE`) -- **remove**
    - Otherwise (headings, prose, checked tasks, blank lines) -- **keep**

**Output**: The file content with all unchecked tasks removed except the one
being planned.

### Why filter sibling tasks?

Without filtering, the planner (and the downstream executor) would see all
unchecked tasks in the file. This creates two problems:

1. **Scope confusion**: The agent might attempt to work on multiple tasks
2. **Wasted context**: Sibling tasks consume context window tokens without
   providing useful information for the current task

The filtering ensures each planning session focuses on exactly one task while
retaining all the rich context (prose, notes, headings, completed tasks) that
task authors provide.

### Impact on task dependencies

Filtering removes visibility into sibling unchecked tasks. If tasks depend on
each other (e.g., "Create the API endpoint" depends on "Add the database
schema"), the planner will not see the dependency.

**Workarounds**:

- Express dependencies as prose: "This task depends on the database schema
  created by a previous task."
- Order dependent tasks so prerequisites complete first (use
  `--concurrency 1`; see [CLI Options](../cli-orchestration/cli.md#options-reference))
- Completed prerequisite tasks appear as `[x]` items, which are preserved in
  the filtered context

## Task parsing details

### Task parsing functions

The parser exposes two parsing entry points:

- **`parseTaskContent(content, filePath)`** — Pure function (no I/O). Takes a
  markdown string and file path, returns a `TaskFile` with extracted tasks.
  Handles CRLF normalization internally.
- **`parseTaskFile(filePath)`** — Reads a file from disk (UTF-8), then delegates
  to `parseTaskContent()`.

For full function signatures, parameters, and error conditions, see the
[API Reference](../task-parsing/api-reference.md). For CRLF normalization
details and line-ending behavior, see the
[Markdown Syntax Reference](../task-parsing/markdown-syntax.md#line-ending-handling).

## Concurrent write safety

The [`markTaskComplete()`](../task-parsing/api-reference.md#marktaskcomplete) function performs a non-atomic read-modify-write cycle
without file locking. With [`--concurrency > 1`](../cli-orchestration/cli.md), concurrent calls on the same
file can produce a TOCTOU race condition where one agent's completion overwrites
another's.

**Mitigating factors**: The default concurrency is 1 (fully serial). Even with
higher concurrency, the risk only applies when multiple tasks from the same file
are in the same batch.

For a detailed analysis of the race condition, potential improvements (file-level
mutex, atomic writes), process interruption risks, and file permission error
handling, see
[Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md#concurrent-task-completion).

## Related documentation

- [Pipeline Overview](./overview.md) -- Where parsing fits in the pipeline
- [Planner Agent](./planner.md) -- How filtered context is consumed
- [Dispatcher](./dispatcher.md) -- The execution phase that follows planning
- [Git Operations](./git.md) -- The commit step after `markTaskComplete`
- [Task Parsing & Markdown](../task-parsing/overview.md) -- Full parser API, testing,
  and edge cases
- [Markdown Syntax Reference](../task-parsing/markdown-syntax.md) -- Supported
  checkbox formats, `(P)`/`(S)` mode prefixes, and line ending handling
- [Orchestrator](../cli-orchestration/orchestrator.md) -- How the orchestrator
  calls `parseTaskFile`, `buildTaskContext`, and `markTaskComplete`
- [Shared Parser Types](../shared-types/parser.md) -- `Task` and `TaskFile` type
  definitions and exported functions
- [Integrations & Troubleshooting](./integrations.md) -- Node.js fs details
- [Parser Tests](../testing/parser-tests.md) -- Test suite verifying parsing
  behavior, edge cases, and CRLF handling
- [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md) --
  File I/O safety and concurrent write analysis
- [Provider Overview](../provider-system/provider-overview.md) -- The AI
  provider sessions used by planner and dispatcher
