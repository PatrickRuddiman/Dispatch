# Progress Reporting

The progress reporting module (`src/providers/progress.ts`) provides a
sanitization and deduplication layer for streaming progress text from AI
provider backends. Provider implementations use this to relay real-time
agent output to the TUI without corrupting the terminal.

## Why this exists

CLI-based providers (OpenCode, Claude Code, Codex) produce raw terminal output
that may contain:

- **ANSI escape codes**: Color codes (`\x1B[31m`), cursor movement sequences
  (`\x1B[2J`), and hyperlinks (`\x1B]8;...`).
- **Control characters**: Carriage returns (`\r`), backspaces (`\x08`), and
  other non-printable characters used for in-place progress bars.
- **Whitespace artifacts**: Multiple consecutive spaces, tabs, and newlines
  from reformatted output.

If these raw characters are passed directly to the TUI's progress display, they
can corrupt the terminal layout, create garbled output, or cause the progress
line to grow unboundedly. The sanitization pipeline strips these artifacts and
produces clean, fixed-length text suitable for display.

## The sanitization pipeline

The `sanitizeProgressText()` function (`src/providers/progress.ts:6-17`)
processes raw text through four stages:

1. **Strip ANSI escape codes**: Removes all ANSI CSI sequences (e.g.,
   `\x1B[31m` for red text), C1 control sequences, and OSC sequences
   (operating system commands like hyperlinks). Uses the pattern at
   `src/providers/progress.ts:3`.

2. **Strip control characters**: Removes all ASCII control characters in the
   range `\u0000-\u0008` and `\u000B-\u001F` (excluding `\n` at `\u000A`), plus
   `\u007F` (DEL). Uses the pattern at `src/providers/progress.ts:4`.

3. **Normalize whitespace**: Collapses consecutive whitespace characters
   (spaces, tabs, newlines) into single spaces and trims leading/trailing
   whitespace.

4. **Truncate**: If the sanitized text exceeds `maxLength` (default 120
   characters), it is truncated with an ellipsis (`...`). This prevents long
   agent output from wrapping or overflowing the progress display.

### Edge cases

- Empty strings after sanitization return `""`.
- If `maxLength` is 0, returns `""`.
- If `maxLength` is 1, returns `"..."` (the ellipsis character).

## The progress reporter

The `createProgressReporter()` function (`src/providers/progress.ts:27-49`)
returns a `ProgressReporter` object that wraps the sanitization pipeline with
deduplication:

### `emit(raw)`

- If no `onProgress` callback was provided, returns immediately (no-op).
- Sanitizes the raw text via `sanitizeProgressText()`.
- If the sanitized text is empty or identical to the last emitted value, skips
  (deduplication).
- Otherwise, calls `onProgress({ text })` and updates the last-emitted value.
- Errors thrown by the `onProgress` callback are **silently swallowed** to
  prevent progress reporting failures from crashing the provider.

### `reset()`

Clears the last-emitted value, allowing the next `emit()` call to re-emit
even if the text is identical. Used when a new prompt starts on the same
session.

## How providers use the reporter

Each provider implementation creates a `ProgressReporter` from the
`ProviderPromptOptions.onProgress` callback and calls `emit()` during streaming:

| Provider | Progress source |
|----------|----------------|
| **OpenCode** | SSE `message.part.updated` events with text delta content |
| **Copilot** | `AssistantMessageEvent` content from session events |
| **Claude** | `content_block_delta` events from `session.stream()` |
| **Codex** | `AgentLoop` event callbacks during `agent.run()` |

The deduplication is important because some providers emit the same text
multiple times (e.g., when SSE events are replayed or when streaming deltas
contain overlapping content).

## The `ProviderProgressSnapshot` type

Defined in `src/providers/interface.ts:16-18`:

```ts
interface ProviderProgressSnapshot {
  text: string;
}
```

This is the data structure passed to the `onProgress` callback. It contains a
single `text` field with the sanitized progress message.

## The ANSI regex patterns

Two regex patterns are defined at the module level
(`src/providers/progress.ts:3-4`):

### `ANSI_PATTERN`

Matches three categories of ANSI/terminal escape sequences:

- **CSI sequences** (`\x1B[...`): SGR color codes, cursor movement, screen
  clearing.
- **C1 CSI sequences** (`\x9B...`): 8-bit equivalents of CSI sequences.
- **OSC sequences** (`\x1B]...\x07` or `\x1B]...\x1B\\`): Operating system
  commands like terminal title changes and hyperlinks.

### `CONTROL_PATTERN`

Matches ASCII control characters excluding common whitespace:

- `\u0000-\u0008`: NULL through BS
- `\u000B-\u001F`: VT through US (excludes LF at `\u000A`)
- `\u007F`: DEL

Line feeds (`\n`) are preserved because they are later collapsed into spaces
by the whitespace normalization step.

## Testing

The progress module has dedicated tests in `src/tests/progress.test.ts`.
To run them in isolation:

```sh
npx vitest run tests/progress.test.ts
```

The vitest configuration at the project root uses V8 coverage with 85%
line/function and 80% branch thresholds.

## Related documentation

- [Provider System Overview](./overview.md) — architecture and the
  `ProviderPromptOptions` type
- [OpenCode Backend](./opencode-backend.md) — how the OpenCode provider
  produces progress events
- [Copilot Backend](./copilot-backend.md) — how the Copilot provider
  produces progress events
- [Claude Backend](../provider-implementations/claude-backend.md) — how the Claude provider produces progress events via `content_block_delta`
- [Codex Backend](../provider-implementations/codex-backend.md) — how the Codex provider produces progress events via `AgentLoop` callbacks
- [Provider Interface Types](../shared-types/provider.md) — `ProviderProgressSnapshot` and `ProviderPromptOptions` type definitions
- [Authentication and Security](../provider-implementations/authentication-and-security.md) — credential and session management across providers
- [Testing](../shared-utilities/testing.md) — test patterns and utilities for provider modules
- [Provider Integrations](./integrations.md) — external dependencies and operational considerations
