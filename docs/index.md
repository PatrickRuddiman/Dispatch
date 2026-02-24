# dispatch-tasks Documentation

dispatch-tasks is a Node.js CLI tool that turns markdown checklists into an
automated, agent-driven development pipeline. You write tasks as GitHub-style
checkbox items (`- [ ] do something`) in plain markdown files, and dispatch-tasks
routes each item to an AI coding agent in an isolated session, marks it complete
in the source file, and creates a conventional commit for the result. The
outcome is a clean, reviewable git history where every commit maps directly to
an item in your original task list.

The tool exists to solve three problems that arise when orchestrating AI coding
agents across many small, well-defined units of work:

- **Context isolation.** Each task runs in a fresh agent session, preventing
  context from one task from leaking into another.
- **Precision through planning.** An optional two-phase pipeline lets a
  read-only planner agent explore the codebase and produce a focused execution
  plan before the executor agent acts.
- **Automated record-keeping.** After each task, the markdown source is updated
  and a conventional commit is created automatically.

dispatch-tasks currently supports two AI agent backends -- OpenCode and GitHub
Copilot -- through a provider abstraction layer, and is designed so that
additional backends can be added by implementing a four-method interface and
registering a boot function.

## Key concepts

- **Task file.** A markdown file containing one or more GitHub-style checkbox
  items (`- [ ] ...`). This is the unit of input to the pipeline.
- **Task.** A single unchecked checkbox item extracted from a task file,
  represented internally as a `Task` object with text, line number, and source
  file metadata.
- **Provider.** An AI agent runtime (OpenCode or Copilot) accessed through the
  `ProviderInstance` interface. Providers manage sessions and handle prompting.
- **Planner.** A read-only AI agent session that explores the codebase and
  produces a detailed execution plan for a task. Skipped with `--no-plan`.
- **Dispatcher.** The module that sends a task (with or without a plan) to an AI
  agent for execution in an isolated session.
- **Conventional commit.** After each task completes, a commit is created with a
  type (feat, fix, docs, refactor, etc.) inferred automatically from the task
  text.

## Reading guide

This documentation is organized into five sections that mirror the architecture
of the tool. If you are new to the project, start with the
[Architecture Overview](./architecture.md), which covers the full system
topology, the six-stage pipeline, and the key design decisions.

From there, the sections are:

- **CLI & Orchestration** covers the command-line interface, the orchestrator
  that drives the multi-phase pipeline, the real-time terminal UI, and logging.
  Start here to understand how user input flows into the system and how tasks
  are coordinated.

- **Task Parsing & Markdown** documents the parser that converts markdown
  checkbox syntax into structured data. It covers the supported markdown
  formats, the API for extracting and completing tasks, concurrency concerns
  around file mutation, and how to run and extend the test suite.

- **Planning & Dispatch Pipeline** explains the core execution engine: the
  optional planner phase, the dispatcher that sends tasks to AI agents, the git
  integration that creates conventional commits, and the task context filtering
  that prevents planner confusion.

- **Provider Abstraction & Backends** describes the strategy pattern that
  decouples the pipeline from specific AI runtimes. It includes setup guides for
  the OpenCode and Copilot backends and a step-by-step guide for adding new
  providers.

- **Shared Interfaces & Utilities** documents the foundational types and
  contracts (`Task`, `TaskFile`, `ProviderInstance`, logger) that every other
  module depends on.

## Quick navigation

- [Architecture Overview](./architecture.md) — High-level system design and component interactions

## Cli Orchestration

- [CLI](./cli-orchestration/cli.md)
- [Integrations](./cli-orchestration/integrations.md)
- [Orchestrator](./cli-orchestration/orchestrator.md)
- [Overview](./cli-orchestration/overview.md)
- [Tui](./cli-orchestration/tui.md)

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

- [Integrations](./shared-types/integrations.md)
- [Logger](./shared-types/logger.md)
- [Overview](./shared-types/overview.md)
- [Parser](./shared-types/parser.md)
- [Provider](./shared-types/provider.md)

## Task Parsing

- [API Reference](./task-parsing/api-reference.md)
- [Architecture And Concurrency](./task-parsing/architecture-and-concurrency.md)
- [Markdown Syntax](./task-parsing/markdown-syntax.md)
- [Overview](./task-parsing/overview.md)
- [Testing Guide](./task-parsing/testing-guide.md)

