# Integrations

This page documents the external dependencies and integrations used by the
CLI & Orchestration group, answering operational questions about configuration,
behavior, and troubleshooting.

## Chalk

See [Chalk reference](../shared-types/integrations.md#chalk) for full
documentation on chalk color detection, FORCE_COLOR, non-TTY behavior, and
level overrides.

Chalk is used in the [logger](../shared-types/logger.md) and [TUI](tui.md)
for terminal string styling, and in the
[configuration wizard](configuration.md#config-wizard-flow) for colored
output (bold headings, cyan key names, green/red provider install indicators).

---

## @inquirer/prompts

**Package**: `@inquirer/prompts`
**Used in**: `src/config-prompts.ts:8`
**Official docs**: [npmjs.com/package/@inquirer/prompts](https://www.npmjs.com/package/@inquirer/prompts)

The `@inquirer/prompts` package provides the interactive terminal prompts used
by the [configuration wizard](configuration.md#config-wizard-flow). It is the
modern ESM-native rewrite of Inquirer.js, offering standalone prompt functions
rather than a monolithic prompt runner.

### Functions used

| Function | Usage | Location |
|----------|-------|----------|
| `select` | Provider selection (with install indicators), model selection, datasource selection | `src/config-prompts.ts:65`, `src/config-prompts.ts:80`, `src/config-prompts.ts:108` |
| `confirm` | "Reconfigure?" prompt, "Save?" confirmation | `src/config-prompts.ts:48`, `src/config-prompts.ts:149` |

### Prompt behavior

- **`select`** renders a list of choices with arrow-key navigation. The user
  presses Enter to select. It supports a `default` option to pre-select a
  value (used to pre-select the existing config value when reconfiguring).
- **`confirm`** renders a yes/no prompt. Returns a boolean. The `default`
  option controls which value is selected when the user just presses Enter.

### Non-TTY behavior

When stdin is not a TTY (e.g., running in a non-interactive CI environment),
`@inquirer/prompts` throws an error because it cannot render interactive
prompts. The `dispatch config` command is inherently interactive and is not
designed for non-TTY use. In CI, configuration should be set via CLI flags
directly (e.g., `--provider copilot --source github`).

### Ctrl+C handling (ExitPromptError)

When the user presses Ctrl+C during any `@inquirer/prompts` prompt, the
library throws an `ExitPromptError`. Because the `dispatch config` subcommand
runs before `parseArgs()` and before signal handlers are installed
(`src/cli.ts:270-281`), this error propagates to the top-level `.catch()`
handler (`src/cli.ts:321-324`), which logs the error and exits with code `1`.

This means pressing Ctrl+C during the config wizard:
1. Does **not** trigger `runCleanup()` via the SIGINT handler (handlers not
   yet installed).
2. Does trigger `runCleanup()` via the `.catch()` error handler.
3. No provider resources need cleanup at this point since no provider has
   been booted.

### Why @inquirer/prompts instead of alternatives

The `@inquirer/prompts` package was chosen for its:
- **ESM-native design**: Compatible with the project's `"type": "module"` setup.
- **Standalone functions**: Each prompt type is imported independently, avoiding
  unused code.
- **Minimal API surface**: Only `select` and `confirm` are needed; the package
  provides exactly these without framework overhead.

---

## Glob (npm package)

**Package**: `glob` v11.0.1
**Used in**: `src/orchestrator.ts`
**Official docs**: [github.com/isaacs/node-glob](https://github.com/isaacs/node-glob)

The glob package is used by the [orchestrator](orchestrator.md) to discover markdown task files
matching a user-provided pattern.

### Usage in dispatch

```typescript
const files = await glob(pattern, { cwd, absolute: true });
```

The orchestrator passes:
- `pattern` -- the user's [glob pattern](cli.md#options-reference) (e.g., `"tasks/**/*.md"`)
- `cwd` -- the working directory (from `--cwd` option or `process.cwd()`)
- `absolute: true` -- returns fully resolved file paths

### Supported glob syntax

The glob package (v11) supports the full Bash glob syntax:

| Pattern | Meaning | Example |
|---------|---------|---------|
| `*` | Match any characters in a single path segment | `*.md` matches `foo.md` |
| `**` | Match zero or more directories (globstar) | `tasks/**/*.md` matches `tasks/a/b/c.md` |
| `?` | Match exactly one character | `task?.md` matches `task1.md` |
| `[abc]` | Character class | `[ab].md` matches `a.md`, `b.md` |
| `[!abc]` | Negated character class | `[!a].md` matches `b.md` but not `a.md` |
| `{a,b}` | Brace expansion | `{src,lib}/**/*.md` matches in both dirs |
| `{1..5}` | Numeric range expansion | `task{1..3}.md` matches `task1.md` through `task3.md` |
| `!(pattern)` | Negation extglob | `!(test).md` matches anything except `test.md` |
| `+(pattern)` | One or more extglob | `+(a\|b).md` |
| `?(pattern)` | Zero or one extglob | `?(test).md` |

### Shell quoting

Glob patterns must be quoted when passed through the shell to prevent the
shell from expanding them before dispatch receives them:

```bash
# Correct -- shell passes the literal pattern to dispatch
dispatch "tasks/**/*.md"
dispatch 'tasks/**/*.md'

# Wrong -- shell expands the glob, dispatch receives individual filenames
dispatch tasks/**/*.md
```

### Symlinks, hidden files, and performance

- **Symlinks**: By default, `**` follows one symbolic link if it is not the
  first item in the pattern, and none if it is. Use `{ follow: true }` to
  follow all symlinks (not currently used by dispatch).
- **Hidden files**: Files starting with `.` are not matched by `*` or `**`
  unless the `{ dot: true }` option is set (not currently used by dispatch).
  An explicit dot in the pattern (e.g., `.hidden/*.md`) will match dot files.
- **Performance**: The glob package uses caching and efficient directory
  traversal. For typical project sizes (thousands of files), performance is
  not a concern. For very large directory trees (100k+ files), glob v11 is
  the second-fastest JavaScript glob implementation. The `{ absolute: true }`
  option adds negligible overhead (string path resolution, no extra syscalls).
- **Race conditions**: Glob results represent a snapshot of the filesystem
  at traversal time. Files may be created, modified, or deleted between
  discovery and parsing. This is inherent to filesystem globbing.

---

## OpenCode AI Agent SDK

**Package**: `@opencode-ai/sdk`
**Used in**: `src/providers/opencode.ts`, `src/providers/index.ts:11`
**Official docs**: [opencode.ai/docs](https://opencode.ai/docs)

The OpenCode SDK provides the default AI agent backend for dispatch. For full
setup instructions and troubleshooting, see [OpenCode Backend](../provider-system/opencode-backend.md).

### Starting or connecting to an OpenCode server

There are two modes:

1. **Automatic server** (default): The provider starts a local OpenCode
   server process. No configuration required -- the SDK handles server
   lifecycle. The server is stopped when `cleanup()` is called.

2. **External server** (`--server-url`): Connects to an already-running
   server. Useful for development or shared server setups.

```bash
# Automatic -- SDK starts its own server
dispatch "tasks/**/*.md"

# External -- connect to running server
dispatch "tasks/**/*.md" --server-url http://localhost:4096
```

### Troubleshooting connection failures

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| "Failed to create OpenCode session" | Server not running or not reachable | Check `--server-url` is correct; verify server is running |
| "OpenCode prompt failed" | Session expired or server error | Check server logs; ensure server has not been restarted mid-session |
| Timeout during `bootProvider()` | Server startup taking too long | Increase system resources; check for port conflicts |
| Orphaned server process after crash | `cleanup()` was not called (see [orchestrator cleanup gap](orchestrator.md#the-cleanup-gap-mitigated)) | Manually kill the OpenCode server process |

### Rate limits and cost

Rate limits and cost depend on the OpenCode server configuration and the
underlying AI model it uses. The dispatch tool sends one prompt per task
(or two if [planning is enabled](../planning-and-dispatch/planner.md): one plan prompt + one execute prompt). With
[`--concurrency N`](cli.md#options-reference), up to N prompts may be in flight simultaneously. Consult
OpenCode documentation for specific rate limit and pricing details.

---

## GitHub Copilot SDK

**Package**: `@github/copilot-sdk`
**Used in**: `src/providers/copilot.ts`, `src/providers/index.ts:12`
**Official docs**: [github.com/github/copilot-sdk](https://github.com/github/copilot-sdk)

The Copilot SDK provides an alternative AI agent backend. For full setup,
authentication, and troubleshooting, see [Copilot Backend](../provider-system/copilot-backend.md).

### Authentication

The Copilot provider supports multiple authentication methods:

1. **Logged-in Copilot CLI user** (default): If the `copilot` CLI is
   installed and the user has authenticated via `copilot auth`, no additional
   configuration is needed.
2. **Environment variables**: Set one of these:
    - `COPILOT_GITHUB_TOKEN`
    - `GH_TOKEN`
    - `GITHUB_TOKEN`

```bash
# Using logged-in CLI user
dispatch "tasks/**/*.md" --provider copilot

# Using a token
GITHUB_TOKEN=ghp_xxxx dispatch "tasks/**/*.md" --provider copilot

# Connecting to external Copilot CLI server
dispatch "tasks/**/*.md" --provider copilot --server-url http://localhost:3000
```

### Rate limits and throttling

Copilot SDK rate limits depend on the user's Copilot subscription tier and
GitHub's API limits. With batch dispatch (`--concurrency > 1`), multiple
sessions send prompts simultaneously. If throttled:

- Individual task prompts may time out or return errors.
- The task is marked as failed in the [TUI](tui.md); other tasks continue.
- Throttled tasks do not block the overall pipeline; they just fail
  individually.

Consider using `--concurrency 1` if you encounter rate limiting.

---

## tsup (build tool)

**Package**: `tsup` v8.4.0 (dev dependency)
**Config file**: `tsup.config.ts`
**Official docs**: [tsup.egoist.dev](https://tsup.egoist.dev/)

tsup is the build tool that compiles TypeScript source to the distributable
JavaScript bundle.

### Configuration

The tsup config is in `tsup.config.ts`:

```typescript
import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf-8"));

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __VERSION__: JSON.stringify(version),
  },
});
```

Key settings:

- **Single entry point**: `src/cli.ts` -- all other modules are bundled
  transitively.
- **ESM format**: Output is ES modules (matching `"type": "module"` in
  `package.json`).
- **Node 18 target**: Uses Node.js 18+ APIs.
- **Shebang banner**: `#!/usr/bin/env node` is prepended so the output is
  directly executable.
- **No code splitting**: All code is in a single `dist/cli.js` file.
- **Source maps**: Enabled for debugging.
- **No type declarations**: `dts: false` -- this is a CLI tool, not a library.

### Build-time version injection via `define`

The `define` block reads the version from `package.json` at build time and
replaces every occurrence of the `__VERSION__` identifier in the source with
the JSON-stringified version string. The global constant is declared in
`src/globals.d.ts` as `declare const __VERSION__: string`.

At `src/cli.ts:307`, the version is displayed as:

```
console.log(`dispatch v${__VERSION__}`);
```

After tsup builds the project, this becomes a literal string in `dist/cli.js`
(e.g., `dispatch v0.0.1`). No runtime file reads are needed.

tsup's `define` feature works like esbuild's `define` -- it performs global
string replacement at build time. The replacement value must be a valid
JavaScript expression (hence `JSON.stringify()` to produce a quoted string
literal).

### Build commands

```bash
npm run build      # Production build
npm run dev        # Watch mode for development
```

---

## Node.js fs/promises (config file I/O and validation)

**Module**: `node:fs/promises`
**Used in**: `src/config.ts:7` (`readFile`, `writeFile`, `mkdir`),
`src/orchestrator/cli-config.ts:11` (`access`)
**Official docs**: [nodejs.org/api/fs.html#promises-api](https://nodejs.org/api/fs.html#promises-api)

The `fs/promises` module provides asynchronous filesystem operations for the
[configuration system](configuration.md). It is used to read, write, and
create the persistent config file at `{CWD}/.dispatch/config.json`, and to
validate output directory writability.

### Functions used

| Function | Usage | Location |
|----------|-------|----------|
| `readFile` | Load config file contents as UTF-8 string | `src/config.ts:55` |
| `writeFile` | Write pretty-printed JSON config to disk | `src/config.ts:73` |
| `mkdir` | Create `.dispatch/` directory if it doesn't exist | `src/config.ts:72` |
| `access` | Validate `--output-dir` exists and is writable (`constants.W_OK`) | `src/orchestrator/cli-config.ts:87` |

### Config file location and permissions

The config file path is `{CWD}/.dispatch/config.json`, computed via
`join(process.cwd(), ".dispatch", "config.json")`. The `.dispatch/` directory is
created with `{ recursive: true }`, which:

- Creates all missing parent directories in the path.
- Is a no-op if the directory already exists.
- Uses the process's default umask for directory permissions (typically
  `0755` on Unix systems).

The config file itself is written with `writeFile` using the default mode,
which on Unix systems is typically `0644` (owner read-write, group and others
read-only). No explicit `mode` option is passed.

### Output directory validation

The `access()` function with `constants.W_OK` (`src/orchestrator/cli-config.ts:87`)
is used to validate that `--output-dir` exists and is writable before
starting the spec pipeline. This is a check-then-act pattern -- it verifies
the directory is accessible at validation time, but does not guarantee it
remains accessible when the pipeline writes to it later.

The `access()` function:
- Returns a resolved promise if the path exists and has the requested
  permissions.
- Rejects with an error if the path does not exist, is not accessible, or
  lacks the requested permissions.
- Does **not** create the directory. Unlike `mkdir`, this is a read-only
  check.

### Error handling strategy

The config system uses a **silent-fallback** strategy for read errors and an
**explicit-error** strategy for write errors:

| Operation | Error behavior | Rationale |
|-----------|---------------|-----------|
| `readFile` (load config) | `catch` returns `{}` -- no error shown | Missing or corrupted config is common and non-fatal |
| `writeFile` (save config) | Error propagates to caller | Write failures need user attention (permissions, disk space) |
| `mkdir` (create dir) | Error propagates to caller | Directory creation failures block config persistence |
| `access` (validate dir) | `catch` triggers `process.exit(1)` with error message | Invalid output-dir should be caught before pipeline starts |

### Troubleshooting fs/promises issues

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| `EACCES` on `saveConfig` | No write permission on `.dispatch/` | `chmod u+w .dispatch/` or check project directory permissions |
| `ENOSPC` on `writeFile` | Disk full | Free disk space |
| Config silently ignored | Corrupted JSON in config file | Run `dispatch config` to reconfigure, or manually edit `.dispatch/config.json` |
| `EROFS` on `mkdir` | Read-only filesystem (e.g., some container images) | Mount a writable volume or use CLI flags exclusively |
| `--output-dir` validation fails | Directory does not exist or is read-only | Create the directory first, or check mount permissions |

### Concurrent access

The config file has no locking mechanism. If two `dispatch` processes run
`dispatch config` simultaneously, the last write wins and the first
write's changes are lost. This is unlikely in practice since config
commands are interactive and infrequent. For automated scenarios, external
locking (e.g., `flock`) would be needed.

---

## Node.js process (stdout, argv, exit)

**Used in**: `src/cli.ts:267`, `src/cli.ts:283`, `src/tui.ts`
**Official docs**: [nodejs.org/api/process.html](https://nodejs.org/api/process.html)

### process.argv

The CLI reads `process.argv.slice(2)` to get user-provided arguments
(skipping the Node.js binary path and script path).

### process.stdout

The TUI writes directly to `process.stdout` using:

- `process.stdout.write(output)` -- for rendering frames (avoids the trailing
  newline that `console.log` adds).
- `process.stdout.columns` -- to determine terminal width for text truncation.
  Falls back to 80 columns if not available.

### process.exit

The CLI calls `process.exit()` at several points:

| Location | Exit code | Reason |
|----------|-----------|--------|
| `src/cli.ts:280` | `0` | `config` subcommand completed |
| `src/cli.ts:303` | `0` | `--help` displayed |
| `src/cli.ts:308` | `0` | `--version` displayed |
| `src/cli.ts:318` | `0` or `1` | Normal completion (`1` if any task failed or fix-tests unsuccessful) |
| `src/cli.ts:324` | `1` | Unhandled exception in `main()` |
| `src/cli.ts:191` | `1` | Invalid `--concurrency` value |
| `src/cli.ts:196` | `1` | `--concurrency` exceeds `MAX_CONCURRENCY` (64) |
| `src/cli.ts:204` | `1` | Unknown `--provider` value |
| `src/cli.ts:216` | `1` | Invalid `--plan-timeout` value |
| `src/cli.ts:227` | `1` | Invalid `--retries` value |
| `src/cli.ts:235` | `1` | Invalid `--plan-retries` value |
| `src/cli.ts:245` | `1` | Invalid `--test-timeout` value |
| `src/cli.ts:257` | `1` | Unknown CLI option |

### Raw ANSI escape codes in non-TTY environments

The TUI's cursor control uses these ANSI sequences:

| Sequence | Meaning |
|----------|---------|
| `\x1B[${n}A` | Move cursor up n lines (CSI CUU) |
| `\x1B[0J` | Clear from cursor to end of screen (CSI ED) |

These are written directly via `process.stdout.write()` and are **not**
filtered by chalk's color detection. In non-TTY environments, they appear
as literal escape characters in the output. See
[TUI -- TTY compatibility](tui.md#tty-compatibility-and-non-tty-environments)
for the full impact assessment.

### Signal handling

Dispatch installs `SIGINT` and `SIGTERM` handlers at `src/cli.ts:289-299`
that call `runCleanup()` from the [cleanup registry](../shared-types/cleanup.md)
before exiting. This ensures provider server processes are stopped on Ctrl+C
or container shutdown.

| Signal | Exit code | Trigger |
|--------|-----------|---------|
| SIGINT | 130 | Ctrl+C or `kill -2` |
| SIGTERM | 143 | `kill <pid>`, container stop, process manager |

Additionally, the `.catch()` handler on the `main()` promise
(`src/cli.ts:321-324`) calls `runCleanup()` before `process.exit(1)` to
handle unhandled exceptions.

For full details on exit codes, double-signal behavior, hung shutdown
troubleshooting, and unhandleable signals, see
[Process Signals integration](../shared-types/integrations.md#nodejs-process-signals-sigint-sigterm).

---

## Node.js child_process (provider detection)

**Module**: `node:child_process`
**Used in**: `src/providers/detect.ts:6`
**Official docs**: [nodejs.org/api/child_process.html](https://nodejs.org/api/child_process.html)

The `execFile` function (promisified) is used by [`checkProviderInstalled()`](../prereqs-and-safety/provider-detection.md)
(`src/providers/detect.ts:29-37`) to detect whether a provider's CLI binary
is available on PATH. It executes `<binary> --version` and returns `true` if
the process exits successfully, `false` otherwise.

The four provider binaries checked are:

| Provider | Binary |
|----------|--------|
| `opencode` | `opencode` |
| `copilot` | `copilot` |
| `claude` | `claude` |
| `codex` | `codex` |

This detection is used in the [configuration wizard](configuration.md#wizard-step-details)
to display green (installed) or red (not found) indicators next to each
provider name in the selection prompt.

---

## Process cleanup registry

**Module**: `src/helpers/cleanup.ts`
**Used in**: `src/orchestrator/runner.ts`, `src/cli.ts` (signal and error
handlers)

The cleanup registry is a simple module that allows sub-modules (orchestrator,
spec-generator) to register their provider's [`cleanup()`](../shared-types/provider.md#cleanup-promisevoid) function at boot time.
The CLI's signal handlers and error handler drain the registry before exiting,
ensuring provider resources are released even when the orchestrator's own error
path doesn't call `instance.cleanup()`.

### API

| Export | Signature | Description |
|--------|-----------|-------------|
| `registerCleanup` | `(fn: () => Promise<void>) => void` | Adds a cleanup function to the registry |
| `runCleanup` | `() => Promise<void>` | Invokes all registered functions, then clears the registry |

### Internal design

- **Storage**: A module-level `Array<() => Promise<void>>`.
- **Drain behavior**: `runCleanup()` calls `cleanups.splice(0)` to atomically
  take all functions from the array, then invokes them sequentially in
  registration order.
- **Error handling**: Each function is called in a `try/catch`. Errors are
  silently swallowed to prevent cleanup failures from masking the original
  error or blocking process exit.
- **Idempotent**: Because `splice(0)` empties the array, calling `runCleanup()`
  multiple times is harmless -- the second call finds an empty array and returns
  immediately.

### Usage in the orchestrator

The cleanup registration happens at provider boot time, immediately after
the provider is booted. It ensures that even if an unhandled error propagates
past the orchestrator's `try/catch`, the CLI's top-level error handler can still
clean up the provider by calling `runCleanup()`.

See the [Orchestrator cleanup documentation](orchestrator.md#process-level-cleanup-via-registercleanup)
for how this interacts with the orchestrator's own error recovery.

## Related documentation

- [CLI](cli.md) -- argument parsing and exit codes
- [Configuration](configuration.md) -- config file, three-tier precedence,
  `dispatch config` subcommand
- [Orchestrator](orchestrator.md) -- glob usage and provider boot
- [TUI](tui.md) -- ANSI rendering and TTY detection
- [Logger](../shared-types/logger.md) -- chalk usage in logging
- [Provider Abstraction & Backends](../provider-system/provider-overview.md) -- provider SDK details
- [OpenCode Backend](../provider-system/opencode-backend.md) -- OpenCode-specific setup and troubleshooting
- [Copilot Backend](../provider-system/copilot-backend.md) -- Copilot-specific setup and authentication
- [Cleanup Registry](../shared-types/cleanup.md) -- Process-level cleanup mechanism
- [Provider Detection](../prereqs-and-safety/provider-detection.md) -- Binary detection used by config wizard
- [Shared Integrations](../shared-types/integrations.md) -- Chalk, fs/promises, and signal handling reference
- [Planner Agent](../planning-and-dispatch/planner.md) -- Planning phase referenced by rate limits discussion
- [Dispatcher](../planning-and-dispatch/dispatcher.md) -- Execution phase that consumes provider sessions
