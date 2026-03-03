# dispatch

AI agent orchestration CLI — parse markdown task files, dispatch each unit of work to code agents (OpenCode, GitHub Copilot, etc.), and commit results with conventional commits.

## Why dispatch?

Manual orchestration of AI coding agents is tedious when a project has many small, well-defined units of work. dispatch solves three problems:

- **Context isolation** — each task runs in a fresh agent session so context from one task does not leak into another.
- **Precision through planning** — an optional two-phase pipeline lets a read-only planner agent explore the codebase first, producing a focused execution plan that the executor agent follows.
- **Automated record-keeping** — after each task, the markdown file is updated and a conventional commit is created, giving a clean, reviewable git history tied directly to the original task list.

The tool is backend-agnostic: it supports multiple issue trackers via a datasource abstraction and multiple AI runtimes via a provider abstraction, letting teams use their existing tools without lock-in.

## Key Features

- **Backend-agnostic** provider and datasource abstractions — no vendor lock-in
- **Two-phase planner-executor pipeline** — optional read-only planner explores the codebase before the executor makes changes (`--no-plan` skips planning)
- **Markdown as source of truth** — task files use `- [ ]` checkbox syntax with `(P)`arallel, `(S)`erial, and `(I)`solated execution mode prefixes
- **Automatic conventional commits** — commit type (feat, fix, docs, refactor, etc.) is inferred from task text
- **Real-time TUI dashboard** — terminal UI with spinner, progress bar, and per-task status tracking
- **Three-tier configuration** — CLI flags > project-local config file (`.dispatch/config.json`) > defaults
- **Configurable concurrency** — control parallel task execution per batch

## Supported Backends

### Providers (AI Agent Runtimes)

| Provider | SDK | Prompt Model |
|----------|-----|-------------|
| OpenCode | `@opencode-ai/sdk` | Async — fire-and-forget + SSE event stream |
| GitHub Copilot | `@github/copilot-sdk` | Synchronous — blocking request/response |

### Datasources (Issue Trackers)

| Datasource | Tool | Auth |
|------------|------|------|
| GitHub Issues | `gh` CLI | `gh auth login` |
| Azure DevOps Work Items | `az` CLI | `az login` |
| Local Markdown | Filesystem | None |

## Prerequisites

### Node.js and npm

Install [Node.js](https://nodejs.org/) **>= 20.12.0** (npm is included). Verify your installation:

```sh
node --version   # must be >= 20.12.0
```

### AI Agent Runtime

At least one AI agent runtime must be installed and authenticated with a default model configured. dispatch cannot function without a provider backend.

**OpenCode**

```sh
# Install
curl -fsSL https://opencode.ai/install | bash
# or: npm install -g opencode-ai
```

Launch `opencode` and run the `/connect` command to configure your LLM provider. Then verify:

```sh
opencode --version
```

See [OpenCode backend docs](./docs/provider-system/opencode-backend.md) for full setup options.

**GitHub Copilot**

Requires an active [GitHub Copilot subscription](https://github.com/features/copilot/plans).

```sh
# Install
npm install -g @github/copilot
```

Launch `copilot` and follow the `/login` prompt to authenticate. Then verify:

```sh
copilot --version
```

See [Copilot backend docs](./docs/provider-system/copilot-backend.md) for full setup options.

## Installation

```bash
npm install -g @pruddiman/dispatch
```

Or run directly without installing:

```bash
npx @pruddiman/dispatch
```

## Quick Start

dispatch operates as a three-stage pipeline:

### 1. Generate specs from issues

Fetch issues from your tracker and generate structured markdown specs with task checkboxes:

```bash
# From issue numbers
dispatch --spec 42,43,44

# From local markdown files using a glob pattern
dispatch --spec "drafts/*.md"

# From an inline text description
dispatch --spec "add dark mode toggle to settings page"
```

This creates spec files in `.dispatch/specs/` (e.g., `42-add-auth.md`) with `- [ ]` task items.

To regenerate existing specs, use `--respec`:

```bash
# Regenerate all existing specs
dispatch --respec

# Regenerate specs for specific issues
dispatch --respec 42,43,44

# Regenerate specs matching a glob pattern
dispatch --respec "specs/*.md"
```

### 2. Execute tasks

Run the generated specs through the plan-and-execute pipeline:

```bash
dispatch ".dispatch/specs/*.md"
```

For each task, dispatch will:
1. **Plan** — a read-only planner agent explores the codebase and produces a detailed execution plan
2. **Execute** — an executor agent follows the plan to make code changes
3. **Commit** — changes are staged and committed with an inferred conventional commit message
4. **Mark complete** — the `- [ ]` checkbox is updated to `- [x]` in the source file

### 3. Fix failing tests

Run tests and automatically fix failures via an AI agent:

```bash
dispatch --fix-tests
```

### Common options

```bash
dispatch --no-plan "tasks.md"          # Skip the planning phase
dispatch --no-branch "tasks.md"        # Skip branch creation, push, and PR lifecycle
dispatch --provider copilot "tasks.md" # Use GitHub Copilot instead of OpenCode
dispatch --source github "tasks.md"    # Explicitly set the datasource
dispatch --concurrency 3 "tasks.md"    # Run up to 3 tasks in parallel
dispatch --server-url http://localhost:3000 "tasks.md"  # Use a running provider server
dispatch --plan-timeout 15 "tasks.md"  # Set planning timeout to 15 minutes
dispatch --plan-retries 2 "tasks.md"   # Retry planning up to 2 times
dispatch --output-dir ./my-specs --spec 42  # Custom output directory for specs
dispatch --verbose "tasks.md"          # Show detailed debug output
```

> **Concurrency auto-scaling:** When `--concurrency` is not specified, dispatch
> automatically computes a safe default using `min(cpuCount, freeMemMB / 500)`,
> with a minimum of 1. Each concurrent agent process is assumed to consume ~500 MB
> of memory.

## Configuration

dispatch uses a three-tier configuration system: CLI flags > project-local config file (`.dispatch/config.json`) > defaults.

### Interactive configuration

```bash
dispatch config
```

Running `dispatch config` launches an interactive wizard that guides you through viewing, setting, and resetting your configuration.

Valid config keys: `provider`, `model`, `concurrency`, `source`, `org`, `project`, `workItemType`, `serverUrl`, `planTimeout`, `planRetries`.

- **`model`** — AI model override in provider-specific format (e.g. `"claude-sonnet-4-5"` for Copilot, `"anthropic/claude-sonnet-4"` for OpenCode). When omitted the provider uses its default.
- **`workItemType`** — Azure DevOps work item type (e.g. `"User Story"`, `"Bug"`). Only relevant when using the `azdevops` datasource.

## Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 20.12.0 | Required — ESM-only runtime |
| git | Any | Required — auto-detection, conventional commits |
| `gh` CLI | Any | Optional — required for GitHub datasource |
| `az` CLI + azure-devops extension | Any | Optional — required for Azure DevOps datasource |
| OpenCode or GitHub Copilot | Varies | At least one AI agent runtime required |

## Development

```bash
git clone https://github.com/PatrickRuddiman/Dispatch.git
cd Dispatch
npm install
npm run build        # Build with tsup
npm test             # Run tests with Vitest
npm run typecheck    # Type-check with tsc --noEmit
```

Additional commands:

```bash
npm run dev          # Watch mode build
npm run test:watch   # Watch mode tests
```

## Troubleshooting

### "Could not detect datasource from git remote"

dispatch auto-detects whether to use GitHub or Azure DevOps by inspecting your git remote URL. If the remote does not match a known pattern (e.g., no remote configured, or a self-hosted URL), detection falls back to local markdown mode.

**Fix:** pass `--source` explicitly:

```sh
dispatch --source github "tasks.md"
dispatch --source azdevops "tasks.md"
```

### Provider binary not found

dispatch requires a provider runtime (`opencode` or `copilot`) to be installed and on your `PATH`. If the binary is missing, the provider will fail to start.

**Verify installation:**

```sh
opencode --version
copilot --version
```

If not installed, see [OpenCode setup](./docs/provider-system/opencode-backend.md) or [Copilot setup](./docs/provider-system/copilot-backend.md).

### Planning timeout exceeded

The planner phase has a default timeout of **10 minutes** per attempt. If the planner does not finish in time, dispatch retries up to `maxPlanAttempts` times (default: 1 retry) before failing the task.

**Fix:** increase the timeout or retries:

```sh
dispatch --plan-timeout 20 "tasks.md"   # 20-minute timeout
dispatch --plan-retries 3 "tasks.md"    # Retry planning up to 3 times
```

Both values can also be set in `.dispatch/config.json` via the `planTimeout` and `planRetries` keys.

### Branch creation failed

dispatch creates a git branch per issue. This can fail if:

- You lack write permissions to the repository.
- A branch with the computed name already exists locally or on the remote.

**Fix:** delete the conflicting branch or use `--no-branch` to skip branch creation entirely:

```sh
dispatch --no-branch "tasks.md"
```

### "No unchecked tasks found"

dispatch looks for unchecked markdown checkboxes in the `## Tasks` section. Tasks must use the exact format `- [ ]` (hyphen, space, open bracket, space, close bracket) with a space inside the brackets.

**Common mistakes:**

```md
- [] task     # wrong — missing space inside brackets
- [x] task    # already checked — dispatch skips these
* [ ] task    # wrong — use - not *
```

**Correct format:**

```md
- [ ] task description
- [ ] (P) parallel task description
```

## Error Handling & Recovery

- **Batch failure isolation** — when a task fails, other tasks in the same batch continue executing. Failed tasks are tracked and reported in the final summary (e.g., `Done — 5 completed, 1 failed`).
- **No run resumption** — runs cannot currently be resumed after interruption. Re-running will re-process all unchecked (`- [ ]`) tasks; tasks already marked complete (`- [x]`) in the source file are skipped.
- **`--dry-run` scope** — `--dry-run` covers task discovery and parsing only. It does not trigger spec generation, planning, or execution.

## License

MIT

## Documentation

For comprehensive documentation, see the [`docs/`](./docs/) directory:

- **[Documentation Index](./docs/index.md)** — entry point with key concepts and navigation guide
- **[Architecture Overview](./docs/architecture.md)** — system topology, pipeline flows, design decisions, and component index
