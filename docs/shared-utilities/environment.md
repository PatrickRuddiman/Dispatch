# Environment

The environment module
([`src/helpers/environment.ts`](../../src/helpers/environment.ts)) detects the
host operating system and produces formatted text blocks that are injected into
AI agent system prompts. This ensures agents know which OS they are running on
and use direct shell commands rather than writing intermediate scripts.

## What it does

The module exports four symbols:

| Export | Kind | Purpose |
|--------|------|---------|
| `EnvironmentInfo` | Interface | Structured representation of `platform`, `os`, and `shell` |
| `getEnvironmentInfo` | Function | Detects the runtime OS from `process.platform` |
| `formatEnvironmentPrompt` | Function | Formats environment info as a markdown prompt block |
| `getEnvironmentBlock` | Alias | Alias for `formatEnvironmentPrompt`, used by the dispatcher module |

## Why it exists

Dispatch delegates code changes to external AI coding agents (OpenCode,
Copilot, Claude, Codex). These agents receive system prompts that describe
the task, codebase context, and execution environment. Without explicit
environment information, agents may:

- Generate `.bat` or `.ps1` scripts on Linux/macOS, or bash scripts on
  Windows.
- Use platform-specific paths (backslashes vs. forward slashes) incorrectly.
- Assume a shell that does not exist on the host OS.

The environment prompt block solves this by injecting a concise,
machine-readable description of the host OS and default shell into every
agent system prompt, along with an explicit instruction to run commands
directly rather than writing intermediate scripts.

## How it works

### Platform detection

The `getEnvironmentInfo()` function reads `process.platform` and maps it
to a human-readable OS name and default shell:

| `process.platform` | OS | Shell | Notes |
|---------------------|----|-------|-------|
| `"win32"` | Windows | `cmd.exe/PowerShell` | Covers all Windows versions |
| `"darwin"` | macOS | `zsh/bash` | zsh is the default shell since macOS Catalina |
| Any other value | Linux | `bash` | Catch-all default for Linux, FreeBSD, etc. |

The function uses a `switch` statement with a `default` branch, so any
platform not explicitly matched (e.g., `"freebsd"`, `"sunos"`, `"aix"`)
falls through to the Linux/bash default. This is a reasonable assumption
because:

1. **Dispatch's primary target platforms are Linux, macOS, and Windows.**
   These cover the vast majority of development environments.
2. **Non-Linux Unix variants** (FreeBSD, Solaris) typically have `bash`
   available and behave similarly to Linux for shell command purposes.
3. **The shell value is informational, not functional.** It is injected
   into agent prompts as guidance, not used to spawn processes. An
   incorrect shell label would result in slightly suboptimal agent
   suggestions but would not cause failures.

### Prompt formatting

The `formatEnvironmentPrompt()` function calls `getEnvironmentInfo()` and
produces a multi-line markdown block:

```markdown
## Environment
- **Operating System:** Linux
- **Default Shell:** bash
- Always run commands directly in the shell. Do NOT write intermediate scripts (e.g. .bat, .ps1, .py files) unless the task explicitly requires creating a script.
```

The instruction to avoid intermediate scripts is critical. Without it,
agents frequently generate wrapper scripts instead of running commands
directly, which adds unnecessary complexity and can fail if the script
format does not match the host OS.

### The `getEnvironmentBlock` alias

The `getEnvironmentBlock` constant is an alias for `formatEnvironmentPrompt`.
It exists for backward compatibility with the
[dispatcher module](../planning-and-dispatch/dispatcher.md)
(`src/dispatcher.ts`), which imports the function under this name.

## Current usage

The environment prompt block is injected into five agent system prompts:

| Agent | Source | Import name |
|-------|--------|-------------|
| Dispatcher (planner prompt) | [`src/dispatcher.ts:86`](../../src/dispatcher.ts) | `getEnvironmentBlock` |
| Dispatcher (executor prompt) | [`src/dispatcher.ts:110`](../../src/dispatcher.ts) | `getEnvironmentBlock` |
| Planner agent | [`src/agents/planner.ts:144`](../../src/agents/planner.ts) | `formatEnvironmentPrompt` |
| Commit agent | [`src/agents/commit.ts:159`](../../src/agents/commit.ts) | `formatEnvironmentPrompt` |
| Spec agent | [`src/agents/spec.ts:398`](../../src/agents/spec.ts) | `formatEnvironmentPrompt` |

Every agent role in the system receives the environment block. This ensures
consistent OS-aware behavior regardless of which agent is active.

## `process.platform` in Node.js

The `process.platform` property is a string identifying the operating system
platform on which the Node.js process is running. It is set at compile time
of the Node.js binary and does not change during the process lifetime.

Possible values include `"aix"`, `"darwin"`, `"freebsd"`, `"linux"`,
`"openbsd"`, `"sunos"`, and `"win32"`. The value is always lowercase.

The environment module only explicitly handles `"win32"` and `"darwin"`,
defaulting everything else to Linux. This is sufficient because Dispatch
targets standard development environments and the shell value is purely
informational for agent prompt guidance.

## Test coverage

The test file
[`src/tests/environment.test.ts`](../../src/tests/environment.test.ts)
covers:

- Detection of all three platform branches (`win32`, `darwin`, default/Linux)
- Correct mapping of platform to OS name and shell description
- `formatEnvironmentPrompt()` output contains OS name, shell, and the
  "run commands directly" instruction
- Platform detection uses `process.platform` (tests mock this value)

## Related documentation

- [Shared Utilities overview](./overview.md) -- Context for all shared utility
  modules
- [Dispatcher](../planning-and-dispatch/dispatcher.md) -- Primary consumer of
  `getEnvironmentBlock` for planner and executor prompts
- [Planner Agent](../agent-system/planner-agent.md) -- Uses
  `formatEnvironmentPrompt` in planning system prompts
- [Commit Agent](../agent-system/commit-agent.md) -- Uses
  `formatEnvironmentPrompt` in commit message generation prompts
- [Spec Agent](../agent-system/spec-agent.md) -- Uses
  `formatEnvironmentPrompt` in spec generation prompts
- [Windows support](../windows.md) -- Platform-specific considerations for
  Windows hosts
- [Helpers & Utilities Tests](../testing/helpers-utilities-tests.md) -- Tests
  covering shared helper functions including environment detection
