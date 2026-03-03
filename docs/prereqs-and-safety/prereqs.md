# Prerequisite Checker

The prerequisite checker validates that the host environment has the external
tools and runtime version required by Dispatch before any pipeline logic runs.
It is the first gate in the CLI execution flow and prevents cryptic downstream
failures by producing clear, actionable error messages.

**Source file:** `src/helpers/prereqs.ts` (98 lines)
**Test file:** `src/tests/prereqs.test.ts` (170 lines)

## What it does

The `checkPrereqs()` function runs up to four checks depending on the selected
[datasource](../datasource-system/overview.md) and returns an array of human-readable failure messages. An empty
array means all checks passed.

| # | Check | Condition | When run | Failure message |
|---|-------|-----------|----------|-----------------|
| 1 | Git availability | `git --version` exits successfully | Always | `git is required but was not found on PATH. Install it from https://git-scm.com` |
| 2 | Node.js version | `process.versions.node >= 20.12.0` | Always | `Node.js >= 20.12.0 is required but found <version>. Please upgrade Node.js` |
| 3 | GitHub CLI | `gh --version` exits successfully | Datasource is `github` | `gh (GitHub CLI) is required for the github datasource but was not found on PATH. Install it from https://cli.github.com/` |
| 4 | Azure CLI | `az --version` exits successfully | Datasource is `azdevops` | `az (Azure CLI) is required for the azdevops datasource but was not found on PATH. Install it from https://learn.microsoft.com/en-us/cli/azure/` |

When the datasource is `md` (local markdown files), only checks 1 and 2 run.
When no context is provided (datasource is undefined), the same two universal
checks run.

## Why these specific checks

-   **Git** is universally required because every pipeline mode (dispatch,
    spec, fix-tests) performs git operations -- branching, committing,
    pushing, or reading the working tree.

-   **Node.js >= 20.12.0** is required because the `engines.node` field in
    `package.json` specifies `">=20.12.0"`. The `MIN_NODE_VERSION` constant
    in `prereqs.ts` matches this exactly. Version 20.12.0 is the first
    LTS point release of the Node.js 20 "Iron" line (released 2024-03-26)
    and includes `crypto.hash()`, `process.loadEnvFile()`, and other
    features that the broader toolchain may depend on.

-   **GitHub CLI (`gh`)** is required only when the datasource is `github`
    because the GitHub datasource implementation delegates all API calls
    to the `gh` binary rather than using REST directly.

-   **Azure CLI (`az`)** is required only when the datasource is `azdevops`
    for the same reason -- the Azure DevOps datasource delegates to `az`.

## How it works

### API

```
checkPrereqs(context?: PrereqContext): Promise<string[]>
```

The function accepts an optional `PrereqContext` object with a `datasource`
field of type `DatasourceName` (`"github" | "azdevops" | "md"`). It returns
a promise that resolves to an array of failure message strings.

### Semver comparison

The Node.js version check uses a local `parseSemver()` helper that splits
the version string on `"."` and converts each segment to a number via
`Number()`. The `semverGte()` function performs a standard
major-then-minor-then-patch comparison to determine whether the current
version meets the minimum.

This is a simplified semver parser that does not handle pre-release tags,
build metadata, or version ranges. It works correctly for the use case of
comparing Node.js release versions, which always follow strict
`MAJOR.MINOR.PATCH` format.

### Tool detection method

Each CLI tool check uses `execFile(binary, ["--version"])` via
`node:child_process`. The function wraps the call in a try/catch:

-   If the binary is found and exits successfully, the check passes.
-   If the binary is not found (`ENOENT`), exits with an error, or times
    out, the catch block pushes a failure message.

The check does not validate the output of `--version` or enforce a minimum
version for git, gh, or az. It only verifies that the binary exists on PATH
and can be invoked.

### Failure accumulation

All checks run unconditionally (within their datasource condition). Failures
accumulate in an array rather than short-circuiting on the first failure. This
means a single invocation can report multiple problems -- for example, both
"git not found" and "Node.js too old" -- so the user can fix everything in
one pass.

## Where it is called

The sole call site is in the orchestrator runner at
`src/orchestrator/runner.ts:142-148`:

The `runFromCli()` method calls `checkPrereqs({ datasource: m.issueSource })`
immediately after `resolveCliConfig()` resolves CLI arguments. The datasource
has already been determined at this point (either from the `--source` flag,
config file, or auto-detection).

If the returned array is non-empty, each message is logged via `log.error()`
and the process exits with code 1. This is a **hard abort** -- no partial
side effects are possible because no pipeline logic has run yet. The function
does not throw; it uses the runner's own `process.exit(1)` call.

### Execution order in the CLI flow

1.  `resolveCliConfig(args)` -- merge CLI flags, config file, defaults
2.  **`checkPrereqs({ datasource })`** -- validate environment
3.  `ensureGitignoreEntry()` -- add `.dispatch/worktrees/` to `.gitignore`
4.  Mode routing -- spec, respec, fix-tests, or dispatch

## Design decisions

### No version checks for CLI tools

The checker does not enforce minimum versions for git, gh, or az. This is a
deliberate simplicity choice: version requirements for these tools are loose
and evolve independently of Dispatch. Checking only for presence avoids false
negatives when a user has a slightly older but compatible version.

### No check for the `md` datasource

The markdown datasource reads files from the local filesystem and does not
shell out to any CLI tool beyond git. Therefore, no additional check is needed
when `datasource` is `"md"`.

### No caching

The function runs once at startup and there is no need to cache results. Each
check executes a fresh `execFile` call. This is acceptable because startup
is a one-time cost and the checks are fast (each is a single `--version` call
that returns immediately).

### Return value vs. throwing

The function returns an array of failure strings rather than throwing. This
lets the caller (the runner) log each message individually and decide how to
exit. It also enables the test suite to verify specific failure combinations
without dealing with exception types.

## Testing

The test suite at `src/tests/prereqs.test.ts` covers the following scenarios:

| Test case | What it verifies |
|-----------|-----------------|
| All prerequisites pass | Empty array returned, `git --version` called |
| git not found | Single failure message mentioning git |
| Node.js below minimum | Single failure mentioning `20.12.0` and actual version |
| Multiple failures (git + Node.js) | Two failures in expected order |
| gh not found (github datasource) | Single failure mentioning gh CLI |
| az not found (azdevops datasource) | Single failure mentioning az CLI |
| md datasource (no CLI check) | Empty array, gh/az never called |
| No context provided | Empty array, gh/az never called |
| Multiple failures including datasource CLI | Three failures (git + Node.js + gh) |
| gh available (github datasource) | Empty array, gh was called |
| az available (azdevops datasource) | Empty array, az was called |

Tests mock `node:child_process` via `vi.mock()` and override
`process.versions.node` via `Object.defineProperty()` to simulate different
Node.js versions. Each test resets the mock and restores the real version in
`beforeEach`/`afterEach` hooks.

## Related documentation

-   [Overview](./overview.md) -- Group overview with pipeline integration
    diagram.
-   [External Integrations](./integrations.md) -- Details on the Git CLI,
    GitHub CLI, Azure CLI, and Node.js runtime dependencies.
-   [CLI Orchestration](../cli-orchestration/overview.md) -- The runner that
    calls `checkPrereqs`.
-   [Configuration](../cli-orchestration/configuration.md) -- Config
    resolution that runs immediately before prerequisite checks.
-   [Datasource System](../datasource-system/overview.md) -- Datasource
    names that drive conditional checks.
-   [GitHub Datasource](../datasource-system/github-datasource.md) -- The
    GitHub implementation that requires `gh`.
-   [Azure DevOps Datasource](../datasource-system/azdevops-datasource.md) --
    The Azure DevOps implementation that requires `az`.
-   [Datasource Integrations](../datasource-system/integrations.md) --
    Subprocess execution details and ENOENT behavior for CLI tools.
-   [Testing Overview](../testing/overview.md) -- Test suite framework;
    prerequisite tests are in `src/tests/prereqs.test.ts`.
-   [Timeout Utility](../shared-utilities/timeout.md) -- Deadline enforcement
    that runs after prerequisite checks pass.
