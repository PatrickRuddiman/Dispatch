# Format Utilities

The format module (`src/format.ts`, 19 lines) provides a single
human-readable duration formatter used across Dispatch for progress
reporting and timing output.

## Why this module exists

Several modules need to display elapsed time to the user: the TUI shows
per-task durations, the spec generator logs generation time, and debug output
includes timing information. Rather than scattering `Math.floor` arithmetic
and string formatting across every call site, `elapsed()` centralizes the
conversion from raw milliseconds into a compact `"Ns"` or `"Nm Ns"` string.

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

The test file (`src/tests/format.test.ts`, 34 lines) covers six categories:

| Test case | Input | Expected output |
|-----------|-------|-----------------|
| Zero milliseconds | `0` | `"0s"` |
| Sub-second durations | `999` | `"0s"` |
| Whole seconds | `1000`, `45000`, `59000` | `"1s"`, `"45s"`, `"59s"` |
| Minutes and seconds | `60000`, `61000`, `133000` | `"1m 0s"`, `"1m 1s"`, `"2m 13s"` |
| Large durations | `3600000`, `5400000` | `"60m 0s"`, `"90m 0s"` |
| Fractional milliseconds | `1500`, `61999` | `"1s"`, `"1m 1s"` |

## Usage in the codebase

The `elapsed()` function is imported by:

- **`src/tui.ts`** — Formats per-task elapsed time in the terminal display.
- **`src/spec-generator.ts`** — Logs generation duration for spec output.

## Source reference

- **Implementation:** `src/format.ts` (19 lines)
- **Tests:** `src/tests/format.test.ts` (34 lines)

## Related documentation

- [Overview](./overview.md) -- Shared Interfaces & Utilities layer
- [Logger](./logger.md) -- Terminal output that often displays elapsed times
- [TUI](../cli-orchestration/tui.md) -- Primary consumer of `elapsed()`
