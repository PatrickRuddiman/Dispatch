# Task Parsing & Markdown

The task parser is the foundational data layer of the Dispatch system. It reads
markdown files containing GitHub-style checkbox syntax, extracts structured
`Task` and `TaskFile` objects, and provides utilities to mark tasks as complete
by mutating the source file. Every other module in the pipeline depends on these
types and functions.

## Why it exists

Dispatch uses plain markdown files as the source of truth for work items. This
design choice means task files are human-readable, version-controllable, and
editable with any text editor. The parser bridges the gap between this
human-friendly format and the structured data that the [orchestrator](../cli-orchestration/orchestrator.md), [planner](../planning-and-dispatch/planner.md),
[dispatcher](../planning-and-dispatch/dispatcher.md), [TUI](../cli-orchestration/tui.md), and [git](../planning-and-dispatch/git.md) modules require.

## What it does

The parser module (`src/parser.ts`) provides four core capabilities:

1. **Parse markdown content** into structured `Task` and `TaskFile` objects
2. **Read task files from disk** with automatic UTF-8 decoding
3. **Build filtered context** for the planner agent, stripping sibling tasks
4. **Mark tasks complete** by performing targeted line-level mutation of the
   source file

## Data flow through the pipeline

The parser produces data that flows through the entire Dispatch pipeline:

```mermaid
flowchart LR
    MD["Markdown Files<br/>*.md"] -->|readFile| PF["parseTaskFile"]
    PF -->|TaskFile| ORCH["Orchestrator"]
    ORCH -->|Task + content| BTC["buildTaskContext"]
    BTC -->|filtered markdown| PLAN["Planner"]
    PLAN -->|execution plan| DISP["Dispatcher"]
    ORCH -->|Task| MTC["markTaskComplete"]
    MTC -->|write [x]| MD
    ORCH -->|Task| GIT["Git Commit"]
    ORCH -->|Task + status| TUI["TUI Dashboard"]
```

### How each consumer uses the parser

| Consumer | Imports | Usage |
|---|---|---|
| Orchestrator (`src/orchestrator.ts`) | `parseTaskFile`, `markTaskComplete`, `buildTaskContext`, `Task`, `TaskFile` | Parses all task files, builds planner context, marks tasks done after execution |
| Planner (`src/planner.ts`) | `Task` | Receives a `Task` object and optional filtered file context to build an execution plan |
| Dispatcher (`src/dispatcher.ts`) | `Task` | Receives a `Task` to build execution prompts for the agent backend |
| TUI (`src/tui.ts`) | `Task` | Displays task text and status in the real-time terminal dashboard |
| Git (`src/git.ts`) | `Task` | Uses task text to build conventional commit messages |

## Task lifecycle

Each task line progresses through an implicit state machine:

```mermaid
stateDiagram-v2
    [*] --> Unchecked: Task file created
    Unchecked --> Parsed: parseTaskFile()
    Parsed --> Planning: planTask()
    Planning --> Executing: dispatchTask()
    Executing --> Completed: markTaskComplete()
    Executing --> Failed: agent error
    Completed --> [*]: git commit
    Failed --> [*]: logged in TUI

    state Unchecked {
        [*] --> "- [ ] task text"
    }
    state Completed {
        [*] --> "- [x] task text"
    }
```

The transitions from `Parsed` through `Completed` involve file I/O and
potential race conditions when multiple agents operate on the same file
concurrently. See [Architecture & Concurrency](./architecture-and-concurrency.md)
for a detailed analysis.

## Source files

| File | Purpose |
|---|---|
| `src/parser.ts` | All parsing logic, types, and file mutation |
| `src/parser.test.ts` | Comprehensive test suite (607 lines, 25+ test cases) |

## Related documentation

- [Markdown Syntax Reference](./markdown-syntax.md) -- supported and rejected
  checkbox formats
- [Architecture & Concurrency](./architecture-and-concurrency.md) -- file I/O
  patterns, race conditions, and staleness analysis
- [API Reference](./api-reference.md) -- types, functions, and their contracts
- [Testing Guide](./testing-guide.md) -- how to run and extend the test suite
- [Task Context & Lifecycle](../planning-and-dispatch/task-context-and-lifecycle.md) --
  how the parser functions fit in the dispatch pipeline
- [Shared Parser Types](../shared-types/parser.md) -- summary of `Task`,
  `TaskFile`, and exported functions
- [Orchestrator](../cli-orchestration/orchestrator.md) -- the primary consumer
  of all parser functions
