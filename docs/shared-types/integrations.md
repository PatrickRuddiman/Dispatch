# Integrations Reference

This document covers the external dependencies used by the shared interfaces and
utilities layer: **chalk** for terminal styling, **Node.js fs/promises** for
file I/O, and **Node.js process signals** for graceful shutdown.

## chalk

- **Package:** [chalk](https://github.com/chalk/chalk) v5.4.1 (npm)
- **Used in:** `src/logger.ts:6`, `src/tui.ts:6` (see [Logger](./logger.md) and [TUI](../cli-orchestration/tui.md))
- **Purpose:** Terminal string styling (colors, bold, dim, etc.) for both the
  logger and TUI

### How chalk detects color support

Chalk v5 uses the
[supports-color](https://github.com/chalk/supports-color) package internally to
detect the terminal's color capabilities. The detection checks, in order of
priority:

1.  **`FORCE_COLOR` env var**: Overrides all other checks.
    - `FORCE_COLOR=0` — disables all colors.
    - `FORCE_COLOR=1` — basic 16 colors.
    - `FORCE_COLOR=2` — 256 colors.
    - `FORCE_COLOR=3` — truecolor (16 million colors).
2.  **`NO_COLOR` env var**: If set, disables all colors (any value).
    See [no-color.org](https://no-color.org).
3.  **`--color` / `--no-color` flags**: CLI flags on the Node.js process.
4.  **`process.stdout.isTTY`**: If stdout is not a TTY, colors are disabled.
5.  **`TERM` env var**: Checks for known terminal types.
6.  **CI environment detection**: Some CI environments are recognized and given
    appropriate color levels.
7.  The `COLORTERM` environment variable.

The result is a **level** from 0 to 3:

| Level | Description | Colors |
|-------|-------------|--------|
| 0 | No color support | Styling is stripped |
| 1 | Basic color support | 16 colors |
| 2 | 256 color support | 256 colors |
| 3 | Truecolor support | 16 million colors |

### Forcing color on or off

For CI pipelines, piped output, or testing, color can be forced:

| Mechanism | Effect |
|-----------|--------|
| `FORCE_COLOR=0` | Disables all colors regardless of detection |
| `FORCE_COLOR=1` | Forces basic 16-color support |
| `FORCE_COLOR=2` | Forces 256-color support |
| `FORCE_COLOR=3` | Forces truecolor support |
| `--color` flag | Enables color (recognized by supports-color) |
| `--no-color` flag | Disables color (recognized by supports-color) |
| `NO_COLOR` env var | Disables color ([no-color.org](https://no-color.org) convention) |

In Dispatch, the most common scenario for forcing color is in CI where you want
colored log output preserved in build logs. Set `FORCE_COLOR=1` in your CI
environment variables.

```bash
# Explicitly disable colors
FORCE_COLOR=0 dispatch "tasks/**/*.md"
NO_COLOR=1 dispatch "tasks/**/*.md"

# Colors auto-disabled when piping
dispatch "tasks/**/*.md" --dry-run | cat

# Force colors in CI
FORCE_COLOR=1 dispatch "tasks/**/*.md" --dry-run
```

For programmatic control, chalk exposes a `level` property (0–3) that can be set
directly. Dispatch does not currently set `chalk.level` programmatically; it
relies entirely on auto-detection and environment variables.

### Non-TTY behavior

When chalk detects a non-TTY stdout, it **gracefully degrades**: styled strings
are returned without ANSI escape codes. The text content is preserved, only the
formatting is stripped. This means:

- `log.info("hello")` outputs `ℹ hello` (plain text, no color codes).
- Piped output and file redirections are clean and readable.
- **Important**: Chalk's auto-detection applies to `console.log` (stdout) and
  `console.error` (stderr) independently. The `chalkStderr` instance handles
  stderr color detection separately.

Note that chalk's color stripping only affects chalk-formatted strings. The raw
ANSI escape codes used by the TUI's cursor movement (`\x1B[...`) are **not**
affected by chalk and will appear as garbage in non-TTY environments. See
[TUI — TTY compatibility](../cli-orchestration/tui.md#tty-compatibility-and-non-tty-environments)
for details.

### Performance overhead

Chalk's performance overhead is negligible for Dispatch's use case. The logger
is called at most once per task for progress updates, plus a handful of times
for startup/shutdown messages. Chalk's styling involves string concatenation
of ANSI escape codes — there is no parsing, DOM manipulation, or I/O involved.

The chalk README notes that "all the coloring packages are more than fast enough"
and that micro-benchmarks showing performance differences between coloring
libraries are misleading in real-world usage.

### chalk v5 ESM migration

Chalk v5+ is **ESM-only** — it cannot be `require()`-d from CommonJS modules.
Dispatch uses ESM throughout (configured via `"module": "ESNext"` in
`tsconfig.json` and `.js` extension imports), so this is not an issue.

If upgrading chalk across major versions in the future:

- **v4 to v5:** The API is largely the same. The main change is the switch to
  ESM. If your build pipeline or test runner does not support ESM, stay on v4.
- **Named imports:** v5 exports `Chalk` as a named export for creating custom
  instances. The default import `chalk` continues to work as before.

## Node.js fs/promises

- **Module:** `node:fs/promises` (built-in)
- **Used in:** `src/parser.ts` (see [Parser Utilities](./parser.md) and [Task Parsing API Reference](../task-parsing/api-reference.md#integration-nodejs-file-system-fspromises))
- **Functions used:** `readFile`, `writeFile`

### How Dispatch uses fs/promises

The parser uses two functions from `fs/promises`:

| Function | Usage | Location |
|----------|-------|----------|
| `readFile(path, "utf-8")` | Read task markdown files for parsing | `src/parser.ts:92` |
| `readFile(path, "utf-8")` | Re-read file content before marking complete | `src/parser.ts:100` |
| `writeFile(path, content, "utf-8")` | Write updated file with checked task | `src/parser.ts:120` |

### File deleted or moved between parse and mark-complete

If the markdown file is deleted, renamed, or moved after parsing but before
[`markTaskComplete`](../task-parsing/api-reference.md#marktaskcomplete) is called, `readFile` will throw an error with code `ENOENT`
(no such file or directory). This error propagates as a rejected promise. The
[dispatcher's](../planning-and-dispatch/dispatcher.md) try/catch (`src/dispatcher.ts:39-41`) will catch it and return a
failure result, but `markTaskComplete` is called *after* the dispatcher returns
in the [orchestrator](../cli-orchestration/orchestrator.md) (`src/orchestrator.ts:145`), so the ENOENT would be an
unhandled rejection in the current code unless it is caught by the broader
`Promise.all` error handling.

**Mitigation:** The orchestrator should wrap `markTaskComplete` in a try/catch
to handle filesystem errors gracefully.

### File permission errors

If the task file is read-only (e.g., checked into a git repository with
restricted permissions, or on a read-only filesystem), `writeFile` will throw
with code `EACCES`. This prevents marking the task as complete.

**Mitigation:** Ensure task markdown files have write permissions. In git
repositories, file permissions are typically not restrictive on checkout.

**To troubleshoot**:

1. Check file permissions: `ls -la tasks/your-file.md`
2. Ensure the user running Dispatch has `rw` access
3. On shared systems, check ACLs: `getfacl tasks/your-file.md`

### Data loss during writeFile

`writeFile` from `fs/promises` is **not atomic**. The implementation:

1.  Opens (or truncates) the file
2.  Writes the new content
3.  Closes the file

If the process is terminated between steps 1 and 2 (e.g., `kill -9`, power
failure, or OOM kill), the file may be left empty (truncated but not written)
or partially written.

**Risk assessment for Dispatch:** The risk is low but non-zero. Task markdown
files are typically under version control, so a corrupted file can be recovered
with `git checkout`. The write operation is small (the entire file content is
written in a single call), minimizing the window of vulnerability.

**Recovery**:

1. Check the task file for corruption: `cat tasks/your-file.md`
2. Use `git checkout -- tasks/your-file.md` to restore from the last commit
3. Re-run dispatch to re-process the affected tasks

**Atomic write alternative:** For higher safety, the write could use a
write-to-temp-then-rename pattern (see [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md#the-read-modify-write-pattern)):

1.  Write to a temporary file in the same directory
2.  `rename()` the temp file to the target path (atomic on most filesystems)

This is not currently implemented in Dispatch.

### Encoding

Both `readFile` and `writeFile` are called with `"utf-8"` encoding. This means:

- Files are read and written as UTF-8 strings (not Buffers)
- The markdown content, including any Unicode characters in task text, is
  preserved correctly
- BOM (Byte Order Mark) at the start of a file would be included in the string
  and could interfere with line-0 parsing, though this is unlikely with markdown
  files

## Node.js Process Signals (SIGINT, SIGTERM)

- **Module:** `node:process` (built-in)
- **Used in:** `src/cli.ts:242-252`
- **Official docs:** [nodejs.org/api/process.html#signal-events](https://nodejs.org/api/process.html#signal-events)

Dispatch installs signal handlers for `SIGINT` and `SIGTERM` to ensure
graceful shutdown of provider resources. Before these handlers were added,
signals caused immediate process termination, potentially leaving orphaned
provider server processes ([OpenCode](../provider-system/opencode-backend.md) or [Copilot](../provider-system/copilot-backend.md) CLI servers).

### How signal handlers work

The handlers are registered in `main()` at `src/cli.ts:242-252`, after
verbose logging is enabled but before any business logic runs:

1. `process.on("SIGINT", ...)` — Fires when the user presses Ctrl+C or
   the process receives signal 2.
2. `process.on("SIGTERM", ...)` — Fires when the process receives signal 15
   (e.g., `kill <pid>`, container shutdown, or process manager stop).

Both handlers follow the same pattern:

1. Log a debug message via `log.debug()` (visible only in `--verbose` mode).
2. Call `await runCleanup()` to drain the [cleanup registry](./cleanup.md).
3. Call `process.exit()` with the conventional exit code.

### Exit codes

| Signal | Exit code | Convention |
|--------|-----------|------------|
| SIGINT | 130 | 128 + signal number (2) |
| SIGTERM | 143 | 128 + signal number (15) |

The `128 + N` convention is used by most Unix shells and CI systems to
indicate that a process was terminated by signal N. CI pipelines (GitHub
Actions, Jenkins, GitLab CI) interpret exit codes above 128 as
signal-terminated processes and typically mark the job as failed.

### Error-path cleanup

In addition to signal handlers, `src/cli.ts:304-307` installs a `.catch()`
on the `main()` promise that also calls `runCleanup()` before
`process.exit(1)`. This ensures provider processes are cleaned up even when
an unhandled exception escapes the main function.

### Double-signal behavior

If a user sends two rapid Ctrl+C signals, the second signal arrives while
`runCleanup()` from the first is still executing. Because `runCleanup()`
uses `splice(0)` to atomically drain the cleanup array (see
[Cleanup registry — Signal coordination](./cleanup.md#how-signals-coordinate-with-the-cleanup-registry)),
the second invocation sees an empty array and returns immediately. This
prevents double-execution of cleanup functions.

However, if a cleanup function itself hangs (e.g., a provider server is
unresponsive), the `await` in `runCleanup()` will block indefinitely. There
is no timeout mechanism. In this case, a third signal or `kill -9` would be
needed to force termination.

### Troubleshooting hung shutdown

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| Process hangs after Ctrl+C | A cleanup function is blocking (e.g., waiting for provider server to stop) | Send another Ctrl+C or `kill -9 <pid>` |
| Exit code 130 in CI | SIGINT was received (Ctrl+C or CI timeout signal) | Expected behavior; check CI timeout settings |
| Exit code 143 in CI | SIGTERM was sent (container/pod shutdown) | Expected behavior; ensure cleanup runs within the container's grace period |
| Orphaned server process despite signal handling | Process killed with `SIGKILL` (signal 9), which cannot be caught | Manually kill the orphaned process; consider using a process manager with SIGTERM grace periods |

### Which signals cannot be handled

Node.js (and POSIX in general) does not allow handling `SIGKILL` (signal 9)
or `SIGSTOP` (signal 19). If a process is killed with `kill -9`, no cleanup
runs. This is a fundamental OS constraint, not a Dispatch limitation.

## Related documentation

- [Overview](./overview.md) -- Shared Interfaces & Utilities layer
- [Cleanup registry](./cleanup.md) -- The cleanup mechanism invoked by signal
  handlers
- [Logger](./logger.md) -- How chalk is used in the logger
- [Parser utilities](./parser.md) -- How fs/promises is used in the parser
- [TUI](../cli-orchestration/tui.md) -- How chalk is used in the TUI display
- [CLI & Orchestration Integrations](../cli-orchestration/integrations.md) --
  Signal handling section in the CLI context
- [Configuration](../cli-orchestration/configuration.md) -- Config file I/O
  that also uses fs/promises
- [Provider Interface](./provider.md) -- Provider lifecycle contract relevant
  to cleanup on signal
- [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md) --
  File I/O safety, race conditions, and the read-modify-write pattern
- [Testing Overview](../testing/overview.md) -- Test infrastructure for the
  modules that depend on these integrations
