# Binary Detection

The binary detection module (`src/providers/detect.ts`) checks whether each
provider's CLI binary is available on the system PATH. It is used exclusively
by the interactive configuration wizard to show installation status indicators
(green or red dots) next to provider names.

**Source file:** `src/providers/detect.ts`

The module exports two things:

1. **`PROVIDER_BINARIES`** — A record mapping each `ProviderName` to its
   expected CLI binary name.
2. **`checkProviderInstalled(name)`** — An async function that attempts to run
   the binary with `--version` and returns `true` if it succeeds, `false`
   otherwise. The function never rejects (throws).

## Why this exists

Before a user selects a provider, Dispatch checks whether the required CLI tool
is actually installed. This gives immediate feedback during the setup wizard
rather than failing at dispatch time with a cryptic "command not found" error.

The detection is purely informational. An uninstalled provider can still be
selected in the wizard — the green/red dot is a hint, not a restriction. This
design allows users to install the provider after configuring Dispatch, or to
use a remote provider that does not require a local binary.

## How detection works

The `checkProviderInstalled()` function (`src/providers/detect.ts:32-43`)
performs a simple availability check:

1. Looks up the binary name from the `PROVIDER_BINARIES` map.
2. Calls `execFile(binary, ["--version"], { timeout: 5000 })` via the
   promisified `child_process.execFile`.
3. If the command succeeds (exit code 0), returns `true`.
4. If the command fails for any reason (not found, timeout, non-zero exit),
   returns `false`.

The function **never rejects** -- all errors are caught and converted to
`false`.

### Never-reject guarantee

The function signature returns `Promise<boolean>` and is documented as "never
rejects." The try/catch ensures that any error from `execFile` is caught and
converted to a `false` return. Callers can safely use `Promise.all()` without
risk of unhandled rejections.

The function does not validate the version string, check for a minimum version,
or parse the output in any way. It is a pure existence check.

### No caching

Each call to `checkProviderInstalled()` spawns a new child process. There is no
result caching. In practice this is acceptable because:

- The function is called at most once per CLI invocation (during the config
  wizard).
- It checks all four providers in parallel via `Promise.all()`, so the total
  wall-clock time is bounded by the slowest single check (typically under
  100ms).

## Provider binary map

Defined at `src/providers/detect.ts:19-24`:

| Provider name | Expected binary | Full detection command |
|---------------|----------------|-----------------------|
| `opencode` | `opencode` | `opencode --version` |
| `copilot` | `copilot` | `copilot --version` |
| `claude` | `claude` | `claude --version` |
| `codex` | `codex` | `codex --version` |

The mapping is defined as a `Record<ProviderName, string>` where
[`ProviderName`](../shared-types/provider.md) is the union type
`"opencode" | "copilot" | "claude" | "codex"` from `src/providers/interface.ts`.
This ensures compile-time exhaustiveness — adding a new provider to the type
union without updating the map will cause a TypeScript error.

## The 5-second timeout

`DETECTION_TIMEOUT_MS` is set to 5,000 ms (`src/providers/detect.ts:14`).

### How Node.js handles the timeout

When `execFile` is called with a `timeout` option and the child process exceeds
that timeout, Node.js sends the `killSignal` to the child process (defaults to
`SIGTERM` on Unix, terminates the process on Windows). The callback receives an
error with the `killed` property set to `true`. Since `checkProviderInstalled`
catches all errors, the timeout causes a `false` return.

According to the [Node.js documentation](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback),
the child process is properly terminated when the timeout fires. On all
platforms, the spawned process is killed, not orphaned.

### Implications for slow networks and CI systems

A valid binary that takes more than 5 seconds to respond to `--version` will be
**falsely reported as unavailable**. This can happen in:

- **CI environments**: Where binary execution may be slow due to cold caches,
  container startup overhead, or network-mounted filesystems.
- **Remote development environments**: Where PATH resolution involves network
  calls (e.g., NFS-mounted `/usr/local/bin`).
- **Resource-constrained systems**: Where heavy I/O contention delays process
  startup.

### Mitigation strategies

1. **Detection is advisory, not blocking**: A failed check shows a red dot in
   the wizard (`src/config-prompts.ts:74`) but does not prevent the user from
   selecting that provider. Users can still choose a provider that appears
   unavailable.
2. **No retry or override mechanism**: There is no configuration option to
   increase the timeout or bypass detection. If the 5-second timeout is
   consistently too short for your environment, the binary will always appear
   unavailable in the wizard, but you can still select it.
3. **Detection is only used in the config wizard**: The main dispatch pipeline
   does not call `checkProviderInstalled()` before booting a provider. Detection
   failures during the wizard do not affect runtime behavior.

## Windows compatibility

On Windows, `checkProviderInstalled()` sets `shell: true` when
`process.platform === "win32"` (`src/providers/detect.ts:37`). This is
necessary because:

- Windows does not support shebangs or direct execution of `.cmd`/`.bat` files
  without a shell.
- Many Node.js CLI tools are installed as `.cmd` wrappers on Windows (e.g.,
  `opencode.cmd`).
- Without `shell: true`, `execFile` would fail with `ENOENT` for these
  wrappers.

The [Node.js documentation](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
confirms this is the correct approach for executing `.bat` and `.cmd` files.

## How detection is used in the config wizard

The interactive configuration wizard (`src/config-prompts.ts:67-78`) calls
`checkProviderInstalled()` for all four providers in parallel:

```ts
const installStatuses = await Promise.all(
  PROVIDER_NAMES.map((name) => checkProviderInstalled(name)),
);
```

Results are displayed as colored dots next to provider names:
- Green dot: binary found
- Red dot: binary not found (or timed out)

## How to verify provider installation

To manually verify which CLI binaries are installed and on PATH:

```sh
# Check each binary individually
opencode --version
copilot --version
claude --version
codex --version
```

If a binary is installed but not on PATH, you can either:
- Add its directory to your `PATH` environment variable.
- Create a symlink in a directory already on PATH.

## Integration: Node.js `child_process`

The detection module uses Node.js `child_process.execFile` (promisified via
`node:util`) for process spawning. Key behaviors from the
[Node.js documentation](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback):

- `execFile` spawns the command directly without a shell (unless `shell: true`
  is set), making it more efficient than `exec`.
- The `timeout` option specifies the maximum execution time in milliseconds.
  When exceeded, the child process is killed with `SIGTERM`.
- The `killSignal` defaults to `SIGTERM`, which allows the child process to
  perform cleanup. On Windows, processes are terminated immediately.
- `execFile` buffers stdout and stderr. For `--version` checks, the buffer size
  is more than adequate.

## Relationship to the prerequisite checker

The provider detection module and the prerequisite checker
(`src/helpers/prereqs.ts`) both probe for external binaries using the same
technique (`execFile` with `--version`), but they serve different purposes:

| Aspect | `checkProviderInstalled` | `checkPrereqs` |
|--------|-------------------------|----------------|
| Purpose | Informational (UI hint) | Blocking (fail-fast gate) |
| Scope | AI provider binaries | git, Node.js, gh, az |
| On failure | Returns `false` | Accumulates error message |
| Called from | Config wizard only | Every CLI pipeline invocation |
| Effect of failure | Red dot in menu | `process.exit(1)` |

The two modules are independent. Provider detection does not run during normal
pipeline execution, and prerequisite checks do not probe provider binaries.

## Design considerations

### Why not cache results

The detection runs once (during the config wizard) and checks four binaries in
parallel. Caching would add complexity without measurable benefit. If the
detection were called repeatedly in a hot path, a time-based cache or
single-flight pattern would be warranted, but the current usage does not
require it.

### Why not block selection of uninstalled providers

Allowing selection of uninstalled providers avoids false negatives in several
scenarios:

- The user plans to install the provider before running a pipeline.
- The provider binary is available on a different machine or in a container
  that will be used at runtime.
- A future provider might not require a local binary (e.g., a cloud-hosted API
  provider).

### Why not check provider versions

Provider CLIs evolve independently of Dispatch. Enforcing minimum versions would
create a maintenance burden and risk blocking users with compatible but slightly
older versions.

### Non-zero exit codes

If a binary exists but exits with a non-zero code on `--version` (e.g., due to
a broken installation or misconfiguration), `execFile` will reject with an
error. The catch block converts this to `false`, meaning the provider will show
as "not installed" in the config wizard. This is by design — a binary that
cannot report its version is treated as unavailable.

## Testing

The detection module has a dedicated test file at `src/tests/detect.test.ts`
(71 lines, 4 tests). The tests mock `node:child_process` and
`process.platform` to verify:

1. **Installed binary**: `execFile` resolves → `checkProviderInstalled` returns
   `true`.
2. **Missing binary**: `execFile` rejects with `ENOENT` →
   `checkProviderInstalled` returns `false`.
3. **Windows platform**: When `process.platform` is `"win32"`, `execFile` is
   called with `{ shell: true }`.
4. **Non-Windows platform**: When `process.platform` is `"linux"`, `execFile`
   is called with `{ shell: false }`.

## Related documentation

- [Provider System Overview](./overview.md) -- architecture and interface
  contract
- [Adding a New Provider](./adding-a-provider.md) -- includes adding the binary
  to `PROVIDER_BINARIES`
- [CLI & Configuration](../cli-orchestration/configuration.md) -- the
  interactive setup wizard that uses detection
- [Prereqs & Safety Integrations](../prereqs-and-safety/integrations.md) --
  similar `execFile`/`child_process` patterns for prerequisite binary checks
- [Troubleshooting](../dispatch-pipeline/troubleshooting.md) -- common errors
  including missing provider binary failures
