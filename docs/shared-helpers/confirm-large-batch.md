# Confirm Large Batch

The `confirmLargeBatch` function in
[`src/helpers/confirm-large-batch.ts`](../../src/helpers/confirm-large-batch.ts)
is a safety gate that requires explicit user confirmation before proceeding
with spec or respec operations that target a large number of items.

## What it does

When a batch operation exceeds a configurable threshold, the function warns
the user via `log.warn()` and prompts them to type `"yes"` to proceed. If
the count is at or below the threshold, it returns `true` immediately without
any user interaction.

The confirmation flow:

1. Compare `count` against `threshold` (default `LARGE_BATCH_THRESHOLD`).
2. If `count <= threshold`, return `true` immediately.
3. Otherwise, emit a warning via `log.warn()` that includes the item count
   and the threshold value.
4. Display an interactive `input()` prompt from `@inquirer/prompts` asking
   the user to type `"yes"`.
5. Return `true` if the trimmed, lowercased answer equals `"yes"`, `false`
   otherwise.

## Why it exists

Accidental large batch operations can be expensive and time-consuming. If a
user runs `dispatch --spec` against a repository with hundreds of open
issues, the resulting AI agent calls could consume significant resources.
This confirmation step provides a human checkpoint before committing to a
potentially costly operation.

The module is extracted into its own file so both the orchestrator runner and
the spec pipeline can share the logic, and tests can mock it via `vi.mock()`
at the module boundary.

## Configuration

### LARGE_BATCH_THRESHOLD

The exported constant `LARGE_BATCH_THRESHOLD` is set to **100**. This value
is hardcoded and is **not configurable** per-project or via the
`~/.dispatch/config.json` file. To change it, modify the source.

The threshold is a count of specs (issues) that will be processed, not a
count of tasks within those specs.

### Custom threshold parameter

The `confirmLargeBatch` function accepts an optional second parameter to
override the default threshold:

```
confirmLargeBatch(count: number, threshold?: number): Promise<boolean>
```

Callers can pass a custom threshold for specific contexts, though the current
codebase uses the default in all call sites.

## Integration with @inquirer/prompts

The function uses the `input()` prompt from
[`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts) (v8.3+)
to collect user input. Key characteristics:

-   **Interactive terminal required.** The `input()` function reads from
    stdin and writes to stdout. It requires an interactive TTY session.

-   **No built-in non-interactive mode.** In CI pipelines or non-TTY
    environments, `input()` will hang waiting for input or throw an error.
    There is no `--yes` flag or environment variable to bypass the prompt.
    If you need to run large batch operations in CI, either ensure the batch
    stays under the threshold or pipe `"yes"` to stdin.

-   **Chalk-formatted prompt text.** The prompt message uses `chalk.bold()`
    to emphasize the `"yes"` text, which degrades gracefully to plain text
    in non-color environments (see
    [Logger -- Behavior in non-TTY environments](../shared-types/logger.md#behavior-in-non-tty-environments-ci-piped-output)).

## Input handling

The user's response is processed with `.trim().toLowerCase()` before
comparison:

-   `"yes"` -- confirmed (returns `true`)
-   `"YES"`, `"Yes"`, `"  yes  "` -- confirmed (case-insensitive, whitespace-trimmed)
-   `"y"`, `"no"`, `""`, any other input -- rejected (returns `false`)

Only the exact word `"yes"` (after normalization) is accepted. This is
intentionally strict to prevent accidental confirmation.

## Test coverage

The test file
[`src/tests/confirm-large-batch.test.ts`](../../src/tests/confirm-large-batch.test.ts)
contains 10 tests across 3 `describe` blocks:

| Block | Tests | What is verified |
|-------|-------|------------------|
| When count is at or below threshold | 2 | No prompt shown; returns `true` for count equal to or below threshold |
| When count exceeds threshold | 6 | Prompt behavior for "yes", "no", empty, case variations, whitespace trimming; `log.warn` called with count |
| Custom threshold | 2 | Override threshold triggers/skips prompt correctly |

The tests use `vi.hoisted()` to create a `mockInput` reference before
`vi.mock("@inquirer/prompts")` runs. The logger is also fully mocked to
prevent console output during tests. See
[Shared Helpers Tests](../testing/shared-helpers-tests.md) for the mocking
pattern details.

## Source reference

-   [`src/helpers/confirm-large-batch.ts`](../../src/helpers/confirm-large-batch.ts)
    -- 42 lines

## Related documentation

-   [Shared Helpers Tests](../testing/shared-helpers-tests.md) -- Test suite
    covering this module
-   [Logger](../shared-types/logger.md) -- The `log.warn()` call used for
    the warning message
-   [Spec Generation](../spec-generation/overview.md) -- Pipeline that uses
    this confirmation gate
-   [CLI & Orchestration](../cli-orchestration/overview.md) -- Runner that
    invokes the confirmation before spec generation
-   [Architecture](../architecture.md) -- System overview including the
    helpers barrel export
-   [Testing Overview](../testing/overview.md) -- Project-wide test framework
