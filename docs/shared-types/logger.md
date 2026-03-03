# Logger

The logger (`src/logger.ts`) provides a minimal structured logging facade for
CLI output. It is a plain object with seven methods plus a `verbose` flag and
an error-chain formatter, producing color-coded terminal output through
[chalk](https://github.com/chalk/chalk).

## What it does

The `log` object is the single logging interface for non-TUI contexts in
Dispatch. It is imported by the [CLI entry point](../cli-orchestration/cli.md)
(`src/cli.ts`), the [orchestrator](../cli-orchestration/orchestrator.md)
(`src/agents/orchestrator.ts`), the
[dispatcher](../planning-and-dispatch/dispatcher.md) (`src/dispatcher.ts`),
both [provider backends](../provider-system/provider-overview.md)
(`src/providers/opencode.ts`, `src/providers/copilot.ts`), the
[spec generator](../spec-generation/overview.md) (`src/spec-generator.ts`),
and the [datasource helpers](../datasource-system/datasource-helpers.md)
(`src/orchestrator/datasource-helpers.ts`).
When the full [TUI](../cli-orchestration/tui.md) is active, the TUI module
renders its own output directly; the logger is used for simpler output modes
and for verbose debug tracing that runs alongside the TUI.

## Why it exists

The [TUI](../cli-orchestration/tui.md) provides rich real-time output during
normal dispatch, but several scenarios require simpler output:

- **Dry-run mode**: Lists discovered tasks without starting the TUI
  (see [CLI `--dry-run`](../cli-orchestration/cli.md)).
- **Error reporting**: The CLI uses `log.error()` for argument validation
  errors before the TUI exists.
- **Warnings**: The [orchestrator](../cli-orchestration/orchestrator.md) uses
  `log.warn()` when no files or tasks are found.
- **Debug tracing**: With `--verbose`, `log.debug()` provides detailed
  internal tracing of provider boot, session creation, prompt dispatch, and
  cleanup operations across every module in the pipeline.
- **Non-TTY environments**: When stdout is not a terminal, the logger's
  line-by-line output is appropriate (though the caller must opt into it via
  `--dry-run`; there is no automatic fallback).

## Usage in the codebase

The logger is used across the entire pipeline:

1. **CLI** (`src/cli.ts`): Error reporting for argument validation, signal
   handler debug messages, verbose flag initialization.
2. **Orchestrator** (`src/agents/orchestrator.ts`): Warnings for empty results,
   dry-run task listing via `log.task()`.
3. **Dispatcher** (`src/dispatcher.ts`): Debug tracing of prompt construction,
   dispatch results, and error chains.
4. **Provider backends** (`src/providers/opencode.ts`,
   `src/providers/copilot.ts`): Debug tracing of server boot, session creation,
   prompt sending, response receipt, and cleanup.
5. **Spec generator** (`src/spec-generator.ts`): Info/success/error for
   pipeline stages, debug tracing of fetch timing, prompt size, and response
   processing.

The TUI replaces the logger's user-facing output during normal (non-dry-run)
execution. However, `log.debug()` messages still fire when `--verbose` is
enabled, even while the TUI is active -- they write to stdout alongside the
TUI's ANSI rendering, which can produce interleaved output.

## Method reference

| Method | Stream | Prefix | Color | Usage |
|--------|--------|--------|-------|-------|
| `log.info(msg)` | stdout | `ℹ` | blue | General informational messages |
| `log.success(msg)` | stdout | `✔` | green | Completion confirmations |
| `log.warn(msg)` | stdout | `⚠` | yellow | Non-fatal warnings |
| `log.error(msg)` | stderr | `✖` | red | Error messages |
| `log.task(index, total, msg)` | stdout | `[n/total]` | cyan | Task progress in dry-run mode |
| `log.dim(msg)` | stdout | *(none)* | dim | Subtle hints and examples |
| `log.debug(msg)` | stdout | `⤷` | dim | Verbose debug output (gated by `log.verbose`) |

### `log.task()` -- zero-based index convention

The `task()` method accepts a **zero-based** `index` parameter and displays it
as **one-based** to the user (`src/logger.ts:27`):

```
console.log(chalk.cyan(`[${index + 1}/${total}]`), msg);
```

This means all callers must pass a zero-based index. The single call site in
the current codebase (`src/agents/orchestrator.ts:326`) uses
`allTasks.indexOf(task)`, which returns a zero-based array index -- so the
convention is followed correctly. If you add new callers, pass the zero-based
position from the task array, not a one-based counter.

### `log.debug()` -- verbose mode

The `debug()` method is gated by the `log.verbose` boolean property
(`src/logger.ts:38-41`):

```typescript
debug(msg: string) {
    if (!this.verbose) return;
    console.log(chalk.dim(`  ⤷ ${msg}`));
}
```

Messages are prefixed with a dim arrow (`⤷`) and indented two spaces to
visually nest them under the preceding info/error line.

#### How the verbose flag is toggled

The `--verbose` CLI flag sets `log.verbose = args.verbose` at
`src/cli.ts:239`, before any other operations. This is a one-time assignment
at startup -- the flag **cannot** be toggled mid-execution. There is no
mechanism (environment variable, signal, or API) to enable or disable verbose
mode while the process is running.

#### What verbose mode reveals

When `--verbose` is active, `log.debug()` calls throughout the pipeline
produce output including:

| Module | Example debug messages |
|--------|-----------------------|
| Provider boot | `"Connecting to existing OpenCode server at ..."`, `"No --server-url, will spawn local server"` |
| Session lifecycle | `"Creating OpenCode session..."`, `"Session created: <id>"` |
| Prompt dispatch | `"Sending async prompt to session <id> (N chars)..."`, `"Prompt response received (N chars)"` |
| Spec generation | `"Spec prompt built (N chars)"`, `"Post-processed spec (N → M chars)"` |
| Error details | Full error cause chains via `log.formatErrorChain()` |
| Signal handling | `"Received SIGINT, cleaning up..."` |

### `log.formatErrorChain()` -- error cause chain formatter

The `formatErrorChain()` method (`src/logger.ts:48-70`) extracts the full
`Error.cause` chain from nested Node.js errors and formats it as a
human-readable multi-line string:

```
Error: fetch failed
  ⤷ Cause: connect ECONNREFUSED 127.0.0.1:4096
  ⤷ Cause: ECONNREFUSED
```

This is critical for diagnosing Node.js network errors. When `fetch()` or an
SDK call fails, Node.js wraps the root cause in a `TypeError: fetch failed`
with the actual network error (like `ECONNREFUSED` or `ETIMEDOUT`) buried in
nested `.cause` properties. Without this formatter, only the outer
"fetch failed" message would be visible.

#### Depth limit

The formatter walks the `.cause` chain up to a **maximum depth of 5**
(`src/logger.ts:53`). This prevents infinite loops if an error object has a
circular `.cause` reference, and bounds the output length.

**Could real-world error chains exceed 5 levels?** In practice, Node.js
network error chains are typically 2-3 levels deep:

1. `TypeError: fetch failed` (fetch API wrapper)
2. `Error: connect ECONNREFUSED ...` (Node.js net layer)
3. System-level error code (optional, e.g., `ECONNREFUSED`)

The SDK wrappers used by Dispatch ([OpenCode SDK](../provider-system/opencode-backend.md), [Copilot SDK](../provider-system/copilot-backend.md)) may add one
additional layer. A depth of 5 provides comfortable headroom for current and
foreseeable error chains. If a chain is truncated, the deepest visible cause
still provides significant diagnostic value.

#### Where formatErrorChain is called

The method is called in error handlers throughout the pipeline:

- `src/dispatcher.ts:46` -- task dispatch failures
- `src/providers/opencode.ts:48, 66, 161` -- server boot, session, and
  prompt failures
- `src/providers/copilot.ts:31, 49, 73` -- CLI boot, session, and prompt
  failures
- `src/spec-generator.ts:288, 362, 462` -- issue fetch and spec generation
  failures

## Why chalk for terminal styling

Chalk was chosen over raw ANSI escape codes or alternatives for several reasons:

1.  **Automatic color support detection.** Chalk uses the
    [supports-color](https://github.com/chalk/supports-color) package internally
    to detect the terminal's color capability level (none, 16, 256, or 16
    million colors). Raw ANSI codes provide no such detection and would require
    implementing this logic manually.

2.  **Composable, readable API.** Calls like `chalk.blue("text")` and
    `chalk.cyan(`[${n}/${total}]`)` are self-documenting. The equivalent ANSI
    escape sequences (`\x1b[34m...\x1b[0m`) are opaque and error-prone.

3.  **No dependencies.** Chalk v5+ has zero runtime dependencies, so the cost of
    adoption is minimal.

4.  **Wide ecosystem trust.** Chalk is used by over 100,000 npm packages. Its
    maturity and active maintenance make it a low-risk dependency.

Smaller alternatives like [yoctocolors](https://github.com/sindresorhus/yoctocolors)
exist but lack chalk's automatic color detection and composable chaining API.

## Why `console.error` only for the error method

The `error` method is the only one that writes to `console.error` (which outputs
to **stderr**). All other methods use `console.log` (which outputs to
**stdout**). This follows the Unix convention of separating normal program output
from error diagnostics:

- **stdout** carries the program's primary output — task listings, progress
  indicators, success messages. It can be piped to other tools or redirected to
  files for processing.
- **stderr** carries diagnostic and error output. When stdout is piped, stderr
  still appears on the terminal so errors remain visible.

This separation matters for Dispatch because dry-run output (task listings) goes
to stdout and can be captured, while errors always surface in the terminal
regardless of redirection.

## Behavior in non-TTY environments (CI, piped output)

When Dispatch runs in a CI pipeline or when stdout is redirected to a file,
chalk's behavior changes automatically:

| Environment | Chalk behavior | Logger output |
|-------------|----------------|---------------|
| TTY terminal | Colors enabled | Colored icons and text |
| Piped to another process | Colors disabled (auto-detected) | Plain text without escape codes |
| Redirected to file | Colors disabled (auto-detected) | Plain text without escape codes |
| `FORCE_COLOR=1` set | Colors forced on | Colored output even in non-TTY |
| `NO_COLOR` set | Colors forced off | Plain text in all environments |

This means the logger's output is safe for piping and redirection — chalk
gracefully degrades to plain text when it detects a non-TTY stdout.

The `log.error()` method writes to `console.error` (stderr), which has
independent color detection from stdout. This means error messages may have
different color behavior than info/warn messages if stdout and stderr are
routed differently.

### Color detection details

1.  **Color detection.** Chalk checks `process.stdout.isTTY` (and the equivalent
    for stderr) via the supports-color package. When the stream is not a TTY —
    as in CI environments, piped commands, or file redirects — chalk detects
    level 0 (no color) and outputs plain text without ANSI escape codes.

2.  **Forcing color on or off.** The `FORCE_COLOR` environment variable overrides
    detection:
    - `FORCE_COLOR=0` disables all colors
    - `FORCE_COLOR=1` enables basic 16 colors
    - `FORCE_COLOR=2` enables 256 colors
    - `FORCE_COLOR=3` enables truecolor (16 million)

    The `--color` and `--no-color` CLI flags (recognized by supports-color) also
    work, though Dispatch does not expose these directly in its own argument
    parser.

3.  **Unicode symbols.** The emoji-style prefix characters (`ℹ`, `✔`, `⚠`, `✖`)
    are Unicode, not ANSI codes. They will appear in the output regardless of
    color support. In environments where Unicode is not supported, they may
    render as replacement characters. This is generally acceptable in modern CI
    systems.

## Structured logging limitations

The logger writes exclusively to `console.log` and `console.error`. There is
**no mechanism** for:

- **Structured output** (JSON logging): All output is human-readable strings
  with ANSI color codes. You cannot pipe logger output to a JSON parser.
- **Granular log levels**: The only filtering is the `verbose` flag, which
  gates `debug()` output. There is no way to suppress info messages while
  keeping errors, or to enable warnings-only mode.
- **File output**: Logs go to stdout/stderr only. There is no file transport.
- **Timestamps**: Messages do not include timestamps.
- **Contextual metadata**: There is no way to attach task IDs, file paths, or
  other structured data beyond what is embedded in the message string.

For debugging and production monitoring, consider:

- **Verbose mode**: `dispatch "tasks/**/*.md" --verbose` enables detailed debug
  output from every module in the pipeline.
- **Piping to a file**: `dispatch "tasks/**/*.md" --dry-run 2>&1 | tee dispatch.log`
  captures all output. Note that chalk will likely disable colors for piped
  output (see [Integrations](./integrations.md)), making the file more
  readable.
- **Structured logging library**: If the project grows to need machine-readable
  logs, libraries like [pino](https://github.com/pinojs/pino) or
  [winston](https://github.com/winstonjs/winston) could replace or supplement
  this module. However, for a CLI tool, human-readable output is typically
  preferred over structured logging.

## Log-level filtering

The logger implements a single level of filtering via the `verbose` flag:

- **`log.verbose = false` (default)**: The six primary methods (`info`,
  `success`, `warn`, `error`, `task`, `dim`) emit unconditionally. `debug()`
  is suppressed.
- **`log.verbose = true` (`--verbose` flag)**: All methods emit, including
  `debug()`.

There is no finer-grained filtering (e.g., suppressing info while keeping
errors). This is a deliberate simplicity choice: Dispatch is a focused CLI
tool, not a long-running service, and the volume of log output is bounded by
the number of tasks. The `--verbose` flag provides a useful "show me
everything" escape hatch for troubleshooting without adding the complexity of
a full log-level hierarchy.

## Source reference

- `src/logger.ts` -- Full logger implementation (71 lines)

## Related documentation

- [Overview](./overview.md) -- Shared Interfaces & Utilities layer
- [Cleanup registry](./cleanup.md) -- How signal handlers use `log.debug()`
  before draining cleanup
- [Format utilities](./format.md) -- The `elapsed()` helper used alongside
  logger output for timing
- [Format Tests](../testing/format-tests.md) -- Test suite covering the
  `elapsed()` function that the logger displays
- [Integrations reference](./integrations.md) -- Chalk color detection, CI
  behavior, and Node.js process signal details
- [TUI](../cli-orchestration/tui.md) -- The alternative rich output mode that
  replaces the logger during normal dispatch
- [CLI & Orchestration](../cli-orchestration/overview.md) -- Where the logger
  is consumed and verbose mode is initialized
- [Configuration](../cli-orchestration/configuration.md) -- How `--verbose`
  is persisted and merged with CLI flags
- [Spec Generation](../spec-generation/overview.md) -- How the spec pipeline
  uses logger for progress reporting and error diagnostics
- [Spec Generation Integrations](../spec-generation/integrations.md) -- Chalk
  behavior in non-TTY environments during spec generation
- [Dispatcher](../planning-and-dispatch/dispatcher.md) -- Debug tracing of
  prompt dispatch and error chain formatting
- [Provider Overview](../provider-system/provider-overview.md) -- Debug
  tracing of provider boot, session creation, and cleanup
- [Datasource Helpers](../datasource-system/datasource-helpers.md) -- How
  datasource helper functions use `log.warn()` and `log.success()`
