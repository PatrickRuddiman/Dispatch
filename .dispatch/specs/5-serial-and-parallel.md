# Serial and Parallel (#5)

> Add `(P)` / `(S)` execution-mode tags to tasks so the orchestrator can run parallel-safe tasks concurrently within groups while serializing dependent tasks, replacing the current flat batch-sequential dispatch loop.

** NOTE: [ u ] is used here to denote an unchecked task, so as not to confuse the parser when parsing this task. You as an AI should understand its meaning

## Context

Dispatch is a TypeScript CLI tool that reads markdown task files containing `- [ u ]` checkboxes, sends each task to an AI agent for implementation, marks them complete, and commits the result. The project uses Node.js 18+, ESM modules, npm, tsup for bundling, and Vitest for testing.

The key modules involved in this change are:

- **`src/parser.ts`** — The markdown parser. Exports the `Task` interface (with fields `index`, `text`, `line`, `raw`, `file`) and functions `parseTaskContent`, `parseTaskFile`, `markTaskComplete`, and `buildTaskContext`. The `UNCHECKED_RE` regex extracts the task text from `- [ u ] <text>` lines. This is where mode extraction must be added.

- **`src/agents/orchestrator.ts`** — The core dispatch pipeline. Contains the `orchestrate()` method which discovers files, parses tasks, boots the provider/planner, and runs a dispatch loop. The current dispatch loop (`while (queue.length > 0)`) splices batches of `concurrency` size from a flat queue and runs them with `Promise.all`. This loop must be replaced with group-aware execution.

- **`src/dispatcher.ts`** — Builds prompts and dispatches individual tasks to the AI provider. Contains `buildPrompt` (no-plan mode) and `buildPlannedPrompt` (with-plan mode). The executor constraints section in `buildPlannedPrompt` should be hardened to prevent the executor from exploring or planning.

- **`src/spec-generator.ts`** — Contains `buildSpecPrompt` which instructs the spec agent to write task files. This prompt needs to be updated to tell the spec agent about `(P)` / `(S)` tagging syntax and to encourage parallelism by default.

- **`src/parser.test.ts`** — The only test file, co-located with the parser. Uses Vitest with `describe`/`it`/`expect` conventions, temp directories for I/O tests, and `toMatchObject`/`toHaveLength`/`toBe` assertions. New parser and grouping tests should follow these conventions.

- **`src/tui.ts`** — The terminal dashboard. Imports `Task` from the parser. No changes needed but it is a downstream consumer of the `Task` interface.

- **`src/agents/planner.ts`** — The planner agent. Also imports `Task`. No changes needed but it is a downstream consumer.

## Why

Currently, Dispatch processes all tasks in a flat queue with simple batch concurrency (`--concurrency N`). Every batch of N tasks runs simultaneously regardless of whether the tasks have dependencies on each other. This has two problems:

1. **Wasted throughput** — Tasks that are independent (e.g., adding tests in two separate modules) cannot be parallelized unless they happen to fall in the same batch.
2. **Correctness risk** — Tasks that depend on prior tasks (e.g., "refactor X" then "update tests for X") may run concurrently and conflict.

The `(P)` (parallel) and `(S)` (serial) mode tags solve both problems by letting spec authors explicitly declare which tasks are safe to run concurrently. The grouping algorithm then ensures serial tasks act as barriers: all prior work completes before a serial task starts, and it completes before subsequent work begins.

This is critical for the dispatch pipeline's correctness and efficiency as task files grow more complex.

## Approach

### 1. Task Mode Extraction (Parser Layer)

Extend the `Task` interface with an optional `mode` field (`"parallel" | "serial"`) that defaults to `"serial"` when unspecified. Update `parseTaskContent` to detect and strip `(P)` or `(S)` prefixes from the task text. The prefix appears at the start of the text after `- [ y ] `, e.g.:

```
- [ u ] (P) Add validation to the user form
- [ u ] (S) Refactor the orchestrator dispatch loop
- [ u ] No prefix defaults to serial
```

The `(P)`/`(S)` prefix should be stripped from `task.text` so downstream consumers (planner, executor, TUI) see clean task descriptions. The `raw` field should continue to contain the full original line. The extraction should be done as a post-processing step after the existing regex match, not by modifying `UNCHECKED_RE` — this keeps the regex simple and the mode logic isolated.

### 2. Task Grouping Algorithm

Implement a pure function `groupTasksByMode` in `src/parser.ts` that converts a flat `Task[]` into an ordered array of `Task[][]` (groups). The algorithm:

- Iterate through tasks in order
- Accumulate consecutive `(P)` tasks into the current group
- When an `(S)` task is encountered, add it to the current group (capping it), then start a new group
- A lone `(S)` task (no preceding P tasks) forms a solo group

Example: `P S S P P P` produces `[[P, S], [S], [P, P, P]]`

This function is pure (no I/O) and highly testable. It lives in the parser module alongside the other task utilities.

### 3. Orchestrator Dispatch Refactor

Replace the flat `while (queue.length > 0)` loop in `orchestrate()` with a group-aware loop:

1. Call `groupTasksByMode(allTasks)` to get execution groups
2. For each group, dispatch all tasks in the group concurrently (respecting the `--concurrency` cap)
3. Wait for the entire group to complete before starting the next group

This preserves the existing plan-then-execute flow per task, the TUI state updates, the mark-complete and commit steps, and error handling. The refactor is surgical — only the dispatch loop changes, not the per-task dispatch logic.

### 4. Spec Agent Prompt Update

Update `buildSpecPrompt` in `src/spec-generator.ts` to instruct the spec agent about `(P)` / `(S)` tagging. The prompt should:

- Explain the syntax: `(P)` for parallel-safe, `(S)` for serial/dependent
- Explain the default: untagged tasks are treated as serial
- Encourage parallelism: most tasks should be `(P)` unless they depend on a prior task's output
- Provide an example showing the tag syntax in task checkboxes

### 5. Executor Prompt Hardening

Update `buildPlannedPrompt` in `src/dispatcher.ts` to add explicit constraints that prevent the executor agent from:

- Exploring the codebase (the planner already did this)
- Re-planning or questioning the plan
- Working on tasks other than the assigned one

This makes the executor more reliable when running multiple tasks in parallel.

### 6. Tests

Add comprehensive tests following the existing Vitest conventions in `src/parser.test.ts`:

- Parser tests for `(P)` / `(S)` extraction: correct mode assignment, prefix stripping, default behavior, edge cases
- Tests for `groupTasksByMode`: the core algorithm with various mode sequences, empty input, all-P, all-S, mixed patterns

## Integration Points

- **`Task` interface** (`src/parser.ts`) — Adding the `mode` field is the foundational change. All downstream consumers import `Task`: `src/dispatcher.ts`, `src/agents/orchestrator.ts`, `src/agents/planner.ts`, `src/tui.ts`. Since `mode` is optional and defaults to `"serial"`, existing behavior is preserved without changes to consumers.

- **`parseTaskContent` function** (`src/parser.ts`) — The mode extraction logic plugs into the existing parse loop. The `UNCHECKED_RE` regex captures `match[2]` as the task text; mode extraction should operate on this captured text.

- **`buildTaskContext` function** (`src/parser.ts`) — Uses `UNCHECKED_RE` to filter lines. Since the raw lines still contain the `(P)`/`(S)` prefix (it is only stripped from `task.text`), no changes are needed here.

- **Orchestrator dispatch loop** (`src/agents/orchestrator.ts`, lines 157-208) — The `while (queue.length > 0)` loop with `queue.splice(0, concurrency)` batching must be replaced. The new loop iterates over groups from `groupTasksByMode`, dispatching each group's tasks with `Promise.all` (still capped by `concurrency`).

- **`buildSpecPrompt`** (`src/spec-generator.ts`) — The task template section that shows `- [ y ] First task...` examples must be updated to include `(P)` / `(S)` syntax and guidance.

- **`buildPlannedPrompt`** (`src/dispatcher.ts`) — The "Executor Constraints" section at the end of the prompt should be extended with anti-exploration directives.

- **Test framework** — Vitest with co-located `*.test.ts` files. Tests use `describe`/`it`/`expect`, `toMatchObject` for partial object assertions, and `toHaveLength` for array length checks. New tests should follow the same patterns as the existing 31 test cases in `src/parser.test.ts`.

- **Build system** — tsup bundles `src/cli.ts` as the single entry point. New exports from `src/parser.ts` (like `groupTasksByMode`) are automatically included since the orchestrator imports from the parser.

## Tasks

- [x] (P) Extend the `Task` interface in `src/parser.ts` with an optional `mode` field (`"parallel" | "serial"`) and update `parseTaskContent` to extract and strip `(P)`/`(S)` prefixes from the task text, defaulting to `"serial"` when no prefix is present

- [x] (P) Update `buildSpecPrompt` in `src/spec-generator.ts` to instruct the spec agent to tag tasks with `(P)` or `(S)` prefixes, explain the semantics (parallel-safe vs. serial/dependent), encourage parallelism as the default, and show example syntax

- [x] (P) Harden the executor constraints in `buildPlannedPrompt` in `src/dispatcher.ts` to explicitly forbid codebase exploration, re-planning, and deviation from the provided plan — ensuring the executor stays focused when running in parallel with other executors

- [x] (S) Implement and export `groupTasksByMode` in `src/parser.ts` — a pure function that takes a flat `Task[]` and returns `Task[][]` where consecutive parallel tasks accumulate into groups, serial tasks cap the current group, and lone serial tasks form solo groups

- [ ] (S) Refactor the dispatch loop in `src/agents/orchestrator.ts` to call `groupTasksByMode`, then iterate over each group dispatching all tasks in the group concurrently (respecting `--concurrency`) and waiting for the group to complete before starting the next

- [ ] (S) Add Vitest tests for `(P)`/`(S)` mode extraction in the parser — covering correct mode assignment, prefix stripping from `task.text`, default serial behavior for untagged tasks, whitespace variations, and edge cases with special characters after the prefix

- [ ] (S) Add Vitest tests for `groupTasksByMode` — covering the core grouping algorithm with sequences like `P,S,S,P,P,P`, empty input, all-parallel, all-serial, single task, and verifying group boundaries match the specification

## References

- Issue: https://github.com/PatrickRuddiman/Dispatch/issues/5
- Existing parser tests: `src/parser.test.ts` (31 test cases demonstrating Vitest conventions)
- Orchestrator dispatch loop: `src/agents/orchestrator.ts` (the `while (queue.length > 0)` batch loop)
- Spec agent prompt: `src/spec-generator.ts` (`buildSpecPrompt` function)
- Executor prompt: `src/dispatcher.ts` (`buildPlannedPrompt` function)
