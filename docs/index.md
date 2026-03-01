# dispatch-tasks Documentation

dispatch-tasks is a Node.js CLI tool that orchestrates AI coding agents to
implement software tasks described in markdown files. It bridges issue trackers
(GitHub Issues, Azure DevOps Work Items) and AI agent runtimes (OpenCode,
GitHub Copilot) through a multi-stage pipeline: fetch issues, generate
structured specs, parse tasks, plan execution, dispatch to AI agents, and
commit results.

The tool solves three problems that arise when automating AI-driven development
at scale. First, it provides **context isolation** so that each task runs in a
fresh agent session with no bleed-over from previous work. Second, it improves
**precision through planning** with an optional two-phase pipeline where a
read-only planner agent explores the codebase before a separate executor agent
makes changes. Third, it handles **automated record-keeping** by marking tasks
complete in the source markdown and creating conventional git commits tied
directly to the original task list.

dispatch-tasks is backend-agnostic: it supports multiple issue trackers via a
datasource abstraction and multiple AI runtimes via a provider abstraction,
letting teams use their existing tools without lock-in. It also supports fully
offline workflows where local markdown files replace cloud-hosted trackers.

## Key concepts

- **Task file**: A markdown file containing `- [ ] ...` checkbox items. Each
  unchecked item is a unit of work dispatched to an AI agent. Tasks can carry
  an optional `(P)` (parallel) or `(S)` (serial) mode prefix that controls
  execution batching.

- **Datasource**: A strategy-pattern abstraction that normalizes access to work
  items across GitHub Issues (`gh` CLI), Azure DevOps Work Items (`az` CLI),
  and local markdown files (`fs`). All backends satisfy a twelve-method
  interface covering CRUD operations and git lifecycle management, producing
  normalized `IssueDetails` objects.

- **Provider**: An abstraction over AI agent runtimes. Each provider implements
  a `createSession` / `prompt` / `cleanup` lifecycle. Two backends are
  supported: OpenCode (async, SSE-based) and GitHub Copilot (synchronous,
  JSON-RPC-based). Selected via the `--provider` flag.

- **Spec file**: A structured markdown document generated from an issue tracker
  item by the spec agent. Specs describe what needs to change and why, with a
  `## Tasks` section containing `- [ ]` checkboxes that the dispatch pipeline
  treats as individual units of work.

- **Planner / Executor**: The two-phase agent architecture. The planner is a
  read-only AI session that explores the codebase and produces a detailed
  execution plan. The executor follows that plan to make code changes. The
  planning phase is optional (`--no-plan` skips it).

- **Orchestrator**: The central pipeline coordinator that drives task
  discovery, parsing, provider lifecycle, planning, execution, markdown
  mutation, git commits, and datasource synchronization. It routes to either
  the dispatch pipeline or the spec-generation pipeline based on the `--spec`
  flag.

- **Registry**: A compile-time map pattern used for providers, agents, and
  datasources. Adding a new implementation requires a code change and
  recompilation rather than runtime plugin discovery, giving exhaustiveness
  checks at compile time.

## Reading guide

New to dispatch-tasks? Start with the
[Architecture Overview](./architecture.md). It covers the full system topology,
both pipeline modes (dispatch and spec generation), the task lifecycle state
machine, and all key design decisions including the strategy patterns,
CLI-over-REST approach, and three-tier configuration precedence.

From there, the documentation is organized by subsystem:

**CLI and orchestration** covers the command-line interface, argument parsing,
persistent configuration (`~/.dispatch/config.json` with three-tier
precedence), the orchestrator pipeline that coordinates all stages, and the
real-time terminal dashboard. Start here to understand how user input flows
into the system.

**Datasource system** explains the strategy-pattern layer that normalizes
access to GitHub Issues, Azure DevOps Work Items, and local markdown files. It
covers auto-detection from git remote URLs, per-backend operation semantics,
git lifecycle management (branching, committing, pushing, PR creation),
authentication delegation to external CLI tools, and a guide for adding new
datasource implementations.

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
items into structured specification files. It explains the end-to-end flow,
AI prompt structure, output format and naming conventions, and error handling.

**Shared interfaces and utilities** documents the foundational types and
contracts that every other module depends on: the cleanup registry, logger,
duration formatting, `Task`/`TaskFile` types, and `ProviderInstance` interface.

**Testing** describes the Vitest-based test suite covering configuration,
format utilities, the parser, and the spec generator, with patterns using both
real filesystem I/O and module mocking for external dependencies.

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

