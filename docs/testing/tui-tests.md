# TUI Tests

This document provides a detailed breakdown of `src/tests/tui.test.ts`
(418 lines), which tests the terminal UI renderer defined in
[`src/tui.ts`](../../src/tui.ts).

## What is tested

The TUI module exports `createTui()`, which returns a controller object
with `state`, `update()`, and `stop()`. The test suite verifies:

- Initialization and default state values
- The 80ms animation interval and its cleanup
- Phase label rendering for all 5 pipeline phases
- Task status icons and labels for all 5 task statuses
- Progress bar and summary line content
- Task list windowing (completed and pending truncation)
- Worktree-grouped display mode (multi-worktree, single-worktree, and
  mixed scenarios)
- Header and issue context rendering (provider, model, source, currentIssue)
- Visual row counting for accurate cursor-up sequences

## Test setup

The test file uses several techniques to make the TUI testable in a
headless environment:

### Fake timers

All tests use `vi.useFakeTimers()` with a fixed system time
(`2025-01-01T00:00:00Z`). This makes `Date.now()` deterministic and allows
controlled advancement of the 80ms animation interval via
`vi.advanceTimersByTime()`.

### stdout mocking

`process.stdout.write` is spied on with
`vi.spyOn(process.stdout, "write").mockImplementation(() => true)`. This
captures all rendered output without printing to the terminal.
`process.stdout.columns` is set to 80 via `Object.defineProperty` to ensure
consistent text truncation behavior.

### Dynamic import

The TUI module is imported dynamically inside an `async setup()` function
(`src/tests/tui.test.ts:40-44`) so that the stdout mocks are in place
before the module initializes. This is necessary because `createTui()`
calls `draw()` immediately on creation, and the mock must capture that
first render.

### Helper functions

- **`lastOutput()`** — Returns the string argument from the most recent
  `process.stdout.write` call. Used in nearly every assertion.
- **`makeTask(text, index)`** — Creates a minimal `Task` object for testing.
- **`addTask(status, text, index, extra)`** — Pushes a `TaskState` onto
  `tui.state.tasks` with the given status and optional overrides.

## Describe blocks

The test file contains **7 describe blocks** with **27 tests** total.

### createTui (7 tests)

| Test | What it verifies |
|------|------------------|
| returns state, update, and stop | Controller object shape |
| initializes state with default values | Empty tasks, `"discovering"` phase, `filesFound: 0` |
| renders immediately on creation | First `write` call contains `"dispatch"` and `"Discovering"` |
| update() triggers a re-render | Calling `update()` produces new stdout output |
| stop() clears the animation interval | No writes after `stop()` + 200ms timer advance |
| stop() renders one final frame | `stop()` calls `draw()` once before clearing interval |
| spinner animates on interval ticks | Advancing timer by 80ms triggers additional writes |

### phase rendering (7 tests)

| Test | Phase | Expected content |
|------|-------|------------------|
| shows 'Discovering task files' | `"discovering"` | `"Discovering task file"` |
| shows 'Parsing tasks' | `"parsing"` | `"Parsing tasks"` |
| shows 'Connecting to {name}' | `"booting"` + provider | `"Connecting to opencode"` |
| shows 'Connecting to provider' when no name | `"booting"` + no provider | `"Connecting to provider"` |
| shows 'Dispatching tasks' | `"dispatching"` | `"Dispatching tasks"` |
| shows 'Complete' | `"done"` | `"Complete"` |
| shows found files count when not dispatching | `filesFound: 5` | `"Found 5 file(s)"` |

### task status rendering (8 tests)

| Test | Status | Expected label |
|------|--------|----------------|
| renders pending task | `"pending"` | `"pending"` |
| renders planning task | `"planning"` | `"planning"` |
| renders running task | `"running"` | `"executing"` |
| renders done task | `"done"` | `"done"` |
| renders failed task | `"failed"` | `"failed"` |
| renders task index as 1-based #N | any | `"#1"` |
| renders task text | `"running"` | Task text substring |
| renders error message for failed task | `"failed"` + error | Error message substring |

### progress bar and summary (5 tests)

| Test | What it verifies |
|------|------------------|
| shows progress bar in dispatching phase | Output contains `"%"` |
| shows task count (done/total) | Output contains `"2/3 tasks"` |
| shows summary with passed count | Output contains `"2 passed"` |
| shows summary with failed count | Output contains `"1 failed"` |
| shows summary with remaining count | Output contains `"remaining"` |

### task list truncation (2 tests)

| Test | What it verifies |
|------|------------------|
| shows 'earlier task(s) completed' when > 3 completed | 5 done + 1 running produces `"2 earlier task(s) completed"` |
| shows 'more task(s) pending' when > 3 pending | 5 pending produces `"2 more task(s) pending"` |

### worktree indicator rendering (6 tests)

| Test | What it verifies |
|------|------------------|
| shows issue numbers when multiple worktrees active | Multi-worktree shows `"#123"` and `"#456"` |
| hides worktree grouping when only one worktree | Single worktree uses flat mode |
| hides worktree grouping when no worktrees set | No worktree uses flat mode |
| shows issue numbers only for worktree groups | Mixed worktree/non-worktree renders correctly |
| caps running tasks at 8 with overflow indicator | 10 running shows `"2 more running"` |
| shows one row per worktree group in grouped mode | 2 worktrees with 2 tasks each show group headers |

### header and issue rendering (5 tests)

| Test | What it verifies |
|------|------------------|
| renders header with dispatch branding | Output contains `"dispatch"` |
| renders provider in header when set | Output contains provider name |
| renders model in header when set | Output contains model name |
| renders source in header when set | Output contains source name |
| renders current issue when set | Output contains `"#42"` and issue title |

### visual row counting in draw (1 test)

| Test | What it verifies |
|------|------------------|
| accounts for line wrapping when computing lastLineCount | A 200-char task at 80 cols produces a cursor-up count greater than simple line count |

This test validates the `countVisualRows()` function indirectly by
inspecting the ANSI cursor-up escape sequence (`\x1B[<N>A`) in the stdout
output on a re-render. It confirms that the cursor-up count reflects
wrapped lines, not just logical newlines.

## Testing patterns

### Output inspection via spy

All tests follow the same pattern: mutate `tui.state`, call `tui.update()`,
then inspect `lastOutput()` for expected substrings. Tests use
`.toContain()` rather than exact string matching because the output includes
ANSI escape codes from chalk that are not relevant to the assertions.

### Negative assertions for display mode

The worktree tests use `.not.toContain("[wt:")` to verify that an older
tag-based worktree display format has been replaced. This serves as a
regression guard against reintroducing the old format.

### ANSI escape sequence parsing

The visual row counting test extracts the cursor-up count from the ANSI
escape sequence using the regex `/\x1B\[(\d+)A/`. This is the only test
that inspects raw escape codes rather than rendered text content.

## Related documentation

- [Test suite overview](overview.md) -- framework, patterns, and coverage map
- [TUI documentation](../cli-orchestration/tui.md) -- full architecture and
  rendering documentation for the TUI module
- [Format Utility Tests](./format-tests.md) -- tests for `elapsed()` and
  `renderHeaderLines()`, which the TUI consumes
- [Format Utilities](../shared-types/format.md) -- API documentation for
  shared formatting functions
- [Executor & Dispatcher Tests](./executor-and-dispatcher-tests.md) --
  mock-based test suites that follow similar patterns
- [Shared Utilities Testing](../shared-utilities/testing.md) -- `timeout.test.ts`
  also uses fake timers, similar to this test suite
- [Orchestrator](../cli-orchestration/orchestrator.md) -- drives TUI state
  transitions tested here
