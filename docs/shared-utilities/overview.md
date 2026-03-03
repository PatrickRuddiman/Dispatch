# Shared Utilities

The shared utilities layer provides two pure, dependency-free modules that are
consumed across multiple subsystems in the Dispatch CLI: **slugify** for
deterministic string-to-identifier conversion and **timeout** for
promise-level deadline enforcement.

| File | Purpose |
|------|---------|
| [`src/slugify.ts`](../../src/slugify.ts) | Convert arbitrary text into URL/filesystem-safe identifiers |
| [`src/timeout.ts`](../../src/timeout.ts) | Wrap any promise with a configurable deadline and labeled error |

## Why these utilities exist

Dispatch generates git branch names and spec filenames from user-supplied
issue titles, and it runs AI agent planning steps that can hang indefinitely.
Both operations need small, well-tested building blocks:

- **slugify** ensures that titles like `"Add dark-mode support!"` produce
  consistent, portable identifiers (`add-dark-mode-support`) regardless of
  casing, punctuation, or Unicode content. These identifiers are used for
  [branch naming](../datasource-system/overview.md#branch-naming-convention)
  and [temp file naming](../datasource-system/datasource-helpers.md#writeitemstotempdir).
- **withTimeout** ensures that a planning step that exceeds its deadline is
  interrupted with a descriptive `TimeoutError`, enabling the retry loop in
  the [orchestrator](../cli-orchestration/orchestrator.md) to attempt recovery.

## How modules depend on these utilities

```mermaid
graph TD
    subgraph "Shared Utilities"
        Slugify["slugify.ts"]
        Timeout["timeout.ts"]
    end

    subgraph "Datasources"
        GH["datasources/github.ts"]
        AZ["datasources/azdevops.ts"]
        MD["datasources/md.ts"]
    end

    subgraph "Orchestrator"
        DP["dispatch-pipeline.ts"]
        SP["spec-pipeline.ts"]
        DH["datasource-helpers.ts"]
    end

    GH -- "slugify(title, 50)" --> Slugify
    AZ -- "slugify(title, 50)" --> Slugify
    MD -- "slugify(title, 50)<br/>slugify(title)" --> Slugify
    SP -- "slugify(title, 60)" --> Slugify
    DH -- "slugify(title, 60)" --> Slugify
    DP -- "withTimeout(promise, ms, label)" --> Timeout
```

## Two maxLength conventions

Consumers have settled on two truncation limits:

| maxLength | Context | Rationale |
|-----------|---------|-----------|
| **50** | Git branch names (`dispatch/<number>-<slug>`) | Practical limit for branch name portability across Git hosts |
| **60** | Spec filenames (`<id>-<slug>.md`) | Keeps filenames readable while accommodating longer titles |
| *(none)* | Markdown datasource `create()` | No truncation needed for internal identifiers |

## Detailed documentation

- [Slugify](./slugify.md) -- String-to-identifier conversion, Unicode
  behavior, truncation edge cases, and cross-codebase usage
- [Timeout](./timeout.md) -- Promise deadline enforcement, TimeoutError,
  retry strategy, memory considerations, and configuration
- [Testing](./testing.md) -- Vitest integration, fake timers, test
  organization, and how to run the shared utility tests

## Related documentation

- [Shared Interfaces & Utilities](../shared-types/overview.md) -- The broader
  shared layer (cleanup, format, logger, parser, provider) that these
  utilities complement
- [CLI & Orchestration](../cli-orchestration/overview.md) -- How the
  orchestrator consumes `withTimeout` for plan deadlines
- [Orchestrator Pipeline](../cli-orchestration/orchestrator.md) -- The
  dispatch pipeline that uses `withTimeout` for planning timeouts
- [Datasource System](../datasource-system/overview.md) -- How datasources
  use `slugify` for branch name generation
- [Datasource Helpers](../datasource-system/datasource-helpers.md) -- How
  `slugify` is used for temp file naming in `writeItemsToTempDir()`
- [Spec Generation](../spec-generation/overview.md) -- How spec pipelines use
  `slugify` for spec filenames
- [Planner Agent](../planning-and-dispatch/planner.md) -- The planning phase
  that is subject to `withTimeout` deadline enforcement
- [Testing Overview](../testing/overview.md) -- Project-wide test suite
  including slugify and timeout test coverage
- [Architecture overview](../architecture.md) -- System-wide context
