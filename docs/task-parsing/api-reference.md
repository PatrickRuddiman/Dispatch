# API Reference

Complete reference for all types and functions exported by the task parser
module (`src/parser.ts`).

## Types

### Task

Represents a single unchecked task extracted from a markdown file.

```typescript
interface Task {
  index: number;                      // Zero-based index within the file
  text: string;                       // The raw text after "- [ ] ", with any (P)/(S) prefix stripped
  line: number;                       // Line number in the file (1-based)
  raw: string;                        // Full original line content, including indentation
  file: string;                       // The source file path
  mode?: "parallel" | "serial";       // Execution mode (defaults to "serial" when unspecified)
}
```

**Field details:**

| Field | Description |
|---|---|
| `index` | Sequential zero-based counter of unchecked tasks in the file. The first unchecked task is `0`, the second is `1`, etc. Checked tasks and non-task lines do not affect the index. |
| `text` | The task description extracted from after `[ ] `. Leading/trailing whitespace is trimmed via `.trim()`. If the text starts with a `(P)` or `(S)` mode prefix, the prefix is stripped before storing. Inline markdown formatting (bold, code, links) is preserved as-is. |
| `line` | 1-based line number in the file. Accounts for blank lines, headings, and other non-task content. Used by `markTaskComplete` to locate the line for mutation. |
| `raw` | The complete original line including leading whitespace and the checkbox prefix. Example: `"  - [ ] Nested task"`. |
| `file` | The file path as passed to `parseTaskContent` or `parseTaskFile`. For `parseTaskFile`, this is the absolute path resolved by the caller. |
| `mode` | Execution mode parsed from an optional `(P)` or `(S)` prefix in the task text. `"parallel"` means the task can run concurrently with adjacent parallel tasks; `"serial"` means the task caps its group and forces sequential execution. Defaults to `"serial"` when no prefix is present. See [Markdown Syntax Reference — Mode Prefixes](./markdown-syntax.md#parallel-and-serial-mode-prefixes) for the full specification. |

Defined at `src/parser.ts:11-24`.

### TaskFile

Represents a parsed markdown file containing zero or more tasks.

```typescript
interface TaskFile {
  path: string;       // The file path
  tasks: Task[];      // All unchecked tasks found in the file
  content: string;    // Full file content (original, un-normalized)
}
```

**Field details:**

| Field | Description |
|---|---|
| `path` | Same value as `Task.file` -- the file path as provided by the caller. |
| `tasks` | Array of all unchecked tasks, in order of appearance. Empty array if no unchecked tasks exist. |
| `content` | The **original** file content as passed to `parseTaskContent`. This is the pre-normalization string -- CRLF sequences are not stripped. The orchestrator passes this field to `buildTaskContext` for planner context generation. |

Defined at `src/parser.ts:26-31`.

## Functions

### parseTaskContent

```typescript
function parseTaskContent(content: string, filePath: string): TaskFile
```

Parse markdown content (string) and return all unchecked tasks. This is a
**pure function** with no file I/O, making it suitable for testing and reuse
with content from any source.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `content` | `string` | Raw markdown content to parse |
| `filePath` | `string` | File path to associate with extracted tasks |

**Returns:** A `TaskFile` with the `content` field set to the original input
string (before CRLF normalization).

**Behavior:**

1. Normalizes CRLF line endings to LF
2. Splits content into lines
3. Tests each line against `UNCHECKED_RE` (`/^(\s*[-*]\s)\[ \]\s+(.+)$/`)
4. For each match, creates a `Task` with a sequential index and 1-based line
   number
5. Returns the `TaskFile` with the original (un-normalized) content

Defined at `src/parser.ts:69-99`.

### parseTaskFile

```typescript
async function parseTaskFile(filePath: string): Promise<TaskFile>
```

Read a file from disk and parse its contents. Thin wrapper around
`parseTaskContent` that handles file I/O.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `filePath` | `string` | Path to the markdown file to parse |

**Returns:** A `Promise<TaskFile>` containing the parsed tasks.

**Errors:**

| Condition | Error |
|---|---|
| File does not exist | Node.js `ENOENT` error |
| Permission denied | Node.js `EACCES` error |
| Path is a directory | Node.js `EISDIR` error |

**Notes:**

- Reads the file as UTF-8 (`src/parser.ts:105`)
- Accepts any file path -- does not enforce `.md` extension
- The `filePath` value is stored in `TaskFile.path` and each `Task.file`

Defined at `src/parser.ts:104-107`.

### buildTaskContext

```typescript
function buildTaskContext(content: string, task: Task): string
```

Build a filtered view of the file content for a single task's planner context.
Removes all unchecked task lines except the specified task, preserving
everything else.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `content` | `string` | Full file content (typically `TaskFile.content`) |
| `task` | `Task` | The specific task to build context for |

**Returns:** A string containing the filtered markdown content.

**What is preserved:**

- All headings, prose, notes, and blank lines
- Already-checked tasks (`[x]` and `[X]`)
- The specific unchecked task identified by `task.line`

**What is removed:**

- All other unchecked task lines (`[ ]`)

**Why this filtering exists:** The [planner](../planning-and-dispatch/planner.md) agent should focus on a single task.
Including sibling unchecked tasks would risk the planner attempting to address
multiple tasks or making incorrect assumptions. Checked tasks and prose are
kept because they provide implementation context. See
[Architecture & Concurrency](./architecture-and-concurrency.md#why-buildtaskcontext-strips-sibling-tasks)
for more detail. See also [Task Context & Lifecycle](../planning-and-dispatch/task-context-and-lifecycle.md)
for how this filtering fits into the dispatch pipeline.

Defined at `src/parser.ts:49-63`.

### markTaskComplete

```typescript
async function markTaskComplete(task: Task): Promise<void>
```

Mark a specific task as complete in its source file by replacing `[ ]` with
`[x]` on the target line. Called by the [orchestrator](../cli-orchestration/orchestrator.md) after a task is
successfully dispatched.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `task` | `Task` | The task to mark as complete. Uses `task.file` and `task.line`. |

**Returns:** `Promise<void>` -- resolves on success, rejects on error.

**Behavior:**

1. Re-reads the file from disk (for freshness -- see
   [Architecture & Concurrency](./architecture-and-concurrency.md#why-marktaskcomplete-re-reads-the-file-from-disk))
2. Splits content into lines using `\n`
3. Validates the line number is in range
4. Applies the regex replacement: `UNCHECKED_RE` -> `CHECKED_SUB`
5. Validates the replacement actually changed the line
6. Writes the full file back to disk with UTF-8 encoding

**Errors:**

| Condition | Error message |
|---|---|
| Line number out of range | `Line {n} out of range in {file} ({total} lines)` |
| Line does not match unchecked pattern | `Line {n} in {file} does not match expected unchecked pattern: "{line}"` |
| File does not exist | Node.js `ENOENT` error |
| Permission denied | Node.js `EACCES` error |

**Important caveats:**

- Always writes LF line endings regardless of the original file's style
- Not safe for concurrent calls on the same file without external
  synchronization
- See [Architecture & Concurrency](./architecture-and-concurrency.md#concurrent-task-completion)
  for concurrency analysis

Defined at `src/parser.ts:112-134`.

### groupTasksByMode

```typescript
function groupTasksByMode(tasks: Task[]): Task[][]
```

Group a flat task list into ordered execution groups based on each task's
`mode` field. The [orchestrator](../cli-orchestration/orchestrator.md) runs
each group concurrently (up to `--concurrency`), waiting for the group to
complete before starting the next one.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `tasks` | `Task[]` | Flat array of tasks (typically from `taskFiles.flatMap(tf => tf.tasks)`) |

**Returns:** An array of task groups (`Task[][]`). Each inner array is an
execution group that the orchestrator dispatches concurrently.

**Grouping algorithm:**

The algorithm iterates through tasks in order, accumulating them into groups:

1. A task with `mode === "parallel"` is appended to the current group.
2. A task with `mode === "serial"` (or no mode) is appended to the current
   group, then the group is closed. A new empty group begins.
3. If tasks remain after the loop (trailing parallel tasks not capped by a
   serial task), they form the final group.

**Examples:**

| Input task modes | Groups produced | Explanation |
|---|---|---|
| `[P, P, P, S]` | `[[P, P, P, S]]` | Three parallel tasks capped by one serial task form a single group |
| `[P, P, S, P, P, S]` | `[[P, P, S], [P, P, S]]` | Two groups, each capped by a serial task |
| `[S, S, S]` | `[[S], [S], [S]]` | Each serial task forms its own group (fully sequential) |
| `[P, P, P]` | `[[P, P, P]]` | Trailing parallel tasks without a serial cap form one group |
| `[P, S, P]` | `[[P, S], [P]]` | First serial caps the first group; trailing parallel starts a new one |
| `[]` | `[]` | Empty input produces empty output |

See [Parser Tests — groupTasksByMode](../testing/parser-tests.md#grouptasksbymode-10-tests)
for the full test coverage of this algorithm.

**Execution order guarantee:** Groups are processed sequentially (group N
completes before group N+1 starts). Within a group, tasks are dispatched
concurrently in batches of `--concurrency`. This means serial tasks act as
synchronization barriers: a serial task ensures all preceding parallel tasks
in its group complete before the next group begins.

See [Orchestrator — Concurrency Model](../cli-orchestration/orchestrator.md#concurrency-model)
for how the orchestrator uses these groups.

Defined at `src/parser.ts:146-171`.

## Internal constants

These are not exported but are important for understanding the parser's
behavior:

| Constant | Value | Purpose |
|---|---|---|
| `UNCHECKED_RE` | `/^(\s*[-*]\s)\[ \]\s+(.+)$/` | Matches an unchecked task line. Group 1 captures the prefix (whitespace + marker), group 2 captures the task text. |
| `CHECKED_RE` | `/^(\s*[-*]\s)\[[xX]\]\s+/` | Matches a checked task line. Used by test expectations but not by the core parse logic. |
| `CHECKED_SUB` | `"$1[x] $2"` | Replacement template that converts unchecked to checked using backreferences from `UNCHECKED_RE`. |
| `MODE_PREFIX_RE` | `/^\(([PS])\)\s+/` | Matches a `(P)` or `(S)` prefix at the start of extracted task text. Group 1 captures the mode letter. `P` maps to `"parallel"`, `S` maps to `"serial"`. The matched prefix is stripped from the `text` field. |

Defined at `src/parser.ts:33-36`. See
[Markdown Syntax Reference](./markdown-syntax.md#how-the-checked_sub-replacement-works)
for a detailed explanation of the replacement pattern and
[Mode Prefixes](./markdown-syntax.md#parallel-and-serial-mode-prefixes) for the
`(P)`/`(S)` prefix specification.

## Integration: Node.js File System (fs/promises)

The parser uses `readFile` and `writeFile` from `node:fs/promises`:

| Function | Used in | Purpose |
|---|---|---|
| `readFile(path, "utf-8")` | `parseTaskFile` (`src/parser.ts:105`) | Read task file content |
| `readFile(path, "utf-8")` | `markTaskComplete` (`src/parser.ts:113`) | Re-read file for freshness |
| `writeFile(path, data, "utf-8")` | `markTaskComplete` (`src/parser.ts:133`) | Write updated file content |

**Key characteristics from the [Node.js documentation](https://nodejs.org/api/fs.html#promises-api):**

- `readFile` reads the entire file into memory. For very large task files, this
  could be a concern, but task files are typically small (< 100 lines).
- `writeFile` replaces the entire file content. It is not atomic -- the file is
  truncated before writing. A crash during write could leave the file empty or
  partially written.
- Both functions accept an encoding parameter. The parser always uses `"utf-8"`.
- Errors are thrown as standard Node.js `SystemError` objects with `code`
  properties like `ENOENT`, `EACCES`, `EISDIR`.

## Related documentation

- [Overview](./overview.md) -- what the parser does and data flow
- [Markdown Syntax Reference](./markdown-syntax.md) -- regex patterns and
  accepted syntax
- [Architecture & Concurrency](./architecture-and-concurrency.md) -- I/O
  safety and race conditions
- [Testing Guide](./testing-guide.md) -- how to run and extend tests
- [Parser Tests (detailed)](../testing/parser-tests.md) -- comprehensive
  breakdown of all 62 parser tests verifying these function contracts
- [Shared Parser Types](../shared-types/parser.md) -- summary of types and
  functions from the shared-types perspective
- [Task Context & Lifecycle](../planning-and-dispatch/task-context-and-lifecycle.md) --
  how the parser functions are used within the dispatch pipeline
- [Orchestrator](../cli-orchestration/orchestrator.md) -- the primary consumer
  of `parseTaskFile`, `buildTaskContext`, and `markTaskComplete`
- [Planning & Dispatch Overview](../planning-and-dispatch/overview.md) --
  pipeline stages that consume parser output
