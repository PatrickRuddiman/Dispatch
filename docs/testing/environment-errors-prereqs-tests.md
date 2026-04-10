# Environment, Errors, and Prerequisites Tests

This document covers three lightweight test files that verify the simpler
helper modules: OS detection, custom error types, and startup prerequisite
validation.

## Test files

| Test file | Production module | Tests | Lines (test) | Lines (source) | Category |
|-----------|-------------------|-------|-------------|----------------|----------|
| [`src/tests/environment.test.ts`](../../src/tests/environment.test.ts) | [`src/helpers/environment.ts`](../../src/helpers/environment.ts) | 6 | 101 | 50 | Platform override |
| [`src/tests/errors.test.ts`](../../src/tests/errors.test.ts) | [`src/helpers/errors.ts`](../../src/helpers/errors.ts) | 5 | 35 | 19 | Pure logic |
| [`src/tests/prereqs.test.ts`](../../src/tests/prereqs.test.ts) | [`src/helpers/prereqs.ts`](../../src/helpers/prereqs.ts) | 10 | 160 | 66 | Mocking + platform |

## Environment tests

### What is tested

The `environment.ts` module exports two functions used to inject OS-aware
context into [AI agent system prompts](../agent-system/overview.md):

| Function | Purpose |
|----------|---------|
| `getEnvironmentInfo()` | Returns `{ platform, os, shell }` based on `process.platform` |
| `formatEnvironmentPrompt()` | Formats environment info as a Markdown text block for agent prompts |

### Test organization

The test file contains **2 describe blocks** with **6 tests** total.

| Describe block | Tests | Focus |
|----------------|-------|-------|
| `getEnvironmentInfo` | 3 | Platform-to-info mapping for win32, linux, darwin |
| `formatEnvironmentPrompt` | 3 | Formatted output contains correct OS name, shell, and instruction |

### Platform mapping

| `process.platform` | `os` | `shell` |
|--------------------|------|---------|
| `"win32"` | `"Windows"` | `"cmd.exe/PowerShell"` |
| `"linux"` | `"Linux"` | `"bash"` |
| `"darwin"` | `"macOS"` | `"zsh/bash"` |

### Testing approach

Tests use `Object.defineProperty(process, "platform", { value: "..." })` to
override the platform for each test case. The real platform is saved before
all tests and restored in both `beforeEach` and `afterEach` hooks to prevent
cross-test contamination.

The `formatEnvironmentPrompt` tests use `expect(prompt).toContain(...)` to
verify key substrings appear in the output without asserting the exact
format, making the tests resilient to minor formatting changes.

## Errors tests

### What is tested

The `errors.ts` module exports [`UnsupportedOperationError`](../shared-utilities/errors.md), a custom error
class used when a datasource or provider does not support a specific
operation (e.g., calling git lifecycle methods on the [markdown datasource](../datasource-system/overview.md)).

### Test organization

The test file contains **1 describe block** with **5 tests** (35 lines).

| Test | What it verifies |
|------|------------------|
| `creates an error with the default message` | Message format: `"Operation not supported: <operation>"` |
| `creates an error with a custom message` | Custom message overrides default |
| `is an instance of Error` | `instanceof Error` and `instanceof UnsupportedOperationError` |
| `has a stack trace` | Stack trace exists and contains class name |
| `operation property is readonly` | Property exists and is a string |

### Key design details

The `UnsupportedOperationError` constructor accepts two parameters:

1. `operation` (required) — stored as a readonly property for programmatic
   error handling
2. `message` (optional) — overrides the default `"Operation not supported: ..."` format

The class sets `this.name = "UnsupportedOperationError"` explicitly so that
error messages include the correct class name rather than the generic `Error`.

### Testing approach

This is a **pure constructor** test with no mocking or I/O. Each test
creates an instance and asserts properties directly.

## Prerequisites tests

### What is tested

The [`prereqs.ts`](../prereqs-and-safety/prereqs.md) module exports `checkPrereqs()`, which verifies that
required external tools and runtime versions are available before any
pipeline logic runs. It returns an array of human-readable failure messages
(empty array means all checks pass).

Two checks are performed:

1. **Git availability** — runs `git --version` via `execFile`
2. **Node.js version** — compares `process.versions.node` against the
   minimum `20.12.0` using semver comparison

### Test organization

The test file contains **1 describe block** with **10 tests** (160 lines).

| Test | Scenario | Expected failures |
|------|----------|-------------------|
| `returns empty array when all prerequisites pass` | Git found, Node >= 20.12.0 | `[]` |
| `reports failure when git is not found` | `execFile` rejects with ENOENT | 1 failure mentioning "git" |
| `reports failure when Node.js version is below minimum` | Node 18.0.0 | 1 failure mentioning "Node.js" and "20.12.0" |
| `reports multiple failures when git is missing and Node.js is too old` | Both fail | 2 failures |
| `passes shell option to git exec on Windows` | `platform = "win32"` | Verifies `{ shell: true }` |
| `omits shell option for git exec on non-Windows` | `platform = "linux"` | Verifies `{ shell: false }` |
| `passes when Node.js major matches minimum and minor is higher` | Node 20.20.0 | `[]` |
| `passes when Node.js major and minor match minimum but patch is higher` | Node 20.12.5 | `[]` |
| `fails when Node.js major matches but minor is below minimum` | Node 20.11.0 | 1 failure |
| `passes for exact minimum version` | Node 20.12.0 | `[]` |

### Windows shell option

The `checkPrereqs` function passes `{ shell: process.platform === "win32" }`
to `execFile` when running `git --version`. On Windows, `git` is typically
installed as a `.cmd` shim that requires shell execution. The test suite
verifies this by overriding `process.platform` and asserting the `shell`
option:

| Platform | `shell` value |
|----------|--------------|
| `"win32"` | `true` |
| `"linux"` | `false` |

### Semver comparison coverage

The `semverGte` function (internal to `prereqs.ts`) uses a
major-then-minor-then-patch comparison. The test suite covers all relevant
boundary conditions:

| Node version | vs minimum `20.12.0` | Result |
|-------------|---------------------|--------|
| `18.0.0` | Major lower | Fail |
| `20.11.0` | Major equal, minor lower | Fail |
| `20.12.0` | Exact match | Pass |
| `20.12.5` | Major/minor equal, patch higher | Pass |
| `20.20.0` | Major equal, minor higher | Pass |

### Mocking strategy

```
vi.hoisted → define mockExecFile
vi.mock("node:child_process") → { execFile: mockExecFile }
vi.mock("node:util") → { promisify: () => mockExecFile }
```

The `promisify` mock returns `mockExecFile` directly so that the
`const exec = promisify(execFile)` line in `prereqs.ts` resolves to the
controllable mock.

Platform and Node.js version are overridden using `Object.defineProperty`:

- `process.platform` — controls the `shell` option for git execution
- `process.versions.node` — controls the Node.js version comparison

Both are restored in `afterEach` to prevent cross-test contamination.

### External integration: Git CLI

- **Binary:** `git`
- **Command:** `git --version`
- **How tested:** `mockExecFile` resolves with `{ stdout: "git version 2.43.0\n" }`
  for success, or rejects with `new Error("spawn git ENOENT")` for failure.
- **Production behavior:** Dispatch requires git for [worktree management](../git-and-worktree/overview.md),
  branch operations, commits, and push. If `git` is not found on PATH, the
  prerequisite check returns a failure message directing the user to
  [https://git-scm.com](https://git-scm.com).

## Related documentation

- [Test suite overview](overview.md) -- framework, patterns, and coverage map
- [Auth Tests](auth-tests.md) -- authentication tests from the same test group
- [Concurrency Tests](concurrency-tests.md) -- concurrency limiter tests from
  the same test group
- [Worktree Tests](worktree-tests.md) -- worktree lifecycle tests from the
  same test group
- [Shared Utilities Testing](../shared-utilities/testing.md) -- prereqs test
  patterns in the shared utilities context
- [Environment utility](../shared-utilities/environment.md) -- full API
  documentation for `getEnvironmentInfo` and `formatEnvironmentPrompt`
- [Errors utility](../shared-utilities/errors.md) -- `UnsupportedOperationError`
  documentation
- [Prerequisite Checker](../prereqs-and-safety/prereqs.md) -- detailed prereqs
  documentation including Windows shell option rationale
- [Git & Worktree Overview](../git-and-worktree/overview.md) -- git dependency
  context
- [Architecture Overview](../architecture.md) -- system-wide design context
