# Dispatch

AI agent orchestration CLI — parse work items from GitHub Issues, Azure DevOps, or local markdown files, dispatch each unit of work to a coding agent (OpenCode, GitHub Copilot, Claude Code, or OpenAI Codex), and commit results with conventional commits.

> **Note:** **Claude Code** (`--provider claude`) and **OpenAI Codex** (`--provider codex`) are largely untested. Expect rough edges and potential failures when using these providers.

## What it does

Dispatch closes the gap between issue trackers and AI coding agents. It:

1. **Fetches work items** from GitHub Issues, Azure DevOps Work Items, or local markdown specs.
2. **Generates structured specs** via an AI agent that explores the codebase and produces task lists.
3. **Plans and executes** each task in isolated AI sessions, with an optional two-phase planner-then-executor pipeline.
4. **Manages the git lifecycle** — branching, committing with conventional commit messages, pushing, and opening pull requests that auto-close the originating issue.

## Prerequisites

### Node.js

Node.js **>= 20.12.0** is required.

### AI provider (choose one)

**OpenCode** (default):

```sh
# Install OpenCode
curl -fsSL https://opencode.ai/install | bash
# or: npm install -g opencode-ai

# Configure an LLM provider (Anthropic, OpenAI, etc.)
opencode
# then run: /connect
```

**GitHub Copilot**:

```sh
# Requires an active GitHub Copilot subscription

# Install the Copilot CLI
npm install -g @github/copilot     # requires Node.js 22+
# or: brew install copilot-cli
# or: winget install GitHub.Copilot

# Authenticate
copilot
# then run: /login
```

For CI environments, set one of these environment variables instead of logging in interactively:
- `COPILOT_GITHUB_TOKEN` — GitHub PAT with **Copilot Requests** permission (highest priority)
- `GH_TOKEN` — standard GitHub CLI token
- `GITHUB_TOKEN` — commonly used in CI

**Claude Code** (`--provider claude`):

```sh
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Authenticate
claude login
# or set ANTHROPIC_API_KEY in your environment
```

Default model: `claude-sonnet-4`. Available models: `claude-sonnet-4`, `claude-sonnet-4-5`, `claude-opus-4-6`, `claude-haiku-3-5`.

**OpenAI Codex** (`--provider codex`):

```sh
# Install the Codex CLI
npm install -g @openai/codex

# Authenticate via environment variable
export OPENAI_API_KEY=sk-...
```

Default model: `o4-mini`. Available models: `o4-mini`, `o3-mini`, `codex-mini-latest`.

### Issue tracker

**GitHub** (`--source github`), **Azure DevOps** (`--source azdevops`): No external CLI tools required — Dispatch authenticates directly via browser-based OAuth device flow. See [Authentication](#authentication) below.

**Local markdown** (`--source md`): No external tools or authentication required.

> **Windows users:** See [Windows prerequisites and setup](docs/windows.md) for platform-specific installation commands, recommended configuration, and known limitations.

## Installation

```sh
# Global install — adds `dispatch` to PATH
npm install -g @pruddiman/dispatch

# Run without installing
npx @pruddiman/dispatch

# Local project install
npm install --save-dev @pruddiman/dispatch
npx dispatch
```

## Quick start

```sh
# Run interactive configuration wizard (first-time setup)
dispatch config

# Dispatch all open issues to AI agents
dispatch

# Dispatch specific issues
dispatch 42 43 44

# Dry run — list tasks without executing
dispatch --dry-run

# Use GitHub Copilot instead of OpenCode
dispatch --provider copilot

# Generate specs from issues (before dispatching)
dispatch --spec 42,43

# Generate a spec from an inline text description
dispatch --spec "add dark mode toggle to settings page"

# Regenerate all existing specs
dispatch --respec

# Group issues into a single feature branch and PR
dispatch --feature my-feature

# Run tests and fix failures via AI
dispatch --fix-tests
```

## Authentication

Dispatch authenticates with GitHub and Azure DevOps using the **OAuth device flow** — no external CLI tools (`gh`, `az`) are required.

On first use (or when a cached token is missing/expired), Dispatch will:

1. Display a **one-time code** and open your browser to the provider's verification page.
2. You sign in and authorize Dispatch in the browser.
3. The token is cached locally at **`~/.dispatch/auth.json`** for future runs.

Authentication is triggered automatically when you run `dispatch` with `--source github` or `--source azdevops`. No separate login step is needed.

**Re-authenticating:** Delete `~/.dispatch/auth.json` (or just the relevant platform key inside it) and run `dispatch` again to re-trigger the device flow.

## Pipeline modes

| Mode | Flag | Description |
|------|------|-------------|
| **Dispatch** | *(default)* | Plan and execute tasks; manage full git lifecycle |
| **Spec generation** | `--spec` | Convert issues into structured markdown spec files |
| **Respec** | `--respec` | Regenerate existing specs (all, by ID, or by glob) |
| **Fix tests** | `--fix-tests` | Detect and auto-fix failing tests via AI |
| **Feature** | `--feature [name]` | Group issues into a single feature branch and PR |

## Task files

Dispatch reads work items from markdown files with `- [ ] ...` checkbox syntax:

```markdown
# My Feature

- [ ] (P) Add the login endpoint
- [ ] (P) Write unit tests for the login endpoint
- [ ] (S) Update the API documentation
```

Each unchecked item is dispatched to an AI agent. An optional mode prefix controls execution batching:

| Prefix | Mode | Behavior |
|--------|------|----------|
| `(P)` | Parallel | Tasks run concurrently (up to `--concurrency`) |
| `(S)` | Serial | Tasks run one at a time |
| `(I)` | Isolated | Each task runs in a dedicated worktree |

Tasks are marked `[x]` when complete. Rerunning dispatch skips already-completed tasks.

## Configuration

Dispatch uses three-tier configuration: CLI flags override config file values, which override hardcoded defaults.

```sh
# Interactive wizard — guided setup for core AI settings (provider/model/source)
dispatch config
```

Config is stored at `.dispatch/config.json` (relative to the working directory where you run `dispatch`):

```json
{
  "provider": "copilot",
  "model": "claude-sonnet-4-5",
  "source": "github",
  "testTimeout": 60
}
```

| Key | Description |
|-----|-------------|
| `provider` | AI backend: `opencode` (default), `copilot`, `claude`, or `codex` |
| `model` | Model to use when spawning agents (provider-specific format) |
| `source` | Issue tracker: `github`, `azdevops`, or `md` |
| `testTimeout` | Test execution timeout in minutes (default: 5, range: 1–120) |
| `planTimeout` | Planning timeout in minutes (default: 10, range: 1–120) |
| `concurrency` | Max parallel dispatches (range: 1–64) |
| `org` | Azure DevOps organization URL |
| `project` | Azure DevOps project name |
| `workItemType` | Azure DevOps work item type filter |
| `iteration` | Azure DevOps iteration path filter |
| `area` | Azure DevOps area path filter |

## Options reference

### Dispatch mode

| Option | Default | Description |
|--------|---------|-------------|
| `<issue-id...>` | *(all open)* | Issue IDs to dispatch |
| `--provider <name>` | `opencode` | AI backend (`opencode`, `copilot`, `claude`, `codex`) |
| `--source <name>` | *(auto-detected)* | Datasource (`github`, `azdevops`, `md`) |
| `--dry-run` | `false` | List tasks without executing |
| `--no-plan` | `false` | Skip planner phase, execute directly |
| `--no-branch` | `false` | Skip branch/push/PR lifecycle |
| `--no-worktree` | `false` | Skip git worktree isolation for parallel issues |
| `--feature [name]` | *(off)* | Group issues into a single feature branch and PR |
| `--force` | `false` | Ignore prior run state and re-run all tasks |
| `--concurrency <n>` | *(cpu/memory)* | Max parallel dispatches (max: 64) |
| `--plan-timeout <min>` | `10` | Planning timeout in minutes |
| `--retries <n>` | `2` | Retry attempts for all agents |
| `--plan-retries <n>` | *(from --retries)* | Retry attempts for the planner agent (overrides `--retries`) |
| `--test-timeout <min>` | `5` | Test timeout in minutes |
| `--server-url <url>` | *(none)* | Connect to a running provider server |
| `--cwd <dir>` | `process.cwd()` | Working directory |
| `--verbose` | `false` | Show detailed debug output |

### Spec mode

| Option | Description |
|--------|-------------|
| `--spec <values...>` | Issue numbers, glob pattern, or inline text description. Activates spec mode. |
| `--respec [values...]` | Regenerate specs: issue numbers, glob, or omit to regenerate all existing specs. |
| `--source <name>` | Datasource override (auto-detected if omitted) |
| `--output-dir <dir>` | Output directory for spec files (default: `.dispatch/specs`) |
| `--org <url>` | Azure DevOps organization URL |
| `--project <name>` | Azure DevOps project name |

### Fix tests mode

| Option | Description |
|--------|-------------|
| `--fix-tests [issue-ids...]` | Run tests and fix failures via AI. Optionally pass issue IDs to target specific branches in worktrees. |

## Datasource auto-detection

When `--source` is not provided, Dispatch inspects the git `origin` remote URL:

| Remote URL contains | Detected source |
|---------------------|----------------|
| `github.com` | `github` |
| `dev.azure.com` | `azdevops` |
| `visualstudio.com` | `azdevops` |

For local-only workflows, pass `--source md` explicitly.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | All tasks completed successfully |
| `1` | One or more tasks failed, or a fatal error occurred |
| `130` | SIGINT (Ctrl+C) |
| `143` | SIGTERM |

## Documentation

Full documentation is in the [`docs/`](docs/) directory:

- [Architecture Overview](docs/architecture.md)
- [Agent System](docs/agent-system/overview.md)
- [CLI & Orchestration](docs/cli-orchestration/overview.md)
- [Datasource System](docs/datasource-system/overview.md)
- [Provider System](docs/provider-system/overview.md)
- [Task Parsing](docs/task-parsing/overview.md)
- [Planning & Dispatch](docs/planning-and-dispatch/overview.md)
- [Spec Generation](docs/spec-generation/overview.md)
- [Issue Fetching](docs/issue-fetching/overview.md)
- [Git & Worktree](docs/git-and-worktree/overview.md)
- [Prerequisites & Safety](docs/prereqs-and-safety/overview.md)
- [Shared Types](docs/shared-types/overview.md)
- [Shared Utilities](docs/shared-utilities/overview.md)
- [Testing](docs/testing/overview.md)
- [Windows](docs/windows.md)
- [Changelog](docs/changelog.md)

## License

MIT
