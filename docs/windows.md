# Windows Guide

This page covers Windows-specific prerequisites, recommended setup, and known
limitations for running Dispatch on Windows.

## Prerequisites

Dispatch requires several command-line tools. The table below lists each tool
with its recommended Windows installation command and when it is required.

| Tool | Install command | Required |
|------|----------------|----------|
| **Git for Windows** | `winget install Git.Git` | Always |
| **Node.js** (>= 20.12.0) | `winget install OpenJS.NodeJS.LTS` | Always |
| **GitHub CLI** | `winget install GitHub.cli` | `--source github` |
| **Azure CLI** | `winget install Microsoft.AzureCLI` | `--source azdevops` |

**Git for Windows** includes Git Bash and is also available from
[gitforwindows.org](https://gitforwindows.org/). **Node.js** can alternatively
be managed through [nvm-windows](https://github.com/coreybutler/nvm-windows).

All four tools are validated at startup by the prerequisite checker. See
[Prerequisite Checker](./prereqs-and-safety/prereqs.md) for details on the
runtime validation logic.

## Recommended setup

### Long paths

Dispatch creates worktrees under `.dispatch/worktrees/` which can produce
deeply nested paths that exceed the default Windows 260-character limit. Enable
long path support in Git:

```sh
git config --global core.longpaths true
```

### Supported shells

Dispatch works from **PowerShell**, **cmd**, and **Git Bash** (installed with
Git for Windows). All `dispatch` CLI commands work identically across these
shells.

### WSL as alternative

If native Windows issues are encountered, Windows Subsystem for Linux (WSL)
provides a full Linux environment where Dispatch runs without
platform-specific concerns.

## Known limitations

### Shell scripts

The repository root contains `.sh` files (`run-git.sh`, `run-tests.sh`,
`worktree-commit.sh`) that are bash-only developer and debug utilities. These
are **not required for normal Dispatch operation** — all user-facing
functionality is accessed through the `dispatch` CLI command.

### Open issues

The following table tracks known Windows-related issues. CRLF handling in the
parser is described in the
[CRLF normalization](./task-parsing/markdown-syntax.md#crlf-normalization)
section of the Markdown Syntax page.

| Issue | Description | Status |
|-------|-------------|--------|
| [#210](https://github.com/PatrickRuddiman/Dispatch/issues/210) | CRLF normalization gap in `markTaskComplete` | Open |
| [#211](https://github.com/PatrickRuddiman/Dispatch/issues/211) | `isFilePath` regex misses Windows-style paths | Open |
| [#212](https://github.com/PatrickRuddiman/Dispatch/issues/212) | Gitignore duplicate-entry check fails on Windows | Open |
| [#213](https://github.com/PatrickRuddiman/Dispatch/issues/213) | Provider binary detection returns false on Windows | Open |
| [#102](https://github.com/PatrickRuddiman/Dispatch/issues/102) | Command splitting (in-flight fix) | In progress |
| [#181](https://github.com/PatrickRuddiman/Dispatch/issues/181) | Path normalization (in-flight fix) | In progress |

## Related documentation

- [Prerequisite Checker](./prereqs-and-safety/prereqs.md) -- Runtime validation
  of git, Node.js, and datasource-specific CLIs.
- [Prerequisites and Safety Overview](./prereqs-and-safety/overview.md) --
  Environment validation and safety checks subsystem.
- [Markdown Syntax — CRLF Normalization](./task-parsing/markdown-syntax.md#crlf-normalization) --
  How the parser normalizes Windows line endings.
- [Architecture Overview](./architecture.md) -- High-level system design and
  component interactions.
