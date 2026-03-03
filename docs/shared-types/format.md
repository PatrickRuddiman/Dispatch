# Format Utilities

## What it does

The format module (`src/helpers/format.ts`, 50 lines) provides human-readable
duration formatting and a shared header renderer used across Dispatch for
progress reporting, timing output, and display banners.

## Why it exists

Several modules need to display elapsed time to the user: the
[TUI](../cli-orchestration/tui.md) shows per-task durations, the
[spec generator](../spec-generation/overview.md) logs generation time, and
debug output includes timing information. Rather than scattering `Math.floor`
arithmetic and string formatting across every call site, `elapsed()` centralizes
the conversion from raw milliseconds into a compact `"Ns"` or `"Nm Ns"` string.

Similarly, the header banner showing provider, model, and source information is
needed by both the TUI and the spec pipeline. `renderHeaderLines()` centralizes
this chalk-formatted output so that all consumers produce a consistent header.

## API

### `elapsed(ms: number): string`

Converts a duration in milliseconds to a human-readable string.

**Parameters:**

- `ms` — Duration in milliseconds. Expected to be a non-negative number.

**Returns:** A string in one of two formats:

| Condition | Format | Example |
|-----------|--------|---------|
| Less than 60 seconds | `"Ns"` | `"0s"`, `"45s"` |
| 60 seconds or more | `"Nm Ns"` | `"1m 0s"`, `"2m 13s"` |

**Behavior details:**

1. Milliseconds are converted to whole seconds via `Math.floor(ms / 1000)`.
   Fractional seconds are always truncated, never rounded.
2. Minutes are extracted via `Math.floor(s / 60)` and remaining seconds via
   `s % 60`.
3. If minutes are greater than zero, the `"Nm Ns"` format is used.
   Otherwise, the `"Ns"` format is used.

### No hour support

The function does not have an hour tier. Durations of 60 minutes or more are
displayed as large minute values (e.g., `"90m 0s"` for 90 minutes). This is
intentional for Dispatch's use case: individual tasks and overall pipeline
runs are expected to complete in minutes, not hours. If hour-scale durations
become common, an `"Nh Nm Ns"` format could be added, but the current format
avoids unnecessary complexity.

The test suite explicitly verifies this behavior: `elapsed(3600000)` returns
`"60m 0s"` and `elapsed(5400000)` returns `"90m 0s"`
(see `src/tests/format.test.ts:25-28`).

### `renderHeaderLines(info: HeaderInfo): string[]`

Builds the standard dispatch header lines used by both the TUI and the
spec-generation banner. Returns an array of chalk-formatted strings, one per
line.

**Parameters:**

- `info` — A `HeaderInfo` object with optional metadata fields.

**`HeaderInfo` interface:**

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `string?` | Provider name (e.g. `"opencode"`, `"copilot"`) |
| `model` | `string?` | Model identifier (e.g. `"gpt-4o"`, `"claude-sonnet-4"`) |
| `source` | `string?` | Datasource name (e.g. `"github"`, `"azdevops"`, `"md"`) |

**Returns:** An array of strings. The first element is always the dispatch
branding line. Subsequent elements are present only when the corresponding
`HeaderInfo` field is provided:

| Line | Content | Condition |
|------|---------|-----------|
| 1 | `  ⚡ dispatch — AI task orchestration` (bold white + dim) | Always |
| 2 | `  provider: <name>` (dim) | When `info.provider` is set |
| 3 | `  model: <name>` (dim) | When `info.model` is set |
| 4 | `  source: <name>` (dim) | When `info.source` is set |

**Consumers:**

- **`src/tui.ts:127`** — TUI header, called on every render frame with
  provider, model, and source from `TuiState`.
- **`src/orchestrator/dispatch-pipeline.ts:89`** — Verbose mode inline header
  (printed once via the logger when `--verbose` is active instead of the TUI).
- **`src/orchestrator/spec-pipeline.ts:213`** — Spec pipeline banner, printed
  before spec generation begins.

### Edge cases and untested inputs

The following inputs are technically valid JavaScript but are not tested and
may produce unexpected output:

| Input | Behavior | Reason |
|-------|----------|--------|
| Negative values (e.g., `-1000`) | Returns `"-1s"` or negative minute values | `Math.floor` of a negative produces a more-negative integer |
| `NaN` | Returns `"NaNs"` | Arithmetic on `NaN` propagates `NaN` |
| `Infinity` | Returns `"Infinitym NaNs"` | `Infinity / 1000` is `Infinity`; `Infinity % 60` is `NaN` |
| Non-integer ms (e.g., `1500.7`) | Behaves correctly — truncated to `"1s"` | `Math.floor` handles fractional values |

None of these edge cases are likely in practice since callers pass
`Date.now()` deltas, which are always non-negative integers.

## Test coverage

The test file (`src/tests/format.test.ts`, 34 lines) covers six categories
including zero/sub-second edge cases, seconds-only formatting, minutes-and-seconds
formatting, large durations (hour-scale), and fractional millisecond truncation.
Tests use [Vitest](https://vitest.dev/) as described in the
[Testing Overview](../testing/overview.md).

See [Format Utility Tests](../testing/format-tests.md) for the full test
breakdown.

## Usage in the codebase

The `elapsed()` function is imported by:

- **`src/tui.ts`** — Formats per-task elapsed time in the terminal display.
- **`src/spec-generator.ts`** — Logs generation duration for spec output.

The `renderHeaderLines()` function is imported by:

- **`src/tui.ts`** — Renders the TUI header on every render frame.
- **`src/orchestrator/dispatch-pipeline.ts`** — Prints a one-time header in
  verbose mode.
- **`src/orchestrator/spec-pipeline.ts`** — Prints the spec pipeline banner.

## Source reference

- **Implementation:** `src/helpers/format.ts` (50 lines)
- **Tests:** `src/tests/format.test.ts` (34 lines)

## Related documentation

- [Overview](./overview.md) -- Shared Interfaces & Utilities layer
- [Logger](./logger.md) -- Terminal output that often displays elapsed times
- [TUI](../cli-orchestration/tui.md) -- Primary consumer of `elapsed()`
- [Format Utility Tests](../testing/format-tests.md) -- Detailed test
  breakdown for `elapsed()` covering edge cases and large durations
- [Testing Overview](../testing/overview.md) -- Project-wide test framework,
  patterns, and coverage map
- [Spec Generation](../spec-generation/overview.md) -- Uses `elapsed()` for
  logging generation duration
- [Integrations](./integrations.md) -- Node.js operational details for the
  shared layer
- [Planning & Dispatch Pipeline](../planning-and-dispatch/overview.md) --
  The dispatch pipeline that uses `renderHeaderLines()` for verbose-mode
  headers
