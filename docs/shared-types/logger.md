# Logger

The logger (`src/logger.ts`) provides a minimal structured logging facade for
CLI output. It is a plain object with six methods, each producing color-coded
terminal output through [chalk](https://github.com/chalk/chalk).

## What it does

The `log` object is the single logging interface for non-TUI contexts in
Dispatch. It is imported by the [CLI entry point](../cli-orchestration/cli.md) (`src/cli.ts`), the [orchestrator](../cli-orchestration/orchestrator.md)
(`src/orchestrator.ts`), and the dry-run code path. When the full [TUI](../cli-orchestration/tui.md) is active,
the TUI module renders its own output directly; the logger is used for simpler
output modes.

## Why it exists

The [TUI](../cli-orchestration/tui.md) provides rich real-time output during
normal dispatch, but several scenarios require simpler output:

- **Dry-run mode**: Lists discovered tasks without starting the TUI
  (see [CLI `--dry-run`](../cli-orchestration/cli.md)).
- **Error reporting**: The CLI uses `log.error()` for argument validation
  errors before the TUI exists.
- **Warnings**: The [orchestrator](../cli-orchestration/orchestrator.md) uses `log.warn()` when no files or tasks
  are found.
- **Non-TTY environments**: When stdout is not a terminal, the logger's
  line-by-line output is appropriate (though the caller must opt into it via
  `--dry-run`; there is no automatic fallback).

## Usage in the codebase

The logger is used in two contexts:

1. **CLI** (`src/cli.ts`): Error reporting for argument validation, version
   display hint.
2. **Orchestrator** (`src/orchestrator.ts`): Warnings for empty results,
   dry-run task listing.

The TUI replaces the logger during normal (non-dry-run) execution. The two
output systems are mutually exclusive — the TUI is not created in dry-run
mode, and the logger is not used during TUI-driven dispatch.

## Method reference

| Method | Stream | Prefix | Color | Usage |
|--------|--------|--------|-------|-------|
| `log.info(msg)` | stdout | `i` | blue | General informational messages |
| `log.success(msg)` | stdout | `check` | green | Completion confirmations |
| `log.warn(msg)` | stdout | `warning` | yellow | Non-fatal warnings |
| `log.error(msg)` | stderr | `x` | red | Error messages |
| `log.task(index, total, msg)` | stdout | `[n/total]` | cyan | Task progress in dry-run mode |
| `log.dim(msg)` | stdout | *(none)* | dim | Subtle hints and examples |

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
- **Log levels**: All methods are always active. There is no way to suppress
  info messages while keeping errors, for example.
- **File output**: Logs go to stdout/stderr only. There is no file transport.
- **Timestamps**: Messages do not include timestamps.
- **Contextual metadata**: There is no way to attach task IDs, file paths, or
  other structured data beyond what is embedded in the message string.

For debugging and production monitoring, consider:

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

The current logger has **no log-level filtering**. Every call to any method
unconditionally emits output. This is a deliberate simplicity choice: Dispatch
is a focused CLI tool, not a long-running service, and the volume of log output
is bounded by the number of tasks.

If log-level filtering becomes necessary, the approach would be to:

1.  Add a `level` property to the `log` object (or accept it at creation time)
2.  Check the level before emitting in each method
3.  Wire the level to a CLI flag (e.g., `--verbose`, `--quiet`)

Currently, the `--dry-run` flag controls output by switching the orchestrator
to a simpler code path that uses `log.info`, `log.task`, and `log.warn` only.
The TUI mode bypasses the logger entirely during normal dispatch.

## Source reference

- `src/logger.ts` — Full logger implementation (26 lines)

## Related documentation

- [Overview](./overview.md) -- Shared Interfaces & Utilities layer
- [Integrations reference](./integrations.md) -- Chalk color detection and CI behavior details
- [TUI](../cli-orchestration/tui.md) -- The alternative rich output mode that
  replaces the logger during normal dispatch
- [CLI & Orchestration](../cli-orchestration/overview.md) -- Where the logger is consumed
