# dispatch Documentation

Dispatch is a command-line tool that automates software engineering work by
delegating tasks from issue trackers to AI coding agents. It reads work items
from GitHub Issues, Azure DevOps Work Items, or local markdown files, converts
them into structured specification and task files, and orchestrates AI agents
(OpenCode, GitHub Copilot, Claude, or Codex) to plan and execute each task —
committing changes, pushing branches, and opening pull requests automatically.

The tool solves three problems that arise when automating AI-driven development
at scale. First, it provides **context isolation** so that each task runs in a
fresh agent session inside its own git worktree with no bleed-over from previous
work. Second, it improves **precision through planning** with an optional
two-phase pipeline where a read-only planner agent explores the codebase before a
separate executor agent makes changes. Third, it handles **automated
record-keeping** by marking tasks complete in the source markdown, generating
conventional commit messages via AI, and opening pull requests that auto-close
the originating issue.

Dispatch is backend-agnostic across three dimensions — issue trackers, AI
runtimes, and agent roles — each implemented as a strategy-pattern plugin behind
a formal TypeScript interface. It supports fully offline workflows where local
markdown files replace cloud-hosted trackers. The tool is intended for developers
and teams who use AI coding agents and want to automate batch execution of work
items from their existing issue tracker without manually shepherding each task
through the agent.

## Key concepts

- **Pipeline mode**: Dispatch operates in three mutually exclusive modes selected
  at the CLI. **Dispatch** (default) plans and executes tasks with full git
  lifecycle management. **Spec generation** (`--spec`) converts issues into
  structured markdown specs via AI-driven codebase exploration. **Fix-tests**
  (`--fix-tests`) detects failing tests and auto-fixes them in an AI repair
  loop.

- **Datasource**: A strategy-pattern abstraction that normalizes access to work
  items across GitHub Issues (`gh` CLI), Azure DevOps Work Items (`az` CLI),
  and local markdown files. All backends satisfy a common interface covering
  CRUD operations, identity resolution, and git lifecycle management (branching,
  committing, pushing, PR creation).

- **Provider**: An abstraction over AI agent runtimes. Each provider implements
  a `createSession` / `prompt` / `cleanup` lifecycle. Four backends are
  supported: OpenCode, GitHub Copilot, Claude, and Codex.

- **Agent**: A named role in the AI pipeline. The **spec agent** generates
  high-level specs from issues. The **planner agent** produces detailed execution
  plans in a read-only session. The **executor agent** implements code changes
  following the plan. The **commit agent** analyzes branch diffs to generate
  conventional commit messages and PR metadata. Agents are managed through a
  registry with type-safe discriminated-union result types.

- **Task file**: A markdown file containing `- [ ] ...` checkbox items. Each
  unchecked item is a unit of work dispatched to an AI agent. Tasks carry an
  optional `(P)` (parallel), `(S)` (serial), or `(I)` (isolated) mode prefix
  that controls execution batching through an accumulator-flush state machine.

- **Worktree**: A git worktree created under `.dispatch/worktrees/` that
  provides filesystem isolation for concurrent task execution, preventing
  uncommitted changes from colliding across parallel agent sessions.

- **Three-tier configuration**: CLI flags override config file values
  (`.dispatch/config.json`), which override auto-detected defaults. An
  interactive wizard (`dispatch config`) guides first-time setup with provider
  detection and Azure DevOps pre-fill.

- **Cleanup registry**: A signal-aware teardown system that ensures provider
  processes and worktrees are cleaned up on exit, even after crashes or
  interrupts.

## Reading guide

New to Dispatch? Start with the [Architecture Overview](architecture.md). It
covers the full system topology, all three pipeline modes, the end-to-end data
flow, key abstractions, and design decisions including the strategy patterns,
CLI-over-REST approach, and session-per-task isolation model.

From there, the documentation is organized by subsystem. A recommended path
through the docs follows the data flow of a typical dispatch run:

**Task parsing** is the foundational data model. The `Task` and `TaskFile` types
are imported by nearly every layer of the system. Start here to understand the
markdown checkbox syntax, `(P)`/`(S)`/`(I)` execution mode prefixes, and
concurrency concerns around file mutation.

**CLI and orchestration** covers the command-line entry point, argument parsing
via Commander.js, three-tier configuration, the orchestrator runner that routes
to the correct pipeline, and the TUI state machine that tracks five phases and
five task statuses with a verbose-mode fallback.

**Datasource system** explains the polymorphic layer that normalizes access to
GitHub Issues, Azure DevOps Work Items, and local markdown files. It covers
auto-detection from git remote URLs, the `supportsGit()` gating pattern,
authentication delegation to external CLI tools, and the markdown datasource's
file lifecycle (create → update → archive).

**Provider system** describes the abstraction that decouples the pipeline from
specific AI runtimes. Dedicated pages cover the Copilot and OpenCode backends
(the two most complex implementations), SSE streaming, session management, and a
step-by-step guide for adding new providers.

**Planning and dispatch** explains the core two-phase AI workflow: a read-only
planner agent explores the codebase and produces an execution prompt, then an
executor agent sends that prompt to an AI provider for implementation — all
within git worktree isolation. Also covers the dispatcher, conventional commit
type inference, and the task context lifecycle.

**Spec generation** covers the `--spec` pipeline's three-mode input
classification (issue numbers, file globs, or inline text), AI-driven spec
creation, validation, and sync-back to the originating datasource.

**Git and worktree helpers** covers worktree lifecycle management, branch
validation with security-aware regex (command injection prevention), crash-safe
run-state persistence, and `.gitignore` management.

**Prerequisites and safety** documents the startup validation of external tool
dependencies (git, Node.js, `gh`, `az`), large-batch confirmation prompts, and
provider binary detection.

**Shared types and utilities** documents the foundational contracts and
cross-cutting helpers: the cleanup registry, dual-channel logging (console +
AsyncLocalStorage-scoped file logs), formatting, error classes, type guards,
slugification, timeouts, and retry logic.

**Testing** describes the Vitest-based test suite, shared mock factories for
providers, datasources, tasks, and child processes, and coverage across unit and
integration tests.

## Quick navigation

- [Architecture Overview](./architecture.md) — High-level system design and component interactions

## Agent System

- [Commit Agent](./agent-system/commit-agent.md)
- [Overview](./agent-system/overview.md)

## Cli Orchestration

- [CLI](./cli-orchestration/cli.md)
- [Configuration](./cli-orchestration/configuration.md)
- [Dispatch Pipeline](./cli-orchestration/dispatch-pipeline.md)
- [Fix Tests Pipeline](./cli-orchestration/fix-tests-pipeline.md)
- [Integrations](./cli-orchestration/integrations.md)
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

## Git And Worktree

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
- [Overview](./issue-fetching/overview.md)

## Planning And Dispatch

- [Agent Types](./planning-and-dispatch/agent-types.md)
- [Dispatcher](./planning-and-dispatch/dispatcher.md)
- [Executor](./planning-and-dispatch/executor.md)
- [Git](./planning-and-dispatch/git.md)
- [Integrations](./planning-and-dispatch/integrations.md)
- [Overview](./planning-and-dispatch/overview.md)
- [Planner](./planning-and-dispatch/planner.md)
- [Task Context And Lifecycle](./planning-and-dispatch/task-context-and-lifecycle.md)

## Prereqs And Safety

- [Confirm Large Batch](./prereqs-and-safety/confirm-large-batch.md)
- [Integrations](./prereqs-and-safety/integrations.md)
- [Overview](./prereqs-and-safety/overview.md)
- [Prereqs](./prereqs-and-safety/prereqs.md)
- [Provider Detection](./prereqs-and-safety/provider-detection.md)

## Provider System

- [Adding A Provider](./provider-system/adding-a-provider.md)
- [Copilot Backend](./provider-system/copilot-backend.md)
- [OpenCode Backend](./provider-system/opencode-backend.md)
- [Overview](./provider-system/overview.md)

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

- [Errors](./shared-utilities/errors.md)
- [Guards](./shared-utilities/guards.md)
- [Overview](./shared-utilities/overview.md)
- [Slugify](./shared-utilities/slugify.md)
- [Testing](./shared-utilities/testing.md)
- [Timeout](./shared-utilities/timeout.md)

## Spec Generation

- [Integrations](./spec-generation/integrations.md)
- [Overview](./spec-generation/overview.md)
- [Spec Agent](./spec-generation/spec-agent.md)

## Task Parsing

- [API Reference](./task-parsing/api-reference.md)
- [Architecture And Concurrency](./task-parsing/architecture-and-concurrency.md)
- [Markdown Syntax](./task-parsing/markdown-syntax.md)
- [Overview](./task-parsing/overview.md)
- [Testing Guide](./task-parsing/testing-guide.md)

## Testing

- [Config Tests](./testing/config-tests.md)
- [Dispatch Pipeline Tests](./testing/dispatch-pipeline-tests.md)
- [Fix Tests Tests](./testing/fix-tests-tests.md)
- [Format Tests](./testing/format-tests.md)
- [Overview](./testing/overview.md)
- [Parser Tests](./testing/parser-tests.md)
- [Planner Executor Tests](./testing/planner-executor-tests.md)
- [Provider Tests](./testing/provider-tests.md)
- [Runner Tests](./testing/runner-tests.md)
- [Spec Generator Tests](./testing/spec-generator-tests.md)
- [Test Fixtures](./testing/test-fixtures.md)

## Overview

- [Changelog](./changelog.md)
- [Windows](./windows.md)

