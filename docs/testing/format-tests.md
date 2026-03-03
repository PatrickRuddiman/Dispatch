# Format Utility Tests

This document provides a detailed breakdown of `src/tests/format.test.ts`,
which tests the formatting utilities defined in
[`src/helpers/format.ts`](../../src/helpers/format.ts).

## What is tested

The format module exports two functions:

- **`elapsed()`** — Converts a duration in milliseconds into a human-readable
  string like `"45s"` or `"2m 13s"`. Used by the TUI and logger to display
  elapsed times during pipeline execution.
- **`renderHeaderLines()`** — Builds the standard dispatch banner header with
  optional provider, model, and source metadata. Used by the TUI and
  spec-generation banner for consistent branding.

## Describe blocks

The test file contains **2 describe blocks** with **12 tests** total.

### elapsed (6 tests)

| Test | Input (ms) | Expected output | What it verifies |
|------|-----------|-----------------|------------------|
| returns `"0s"` for zero milliseconds | `0` | `"0s"` | Zero edge case |
| returns `"0s"` for sub-second durations | `999` | `"0s"` | Sub-second truncation via `Math.floor` |
| formats seconds correctly | `1000`, `45000`, `59000` | `"1s"`, `"45s"`, `"59s"` | Seconds-only range (< 60s) |
| formats minutes and seconds correctly | `60000`, `61000`, `133000` | `"1m 0s"`, `"1m 1s"`, `"2m 13s"` | Minutes + seconds range |
| handles large durations | `3600000`, `5400000` | `"60m 0s"`, `"90m 0s"` | Hour-scale durations (no hour unit) |
| truncates fractional milliseconds via `Math.floor` | `1500`, `61999` | `"1s"`, `"1m 1s"` | Fractional truncation, not rounding |

### renderHeaderLines (6 tests)

| Test | Input | Expected behavior | What it verifies |
|------|-------|-------------------|------------------|
| returns the title line when no options are provided | `{}` | 1 line containing `"dispatch"` and `"AI task orchestration"` | Default branding output |
| includes provider on its own line when provided | `{ provider: "opencode" }` | 2 lines; line 2 contains `"provider: opencode"` | Single metadata field |
| includes model on its own line when provided | `{ model: "anthropic/claude-sonnet-4" }` | 2 lines; line 2 contains `"model: anthropic/claude-sonnet-4"` | Model field rendering |
| includes source on its own line when provided | `{ source: "github" }` | 2 lines; line 2 contains `"source: github"` | Source field rendering |
| includes all three fields on separate lines when all are provided | `{ provider, model, source }` | 4 lines in order: branding, provider, model, source | Full metadata output and ordering |
| omits undefined fields | `{ provider: "copilot", source: "azdevops" }` | 3 lines; no model line present | Selective omission of falsy fields |

### Formatting rules

See [Format Utilities](../shared-types/format.md#api) for the full API
documentation, including behavior details for both functions, the
`HeaderInfo` interface, edge cases, and the no-hour-support design rationale.

## Testing approach

Both functions are **pure functions** with no side effects, no I/O, and no
external dependencies (chalk styling is deterministic). The tests use simple
assertion patterns:

- `elapsed` tests: `expect(elapsed(input)).toBe(expected)` for exact string
  matching.
- `renderHeaderLines` tests: `expect(lines).toHaveLength(n)` for array
  length, and `expect(lines[i]).toContain(substring)` for content
  verification. The tests check for the presence of substrings rather than
  exact matches because the output includes chalk ANSI escape codes.

No mocking, temporary files, or setup/teardown is needed.

## Related documentation

- [Test suite overview](overview.md) -- framework, patterns, and coverage map
- [Format Utilities](../shared-types/format.md) -- full API documentation for
  `elapsed()` and `renderHeaderLines()` including the `HeaderInfo` interface,
  behavior details, and design rationale
- [Logger](../shared-types/logger.md) -- logger module that uses `elapsed()`
  output for timing display in pipeline messages
- [TUI documentation](../cli-orchestration/tui.md) -- primary consumer of
  both `elapsed()` and `renderHeaderLines()`
- [TUI Tests](./tui-tests.md) -- test suite for the TUI renderer, which
  exercises `renderHeaderLines()` indirectly via integration
- [Shared types overview](../shared-types/overview.md) -- formatting utilities context
- [Parser Tests](./parser-tests.md) -- Another pure-function test suite in
  the project, using similar assertion patterns
- [Config Tests](./config-tests.md) -- Configuration test suite covering
  persistent settings and merge logic
- [Spec Generator Tests](./spec-generator-tests.md) -- Test suite for spec
  generation utility functions
- [Shared Utilities Testing](../shared-utilities/testing.md) -- Slugify and
  timeout test suites that follow similar pure-function testing patterns
