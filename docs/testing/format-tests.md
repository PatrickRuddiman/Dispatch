# Format Utility Tests

This document provides a detailed breakdown of `src/tests/format.test.ts`,
which tests the duration formatting utility defined in
[`src/format.ts`](../../src/format.ts).

## What is tested

The `format.ts` module exports a single function, `elapsed()`, which converts
a duration in milliseconds into a human-readable string like `"45s"` or
`"2m 13s"`. This is used by the TUI and logger to display elapsed times during
pipeline execution.

## Describe block

The test file contains **1 describe block** with **6 tests**.

### elapsed (6 tests)

| Test | Input (ms) | Expected output | What it verifies |
|------|-----------|-----------------|------------------|
| returns `"0s"` for zero milliseconds | `0` | `"0s"` | Zero edge case |
| returns `"0s"` for sub-second durations | `999` | `"0s"` | Sub-second truncation via `Math.floor` |
| formats seconds correctly | `1000`, `45000`, `59000` | `"1s"`, `"45s"`, `"59s"` | Seconds-only range (< 60s) |
| formats minutes and seconds correctly | `60000`, `61000`, `133000` | `"1m 0s"`, `"1m 1s"`, `"2m 13s"` | Minutes + seconds range |
| handles large durations | `3600000`, `5400000` | `"60m 0s"`, `"90m 0s"` | Hour-scale durations (no hour unit) |
| truncates fractional milliseconds via `Math.floor` | `1500`, `61999` | `"1s"`, `"1m 1s"` | Fractional truncation, not rounding |

### Formatting rules

The `elapsed()` function follows these rules:

1. Convert milliseconds to whole seconds using `Math.floor(ms / 1000)`
2. If the result is >= 60 seconds, format as `"Xm Ys"` where Y is the remainder
3. If the result is < 60 seconds, format as `"Xs"`
4. There is no hour or day unit -- large durations display as high minute counts
   (e.g., 1 hour = `"60m 0s"`)

## Testing approach

This is a **pure function** with no side effects, no I/O, and no dependencies.
The tests use simple `expect(elapsed(input)).toBe(expected)` assertions. No
mocking, temporary files, or setup/teardown is needed.

## Related documentation

- [Test suite overview](overview.md) — framework, patterns, and coverage map
- [TUI documentation](../cli-orchestration/tui.md) — primary consumer of `elapsed()`
- [Shared types overview](../shared-types/overview.md) — formatting utilities context
