# Provider Binary Detection

The provider binary detection module checks whether each AI provider's CLI
binary is available on the system PATH. It is used exclusively by the
interactive configuration wizard to show the user which providers are
installed before they make a selection.

**Source file:** `src/providers/detect.ts` (38 lines)

## What it does

The module exports two things:

1.  **`PROVIDER_BINARIES`** -- A record mapping each `ProviderName` to its
    expected CLI binary name.

2.  **`checkProviderInstalled(name)`** -- An async function that attempts
    to run the binary with `--version` and returns `true` if it succeeds,
    `false` otherwise. The function never rejects (throws).

### Provider-to-binary mapping

| Provider name | Binary | Full detection command |
|---------------|--------|-----------------------|
| `opencode` | `opencode` | `opencode --version` |
| `copilot` | `copilot` | `copilot --version` |
| `claude` | `claude` | `claude --version` |
| `codex` | `codex` | `codex --version` |

The mapping is defined as a `Record<ProviderName, string>` where
[`ProviderName`](../shared-types/provider.md) is the union type `"opencode" | "copilot" | "claude" | "codex"`
from `src/providers/interface.ts`. This ensures compile-time exhaustiveness --
adding a new provider to the type union without updating the map will cause a
TypeScript error.

## Why it exists

The interactive configuration wizard at `src/config-prompts.ts` needs to
display which providers are available on the user's machine. Without this
information, a user might select a provider that is not installed and only
discover the problem later when the pipeline attempts to boot it.

The detection is purely informational. An uninstalled provider can still be
selected in the wizard -- the green/red dot is a hint, not a restriction.
This design allows users to install the provider after configuring Dispatch,
or to use a remote provider that does not require a local binary.

## How it works

### Detection method

The function calls `execFile(binary, ["--version"])` via the promisified
`node:child_process.execFile`. The call is wrapped in a try/catch:

-   **Success path:** The binary exists, runs, and exits with code 0.
    The function returns `true`. The stdout/stderr output is ignored.
-   **Failure path:** The binary is not found (`ENOENT`), crashes, or
    exits with a non-zero code. The catch block returns `false`.

The function does not validate the version string, check for a minimum
version, or parse the output in any way. It is a pure existence check.

### Never-reject guarantee

The function signature returns `Promise<boolean>` and is documented as
"never rejects." The try/catch ensures that any error from `execFile` is
caught and converted to a `false` return. Callers can safely use
`Promise.all()` without risk of unhandled rejections.

### No caching

Each call to `checkProviderInstalled()` spawns a new child process. There
is no result caching. In practice this is acceptable because:

-   The function is called at most once per CLI invocation (during the
    config wizard).
-   It checks all four providers in parallel via `Promise.all()`, so the
    total wall-clock time is bounded by the slowest single check (typically
    under 100ms).

## Where it is called

The sole call site is in the configuration wizard at
`src/config-prompts.ts:61-62`:

The wizard calls `checkProviderInstalled()` for all entries in
`PROVIDER_NAMES` via `Promise.all()`. The returned boolean array is used
to render the provider selection menu:

-   `true` (installed): Green dot (`chalk.green("●")`) before the name.
-   `false` (not installed): Red dot (`chalk.red("●")`) before the name.

The user then selects a provider from the list using `@inquirer/prompts`
`select()`. The installation status does not filter the list -- all four
providers are always shown.

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

The two modules are independent. Provider detection does not run during
normal pipeline execution, and prerequisite checks do not probe provider
binaries.

## Design considerations

### Why not cache results

The detection runs once (during the config wizard) and checks four binaries
in parallel. Caching would add complexity without measurable benefit. If the
detection were called repeatedly in a hot path, a time-based cache or
single-flight pattern would be warranted, but the current usage does not
require it.

### Why not block selection of uninstalled providers

Allowing selection of uninstalled providers avoids false negatives in several
scenarios:

-   The user plans to install the provider before running a pipeline.
-   The provider binary is available on a different machine or in a
    container that will be used at runtime.
-   A future provider might not require a local binary (e.g., a
    cloud-hosted API provider).

### Why not check provider versions

Provider CLIs evolve independently of Dispatch. Enforcing minimum versions
would create a maintenance burden and risk blocking users with compatible
but slightly older versions.

### Platform-specific shell behavior

The `execFile` call at `src/providers/detect.ts:33-34` passes
`{ shell: process.platform === "win32" }` as an option. This is necessary
because:

- **Windows**: Provider CLIs are often installed as `.cmd` or `.bat` wrappers
  (e.g., `copilot.cmd`). These wrappers require shell interpretation to execute.
  Without `shell: true`, `execFile` would look for a literal `copilot` binary
  and fail with `ENOENT` even though `copilot.cmd` is on PATH.
- **Unix (macOS, Linux)**: Provider binaries are typically native executables or
  shell scripts with a shebang line. Direct execution via `execFile` works
  without invoking a shell, which is faster and avoids shell injection risks.

### Non-zero exit codes

If a binary exists but exits with a non-zero code on `--version` (e.g., due to
a broken installation or misconfiguration), `execFile` will reject with an
error. The catch block converts this to `false`, meaning the provider will show
as "not installed" in the config wizard. This is by design -- a binary that
cannot report its version is treated as unavailable.

## Testing

The detection module has a dedicated test file at `src/tests/detect.test.ts`
(71 lines, 4 tests). The tests mock `node:child_process` and
`process.platform` to verify:

1.  **Installed binary**: `execFile` resolves → `checkProviderInstalled` returns
    `true`.
2.  **Missing binary**: `execFile` rejects with `ENOENT` →
    `checkProviderInstalled` returns `false`.
3.  **Windows platform**: When `process.platform` is `"win32"`, `execFile` is
    called with `{ shell: true }`.
4.  **Non-Windows platform**: When `process.platform` is `"linux"`, `execFile`
    is called with `{ shell: false }`.

## Related documentation

-   [Overview](./overview.md) -- Group overview showing where provider
    detection fits in the CLI flow.
-   [External Integrations](./integrations.md) -- Details on provider
    binary dependencies and installation sources.
-   [Provider System](../provider-system/overview.md) -- The
    provider abstraction that these binaries implement.
-   [Provider Tests](../testing/provider-tests.md) -- Unit tests for the
    provider backends and registry that these binaries back.
-   [Configuration](../cli-orchestration/configuration.md) -- The config
    wizard that uses detection results.
-   [CLI Integrations](../cli-orchestration/integrations.md) -- Child process
    usage for provider detection via `execFile`.
-   [Adding a Provider](../provider-system/adding-a-provider.md) -- Step-by-step
    guide for implementing a new provider backend, including binary registration.
