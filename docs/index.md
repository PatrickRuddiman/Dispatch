# dispatch-tasks Documentation

dispatch-tasks is a Node.js CLI tool that automates multi-task software
engineering work by delegating to AI coding agents. It reads markdown files
containing GitHub-style checkbox items (`- [ ] do something`), dispatches each
task to an AI agent in an isolated session, marks the task complete in the
source file, and creates a conventional commit for the result.

The tool operates in two modes that together form a three-stage AI pipeline
from issue tracker to implemented, committed code:

1. **Spec mode** (`dispatch --spec 42,43`) fetches issues from GitHub or Azure
   DevOps, prompts an AI agent to explore the codebase, and produces structured
   markdown spec files containing high-level task checklists.
2. **Planner + executor mode** (`dispatch "specs/*.md"`) parses those spec
   files, optionally runs a read-only planner agent to produce detailed
   execution plans, then dispatches each task to an executor agent that makes
   code changes, updates the markdown, and commits the result.

dispatch-tasks is designed for teams and individuals who use AI coding agents
and want to orchestrate them at scale -- processing batches of well-defined
tasks with context isolation, automated planning, and clean git history, rather
than manually prompting an agent one task at a time. It currently supports two
AI agent backends (OpenCode and GitHub Copilot) through a provider abstraction
layer, with additional backends added by implementing a four-method
`ProviderInstance` interface.

## Key concepts

- **Task file**: A markdown file containing `- [ ] ...` checkbox items. Each
  unchecked item is a unit of work dispatched to an AI agent.
- **Execution mode prefix**: Tasks can be prefixed with `(P)` for parallel or
  `(S)` for serial execution. The orchestrator groups tasks by mode and
  processes groups sequentially, running parallel tasks concurrently within
  each group.
- **Provider**: An AI agent backend (OpenCode or Copilot) abstracted behind the
  `ProviderInstance` interface. Providers manage sessions and handle prompting;
  they are interchangeable via the `--provider` flag.
- **Session isolation**: Every task gets a fresh provider session for both
  planning and execution, preventing context leakage between tasks.
- **Planner agent**: An optional read-only AI session that explores the
  codebase and produces a detailed execution plan before the executor acts.
  Bypassed with `--no-plan`.
- **Spec agent**: An AI session that converts issue tracker items into
  structured markdown spec files with Context, Approach, Integration Points,
  and Tasks sections.
- **Issue fetcher**: A pluggable adapter that retrieves issues from GitHub
  (via `gh` CLI) or Azure DevOps (via `az` CLI) and normalizes them into a
  common `IssueDetails` structure.
- **Conventional commit**: After each task completes, changes are staged and
  committed with a type (feat, fix, docs, refactor, etc.) inferred
  automatically from the task text.
- **Registry**: A compile-time map pattern used for providers, agents, and
  issue fetchers. Adding a new implementation requires a code change and
  recompilation rather than runtime plugin discovery.

## Reading guide

If you are new to the project, start with the
[Architecture Overview](./architecture.md). It covers the full system topology,
both pipeline modes, the task lifecycle state machine, and key design decisions.

From there, each section focuses on a major subsystem:

**CLI and orchestration** covers the command-line interface, the orchestrator
that drives the multi-phase dispatch pipeline, the real-time terminal UI, and
logging. Start here to understand how user input flows into the system and how
tasks are discovered, grouped, and dispatched.

**Task parsing** documents the parser that converts markdown checkbox syntax
into structured data. It covers supported markdown formats, the API for
extracting and completing tasks, concurrency concerns around file mutation, and
the parser test suite.

**Planning and dispatch** explains the core execution engine: the optional
planner phase, the dispatcher that sends tasks to AI agents in isolated
sessions, the git integration that creates conventional commits, and the
context filtering that prevents planner confusion from sibling tasks.

**Provider system** describes the strategy pattern that decouples the pipeline
from specific AI runtimes. It includes setup guides for the OpenCode and
Copilot backends and a step-by-step guide for adding new providers.

**Issue fetching** documents the data-ingestion layer used by spec mode. It
covers the `IssueFetcher` interface, the GitHub and Azure DevOps
implementations, auto-detection of the issue source from the git remote, and
how to add support for a new tracker.

**Spec generation** explains the `--spec` pipeline end-to-end: how issues are
fetched, how the AI is prompted to produce high-level spec files, the output
format and naming conventions, and error handling.

**Shared interfaces and utilities** documents the foundational types and
contracts (`Task`, `TaskFile`, `ProviderInstance`, cleanup registry, logger,
duration formatting) that every other module depends on.

**Testing** covers the Vitest-based test suite, including configuration tests,
parser tests, format utility tests, and spec generator tests, all using real
filesystem I/O rather than mocks.

## Quick navigation

- [Architecture Overview](./architecture.md) — High-level system design and component interactions

## Cli Orchestration

- [CLI](./cli-orchestration/cli.md)
- [Integrations](./cli-orchestration/integrations.md)
- [Orchestrator](./cli-orchestration/orchestrator.md)
- [Overview](./cli-orchestration/overview.md)
- [Tui](./cli-orchestration/tui.md)

## Issue Fetching

- [Adding A Fetcher](./issue-fetching/adding-a-fetcher.md)
- [Azdevops Fetcher](./issue-fetching/azdevops-fetcher.md)
- [Github Fetcher](./issue-fetching/github-fetcher.md)
- [Integrations](./issue-fetching/integrations.md)
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

