# Format Utilities

## What it does

The format module (`src/helpers/format.ts`, 50 lines) provides shared
formatting utilities used across the Dispatch CLI:

- **`elapsed()`** — Human-readable duration formatter (`"45s"`, `"2m 13s"`)
- **`renderHeaderLines()`** — Shared header builder that produces the
  standard dispatch banner with optional provider, model, and source metadata

## Why it exists

Several modules need consistent formatting output:

- The [TUI](../cli-orchestration/tui.md) shows per-task durations and a
  branded header with provider/model/source metadata.
- The [spec generator](../spec-generation/overview.md) logs generation time
  and displays its own banner.
- Debug output includes timing information.

Rather than scattering `Math.floor` arithmetic, string formatting, and chalk
styling across every call site, the format module centralizes these concerns
into two reusable functions. The `renderHeaderLines()` function ensures that
both the TUI and the spec-generation banner render an identical header layout,
so changes to branding or metadata fields propagate to all consumers
automatically.

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

#### No hour support

The function does not have an hour tier. Durations of 60 minutes or more are
displayed as large minute values (e.g., `"90m 0s"` for 90 minutes). This is
intentional for Dispatch's use case: individual tasks and overall pipeline
runs are expected to complete in minutes, not hours. If hour-scale durations
become common, an `"Nh Nm Ns"` format could be added, but the current format
avoids unnecessary complexity.

The test suite explicitly verifies this behavior: `elapsed(3600000)` returns
`"60m 0s"` and `elapsed(5400000)` returns `"90m 0s"`
(see `src/tests/format.test.ts:25-28`).

#### Edge cases and untested inputs

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

### `HeaderInfo` interface

The `HeaderInfo` interface (`src/helpers/format.ts:24-28`) defines the
metadata fields accepted by `renderHeaderLines()`:

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `string?` | Provider name (e.g., `"opencode"`, `"copilot"`) |
| `model` | `string?` | Model identifier (e.g., `"anthropic/claude-sonnet-4"`) |
| `source` | `string?` | Datasource name (e.g., `"github"`, `"azdevops"`, `"md"`) |

All fields are optional. When omitted, the corresponding line is simply not
rendered.

### `renderHeaderLines(info: HeaderInfo): string[]`

Builds the standard dispatch header lines used by both the TUI and the
spec-generation banner.

**Parameters:**

- `info` — A `HeaderInfo` object with optional `provider`, `model`, and
  `source` fields.

**Returns:** An array of chalk-formatted strings, one per line. The first
element is always the branding line (`"dispatch — AI task orchestration"`).
Subsequent elements are conditional metadata lines rendered in the order:
provider, model, source.

**Output structure:**

| Line | Condition | Content |
|------|-----------|---------|
| 1 (always) | Always present | Branding: `"dispatch — AI task orchestration"` |
| 2 (optional) | `info.provider` is truthy | `"provider: {name}"` |
| 3 (optional) | `info.model` is truthy | `"model: {id}"` |
| 4 (optional) | `info.source` is truthy | `"source: {name}"` |

The returned array length ranges from 1 (no metadata) to 4 (all fields
provided). Each string is pre-formatted with chalk styles (`chalk.bold.white`
for branding, `chalk.dim` for metadata lines).

**Why an array instead of a joined string?** The caller (typically
`render()` in `src/tui.ts`) spreads the result into a lines array via
`lines.push(...renderHeaderLines(info))`. Returning an array gives callers
control over how lines are joined and what separator or padding surrounds
them.

## Test coverage

The test file (`src/tests/format.test.ts`, 82 lines) contains **2 describe
blocks** with **12 tests** total:

- **`elapsed`** (6 tests) — Zero/sub-second edge cases, seconds-only
  formatting, minutes-and-seconds formatting, large durations (hour-scale),
  and fractional millisecond truncation.
- **`renderHeaderLines`** (6 tests) — Title-only output, individual field
  rendering (provider, model, source), all-fields output, and selective
  field omission.

Tests use [Vitest](https://vitest.dev/) as described in the
[Testing Overview](../testing/overview.md).

See [Format Utility Tests](../testing/format-tests.md) for the full test
breakdown.

## Usage in the codebase

The format module is imported by:

- **`src/tui.ts`** — Uses both `elapsed()` for per-task duration display and
  `renderHeaderLines()` for the TUI header banner.
- **`src/spec-generator.ts`** — Uses `elapsed()` for generation duration and
  `renderHeaderLines()` for the spec-generation banner.

## Source reference

- **Implementation:** `src/helpers/format.ts` (50 lines)
- **Tests:** `src/tests/format.test.ts` (82 lines)

## Related documentation

- [Overview](./overview.md) -- Shared Interfaces & Utilities layer
- [Logger](./logger.md) -- Terminal output that often displays elapsed times
- [TUI](../cli-orchestration/tui.md) -- Primary consumer of both `elapsed()`
  and `renderHeaderLines()`
- [Format Utility Tests](../testing/format-tests.md) -- Detailed test
  breakdown for both `elapsed()` and `renderHeaderLines()`
- [Testing Overview](../testing/overview.md) -- Project-wide test framework,
  patterns, and coverage map
- [Spec Generation](../spec-generation/overview.md) -- Uses `elapsed()` and
  `renderHeaderLines()` for timing and banner display
- [Integrations](./integrations.md) -- Node.js operational details for the
  shared layer
