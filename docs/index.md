# dispatch Documentation

Dispatch is a command-line tool that automates software engineering work by
delegating tasks from issue trackers to AI coding agents. It reads work items
from GitHub Issues, Azure DevOps Work Items, or local markdown files, converts
them into structured specification and task files, and orchestrates AI agents
(OpenCode, GitHub Copilot, Claude, or Codex) to plan and execute each task --
committing changes, pushing branches, and opening pull requests automatically.

The tool solves three problems that arise when automating AI-driven development
at scale. First, it provides **context isolation** so that each task runs in a
fresh agent session inside its own git worktree with no bleed-over from previous
work. Second, it improves **precision through planning** with an optional
two-phase pipeline where a read-only planner agent explores the codebase before
a separate executor agent makes changes. Third, it handles **automated
record-keeping** by marking tasks complete in the source markdown, generating
conventional commit messages via AI, and opening pull requests that auto-close
the originating issue.

Dispatch is backend-agnostic across three dimensions -- issue trackers, AI
runtimes, and agent roles -- each implemented as a strategy-pattern plugin behind
a formal TypeScript interface. It supports fully offline workflows where local
markdown files replace cloud-hosted trackers. The tool is intended for developers
and teams who use AI coding agents and want to automate batch execution of work
items from their existing issue tracker without manually shepherding each task
through the agent.

## Key concepts

- **Pipeline modes**: Dispatch operates in three mutually exclusive modes
  selected at the CLI. **Dispatch** (default) plans and executes tasks with full
  git lifecycle management. **Spec generation** (`--spec`) converts issues into
  structured markdown specs via AI-driven codebase exploration. **Fix-tests**
  detects failing tests, feeds failures to an AI provider, and re-runs to verify
  repairs.

- **Datasource**: A strategy-pattern abstraction that normalizes access to work
  items across GitHub Issues (`gh` CLI), Azure DevOps Work Items (`az` CLI), and
  local markdown files. All backends satisfy a common interface covering CRUD
  operations, identity resolution, and git lifecycle management (branching,
  committing, pushing, PR creation). Auto-detection from git remote URLs routes
  to the correct backend.

- **Provider**: An abstraction over AI agent runtimes. Each provider implements a
  `boot` / `createSession` / `prompt` / `cleanup` lifecycle. Four backends are
  supported -- OpenCode, GitHub Copilot, Claude, and Codex -- each with
  fundamentally different concurrency models unified behind a **ProviderPool**
  that enables transparent failover on throttle errors with cooldown-based
  recovery.

- **Agent**: A named role in the AI pipeline, constructed via a
  boot-function-returns-closure pattern. The **spec agent** generates
  high-level specs from issues. The **planner agent** produces detailed
  execution plans in a read-only session. The **executor agent** implements code
  changes following the plan. The **commit agent** analyzes branch diffs to
  generate conventional commit messages and PR metadata. All agents return
  `AgentResult<T>`, a discriminated union that enforces compile-time safety for
  success/failure handling.

- **Task file**: A markdown file containing `- [ ] ...` checkbox items. Each
  unchecked item is a unit of work dispatched to an AI agent. Tasks carry an
  optional `(P)` (parallel), `(S)` (serial), or `(I)` (isolated) mode prefix
  that controls execution batching through a sliding-window concurrency limiter.

- **Worktree**: A git worktree created under `.dispatch/worktrees/` that provides
  filesystem isolation for concurrent task execution, preventing uncommitted
  changes from colliding across parallel agent sessions. The worktree manager
  includes retry logic with exponential backoff for lock contention and six
  failure-mode recovery paths.

- **Three-tier configuration**: CLI flags override config file values
  (`.dispatch/config.json`), which override auto-detected defaults. Per-agent
  provider/model overrides cascade through a resolution chain (per-agent >
  fast-tier > top-level). An interactive wizard (`dispatch config`) guides
  first-time setup.

- **MCP server**: A Model Context Protocol server that exposes Dispatch's
  capabilities as tools for external AI assistants. It supports stdio and HTTP
  transports, SQLite-backed state persistence, and forked child processes for
  crash-isolated pipeline execution with an IPC message protocol for progress
  reporting.

- **Feature branch mode**: A merge strategy where per-issue worktrees are merged
  via `--no-ff` into a shared feature branch, producing an aggregated PR instead
  of one PR per issue.

## Reading guide

New to Dispatch? Start with the [Architecture Overview](architecture.md). It
covers the full system topology, all three pipeline modes, the end-to-end data
flow, key abstractions, and design decisions including the strategy patterns,
CLI-over-REST approach, and session-per-task isolation model.

From there, the documentation is organized by subsystem. A recommended path
through the docs follows the data flow of a typical dispatch run:

**CLI and orchestration** covers the command-line entry point, argument parsing
via Commander.js, three-tier configuration, the orchestrator runner that routes
to the correct pipeline (dispatch, spec, or fix-tests), and the TUI state
machine that tracks phases and task statuses with a verbose-mode fallback. Start
here to understand how user commands become pipeline invocations and how the
config resolution chain works.

**Task parsing** is the foundational data model. The `Task` and `TaskFile` types
are imported by nearly every layer of the system. Read this section to understand
the markdown checkbox syntax, `(P)`/`(S)`/`(I)` execution mode prefixes, and the
accumulator-flush state machine that groups tasks into execution batches.

**Datasource system** explains the polymorphic layer that normalizes access to
GitHub Issues, Azure DevOps Work Items, and local markdown files. It covers
auto-detection from git remote URLs, the `supportsGit()` gating pattern,
OAuth device-flow authentication for GitHub and Azure DevOps with token caching,
and the markdown datasource's file lifecycle (create, update, archive).

**Agent system** documents the four agent roles (spec, planner, executor, commit)
and the pipeline that chains them. Key topics include the `AgentResult<T>`
discriminated union, the boot-function-returns-closure pattern, the two-phase
timebox mechanism (warn then kill) for bounding agent execution, and
dual-path prompt construction for planned versus unplanned execution.

**Provider system** describes the abstraction that decouples the pipeline from
specific AI runtimes. Dedicated pages cover each backend's concurrency model
(synchronous streaming, blocking, event-driven, SSE-based), the provider pool
failover state machine with throttle detection and cooldown, and a step-by-step
guide for adding new providers.

**Dispatch pipeline** details the full lifecycle of a dispatch run across six
phases: issue discovery, task parsing, AI planning, execution, commit/PR
creation, and error recovery. It covers worktree isolation, feature branch mode,
interactive recovery for failed tasks with TTY/non-TTY branching, and the
provider pool's priority-ordered failover.

**Spec generation** covers the `--spec` pipeline's three-mode input
classification (issue numbers, file globs, or inline text), AI-driven spec
creation with advisory validation, and sync-back to the originating datasource.

**Git and worktree helpers** covers worktree lifecycle management with retry and
cleanup, branch validation with security-aware regex for command injection
prevention, crash-safe SQLite-backed run-state persistence, and `.gitignore`
management.

**MCP server and tools** documents how Dispatch is exposed as MCP-callable tools
for external AI agents. Topics include the dual-transport architecture (stdio and
HTTP with session multiplexing), SQLite-backed state management, the forked
dispatch worker with IPC message protocol, and the six tool registration modules
(dispatch, spec, monitor, recovery, config, fork-run).

**Shared types and utilities** documents the foundational contracts and
cross-cutting helpers: the cleanup registry, dual-channel logging (console plus
AsyncLocalStorage-scoped file logs), formatting, error classes, type guards,
retry and timeout wrappers, the sliding-window concurrency limiter with early
termination, and OS-aware environment detection for agent prompt injection.

**Testing** describes the Vitest-based test suite with coverage thresholds
(85% lines, 80% branches, 85% functions), shared mock factories for providers,
datasources, tasks, and child processes, and coverage across unit and integration
tests including full end-to-end scenarios that create real git repositories and
drive the complete pipeline.

## Quick navigation

- [Architecture Overview](./architecture.md) — High-level system design and component interactions

## Agent System

- [Commit Agent](./agent-system/commit-agent.md)
- [Executor Agent](./agent-system/executor-agent.md)
- [Overview](./agent-system/overview.md)
- [Pipeline Flow](./agent-system/pipeline-flow.md)
- [Planner Agent](./agent-system/planner-agent.md)
- [Spec Agent](./agent-system/spec-agent.md)

## Cli Orchestration

- [Authentication](./cli-orchestration/authentication.md)
- [CLI](./cli-orchestration/cli.md)
- [Configuration](./cli-orchestration/configuration.md)
- [Dispatch Pipeline](./cli-orchestration/dispatch-pipeline.md)
- [Integrations](./cli-orchestration/integrations.md)
- [MCP Subcommand](./cli-orchestration/mcp-subcommand.md)
- [Orchestrator](./cli-orchestration/orchestrator.md)
- [Overview](./cli-orchestration/overview.md)
- [Tui](./cli-orchestration/tui.md)

## Datasource System

- [Azdevops Datasource](./datasource-system/azdevops-datasource.md)
- [Datasource Helpers](./datasource-system/datasource-helpers.md)
- [Github Datasource](./datasource-system/github-datasource.md)
- [Integrations](./datasource-system/integrations.md)
- [Markdown Datasource](./datasource-system/markdown-datasource.md)
- [Overview](./datasource-system/overview.md)
- [Testing](./datasource-system/testing.md)

## Deprecated Compat

- [Overview](./deprecated-compat/overview.md)

## Dispatch Pipeline

- [Commit And Pr Generation](./dispatch-pipeline/commit-and-pr-generation.md)
- [Feature Branch Mode](./dispatch-pipeline/feature-branch-mode.md)
- [Integrations](./dispatch-pipeline/integrations.md)
- [Pipeline Lifecycle](./dispatch-pipeline/pipeline-lifecycle.md)
- [Task Recovery](./dispatch-pipeline/task-recovery.md)
- [Troubleshooting](./dispatch-pipeline/troubleshooting.md)
- [Worktree Lifecycle](./dispatch-pipeline/worktree-lifecycle.md)

## Git And Worktree

- [Authentication](./git-and-worktree/authentication.md)
- [Branch Validation](./git-and-worktree/branch-validation.md)
- [Gitignore Helper](./git-and-worktree/gitignore-helper.md)
- [Integrations](./git-and-worktree/integrations.md)
- [Overview](./git-and-worktree/overview.md)
- [Run State](./git-and-worktree/run-state.md)
- [Testing](./git-and-worktree/testing.md)
- [Worktree Management](./git-and-worktree/worktree-management.md)

## Issue Fetching

- [Adding A Fetcher](./issue-fetching/adding-a-fetcher.md)
- [Azdevops Fetcher](./issue-fetching/azdevops-fetcher.md)
- [Github Fetcher](./issue-fetching/github-fetcher.md)

## Mcp Server

- [Dispatch Worker](./mcp-server/dispatch-worker.md)
- [Operations Guide](./mcp-server/operations-guide.md)
- [Overview](./mcp-server/overview.md)
- [Server Transports](./mcp-server/server-transports.md)
- [State Management](./mcp-server/state-management.md)

## Mcp Tools

- [Config Resolution](./mcp-tools/config-resolution.md)
- [Config Tools](./mcp-tools/config-tools.md)
- [Dispatch Tools](./mcp-tools/dispatch-tools.md)
- [Fork Run Ipc](./mcp-tools/fork-run-ipc.md)
- [Monitor Tools](./mcp-tools/monitor-tools.md)
- [Overview](./mcp-tools/overview.md)
- [Recovery Tools](./mcp-tools/recovery-tools.md)
- [Spec Tools](./mcp-tools/spec-tools.md)

## Orchestrator

- [Integrations](./orchestrator/integrations.md)
- [Overview](./orchestrator/overview.md)
- [Spec Pipeline](./orchestrator/spec-pipeline.md)

## Planning And Dispatch

- [Agent Types](./planning-and-dispatch/agent-types.md)
- [Dispatcher](./planning-and-dispatch/dispatcher.md)
- [Git](./planning-and-dispatch/git.md)
- [Integrations](./planning-and-dispatch/integrations.md)
- [Overview](./planning-and-dispatch/overview.md)
- [Task Context And Lifecycle](./planning-and-dispatch/task-context-and-lifecycle.md)

## Prereqs And Safety

- [Confirm Large Batch](./prereqs-and-safety/confirm-large-batch.md)
- [Integrations](./prereqs-and-safety/integrations.md)
- [Overview](./prereqs-and-safety/overview.md)
- [Prereqs](./prereqs-and-safety/prereqs.md)

## Provider Implementations

- [Authentication And Security](./provider-implementations/authentication-and-security.md)
- [Claude Backend](./provider-implementations/claude-backend.md)
- [Codex Backend](./provider-implementations/codex-backend.md)
- [Overview](./provider-implementations/overview.md)

## Provider System

- [Adding A Provider](./provider-system/adding-a-provider.md)
- [Binary Detection](./provider-system/binary-detection.md)
- [Copilot Backend](./provider-system/copilot-backend.md)
- [Error Classification](./provider-system/error-classification.md)
- [Integrations](./provider-system/integrations.md)
- [OpenCode Backend](./provider-system/opencode-backend.md)
- [Overview](./provider-system/overview.md)
- [Pool And Failover](./provider-system/pool-and-failover.md)
- [Progress Reporting](./provider-system/progress-reporting.md)

## Shared Types

- [Cleanup](./shared-types/cleanup.md)
- [File Logger](./shared-types/file-logger.md)
- [Format](./shared-types/format.md)
- [Integrations](./shared-types/integrations.md)
- [Logger](./shared-types/logger.md)
- [Overview](./shared-types/overview.md)
- [Parser](./shared-types/parser.md)
- [Provider](./shared-types/provider.md)

## Shared Utilities

- [Concurrency](./shared-utilities/concurrency.md)
- [Environment](./shared-utilities/environment.md)
- [Errors](./shared-utilities/errors.md)
- [Guards](./shared-utilities/guards.md)
- [Overview](./shared-utilities/overview.md)
- [Retry](./shared-utilities/retry.md)
- [Slugify](./shared-utilities/slugify.md)
- [Testing](./shared-utilities/testing.md)
- [Timeout](./shared-utilities/timeout.md)

## Spec Generation

- [Integrations](./spec-generation/integrations.md)
- [Overview](./spec-generation/overview.md)

## Task Parsing

- [API Reference](./task-parsing/api-reference.md)
- [Architecture And Concurrency](./task-parsing/architecture-and-concurrency.md)
- [Markdown Syntax](./task-parsing/markdown-syntax.md)
- [Overview](./task-parsing/overview.md)
- [Testing Guide](./task-parsing/testing-guide.md)

## Testing

- [Auth Tests](./testing/auth-tests.md)
- [Azdevops Datasource Tests](./testing/azdevops-datasource-tests.md)
- [Commit Agent Tests](./testing/commit-agent-tests.md)
- [Concurrency Tests](./testing/concurrency-tests.md)
- [Config Tests](./testing/config-tests.md)
- [Database Tests](./testing/database-tests.md)
- [Datasource Helpers Tests](./testing/datasource-helpers-tests.md)
- [Datasource Tests](./testing/datasource-tests.md)
- [Datasource Url Parsing Tests](./testing/datasource-url-parsing-tests.md)
- [Dispatch Pipeline Tests](./testing/dispatch-pipeline-tests.md)
- [Environment Errors Prereqs Tests](./testing/environment-errors-prereqs-tests.md)
- [Format Tests](./testing/format-tests.md)
- [Github Datasource Tests](./testing/github-datasource-tests.md)
- [Helpers Utilities Tests](./testing/helpers-utilities-tests.md)
- [Manager Tests](./testing/manager-tests.md)
- [MCP State Tests](./testing/mcp-state-tests.md)
- [MCP Tools Tests](./testing/mcp-tools-tests.md)
- [Md Datasource Tests](./testing/md-datasource-tests.md)
- [Overview](./testing/overview.md)
- [Parser Tests](./testing/parser-tests.md)
- [Planner Executor Tests](./testing/planner-executor-tests.md)
- [Provider Tests](./testing/provider-tests.md)
- [Run State Tests](./testing/run-state-tests.md)
- [Runner Tests](./testing/runner-tests.md)
- [Spec Agent Tests](./testing/spec-agent-tests.md)
- [Spec Generator Tests](./testing/spec-generator-tests.md)
- [Spec Pipeline Tests](./testing/spec-pipeline-tests.md)
- [Test Fixtures](./testing/test-fixtures.md)
- [Tests Integration E2e](./testing/tests-integration-e2e.md)
- [Tui Tests](./testing/tui-tests.md)
- [Worktree Tests](./testing/worktree-tests.md)

## Overview

- [Changelog](./changelog.md)
- [Windows](./windows.md)

