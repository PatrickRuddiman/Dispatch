# Parser Utilities

The parser module (`src/parser.ts`) defines the `Task` and `TaskFile` data types
along with pure and async functions for extracting unchecked markdown checkbox
items, building filtered per-task context for planner agents, and marking tasks
complete via file rewrites.

## What it does

The parser is the data extraction and mutation layer for the Dispatch pipeline.
It:

1. Parses markdown files containing GitHub-style checkbox syntax (`- [ ]` /
   `- [x]`) into structured `Task` and `TaskFile` objects (see the
   [Markdown Syntax Reference](../task-parsing/markdown-syntax.md) for
   accepted formats)
2. Builds filtered views of markdown content for individual task
   [planning](../planning-and-dispatch/planner.md)
3. Performs targeted line-level mutations to check off completed tasks

## Why it exists

Every module in the pipeline needs a consistent representation of tasks. The
parser provides this by:

- Separating **pure parsing** (`parseTaskContent`) from **file I/O**
  (`parseTaskFile`), enabling direct unit testing without filesystem access
  (see [Testing Guide](../task-parsing/testing-guide.md))
- Providing a **context filtering** function (`buildTaskContext`) that prevents
  [planner agents](../planning-and-dispatch/planner.md) from being confused by
  sibling tasks
- Encapsulating the **read-modify-write** mutation pattern for task completion in
  a single function with clear error semantics (see
  [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md))

## Data types

### Task

Represents a single unchecked markdown checkbox item:

| Field | Type | Description |
|-------|------|-------------|
| `index` | `number` | Zero-based index within the file's unchecked tasks |
| `text` | `string` | The raw text content after `- [ ] ` (trimmed, with any `(P)`/`(S)`/`(I)` prefix stripped) |
| `line` | `number` | 1-based line number in the source file |
| `raw` | `string` | Full original line content including indentation |
| `file` | `string` | Absolute path to the source file |
| `mode` | `"parallel" \| "serial" \| "isolated"` | Execution mode parsed from an optional `(P)`, `(S)`, or `(I)` prefix. Defaults to `"serial"` when no prefix is present. See [Mode Prefixes](../task-parsing/markdown-syntax.md#parallel-serial-and-isolated-mode-prefixes). |

### TaskFile

Represents a parsed markdown file:

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Absolute file path |
| `tasks` | `Task[]` | All unchecked tasks found in the file |
| `content` | `string` | Full file content (unmodified) for planner context |

## Exported functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `parseTaskContent` | `(content: string, filePath: string) → TaskFile` | Pure function — parses markdown string into tasks |
| `parseTaskFile` | `(filePath: string) → Promise<TaskFile>` | Reads file from disk, delegates to `parseTaskContent` |
| `buildTaskContext` | `(content: string, task: Task) → string` | Filters sibling unchecked tasks for planner context |
| `markTaskComplete` | `(task: Task) → Promise<void>` | Read-modify-write cycle to replace `[ ]` with `[x]` |
| `groupTasksByMode` | `(tasks: Task[]) → Task[][]` | Groups tasks into ordered execution batches by mode. See [API Reference](../task-parsing/api-reference.md#grouptasksbymode). |

## Source references

- `src/parser.ts` — Full parser implementation (187 lines)
- `src/tests/parser.test.ts` — Comprehensive test suite (995 lines, 62 tests);
  see [Parser Tests](../testing/parser-tests.md) for the detailed breakdown

## Detailed documentation

For comprehensive coverage of the parser including regex patterns, edge cases,
concurrency analysis, and testing:

- [Task Parsing Overview](../task-parsing/overview.md) — Data flow and task lifecycle
- [Markdown Syntax Reference](../task-parsing/markdown-syntax.md) — Supported and
  rejected checkbox formats, CRLF handling
- [API Reference](../task-parsing/api-reference.md) — Full function signatures,
  parameters, error conditions, and type details
- [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md) —
  Read-modify-write pattern, race conditions, file I/O safety

## Related documentation

- [Overview](./overview.md) -- Shared Interfaces & Utilities layer
- [Integrations reference](./integrations.md) -- Node.js fs/promises operational details
- [Planning & Dispatch Pipeline](../planning-and-dispatch/overview.md) -- How the parser feeds the pipeline
- [Task Context & Lifecycle](../planning-and-dispatch/task-context-and-lifecycle.md) --
  How `buildTaskContext` and `markTaskComplete` fit in the dispatch pipeline
- [Provider Interface](./provider.md) -- The `ProviderInstance` abstraction that
  consumes parser output
- [Configuration System](../cli-orchestration/configuration.md) -- `--concurrency`
  and `--no-plan` flags that affect how grouped tasks are dispatched
- [Testing Guide](../task-parsing/testing-guide.md) -- How to run and extend
  the parser test suite
- [Parser Tests (detailed)](../testing/parser-tests.md) -- Comprehensive
  breakdown of all 62 parser tests including mode extraction and grouping
- [CLI & Orchestration](../cli-orchestration/overview.md) -- How the orchestrator
  uses `parseTaskFile`, `buildTaskContext`, and `markTaskComplete`
- [Spec Generation](../spec-generation/overview.md) -- The `--spec` pipeline
  that produces the markdown task files consumed by the parser
- [Git Worktree Helpers](../git-and-worktree/overview.md) -- Worktree
  isolation model; `markTaskComplete` writes within isolated worktrees
