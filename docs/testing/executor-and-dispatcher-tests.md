# Executor & Dispatcher Tests

This document covers the test suites for the executor agent
(`src/tests/executor.test.ts`, 225 lines, 9 tests) and the dispatcher
(`src/tests/dispatcher.test.ts`, 140 lines, 7 tests). Together, these 16
tests verify the final execution stage of the Dispatch pipeline.

Both test files use [Vitest](https://vitest.dev/) and follow the project's
mock-based testing pattern for modules that depend on external services.

## What is tested

The tests verify:

- **Executor boot validation** -- Provider requirement enforcement
- **Plan-to-prompt routing** -- Null-to-undefined coercion for the planned vs
  generic prompt path
- **Task completion lifecycle** -- `markTaskComplete` called only on success
- **Error containment** -- All exceptions converted to structured results
- **Timing accuracy** -- `elapsedMs` captures wall-clock execution time
- **Prompt content** -- Correct metadata, plan embedding, and commit instruction
  presence/absence
- **Edge cases** -- Null provider responses, empty task text, non-Error
  exceptions

## Test infrastructure

### Mocking strategy

Both test files mock their dependencies rather than using real providers or
filesystem I/O:

| Test file | Mocked modules | Reason |
|-----------|---------------|--------|
| `executor.test.ts` | `../dispatcher.js`, `../parser.js` | Isolate executor logic from dispatch and file I/O |
| `dispatcher.test.ts` | `../helpers/logger.js` | Isolate dispatcher from logger side effects |

The executor tests use Vitest's `vi.mock()` with factory functions to replace
`dispatchTask` and `markTaskComplete` with controllable fakes. The dispatcher
tests mock only the logger and use a `createMockProvider()` helper from
`src/tests/fixtures.ts` to supply a fake `ProviderInstance`.

### Shared fixtures

Both files use the same task fixture shape:

| Field | Value |
|-------|-------|
| `index` | `0` |
| `text` | `"Implement the widget"` |
| `line` | `3` |
| `raw` | `"- [ ] Implement the widget"` |
| `file` | `"/tmp/test/42-feature.md"` |

The dispatcher test imports `createMockTask()` from `src/tests/fixtures.ts`.
The executor test defines its own `TASK_FIXTURE` constant with the same values
and a local `createMockProvider()` helper (duplicated from fixtures for
module-level mock isolation).

### Reset pattern

Both test files call `vi.resetAllMocks()` in a `beforeEach` hook to clear
mock call counts, return values, and implementations between tests. This
prevents state leakage between test cases.

## Executor tests (`executor.test.ts`)

9 tests across 2 describe blocks.

### `describe("boot")`

| Test | What it verifies |
|------|-----------------|
| throws when provider is not supplied | `boot({ cwd })` without `provider` rejects with `"Executor agent requires a provider instance"` |
| returns agent with name 'executor' | `agent.name === "executor"` |
| returns agent with execute and cleanup methods | Both methods exist and are functions |

### `describe("execute")`

| Test | What it verifies | Key assertions |
|------|-----------------|----------------|
| calls dispatchTask and markTaskComplete on success | Happy path with plan string | `dispatchTask` called with `(provider, task, cwd, plan)`, `markTaskComplete` called with `(task)`, `result.success === true` |
| surfaces dispatch failure without calling markTaskComplete | Dispatch returns `{ success: false }` | `markTaskComplete` not called, error forwarded in result |
| catches dispatchTask exceptions and returns failure | `dispatchTask` throws `Error` | Exception caught, `result.error === "Session creation failed"`, `markTaskComplete` not called |
| passes undefined when plan is null | `plan: null` input | `dispatchTask` called with 4th arg `undefined`, triggers generic prompt path |
| handles non-Error exceptions | `dispatchTask` rejects with `"raw string error"` | `log.extractMessage` converts string to error message |
| tracks elapsed time in milliseconds | 20ms delay injected via mock | `elapsedMs >= 20` and `< 2000` |

#### Null-to-undefined coercion test

The test "passes undefined to dispatchTask when plan is null" verifies the
`plan ?? undefined` coercion at `src/agents/executor.ts:83`. This is the
mechanism that bridges the orchestrator's `plan: string | null` interface
with the dispatcher's `plan?: string` parameter:

- Orchestrator passes `plan: null` (planning was skipped)
- Executor converts to `undefined` via `??`
- Dispatcher receives `plan` as `undefined`, triggering `buildPrompt()` instead
  of `buildPlannedPrompt()`

#### Elapsed time test

The test "tracks elapsed time in milliseconds" injects a 20ms delay into the
mocked `dispatchTask` and asserts that `elapsedMs` is at least 20ms but less
than 2000ms. This validates the `Date.now()` timing at
`src/agents/executor.ts:78, 93, 101`.

Note: This test uses real `setTimeout`, not Vitest fake timers. The 20ms delay
is short enough for reliable CI execution but long enough to distinguish from
zero.

## Dispatcher tests (`dispatcher.test.ts`)

7 tests in 1 describe block.

### `describe("dispatchTask")`

| Test | What it verifies | Key assertions |
|------|-----------------|----------------|
| returns success when provider responds (no plan) | Happy path without plan | Result is `{ task, success: true }`, prompt contains task metadata, does NOT contain "Execution Plan" |
| returns success with planned prompt when plan is provided | Happy path with plan | Prompt contains "Execution Plan" and plan text |
| returns failure when provider returns null | `prompt()` returns `null` | Result is `{ success: false, error: "No response from agent" }` |
| returns failure when createSession throws | `createSession()` rejects | Result contains error message, `prompt()` never called |
| returns failure when prompt throws | `prompt()` rejects | Result contains error message |
| handles non-Error exceptions | `prompt()` rejects with `"raw string error"` | String exception converted to error message |
| handles empty task text | Task with `text: ""` | Dispatch still succeeds (no validation on task text) |

#### Prompt content assertions

The dispatcher tests inspect the actual prompt string passed to
`provider.prompt()` to verify correct construction:

- **No-plan prompt**: Contains working directory, source file path, line number,
  task text. Does NOT contain "Execution Plan".
- **Planned prompt**: Contains all of the above PLUS "Execution Plan" section
  header and the plan text verbatim.
- **Commit instruction**: When task text contains "commit" (word boundary match),
  prompt contains "stage all changes and create a conventional commit". When
  absent, prompt contains "Do NOT commit changes".

#### Session creation failure test

The test "returns failure when createSession throws" verifies that when
`createSession()` rejects, the error is caught and `prompt()` is never called.
This confirms that the dispatcher does not attempt to prompt on an invalid
session.

## Integration between executor and dispatcher tests

The executor tests mock `dispatchTask` entirely, so they do not exercise the
dispatcher's prompt construction logic. The dispatcher tests exercise prompt
construction directly but do not test the executor's task-completion or timing
logic. Together, they provide full coverage of the execution path:

```
Executor tests                     Dispatcher tests
--------------                     ----------------
boot validation                    prompt construction (planned/unplanned)
plan → undefined coercion          session isolation (createSession called)
markTaskComplete on success        null response handling
markTaskComplete skipped on fail   commit instruction detection
elapsedMs tracking                 error handling (session/prompt/non-Error)
error containment                  empty task text edge case
```

## Running the tests

```bash
# Run both test files
npx vitest run src/tests/executor.test.ts src/tests/dispatcher.test.ts

# Run only executor tests
npx vitest run src/tests/executor.test.ts

# Run only dispatcher tests
npx vitest run src/tests/dispatcher.test.ts

# Run in watch mode
npx vitest src/tests/executor.test.ts src/tests/dispatcher.test.ts
```

### Debugging mock behavior

If a test fails because a mock was not called as expected:

1. Check that `vi.resetAllMocks()` is running in `beforeEach` -- stale mock
   state from a previous test is the most common cause.
2. Verify the mock factory in `vi.mock()` matches the import path exactly.
   Vitest hoists `vi.mock()` calls to the top of the file, so they execute
   before any imports.
3. Use `vi.mocked(fn).mock.calls` to inspect the actual arguments passed to
   a mock in a failing test.

### Running tests in isolation

To run a single test case, use Vitest's `-t` flag:

```bash
npx vitest run src/tests/executor.test.ts -t "passes undefined to dispatchTask when plan is null"
```

Or temporarily change `it(` to `it.only(` in the test file and run in watch
mode.

## Related documentation

- [Executor Agent](../planning-and-dispatch/executor.md) -- Production module
  documented by `executor.test.ts`
- [Dispatcher](../planning-and-dispatch/dispatcher.md) -- Production module
  documented by `dispatcher.test.ts`
- [Testing Overview](./overview.md) -- Test suite structure, framework, and
  patterns
- [Parser Tests](./parser-tests.md) -- Parser test suite (tests the
  `markTaskComplete` function mocked by executor tests)
- [Shared Test Fixtures](../../src/tests/fixtures.ts) -- `createMockProvider`
  and `createMockTask` helpers
- [Provider Abstraction](../provider-system/provider-overview.md) -- The
  `ProviderInstance` interface used by mock providers in tests
