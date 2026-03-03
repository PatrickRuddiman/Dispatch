# Batch Confirmation Prompt

The batch confirmation prompt is a safety mechanism that prevents accidental
execution of large operations. When the number of items to process exceeds a
configurable threshold, the prompt requires the user to explicitly type the
word "yes" before proceeding. This guards against unintentional runs that
would consume significant AI resources or time.

**Source file:** `src/helpers/confirm-large-batch.ts` (42 lines)
**Test file:** `src/tests/confirm-large-batch.test.ts` (124 lines)

## What it does

The `confirmLargeBatch()` function takes a count and an optional threshold.
If the count is at or below the threshold, it returns `true` immediately
without prompting. If the count exceeds the threshold, it warns the user
and presents an interactive `input()` prompt requiring them to type "yes".

### Threshold behavior

| Condition | Result |
|-----------|--------|
| `count <= threshold` | Returns `true` immediately (no prompt) |
| `count > threshold`, user types "yes" | Returns `true` |
| `count > threshold`, user types anything else | Returns `false` |
| `count > threshold`, user types empty string | Returns `false` |

The boundary is inclusive: a count equal to the threshold does **not** trigger
the prompt. Only counts strictly greater than the threshold trigger it.

### Input validation

The prompt accepts "yes" case-insensitively and trims leading/trailing
whitespace. All of these are accepted: `"yes"`, `"YES"`, `"Yes"`, `"  yes  "`.
Any other input -- including `"y"`, `"Y"`, `"no"`, `"sure"`, or an empty
string -- causes the function to return `false`.

The deliberate requirement to type the full word "yes" (rather than just "y"
or pressing Enter) is a friction-by-design choice. It forces the user to make
a conscious decision when processing a large number of items.

## Why it exists

Dispatch operations can target hundreds or thousands of issues/specs at once.
A respec with no arguments discovers all existing specs and regenerates them.
The spec pipeline processes all matched items in batch. Without a safety gate,
a typo or misunderstanding could trigger an expensive operation that consumes
AI tokens and takes a long time to complete.

The default threshold of 100 items (`LARGE_BATCH_THRESHOLD`) was chosen as a
reasonable boundary between "normal batch operation" and "probably not what
you meant to do."

## API

```
confirmLargeBatch(count: number, threshold?: number): Promise<boolean>
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `count` | `number` | *(required)* | Number of items that will be processed |
| `threshold` | `number` | `100` | Minimum count that triggers the prompt |

**Returns:** `true` if the user confirmed (or count is at/below threshold),
`false` otherwise.

**Exported constant:** `LARGE_BATCH_THRESHOLD = 100`

## Where it is called

The function has two call sites with different abort behaviors:

### 1. Runner respec path (`src/orchestrator/runner.ts:206-208`)

When `--respec` is invoked with no arguments, the runner discovers all
existing specs via `datasource.list()`, then calls `confirmLargeBatch()` with
the count of discovered specs. If the user declines:

-   The runner calls `process.exit(0)` -- a clean exit with code 0.
-   No pipeline logic has run; the only preceding work was datasource
    discovery (a read-only operation).

### 2. Spec pipeline (`src/orchestrator/spec-pipeline.ts:199-202`)

After resolving items from any input mode (tracker IDs, file globs, or inline
text), the spec pipeline calls `confirmLargeBatch()` with the count of valid
items. If the user declines:

-   The function returns an empty `SpecSummary` with all-zero counts
    (`total: 0, generated: 0, failed: 0`).
-   No side effects occur because the prompt runs **before** the AI
    provider is booted. Provider boot is the first operation that creates
    external resources.

### Timing guarantee

In both call sites, the confirmation prompt runs before any destructive or
resource-consuming operation. This ensures that declining always results in
a clean abort with no partial side effects.

## How it works internally

1.  Compare `count <= threshold`. If true, return `true` immediately.
2.  Call `log.warn()` with a message showing the count and threshold. The
    count is rendered in bold via `chalk.bold()`.
3.  Call `input()` from `@inquirer/prompts` with a message prompting the
    user to type "yes".
4.  Trim and lowercase the user's response. Return `true` if it equals
    `"yes"`, `false` otherwise.

## Non-TTY behavior

The prompt uses `@inquirer/prompts` `input()`, which reads from `process.stdin`
by default. In a non-TTY environment (CI, piped input, background scripts):

-   If stdin is not a TTY, `@inquirer/prompts` will attempt to read from
    the piped input. If no input is available, the prompt will hang
    indefinitely waiting for data.
-   There is no built-in timeout or automatic fallback. If running in CI
    and the batch exceeds the threshold, the process will block.
-   To work around this in CI, either ensure the batch count is below the
    threshold, or pipe `echo "yes"` to stdin.

The `@inquirer/prompts` library supports custom `input` and `output` streams
via a second options argument, as well as cancellation via `AbortSignal`. The
current implementation does not use these features.

## Testing

The test suite at `src/tests/confirm-large-batch.test.ts` covers:

| Test case | What it verifies |
|-----------|-----------------|
| `LARGE_BATCH_THRESHOLD` export | Constant equals 100 |
| Count equals threshold | Returns `true`, no prompt shown |
| Count below threshold | Returns `true`, no prompt shown |
| User types "yes" | Returns `true` |
| User types "no" | Returns `false` |
| User types empty string | Returns `false` |
| Case-insensitive "YES", "Yes" | Returns `true` |
| Whitespace-trimmed input | `"  yes  "` returns `true` |
| Warning message content | `log.warn` called with count string |
| Custom threshold (count > custom) | Prompt shown, returns `true` on "yes" |
| Custom threshold (count = custom) | No prompt shown, returns `true` |

Tests mock `@inquirer/prompts` via `vi.mock()` so no actual terminal
interaction occurs. The logger is also mocked to verify warning output
without producing console noise.

## Related documentation

-   [Overview](./overview.md) -- Group overview with pipeline integration
    diagram showing both call sites.
-   [External Integrations](./integrations.md) -- Details on
    `@inquirer/prompts` and chalk dependencies.
-   [Spec Generation](../spec-generation/overview.md) -- The spec pipeline
    that uses this prompt.
-   [Spec Generation Integrations](../spec-generation/integrations.md) --
    The `@inquirer/prompts` integration for large batch confirmation.
-   [Testing -- Config Tests](../testing/config-tests.md) -- Test patterns
    for configuration validation, which covers related threshold logic.
-   [CLI Orchestration](../cli-orchestration/overview.md) -- The runner
    that uses this prompt in the respec path.
