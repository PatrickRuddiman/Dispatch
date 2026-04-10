# Planner & Executor Agent Tests

This document covers the two test files that verify the planner and executor
agents: `src/tests/planner.test.ts` and `src/tests/executor.test.ts`. Together
they validate the agent boot lifecycle, prompt construction, provider
interaction, error handling, task completion coupling, and worktree isolation
passthrough.

## Test file inventory

| Test file | Production module | Lines (test) | Test count | Category |
|-----------|-------------------|-------------|------------|----------|
| `executor.test.ts` | `src/agents/executor.ts` | 257 | 10 | Module mock, dispatch + mark-complete |
| `planner.test.ts` | `src/agents/planner.ts` | 326 | 20 | Provider mock, prompt construction |

**Total: 583 lines of test code** covering 30 tests across 2 files.

## What these tests verify

Both test files follow a common structural pattern: they mock external
dependencies, import the production module's `boot()` function, create an
agent instance, and test the agent's methods. Each test file verifies:

- **Boot**: Provider requirement validation, agent name, method presence
- **Core operation**: Happy-path success, provider interaction, return type
- **Error handling**: Dispatch/prompt failures, exception catching, non-Error
  exceptions
- **Timing**: Elapsed time tracking via `durationMs`
- **Worktree isolation**: `worktreeRoot` passthrough behavior

## Executor agent tests

**File**: `src/tests/executor.test.ts` (257 lines, 10 tests)
**Production module**: `src/agents/executor.ts`

### What is tested

| Describe block | Tests | What is verified |
|----------------|-------|------------------|
| `boot` | 3 | Provider requirement, agent name, method presence (`execute`, `cleanup`) |
| `execute` | 7 | Dispatch + mark-complete, failure handling, exception catching, null-plan passthrough, non-Error exceptions, timing, worktree passthrough |

### Mocking strategy

The executor tests mock two production modules rather than external SDKs:

| Mocked module | Mock target | Purpose |
|---------------|-------------|---------|
| `../dispatcher.js` | `dispatchTask` | Isolate executor from provider interaction |
| `../parser.js` | `markTaskComplete` | Isolate executor from filesystem I/O |

This approach tests the executor's coordination logic — its decision to call
`markTaskComplete` on success, skip it on failure, and catch exceptions — without
involving any real AI provider or file operations.

The test file also defines a local `createMockProvider()` helper that creates
a conformant `ProviderInstance` with mock methods. This is used only by the
`boot()` tests; the `execute()` tests interact with the mocked `dispatchTask`
directly.

### Key test behaviors

#### Dispatch success triggers `markTaskComplete`

The test "calls dispatchTask and markTaskComplete on success" verifies the
critical coupling between dispatch and task completion:

1. `dispatchTask` returns `{ success: true }`
2. `markTaskComplete` is called with the task
3. The result has `success: true` and `data.dispatchResult`

#### Dispatch failure skips `markTaskComplete`

The test "surfaces dispatch failure without calling markTaskComplete" verifies
that failed dispatches leave the task unchecked:

1. `dispatchTask` returns `{ success: false, error: "..." }`
2. `markTaskComplete` is **not** called
3. The result has `success: false` and `data: null`

#### Null plan coercion

The test "passes undefined to dispatchTask when plan is null" verifies the
`plan ?? undefined` coercion at `src/agents/executor.ts:71`. When the
executor receives `plan: null` (planning was skipped), it passes `undefined`
to `dispatchTask`, which triggers the simple (non-planned) prompt path in
the [dispatcher](../planning-and-dispatch/dispatcher.md).

#### Worktree passthrough

The test "passes worktreeRoot to dispatchTask when provided in input" verifies
that the optional `worktreeRoot` field in `ExecuteInput` is forwarded to
`dispatchTask` as the fifth argument, enabling
[worktree isolation](../planning-and-dispatch/dispatcher.md#worktree-isolation)
in the prompt.

## Planner agent tests

**File**: `src/tests/planner.test.ts` (326 lines, 20 tests)
**Production module**: `src/agents/planner.ts`

### What is tested

| Describe block | Tests | What is verified |
|----------------|-------|------------------|
| `boot` | 3 | Provider requirement, agent name, method presence (`plan`, `cleanup`) |
| `plan` | 16 | Session creation, prompt metadata, file context inclusion/omission, empty/whitespace/null response failures, session exception, prompt exception, non-Error exceptions, timing, cwd override, boot-time cwd fallback, worktree isolation (6 tests) |
| `cleanup` | 1 | Resolves without error |

### Mocking strategy

Unlike the executor tests, the planner tests do **not** mock any production
modules. Instead, they mock at the provider level using `createMockProvider()`
from `src/tests/fixtures.ts` and verify the prompt content sent to the
provider:

| What is mocked | How | Purpose |
|----------------|-----|---------|
| `provider.createSession` | `vi.fn().mockResolvedValue("session-1")` | Return deterministic session ID |
| `provider.prompt` | `vi.fn().mockResolvedValue(...)` | Control plan output |

This approach tests the planner's prompt construction logic end-to-end: given
a task and optional context, does the planner produce a prompt containing the
expected metadata, context, and instructions?

### Key test behaviors

#### Prompt metadata verification

The test "includes task metadata in the prompt sent to the provider" verifies
that the planning prompt contains:
- The working directory path
- The task's source file path
- The task's line number
- The task text

#### File context inclusion

Two tests verify the conditional inclusion of file context:
- "includes file context in the prompt when provided" — checks for the
  `"Task File Contents"` section header and the context text
- "does not include file context section when fileContext is not provided" —
  checks that the section is absent

#### Empty response handling

Three tests cover the planner's response validation:
- Empty string `""` → failure with "Planner returned empty plan"
- Whitespace-only `"   \n  \t  "` → failure with "Planner returned empty plan"
- `null` → failure with "Planner returned empty plan"

This validates the `!plan?.trim()` check at `src/agents/planner.ts:69`.

#### CWD override behavior

Two tests verify the working directory override mechanism:
- "uses cwd override in prompt when provided" — the override replaces the
  boot-time cwd
- "falls back to boot-time cwd when cwd override is not provided" — the
  boot-time cwd is used when no override is given

This validates the `cwdOverride ?? cwd` expression at
`src/agents/planner.ts:63`.

#### Worktree isolation tests (6 tests)

The worktree isolation suite is the most thorough section, covering:

| Test | Verifies |
|------|----------|
| Includes worktree isolation when worktreeRoot is provided | `"Worktree Isolation"` section appears |
| Does not include worktree isolation when worktreeRoot is not provided | Section is absent |
| Includes all worktree restriction instructions | Three restriction rules present |
| Includes both file context and worktree isolation when both are provided | Both sections coexist |
| Places worktreeRoot in isolation section and cwd in task section independently | Different paths in different sections |
| Does not include worktree isolation when worktreeRoot is empty string | Empty string treated as falsy |
| Includes worktree isolation with boot-time cwd when no cwd override | Both features work with boot-time cwd |

## Testing patterns

### Module-level mocking (executor)

The executor tests use `vi.mock()` at the module level to replace
`dispatchTask` and `markTaskComplete` before the production module is
imported. This is necessary because the executor calls these functions
directly (not via injected dependencies):

```typescript
vi.mock("../dispatcher.js", () => ({
  dispatchTask: vi.fn(),
}));

vi.mock("../parser.js", () => ({
  markTaskComplete: vi.fn(),
}));

import { dispatchTask } from "../dispatcher.js";
import { markTaskComplete } from "../parser.js";
import { boot } from "../agents/executor.js";
```

After import, tests configure return values per-test using `vi.mocked()`:

```typescript
const mockDispatch = vi.mocked(dispatchTask);
mockDispatch.mockResolvedValue({ task: TASK_FIXTURE, success: true });
```

### Provider-level mocking (planner)

The planner tests mock at a higher level — the provider interface — since
the planner's only external dependency is the provider. The shared
`createMockProvider()` fixture accepts partial overrides:

```typescript
const provider = createMockProvider({
  prompt: vi.fn().mockResolvedValue("Step 1: do X"),
});
```

This approach is simpler and more focused: it tests what prompt the planner
sends to the provider and what it does with the provider's response.

### Shared test fixtures

The planner tests import `createMockProvider` and `createMockTask` from
[`src/tests/fixtures.ts`](./test-fixtures.md). The executor tests define their own local
`createMockProvider()` and `TASK_FIXTURE`. Both fixture implementations
produce equivalent mock objects with the same shape:

| Fixture | Planner tests | Executor tests |
|---------|---------------|----------------|
| Mock provider | `createMockProvider()` from `fixtures.ts` | Local `createMockProvider()` |
| Mock task | `createMockTask()` from `fixtures.ts` | Local `TASK_FIXTURE` constant |

The local definitions in the executor test file produce identical objects to
the shared fixtures (same field values: `index: 0`, `text: "Implement the widget"`,
`line: 3`, `file: "/tmp/test/42-feature.md"`).

### Mock reset with `beforeEach`

Both test files call `vi.resetAllMocks()` in a `beforeEach` hook within the
`execute`/`plan` describe blocks. This ensures test isolation — each test
starts with clean mocks regardless of what previous tests configured.

## Integration: Vitest

**Key Vitest features used in these tests**:

| Feature | Usage | Why |
|---------|-------|-----|
| `vi.mock()` | `executor.test.ts` (2 module mocks) | Replace `dispatchTask` and `markTaskComplete` |
| `vi.fn()` | Both files | Create mock functions with call tracking |
| `vi.mocked()` | `executor.test.ts` | Type-safe access to mock `.mock.calls` |
| `vi.resetAllMocks()` | Both files (in `beforeEach`) | Reset mock state between tests |
| `expect(...).rejects.toThrow()` | Both files | Assert boot failures |
| `expect(...).toHaveBeenCalledWith()` | Both files | Verify function call arguments |
| `expect.stringContaining()` | `planner.test.ts` | Partial prompt content matching |

## How to run

```sh
# Run both planner and executor tests
npx vitest run src/tests/executor.test.ts src/tests/planner.test.ts

# Run executor tests only
npx vitest run src/tests/executor.test.ts

# Run planner tests only
npx vitest run src/tests/planner.test.ts

# Run in watch mode
npx vitest src/tests/planner.test.ts

# Run with verbose output
npx vitest run --reporter=verbose src/tests/executor.test.ts src/tests/planner.test.ts
```

All tests run without network access, installed CLI tools, or API credentials
because all external interactions are mocked.

### Are there integration tests for the full plan-then-execute flow?

No. These tests verify each agent in isolation. There is no test that boots
both a planner and executor with a real (or fully mocked) provider and runs
the complete plan → execute → mark-complete flow. Integration testing for
this flow would require either:

- A mock provider that returns realistic plan text and executor responses
- An end-to-end test that boots a real provider (e.g., via `--server-url`)

The `src/tests/integration/dispatch-flow.test.ts` file tests the dispatch
pipeline at a higher level but uses mocked agents. See the
[testing overview](./overview.md) for the full test coverage map.

See also the [shared utilities testing](../shared-utilities/testing.md)
documentation for related fake timer and pure-function testing patterns.

## Related documentation

- [Testing Overview](./overview.md) — Project-wide test strategy and coverage
- [Provider Tests](./provider-tests.md) — Similar mock patterns for provider
  backends
- [Executor Agent](../agent-system/executor-agent.md) — Production behavior
  of the executor
- [Planner Agent](../agent-system/planner-agent.md) — Production behavior
  of the planner
- [Dispatcher](../planning-and-dispatch/dispatcher.md) — The `dispatchTask`
  function mocked by executor tests
- [Agent Types](../planning-and-dispatch/agent-types.md) — `AgentResult<T>`,
  `ExecutorData`, and `PlannerData` types verified by these tests
- [Task Parsing API Reference](../task-parsing/api-reference.md) —
  `markTaskComplete` function mocked by executor tests
- [Pipeline Overview](../planning-and-dispatch/overview.md) — How planner and
  executor fit into the dispatch pipeline
- [Test Fixtures](./test-fixtures.md) — Shared mock factories
  (`createMockProvider`, `createMockTask`) consumed by planner tests
- [Shared Utilities Testing](../shared-utilities/testing.md) — Related
  testing patterns (fake timers, pure-function testing) used across the project
- [Git & Worktree Testing](../git-and-worktree/testing.md) — Related test
  suite that exercises worktree creation/removal, relevant to worktree
  isolation passthrough tests
- [Concurrency Utility](../shared-utilities/concurrency.md) —
  `runWithConcurrency()` model used for parallel execution in the pipeline
  tested here
- [Timeout Utility](../shared-utilities/timeout.md) — `withTimeout()` wrapper
  used for plan generation deadlines
- [Configuration](../cli-orchestration/configuration.md) — `planTimeout`,
  `planRetries`, and `concurrency` settings exercised by these tests
