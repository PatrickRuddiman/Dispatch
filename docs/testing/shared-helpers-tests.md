# Shared Helpers Tests

This document covers the test infrastructure, patterns, and coverage for the
five shared helper modules located in `src/helpers/`. These test files verify
the `confirm-large-batch`, `logger`, `prereqs`, `run-state`, and `slugify`
modules.

## Test files

| Test file | Production module | Tests | Lines (test) | Lines (source) | Category |
|-----------|-------------------|-------|-------------|----------------|----------|
| [`confirm-large-batch.test.ts`](../../src/tests/confirm-large-batch.test.ts) | [`src/helpers/confirm-large-batch.ts`](../../src/helpers/confirm-large-batch.ts) | 10 | 124 | 42 | Mock-based, async |
| [`logger.test.ts`](../../src/tests/logger.test.ts) | [`src/helpers/logger.ts`](../../src/helpers/logger.ts) | 24 | 253 | 85 | Spy-based |
| [`prereqs.test.ts`](../../src/tests/prereqs.test.ts) | [`src/helpers/prereqs.ts`](../../src/helpers/prereqs.ts) | 11 | 170 | 98 | Mock-based, async |
| [`run-state.test.ts`](../../src/tests/run-state.test.ts) | [`src/helpers/run-state.ts`](../../src/helpers/run-state.ts) | 12 | 185 | 46 | Mock-based |
| [`slugify.test.ts`](../../src/tests/slugify.test.ts) | [`src/helpers/slugify.ts`](../../src/helpers/slugify.ts) | 24 | 113 | 34 | Pure logic |

**Total: 81 tests across 865 lines of test code** covering 305 lines of
production code.

## Running the tests

### All shared helpers tests

```
npx vitest run src/tests/confirm-large-batch.test.ts src/tests/logger.test.ts src/tests/prereqs.test.ts src/tests/run-state.test.ts src/tests/slugify.test.ts
```

### Single file

```
npx vitest run src/tests/logger.test.ts
```

### With coverage

```
npx vitest run --coverage src/tests/run-state.test.ts
```

The project's coverage configuration (`vitest.config.ts`) uses the v8
provider with an 80% line coverage threshold. Coverage reports exclude test
files, interface files, and barrel index files.

## Framework details

The project uses [Vitest](https://vitest.dev/) **v4.0.18** with a
`vitest.config.ts` that configures:

-   v8 coverage provider with `text` and `json` reporters
-   80% line coverage threshold
-   Module alias for `@openai/codex` mock
-   Exclusions for `node_modules/`, `dist/`, and `.worktrees/`

See the [Testing Overview](./overview.md) for framework-wide details
including debugging and CI integration.

## Testing patterns

### The vi.hoisted() + vi.mock() pattern

Three of the five test files (`confirm-large-batch`, `prereqs`, `run-state`)
use the `vi.hoisted()` pattern to create mock references that are accessible
inside `vi.mock()` factory functions. This is the most important mocking
pattern in these tests.

**Why it is necessary:** Vitest hoists `vi.mock()` calls to the top of the
file at compile time, so they execute *before* any imports. A naive approach
of declaring a `const mockFn = vi.fn()` at the top of the file and
referencing it inside `vi.mock()` would fail because the mock variable
declaration runs *after* the hoisted `vi.mock()` call.

`vi.hoisted()` solves this by returning values that are available at the
hoisted scope. The factory function passed to `vi.hoisted()` runs in the
same hoisted context as `vi.mock()`, so the returned references are safe to
use inside mock factories.

**The pattern:**

```
// Step 1: Create mock references in hoisted scope
const { mockFn } = vi.hoisted(() => ({
    mockFn: vi.fn(),
}));

// Step 2: Use hoisted references in mock factory
vi.mock("some-module", () => ({
    exportedFn: mockFn,
}));

// Step 3: Import (runs after mocks are installed)
import { exportedFn } from "some-module";

// Step 4: Control mock behavior in tests
it("does something", async () => {
    mockFn.mockResolvedValue("result");
    // ...
});
```

**Where it is used:**

| Test file | Hoisted mocks | Module mocked |
|-----------|---------------|---------------|
| `confirm-large-batch.test.ts` | `mockInput` | `@inquirer/prompts` |
| `prereqs.test.ts` | `mockExecFile` | `node:child_process`, `node:util` |
| `run-state.test.ts` | `mockReadFile`, `mockWriteFile`, `mockRename`, `mockMkdir` | `node:fs/promises` |

### Console spy pattern (logger tests)

The logger tests do not use `vi.mock()` at all. Instead, they spy on
`console.log` and `console.error` directly using `vi.spyOn()`:

```
logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
```

This approach works because the logger module calls `console.log` and
`console.error` at runtime -- there is no module-level import to intercept.
The `.mockImplementation(() => {})` suppresses actual console output during
tests. Spies are restored via `vi.restoreAllMocks()` in `afterEach`.

This pattern verifies both:

-   **Output routing:** Which console method was called (log vs error)
-   **Content:** What arguments were passed (icon prefix, message text)

### Full module mock pattern (confirm-large-batch tests)

The `confirm-large-batch.test.ts` mocks two entire modules:

1.  `@inquirer/prompts` -- Replaces `input()` with `mockInput` to simulate
    user responses without a real TTY.
2.  `../helpers/logger.js` -- Replaces the entire `log` object with
    `vi.fn()` stubs to prevent chalk-formatted console output and to assert
    that `log.warn()` was called.

This is the most thorough mocking in the test suite because the production
module depends on interactive I/O (`@inquirer/prompts`) and formatted
terminal output (`chalk` via `logger`), both of which are impractical to use
in automated tests.

### Process property override (prereqs tests)

The prereqs tests need to simulate different Node.js versions to test the
`MIN_NODE_VERSION` check. They use `Object.defineProperty` to temporarily
override `process.versions.node`:

```
Object.defineProperty(process.versions, "node", {
    value: "18.0.0",
    configurable: true,
});
```

The original value is captured before each test and restored in both
`beforeEach` and `afterEach` hooks to prevent cross-test contamination.
The `configurable: true` flag is required because `process.versions`
properties are not normally writable.

### Pure function testing (slugify tests)

The slugify tests are straightforward input/output assertions with no
mocking, spying, or setup. Each test calls `slugify(input, maxLength?)` and
asserts the returned string with `expect(...).toBe(...)`. No `beforeEach`
or `afterEach` hooks are needed because the function is pure and stateless.

Tests are organized into `describe` blocks by category:

-   Basic transformations
-   Unicode handling
-   Truncation behavior
-   Edge cases (empty input, already-valid input)
-   Real-world patterns matching actual codebase usage

## Test organization by module

### confirm-large-batch.test.ts (10 tests)

| Describe block | Tests | Coverage |
|----------------|-------|----------|
| When count is at or below threshold | 2 | Early return path |
| When count exceeds threshold | 6 | Prompt flow, case sensitivity, trimming, log.warn assertion |
| Custom threshold | 2 | Override threshold parameter |

### logger.test.ts (24 tests)

| Describe block | Tests | Coverage |
|----------------|-------|----------|
| info | 2 | Output to console.log, prefix icon |
| success | 2 | Output to console.log, prefix icon |
| warn | 2 | Output to console.log, prefix icon |
| error | 3 | Output to console.error (not console.log), prefix icon |
| task | 3 | 1-based index display, message, last task |
| dim | 2 | Output to console.log, chalk.dim passthrough |
| debug | 5 | Verbose gating, toggling, message and arrow prefix |
| formatErrorChain | 8 | Single error, nested cause, deep chain, depth limit, non-Error values, null, non-Error cause |
| extractMessage | 5 | Error instances, strings, numbers, null, undefined |

### prereqs.test.ts (11 tests)

| Scenario | Tests |
|----------|-------|
| All pass (no context) | 1 |
| Git missing | 1 |
| Node.js too old | 1 |
| Git + Node.js both fail | 1 |
| gh missing (github datasource) | 1 |
| az missing (azdevops datasource) | 1 |
| md datasource skips gh/az | 1 |
| No context skips gh/az | 1 |
| Cascading failures (git + Node + gh) | 1 |
| gh available and passes | 1 |
| az available and passes | 1 |

### run-state.test.ts (12 tests)

| Describe block | Tests | Coverage |
|----------------|-------|----------|
| loadRunState | 3 | Missing file, valid JSON, malformed JSON |
| saveRunState | 1 | Atomic write sequence (mkdir, writeFile .tmp, rename) |
| buildTaskId | 2 | Full path basename extraction, bare filename |
| shouldSkipTask | 6 | success/failed/pending/running/unknown/null |

### slugify.test.ts (24 tests)

See [Slugify](../shared-utilities/slugify.md#test-coverage) for the full
test case breakdown. The tests cover basic transformations, unicode, 
truncation, edge cases, and real-world patterns matching actual codebase
call sites.

## What is NOT tested

The following gaps exist in the current test suite:

-   **Trailing hyphen after slugify truncation.** When `.slice(0, maxLength)`
    lands immediately after a replaced character, the result ends with a
    hyphen. This is cosmetically imperfect but functionally harmless.

-   **Non-interactive terminal behavior for confirmLargeBatch.** The tests
    mock `@inquirer/prompts` entirely, so there is no coverage of what
    happens when `input()` encounters a non-TTY environment.

-   **Real filesystem I/O for run-state.** The tests mock all `fs/promises`
    functions. There is no integration test that writes and reads an actual
    `.dispatch/run-state.json` file.

-   **Process.versions.node edge cases for prereqs.** The semver comparison
    is tested with one below-minimum version (`18.0.0`) but not with
    boundary versions like `20.11.999` or `20.12.0` exactly.

-   **Logger chalk output verification.** The tests verify that message text
    appears in console output but do not assert specific ANSI color codes.
    This is intentional -- chalk output varies by terminal capability, and
    asserting raw escape codes would make tests brittle.

## Related documentation

-   [Confirm Large Batch](../shared-helpers/confirm-large-batch.md) --
    Production module documentation
-   [Prerequisite Checker](../shared-helpers/prereqs.md) -- Production
    module documentation
-   [Run State](../shared-helpers/run-state.md) -- Production module
    documentation
-   [Logger](../shared-types/logger.md) -- Logger production code
    documentation
-   [Slugify](../shared-utilities/slugify.md) -- Slugify production code
    documentation
-   [Testing Overview](./overview.md) -- Project-wide test framework,
    strategy, and full coverage map
-   [Shared Utilities Testing](../shared-utilities/testing.md) -- Testing
    patterns for the slugify and timeout utility modules
-   [Executor & Dispatcher Tests](./executor-and-dispatcher-tests.md) --
    Additional vi.mock() patterns for comparison
