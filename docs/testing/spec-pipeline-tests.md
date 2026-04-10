# Spec Pipeline Tests

This document covers the test file that verifies the spec generation pipeline
(`src/orchestrator/spec-pipeline.ts`): source resolution, the three input
modes (tracker, inline text, file/glob), datasource sync, concurrent
generation, retry logic, dry-run mode, and spec generation timeouts.

## Test file inventory

| Test file | Production module | Lines (test) | Test count | Category |
|-----------|-------------------|-------------|------------|----------|
| `spec-pipeline.test.ts` | `src/orchestrator/spec-pipeline.ts` | 1,356 | 48 | Module mocks, pipeline lifecycle |

## What these tests verify

`spec-pipeline.test.ts` provides end-to-end coverage of `runSpecPipeline()`,
the function that turns issue numbers, inline text, or file globs into
generated spec documents. The tests exercise every input mode, every error
path, the [retry loop](../shared-utilities/overview.md), the [sliding-window concurrency model](../shared-utilities/overview.md), and the per-item
timeout mechanism.

## Mock architecture

The test uses Vitest's `vi.hoisted()` block to define mock references that
are shared across all `vi.mock()` calls. This ensures the mocks are available
before ESM module initialization:

| Mocked module | Key mock functions | Purpose |
|---------------|-------------------|---------|
| `agents/spec.js` | `boot` → `generate`, `cleanup` | Spec agent with configurable `generate()` |
| `providers/index.js` | `bootProvider` | Returns mock provider with `createSession`, `prompt`, `cleanup` |
| `datasources/index.js` | `getDatasource` | Returns mock datasource with `fetch`, `update`, `create` |
| `datasources/md.js` | `extractTitle` | Returns `"Mock Title"` for file rename logic |
| `spec-generator.js` | `isIssueNumbers`, `isGlobOrFilePath`, `resolveSource`, `defaultConcurrency` | Input classification and source resolution |
| `node:fs/promises` | `mkdir`, `readFile`, `rename`, `unlink` | File operations for spec output |
| `glob` | `glob` | File glob resolution for file/glob mode |
| `helpers/confirm-large-batch.js` | `confirmLargeBatch` | Large batch safety prompt |
| `helpers/auth.js` | `ensureAuthReady`, `setAuthPromptHandler` | Auth lifecycle |
| `helpers/logger.js` | `log` | Silent logger with `vi.fn()` for all methods |
| `helpers/cleanup.js` | `registerCleanup` | Cleanup registration (no-op) |
| `helpers/format.js` | `elapsed`, `renderHeaderLines` | Formatting (deterministic returns) |
| `helpers/slugify.js` | `slugify` | Simplified slug implementation for filename generation |

### Shared test infrastructure

The test imports [`createMockDatasource`](test-fixtures.md) from `src/tests/fixtures.ts` to
construct datasource mocks with the correct interface shape. The `beforeEach`
block configures the datasource via `createMockDatasource("github", {...})`
by default, switching to `createMockDatasource("md", {...})` for tests that
exercise md-datasource-specific behavior.

### Helper functions

| Helper | Purpose |
|--------|---------|
| `deferred<T>()` | Creates a manually-resolvable promise for controlling async timing in concurrency tests |
| `baseOpts(overrides?)` | Returns a minimal `SpecOptions` object with sensible defaults (`issues: "1,2"`, `provider: "opencode"`, `concurrency: 1`) |

## Test suites

The test file is organized into thirteen `describe` blocks within a single
top-level `describe("runSpecPipeline")`:

### Source resolution (1 test)

Verifies the early-exit path when `resolveSource()` returns `null`:

- **Returns zero counts** — `total: 0`, `generated: 0`, `failed: 0`, empty
  `files` and `issueNumbers` arrays

### Tracker mode (6 tests)

Verifies the primary input mode where issues are specified by number:

| Test | What is verified |
|------|------------------|
| Fetches issues and generates specs | Two-issue batch: `fetch` x2, `generate` x2, `update` x2, correct counts |
| Returns early on empty issues | Empty string input logs error, returns zero counts |
| Handles fetch errors gracefully | One fetch fails, one succeeds: `generated: 1`, `failed: 1` |
| Returns failed count on all failures | All fetches reject: logs "No issues could be loaded", `failed: 2` |
| Handles spec generation failure | `generate()` returns `{ success: false }`: `failed: 1` |
| Handles datasource update failure | `update()` rejects: warns "Could not sync", still counts as generated |

The sixth test (`keeps multi-item tracker generation scoped per item`) is the
most detailed — it verifies that `buildSpecPrompt()` produces per-item prompts
containing scoping language ("scoped to exactly one source item",
"single passed issue, file, or inline request") and that each prompt contains
only its own issue's title and body, not the other issue's content.

### Inline text mode (1 test)

Verifies the free-text input path where `isIssueNumbers()` returns `false`
and `isGlobOrFilePath()` returns `false`:

- **Generates spec from inline text** — `generate()` called once with a
  `filePath` argument, `total: 1`, `generated: 1`

### File/glob mode (5 tests)

Verifies the file-based input path where `isGlobOrFilePath()` returns `true`:

| Test | What is verified |
|------|------------------|
| Resolves files from glob | Two matches: `generated: 2`, `failed: 0` |
| Returns early on no matches | Empty glob: logs "No files matched", zero counts |
| Handles file read errors | `readFile` rejects: logs "No files could be loaded", `failed: 1` |
| Creates new issue (tracker datasource) | Non-md datasource: `create()` called, `unlink()` deletes local file, issue number `"99"` in results |
| Creates numbered spec (md datasource, no ID prefix) | md datasource without numeric prefix: `create()` called, original file deleted, issue number `"99"` |
| Updates spec in-place (md datasource, has ID prefix) | md datasource with `3-my-feature.md`: `update("3", ...)` called, no `create()`, no `unlink()` |

The last two tests verify the md-datasource respec behavior: files with an
existing numeric ID prefix (e.g., `3-my-feature.md`) are updated in place,
while files without a prefix are created as new numbered specs.

### Datasource sync (4 tests)

Verifies the post-generation sync workflow:

| Test | What is verified |
|------|------------------|
| Updates existing issue in tracker mode | `update("1", "Test Issue", ...)` called, local spec deleted via `unlink()` |
| Logs success after local deletion | When `log.verbose` is `true`, logs "Deleted local spec" |
| Warns on sync failure | `update()` rejects: warns "Could not sync", does not delete local file |
| Creates new issue in file mode | File mode with tracker datasource: `create()` called, `unlink()` deletes original |

### Cleanup (2 tests)

Verifies resource teardown:

- **Calls both cleanup methods** — `specAgent.cleanup()` and
  `instance.cleanup()` each called once
- **Completes without intermediate feedback** — Pipeline succeeds even when
  `generate()` produces no streaming events

### Concurrent spec generation (1 test)

Verifies that concurrent generation does not cross-wire item results:

- Uses `deferred<T>()` to control resolution order — item 2 resolves before
  item 1
- Verifies that `update()` calls match the correct issue number to the
  correct generated content (issue 1 gets "Spec One", issue 2 gets "Spec Two")
- Validates `total: 2`, `generated: 2`, `failed: 0`

### Defensive guard for null details (1 test)

Verifies the safety net when `details` is unexpectedly `null` in the
generation loop:

- Patches `Array.prototype.filter` to bypass the `validItems` type-predicate
  filter, simulating a future refactor that might let null-details items through
- Asserts `log.error("Skipping item 2: missing issue details")`
- Confirms the null-details item is counted as failed

This test exists to prevent silent failures if the upstream filter logic is
ever accidentally removed.

### Summary output (2 tests)

Verifies the end-of-pipeline user-facing output:

- **Logs dispatch hint** — `log.dim()` called with `"dispatch 1,2"` for
  numeric identifiers
- **Includes timing metadata** — Result contains `durationMs >= 0` and
  `fileDurationsMs` object

### Rename after generation (1 test)

Verifies that spec files are renamed based on the H1 title extracted from the
generated content:

- `extractTitle()` returns `"New Title"` → `rename()` is called
- Result `files` array has one entry

### Large batch confirmation (2 tests)

Verifies the safety prompt for large batches:

| Test | What is verified |
|------|------------------|
| Prompts for confirmation | 101 items → `confirmLargeBatch(101)` called |
| Returns early on decline | User declines → zero counts, `generate()` never called |

### Error paths (2 tests)

Verifies error handling for two distinct failure modes:

| Test | What is verified |
|------|------------------|
| Exception from `generate()` | `generate()` throws (not just `{ success: false }`): `failed: 1`, logs "Failed to generate spec" |
| Provider cleanup throws | `cleanup()` rejects: pipeline still returns successful result, warns "Provider cleanup failed" |

### Batch partial-failure (2 tests)

Verifies mixed success/failure in concurrent batches:

| Test | What is verified |
|------|------------------|
| Mixed results | 5 issues, 3 succeed, 2 fail (fetch rejects): `generated: 3`, `failed: 2` |
| All fail concurrently | 5 issues, all fetches reject: `generated: 0`, `failed: 5`, no throw |

### Dry-run mode (6 tests)

Verifies the preview mode that skips actual generation:

| Test | What is verified |
|------|------------------|
| Returns summary with generated: 0 | `bootProvider` not called, `total: 2`, `generated: 0` |
| Does not call confirmLargeBatch | Safety prompt skipped in dry-run |
| Does not write files or generate | `mkdir` and `generate` not called |
| Logs structured preview | `log.info("[DRY RUN]")` and `"Would generate spec for #1"` / `"#2"` |
| Returns failed count for load errors | One fetch fails: `failed: 1`, `generated: 0` |
| Works in file/glob mode | Glob resolves one file: `total: 1`, `generated: 0`, no provider boot |

### Retry logic (4 tests)

Verifies the per-item retry mechanism:

| Test | What is verified |
|------|------------------|
| Succeeds on retry | `generate()` fails once, succeeds on second: `generated: 1`, warns "Attempt 1/2 failed" |
| Exhausts all retries | `retries: 2` → 3 total attempts, all fail: `failed: 1` |
| No retry at retries: 0 | One attempt only: `generated: 0`, `failed: 1` |
| Default retries is 3 | Unspecified retries → 4 total attempts (1 initial + 3 retries) |

### Auth prompt handler (1 test)

Verifies that the spec pipeline does **not** touch the auth prompt handler:

- `setAuthPromptHandler` is never called — spec mode uses `log.info()` output
  for auth prompts since there is no TUI

### Sliding-window spec queue concurrency (5 tests)

Verifies the sliding-window concurrency model using fake timers:

| Test | What is verified |
|------|------------------|
| Starts new items as slots open | Item 1 takes 200ms, item 2 takes 50ms. After item 2 finishes, item 3 starts immediately (doesn't wait for item 1) |
| Respects concurrency limit | 6 items, concurrency 3: `maxInFlight` never exceeds 3 |
| Accumulates results correctly | 3 items, concurrency 2: all counts and issue numbers correct |
| Handles mixed success/failure | 3 items, second fails: `generated: 2`, `failed: 1` |
| Sequential with concurrency 1 | 3 items: events are strictly `start:1, end:1, start:2, end:2, start:3, end:3` |

The first test is the most important — it proves that the implementation uses
a true sliding window (semaphore-based) rather than batch-of-N chunking. When
a fast item completes, the next item starts immediately without waiting for
the slowest item in the current "batch" to finish.

### Spec generation timeouts (4 tests)

Verifies the per-item timeout mechanism using fake timers:

| Test | What is verified |
|------|------------------|
| Default timeout | `generate()` hangs forever → times out at 1,200,000ms (DEFAULT_SPEC_WARN_MIN + DEFAULT_SPEC_KILL_MIN = 20 min), logs "Timed out after 1200000ms specAgent.generate(#1)" |
| Retry after timeout | First attempt hangs (times out at 60ms with tiny timeout), second succeeds: `generated: 1`, warns "Attempt 1/2 failed" |
| Cleanup after timeout | Timed-out item: `failed: 1`, cleanup called once, no `update()` or `unlink()` |
| Partial batch timeout | 2 items concurrent, item 1 times out on both attempts, item 2 succeeds: `generated: 1`, `failed: 1`, `update` x1, `unlink` x1 |

## Testing patterns

### Fake timer usage

The sliding-window concurrency and timeout test suites use
`vi.useFakeTimers()` / `vi.useRealTimers()` in `beforeEach` / `afterEach`
blocks. Time is advanced with `vi.advanceTimersByTimeAsync()` and
`vi.runAllTimersAsync()`.

This is one of only two test files in the project that use fake timers
(the other being `timeout.test.ts`). See the
[testing overview](./overview.md#fake-timer-testing) for the general pattern.

### Deferred promise pattern

The `deferred<T>()` helper creates a manually-resolvable promise:

```
function deferred<T>() {
  let resolve, reject;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
```

This pattern is used in the concurrent generation test to control the
resolution order of multiple `generate()` calls, proving that results are
correctly attributed to their source items regardless of completion order.

### Array.prototype.filter patching

The defensive guard test patches `Array.prototype.filter` to bypass the
`validItems` type-predicate filter. This is the only test in the project that
patches a built-in prototype method. The patch is carefully scoped:

1. Only the first filter call on arrays containing objects with a `details`
   key is intercepted
2. The original filter is restored before assertions
3. The test verifies both the error log and the failed count

## How to run

```sh
# Run the spec pipeline tests
npx vitest run src/tests/spec-pipeline.test.ts

# Run with verbose output
npx vitest run --reporter=verbose src/tests/spec-pipeline.test.ts

# Run in watch mode
npx vitest src/tests/spec-pipeline.test.ts
```

All spec pipeline tests run without network access, AI providers, or external
CLI tools because all downstream calls are mocked.

## Related documentation

- [Testing Overview](./overview.md) -- project-wide test strategy, framework,
  and coverage map
- [Spec Generation Overview](../spec-generation/overview.md) -- the production
  module these tests verify
- [Spec Generator Tests](./spec-generator-tests.md) -- tests for the
  `spec-generator.ts` module (input classification, validation, source
  resolution)
- [Runner Tests](./runner-tests.md) -- tests for the orchestrator runner that
  delegates to `runSpecPipeline`
- [Dispatch Pipeline Tests](./dispatch-pipeline-tests.md) -- tests for the
  dispatch pipeline, the other major pipeline in the orchestrator
- [Test Fixtures & Cleanup Tests](./test-fixtures.md) -- `createMockDatasource`
  factory used by this test file
- [Datasource System](../datasource-system/overview.md) -- the datasource
  interface consumed during sync
- [Provider System](../provider-system/overview.md) -- the provider interface
  mocked by `bootProvider`
