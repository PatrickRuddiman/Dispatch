# Dispatch Documentation

Dispatch is a command-line tool that automates software engineering work by
delegating tasks from issue trackers to AI coding agents. It reads work items
from GitHub Issues, Azure DevOps Work Items, or local markdown files, converts
them into structured specification and task files, and orchestrates AI agents
(OpenCode or GitHub Copilot) to plan and execute each task — committing changes,
pushing branches, and opening pull requests automatically.

The tool solves three problems that arise when automating AI-driven development
at scale. First, it provides **context isolation** so that each task runs in a
fresh agent session with no bleed-over from previous work. Second, it improves
**precision through planning** with an optional two-phase pipeline where a
read-only planner agent explores the codebase before a separate executor agent
makes changes. Third, it handles **automated record-keeping** by marking tasks
complete in the source markdown and creating conventional git commits tied
directly to the original task list.

Dispatch is backend-agnostic across three dimensions — issue trackers, AI
runtimes, and agent roles — each implemented as a strategy-pattern plugin behind
a formal TypeScript interface. It also supports fully offline workflows where
local markdown files replace cloud-hosted trackers. The tool is intended for
developers and teams who want to automate repetitive implementation work across
repositories that use GitHub, Azure DevOps, or local markdown-based workflows.

## Key concepts

- **Task file**: A markdown file containing `- [ ] ...` checkbox items. Each
  unchecked item is a unit of work dispatched to an AI agent. Tasks can carry
  an optional `(P)` (parallel) or `(S)` (serial) mode prefix that controls
  execution batching.

- **Datasource**: A strategy-pattern abstraction that normalizes access to work
  items across GitHub Issues (`gh` CLI), Azure DevOps Work Items (`az` CLI),
  and local markdown files (`fs`). All backends satisfy a twelve-method
  interface covering CRUD operations and git lifecycle management (branching,
  committing, pushing, PR creation), producing normalized `IssueDetails`
  objects consumed by the rest of the pipeline.

- **Provider**: An abstraction over AI agent runtimes. Each provider implements
  a `createSession` / `prompt` / `cleanup` lifecycle. Two backends are
  supported: OpenCode (async, SSE-based) and GitHub Copilot (synchronous,
  JSON-RPC-based). Selected via the `--provider` flag.

- **Agent**: A named role in the AI pipeline. Three agent roles exist: the
  **spec agent** (explores the codebase and generates high-level specs), the
  **planner agent** (produces detailed execution plans in a read-only session),
  and the **executor agent** (implements code changes following the plan).

- **Pipeline mode**: Dispatch operates in three mutually exclusive modes:
  **spec generation** (`--spec`) converts issues into structured markdown specs,
  **dispatch** (default) plans and executes tasks with git lifecycle management,
  and **fix-tests** (`--fix-tests`) detects and auto-fixes failing tests via AI.

- **Orchestrator**: The central pipeline coordinator that drives task
  discovery, parsing, provider lifecycle, planning, execution, markdown
  mutation, git commits, and datasource synchronization.

- **Registry**: A compile-time map pattern used for providers, agents, and
  datasources. Adding a new implementation requires a code change and
  recompilation rather than runtime plugin discovery, providing TypeScript
  exhaustiveness checks at compile time.

- **Three-tier configuration**: CLI flags override config file values
  (`~/.dispatch/config.json`), which override hardcoded defaults. An
  interactive wizard (`dispatch config`) guides first-time setup.

## Reading guide

New to Dispatch? Start with the
[Architecture Overview](./architecture.md). It covers the full system topology,
all three pipeline modes, the task lifecycle state machine, data flow diagrams,
and key design decisions including the strategy patterns, CLI-over-REST
approach, and session-per-task isolation model.

From there, the documentation is organized by subsystem:

**CLI and orchestration** covers the command-line interface, argument parsing,
persistent configuration with three-tier precedence, the orchestrator pipeline
that coordinates all stages, and the real-time terminal dashboard. Start here
to understand how user input flows into the system.

**Datasource system** explains the strategy-pattern layer that normalizes
access to GitHub Issues, Azure DevOps Work Items, and local markdown files. It
covers auto-detection from git remote URLs, per-backend operation semantics,
git lifecycle management, authentication delegation to external CLI tools, and
a guide for adding new datasource implementations.

**Provider system** describes the abstraction that decouples the pipeline from
specific AI runtimes. Dedicated pages cover the OpenCode and Copilot backends,
session isolation, cleanup and resource management, and a step-by-step guide
for adding new providers.

**Task parsing** documents the parser that converts markdown checkbox syntax
into structured `Task` and `TaskFile` objects. It covers supported markdown
formats, the `(P)`/`(S)` execution mode prefixes, the API for extracting and
completing tasks, and concurrency concerns around file mutation.

**Planning and dispatch** explains the core execution engine: the optional
planner phase that produces detailed execution plans, the dispatcher that sends
tasks to AI agents in isolated sessions, git operations with conventional
commit type inference, and the task context lifecycle.

**Spec generation** covers the `--spec` pipeline that converts issue tracker
items into structured specification files. It explains the three-stage
end-to-end flow (spec agent, planner agent, executor agent), AI prompt
structure, output format and naming conventions, and error handling.

**Shared interfaces and utilities** documents the foundational types and
contracts that every other module depends on: the cleanup registry, logger,
duration formatting, `Task`/`TaskFile` types, `ProviderInstance` interface,
and the slugify and timeout helper functions.

**Testing** describes the Vitest-based test suite covering configuration,
format utilities, the parser, and the spec generator, with patterns using real
filesystem I/O and fake timers.

**Deprecated compatibility layer** documents the legacy `IssueFetcher` shims
that delegate to the new datasource system. These are slated for removal and
no production code imports from them.

## Quick navigation

- [Architecture Overview](./architecture.md) — High-level system design and component interactions

## Cli Orchestration

- [CLI](./cli-orchestration/cli.md)
- [Configuration](./cli-orchestration/configuration.md)
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

## Issue Fetching

- [Adding A Fetcher](./issue-fetching/adding-a-fetcher.md)
- [Azdevops Fetcher](./issue-fetching/azdevops-fetcher.md)
- [Github Fetcher](./issue-fetching/github-fetcher.md)
- [Overview](./issue-fetching/overview.md)

## Planning And Dispatch

- [Dispatcher](./planning-and-dispatch/dispatcher.md)
- [Git](./planning-and-dispatch/git.md)
- [Integrations](./planning-and-dispatch/integrations.md)
- [Overview](./planning-and-dispatch/overview.md)
- [Planner](./planning-and-dispatch/planner.md)
- [Task Context And Lifecycle](./planning-and-dispatch/task-context-and-lifecycle.md)

## Provider System

- [Adding A Provider](./provider-system/adding-a-provider.md)
- [Copilot Backend](./provider-system/copilot-backend.md)
- [OpenCode Backend](./provider-system/opencode-backend.md)
- [Provider Overview](./provider-system/provider-overview.md)

## Shared Types

- [Cleanup](./shared-types/cleanup.md)
- [Format](./shared-types/format.md)
- [Integrations](./shared-types/integrations.md)
- [Logger](./shared-types/logger.md)
- [Overview](./shared-types/overview.md)
- [Parser](./shared-types/parser.md)
- [Provider](./shared-types/provider.md)

## Shared Utilities

- [Overview](./shared-utilities/overview.md)
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

- [Config Tests](./testing/config-tests.md)
- [Format Tests](./testing/format-tests.md)
- [Overview](./testing/overview.md)
- [Parser Tests](./testing/parser-tests.md)
- [Spec Generator Tests](./testing/spec-generator-tests.md)

## Overview

- [Changelog](./changelog.md)

