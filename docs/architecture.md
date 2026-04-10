# Dispatch — Architecture Overview

Dispatch is a command-line tool that automates software engineering work by
delegating tasks from issue trackers to AI coding agents. It reads work items
from GitHub Issues, Azure DevOps Work Items, or local markdown files, converts
them into structured specification and task files, and orchestrates AI agents
(OpenCode, GitHub Copilot, Claude, or Codex) to plan and execute each task — committing changes,
pushing branches, and opening pull requests automatically.

## Why Dispatch exists

Manual orchestration of AI coding agents is tedious when a project has many
small, well-defined units of work. Dispatch closes that gap by:

1. **Fetching issues** from the team's existing tracker (GitHub, Azure DevOps)
   or reading local markdown specs.
2. **Generating structured specs** via an AI agent that explores the codebase
   and produces strategic task lists.
3. **Planning and executing** each task through isolated AI sessions, with an
   optional two-phase planner-then-executor architecture for higher-quality
   results.
4. **Managing the full git lifecycle** — branching, committing with conventional
   commit messages, pushing, and opening pull requests that auto-close the
   originating issue.

The tool is backend-agnostic across three dimensions — issue trackers
(datasources), AI runtimes (providers), and agent roles — each implemented as
a strategy-pattern plugin behind a formal TypeScript interface.

## System architecture

```mermaid
C4Context
    title Dispatch — System Topology

    Person(dev, "Developer", "Runs dispatch CLI")
    Person(aiClient, "AI Agent Client", "Invokes dispatch via MCP")

    System_Boundary(dispatch, "Dispatch CLI") {
        Container(cli, "CLI Entry Point", "src/cli.ts", "Argument parsing, signal handlers, config routing")
        Container(config, "Configuration", "src/config.ts, config-prompts.ts, orchestrator/cli-config.ts", "Persistent config ({CWD}/.dispatch/config.json), interactive wizard, three-tier merge")
        Container(runner, "Orchestrator Runner", "src/orchestrator/runner.ts", "Pipeline router: dispatch, spec modes")

        Container(spec_pipe, "Spec Pipeline", "src/orchestrator/spec-pipeline.ts", "Issue-to-spec generation with batch concurrency")
        Container(dispatch_pipe, "Dispatch Pipeline", "src/orchestrator/dispatch-pipeline.ts", "Task planning, execution, git lifecycle, PR creation")

        Container(ds_layer, "Datasource Layer", "src/datasources/", "Unified CRUD + git lifecycle across backends")
        Container(prov_layer, "Provider Layer", "src/providers/", "AI runtime abstraction: boot, session, prompt, cleanup")
        Container(agent_layer, "Agent Layer", "src/agents/", "Planner, executor, spec agent roles")

        Container(parser, "Task Parser", "src/parser.ts", "Markdown checkbox extraction, context filtering, completion marking")
        Container(specgen, "Spec Generator", "src/spec-generator.ts", "Input classification, post-processing, validation")
        Container(tui, "Terminal UI", "src/tui.ts", "Real-time progress dashboard with spinner and task list")
        Container(mcp, "MCP Server", "src/mcp/", "Model Context Protocol server: 16 tools, stdio/HTTP transports, forked worker execution")
        Container(shared, "Shared Utilities", "src/helpers/cleanup.ts, logger.ts, format.ts, slugify.ts, timeout.ts", "Cleanup registry, logging, formatting, slugification, timeout")
    }

    System_Ext(github, "GitHub", "Issues, PRs via @octokit/rest SDK")
    System_Ext(azdevops, "Azure DevOps", "Work items, PRs via azure-devops-node-api SDK")
    System_Ext(localfs, "Local Filesystem", ".dispatch/specs/ markdown files")
    System_Ext(git, "Git CLI", "Branch, commit, push operations")
    System_Ext(opencode, "OpenCode", "AI agent runtime via @opencode-ai/sdk")
    System_Ext(copilot, "GitHub Copilot", "AI agent runtime via @github/copilot-sdk")
    System_Ext(claude, "Claude", "AI agent runtime via @anthropic-ai/claude-agent-sdk")
    System_Ext(codex, "Codex", "AI agent runtime via @openai/codex")

    Rel(dev, cli, "invokes")
    Rel(aiClient, mcp, "MCP tool calls")
    Rel(cli, config, "config subcommand")
    Rel(cli, runner, "delegates pipeline execution")
    Rel(cli, mcp, "mcp subcommand")
    Rel(mcp, runner, "fork + IPC")
    Rel(runner, spec_pipe, "--spec")
    Rel(runner, dispatch_pipe, "default mode")
    Rel(spec_pipe, ds_layer, "fetch, update, create")
    Rel(spec_pipe, prov_layer, "boot, session, prompt")
    Rel(spec_pipe, agent_layer, "spec agent")
    Rel(dispatch_pipe, ds_layer, "fetch, close, git lifecycle")
    Rel(dispatch_pipe, prov_layer, "boot, session, prompt")
    Rel(dispatch_pipe, agent_layer, "planner + executor agents")
    Rel(dispatch_pipe, parser, "parse, mark complete, group by mode")
    Rel(dispatch_pipe, tui, "real-time progress")
    Rel(ds_layer, github, "@octokit/rest SDK")
    Rel(ds_layer, azdevops, "azure-devops-node-api SDK")
    Rel(ds_layer, localfs, "fs/promises")
    Rel(ds_layer, git, "git commands")
    Rel(prov_layer, opencode, "@opencode-ai/sdk")
    Rel(prov_layer, copilot, "@github/copilot-sdk")
    Rel(prov_layer, claude, "@anthropic-ai/claude-agent-sdk")
    Rel(prov_layer, codex, "@openai/codex")
```

## Pipeline modes

Dispatch operates in three mutually exclusive modes, routed by the
[orchestrator runner](cli-orchestration/orchestrator.md). Mode exclusion is
enforced by the orchestrator, not the argument parser.

| Mode | Trigger | Purpose | Detail page |
|------|---------|---------|-------------|
| **Spec generation** | `--spec` | Convert issues into structured markdown specs | [Spec generation](spec-generation/overview.md) |
| **Dispatch** | Default (no mode flag) | Plan and execute tasks, commit, push, open PRs | [Planning & dispatch](planning-and-dispatch/overview.md) |

The three-stage end-to-end workflow connects these modes:

```mermaid
flowchart LR
    A["Issue Tracker<br/>(GitHub / AzDevOps / .md)"] -->|"dispatch --spec 42"| B["Spec Agent<br/>Explores codebase,<br/>writes spec file"]
    B -->|".dispatch/specs/*.md"| C["dispatch 42"]
    C --> D["Planner Agent<br/>Read-only exploration,<br/>detailed plan per task"]
    D --> E["Executor Agent<br/>Implements changes<br/>per plan"]
    E --> F["Git: branch, commit,<br/>push, open PR"]
```

| Stage | Command | Agent | Output |
|-------|---------|-------|--------|
| 1. Spec | `dispatch --spec 42,43` | [Spec agent](spec-generation/overview.md) | Structured markdown specs with `- [ ]` tasks |
| 2. Plan | `dispatch 42` | [Planner agent](agent-system/planner-agent.md) | Detailed execution plan per task |
| 3. Execute | (same command) | [Executor agent](planning-and-dispatch/dispatcher.md) | Code changes + conventional commits + PRs |

Stages 2 and 3 run within the same `dispatch` invocation. Stage 1 is a separate
invocation that produces the markdown files consumed by stages 2 and 3.

## Data flow

### Configuration resolution

User configuration flows through a [three-tier merge](cli-orchestration/configuration.md)
before reaching any pipeline:

```mermaid
flowchart TD
    A["CLI flags<br/>(--provider, --source, etc.)"] --> D["resolveCliConfig()<br/>src/orchestrator/cli-config.ts"]
    B["Config file<br/>({CWD}/.dispatch/config.json)"] --> D
    C["Hardcoded defaults<br/>(opencode, auto-detect, etc.)"] --> D
    D -->|"explicitFlags set<br/>distinguishes intentional args"| E["Resolved options"]
    E --> F{"Mode?"}
    F -->|"--spec"| G["Spec pipeline"]
    F -->|"default"| H["Dispatch pipeline"]
```

The `explicitFlags` set tracks which CLI arguments were user-provided versus
defaulted, so config-file values fill gaps without overriding intentional flags.
See [configuration](cli-orchestration/configuration.md) for the full merge logic.

### Dispatch pipeline phases

The dispatch pipeline is a multi-phase workflow. Each phase has distinct error
handling and the pipeline manages per-issue git branch isolation:

```mermaid
sequenceDiagram
    participant DS as Datasource
    participant DP as Dispatch Pipeline
    participant Parser as Task Parser
    participant Planner as Planner Agent
    participant Executor as Executor Agent
    participant Git as Git CLI
    participant Tracker as Issue Tracker

    DP->>DS: fetch issues (by ID or list all)
    DS-->>DP: IssueDetails[]

    DP->>DP: writeItemsToTempDir() — stage to temp markdown files

    DP->>Parser: parseTaskFile() per file
    Parser-->>DP: TaskFile[] with Task[]

    DP->>DP: bootProvider(), register cleanup

    loop Per issue file
        DP->>DS: createAndSwitchBranch("dispatch/N-slug")

        DP->>Parser: groupTasksByMode() — (P)arallel/(S)erial batches

        loop Per task batch (concurrency N)
            DP->>Planner: plan(task, context) [withTimeout + retry]
            Planner-->>DP: execution plan

            DP->>Executor: execute(task, plan)
            Executor-->>DP: result

            DP->>Parser: markTaskComplete(file, task)
            DP->>DS: commitAllChanges()
            DP->>DS: update() — sync task state back to datasource
        end

        DP->>DS: pushBranch()
        DP->>DS: createPullRequest() [Closes #N / Resolves AB#N]
        DP->>DS: switchBranch(defaultBranch)
    end

    DP->>DS: closeCompletedSpecIssues()
    DP->>DP: cleanup provider resources
```

For full phase details, see [dispatch pipeline](planning-and-dispatch/overview.md)
and [datasource helpers](datasource-system/datasource-helpers.md).

### Spec generation pipeline phases

When invoked with `--spec`, the pipeline converts issues into AI-generated
specification files:

```mermaid
flowchart LR
    A["1. Resolve datasource<br/>auto-detect or --source"] --> B["2. Fetch issues<br/>or read files/globs"]
    B --> C["3. Boot AI provider"]
    C --> D["4. Generate specs<br/>batch with concurrency"]
    D --> E["5. Post-process<br/>strip fences, validate"]
    E --> F["6. Write + rename<br/>H1-derived filename"]
    F --> G["7. Sync back<br/>update/create on tracker"]
```

Three input modes are supported: tracker issue IDs (`dispatch --spec 42,43`),
file/glob patterns (`dispatch --spec "drafts/*.md"`), and inline text
(`dispatch --spec "Add dark mode"`). The input type determines the
sync-back behavior. See [spec generation](spec-generation/overview.md) for
details.

## Key abstractions

Dispatch is built on three parallel strategy-pattern registries. Each has a
formal TypeScript interface, a static `Record<Name, BootFn>` map with
compile-time string literal union keys, and a boot/get function:

| Registry | Key type | Location | Extension guide |
|----------|----------|----------|-----------------|
| Providers | `ProviderName` (`"opencode"` \| `"copilot"` \| `"claude"` \| `"codex"`) | `src/providers/index.ts` | [Adding a provider](provider-system/adding-a-provider.md) |
| Agents | `AgentName` (`"planner"` \| `"executor"` \| `"spec"` \| `"commit"`) | `src/agents/index.ts` | [Agent framework](agent-system/overview.md) |
| Datasources | `DatasourceName` (`"github"` \| `"azdevops"` \| `"md"`) | `src/datasources/index.ts` | [Adding a datasource](datasource-system/overview.md#adding-a-new-datasource) |

### Datasource layer

The [datasource interface](datasource-system/overview.md) defines a fifteen-method
contract covering five CRUD operations (`list`, `fetch`, `create`, `update`,
`close`), two identity/capability methods (`getUsername`, `supportsGit`), and
eight git lifecycle operations (`getDefaultBranch`, `getCurrentBranch`,
`buildBranchName`, `createAndSwitchBranch`, `switchBranch`, `pushBranch`,
`commitAllChanges`, `createPullRequest`).

| Datasource | Backend | Auth method | Detail page |
|------------|---------|-------------|-------------|
| `github` | `@octokit/rest` SDK | OAuth device-code flow (`@octokit/auth-oauth-device`) | [GitHub datasource](datasource-system/github-datasource.md) |
| `azdevops` | `azure-devops-node-api` SDK | `DeviceCodeCredential` (`@azure/identity`) | [Azure DevOps datasource](datasource-system/azdevops-datasource.md) |
| `md` | Local filesystem (`fs/promises`) | None | [Markdown datasource](datasource-system/markdown-datasource.md) |

Auto-detection from `git remote get-url origin` matches `github.com`,
`dev.azure.com`, and `visualstudio.com` patterns. Both SSH and HTTPS URL
formats are supported. See [auto-detection](datasource-system/overview.md#auto-detection)
for limitations (no GitHub Enterprise, only checks `origin` remote).

All three implementations use a shared `<username>/dispatch/<number>-<slug>` branch
naming convention via [slugify](shared-utilities/slugify.md), and
platform-specific PR auto-close syntax (`Closes #N` for GitHub,
`Resolves AB#N` for Azure DevOps) that is used as a fallback when the caller
does not provide a PR body.

### Provider layer

The [provider interface](provider-system/overview.md) abstracts AI
agent runtimes behind a session-based lifecycle: `boot` → `createSession` →
`prompt` → `cleanup`.

| Provider | SDK | Prompt model | Detail page |
|----------|-----|-------------|-------------|
| `opencode` | `@opencode-ai/sdk` | Async (fire-and-forget + SSE events) | [OpenCode backend](provider-system/opencode-backend.md) |
| `copilot` | `@github/copilot-sdk` | Async (event-based `send` + idle/error listeners) | [Copilot backend](provider-system/copilot-backend.md) |
| `claude` | `@anthropic-ai/claude-agent-sdk` | SDK-based agent interaction | [Claude backend](provider-implementations/claude-backend.md) |
| `codex` | `@openai/codex` | SDK-based agent loop | [Codex backend](provider-implementations/codex-backend.md) |

Each task gets an isolated session to prevent context leakage between tasks.
Providers manage their own server lifecycle (spawning or connecting to external
processes via `--server-url`). See
[session isolation](provider-system/overview.md#session-isolation-model).

### Agent layer

Four [agent roles](agent-system/overview.md) power the AI-driven
pipeline:

| Agent | Purpose | Key behavior | Detail page |
|-------|---------|-------------|-------------|
| **Spec** | Explore codebase, generate strategic specs | Writes to `.dispatch/tmp/` via AI, reads back, post-processes | [Spec generation](spec-generation/overview.md) |
| **Planner** | Read-only exploration, produce execution plan | Read-only enforcement via prompt instructions (not tool restrictions) | [Planner](agent-system/planner-agent.md) |
| **Executor** | Follow plan, make code changes | Gets plan context from planner output | [Dispatcher](planning-and-dispatch/dispatcher.md) |
| **Commit** | Analyze branch diff, generate commit message and PR metadata | Conventional Commits format, writes to `.dispatch/tmp/` | [Commit agent](agent-system/commit-agent.md) |

The optional `--no-plan` flag bypasses the planner for simpler tasks.

## Cross-cutting concerns

### Authentication and secrets

Dispatch stores no credentials. Authentication is delegated entirely to
external CLI tools and SDKs:

| Backend | Auth mechanism | Managed by |
|---------|---------------|------------|
| GitHub datasource | OAuth device-code flow via `@octokit/auth-oauth-device`, cached at `~/.dispatch/auth.json` (mode 0o600) | [Authentication](cli-orchestration/authentication.md) |
| Azure DevOps datasource | `DeviceCodeCredential` via `@azure/identity`, cached at `~/.dispatch/auth.json` | [Authentication](cli-orchestration/authentication.md) |
| OpenCode provider | Server-level config; no credentials passed by dispatch | [OpenCode SDK](provider-system/opencode-backend.md) |
| Copilot provider | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, or logged-in `gh` CLI user | [Copilot SDK](provider-system/copilot-backend.md) |

For tracker-backed datasources (GitHub and Azure DevOps), Dispatch also
performs its own OAuth device-flow authentication via `src/helpers/auth.ts`,
caching tokens at `~/.dispatch/auth.json`. This authentication runs **early
in the lifecycle** — during `dispatch config`, or at startup for dispatch and
spec pipelines — so device-code prompts appear before pipeline work begins.
Cached tokens make the check instant. The lazy auth inside individual
datasource methods remains as a safety net.

There is no secrets rotation mechanism within Dispatch. Token lifecycle is
managed by the underlying tools. For CI/CD environments, use environment
variables instead of interactive login. The only persistent data is
`{CWD}/.dispatch/config.json`, which contains user preferences but no secrets.
See [datasource integrations](datasource-system/integrations.md) and
[provider overview](provider-system/overview.md).

### Process cleanup and graceful shutdown

The [cleanup registry](shared-types/cleanup.md) (`src/helpers/cleanup.ts`) provides a
safety net for resource teardown:

1. When a provider boots, its `cleanup()` is registered immediately via
   `registerCleanup()`.
2. On **normal completion**, the pipeline calls `cleanup()` explicitly.
3. On **signal exit** (SIGINT, SIGTERM), the CLI's signal handlers drain the
   registry via `runCleanup()`.
4. After draining, `cleanups.splice(0)` clears the array so repeated calls are
   harmless.

This dual-path design (explicit + registry) ensures spawned server processes
are terminated even on abnormal exit. Both providers handle double-cleanup
safely (OpenCode via a `cleaned` boolean guard, Copilot via error swallowing).
Exit codes follow Unix conventions: 0 for success, 1 for failures, 130 for
SIGINT, 143 for SIGTERM. See
[provider cleanup](provider-system/overview.md#cleanup-and-resource-management).

### Error handling strategy

The system uses a consistent **catch-and-continue** pattern for batch
operations:

| Scenario | Behavior | Detail page |
|----------|----------|-------------|
| Issue fetch fails | Logged, skipped; others continue | [Spec generation](spec-generation/overview.md#error-handling-and-exit-codes) |
| Spec generation fails for one issue | Per-attempt timeout/retries are exhausted for that item; `failed` counter increments and others continue | [Spec generation](spec-generation/overview.md#error-handling-and-exit-codes) |
| Planner times out | Retried up to `--plan-retries` (or shared `--retries`, default 3) with `--plan-timeout` (default 30 min); exhausted retries pause interactive dispatch runs for manual rerun, while verbose or non-TTY runs fail predictably without waiting | [Orchestrator](cli-orchestration/orchestrator.md) |
| Executor returns null / exhausts retries | Interactive dispatch runs enter paused recovery for manual rerun or quit; verbose or non-TTY runs finalize the task as failed and stop predictably | [Dispatcher](planning-and-dispatch/dispatcher.md) |
| Datasource sync fails post-execution | Warning logged; task still counted as done | [Orchestrator](cli-orchestration/orchestrator.md) |
| Provider boot fails | Entire run aborts (misconfiguration — no retry) | [Provider error recovery](provider-system/overview.md#error-recovery-on-boot-failure) |
| PR already exists for branch | Falls back to returning existing PR URL | [Datasource overview](datasource-system/overview.md#existing-pr-handling) |
| Config file corrupted | `loadConfig()` returns `{}` silently; defaults apply | [Configuration](cli-orchestration/configuration.md) |
| `execFile` target not found | `ENOENT` error; fetch/operation marked failed | [Datasource integrations](datasource-system/integrations.md) |

Exit code is `0` if all tasks/specs succeed, `1` if any fail. No distinction
between partial and total failure.

### Monitoring and observability

Dispatch provides three output channels with no external monitoring integration:

- **[TUI dashboard](cli-orchestration/tui.md)**: Real-time terminal rendering
  with spinner, progress bar, per-task status tracking, and elapsed time.
  Tracks both per-task states (pending → planning → running → paused →
  done/failed) and global phase states (discovering → parsing → booting →
  dispatching → paused → done), including in-session rerun recovery.
- **[Console logger](shared-types/logger.md)**: Structured chalk-formatted
  output with `--verbose` for debug-level messages. `formatErrorChain()`
  traverses nested `.cause` properties up to five levels. Active in dry-run,
  verbose, non-TTY, and spec generation contexts, and it is the deliberate
  non-waiting fallback when paused recovery cannot prompt for input. Level
  controlled by `LOG_LEVEL` env var, `DEBUG` env var, or the `--verbose` CLI
  flag.
- **[File logger](shared-types/file-logger.md)**: Per-issue structured log
  files at `.dispatch/logs/issue-{id}.log`, scoped via Node.js
  `AsyncLocalStorage`. When verbose mode is active, every `log.*` call mirrors
  its output (with ANSI codes stripped) into the current file logger context.
  Each pipeline (`dispatch`, `spec`) creates its own
  `AsyncLocalStorage.run()` scope per issue.

The dual-channel logging architecture means a single `log.info()` call performs
two writes: styled console output and plain-text file append. Log files contain
full AI prompts and responses, enabling post-hoc debugging and replay. Files
are truncated (overwritten) per run — there is no rotation or retention policy.

Color output is controlled by `FORCE_COLOR`, `NO_COLOR`, or `--no-color`. There
is no structured JSON log output, no metrics export, and no health checks for
AI providers.

### Concurrency model

Both pipelines support configurable concurrency:

- **Dispatch pipeline**: `--concurrency N` (default: `min(cpuCount, freeMB/500)`,
  at least 1) controls how many tasks run in parallel per batch via
  `Promise.all()`.
- **Spec pipeline**: Same default calculation, batch-concurrent generation.

Concurrent task execution (`--concurrency > 1`) introduces risks documented in
[architecture & concurrency](task-parsing/architecture-and-concurrency.md):

1. **Markdown file corruption**: `markTaskComplete` performs a read-modify-write
   cycle without file locking.
2. **Git commit cross-contamination**: `git add -A` stages all changes; one
   task's commit can include another's uncommitted work.

### Worktree isolation

When processing multiple issues concurrently (`--concurrency > 1`), the
dispatch pipeline creates per-issue [git worktrees](git-and-worktree/overview.md)
under `.dispatch/worktrees/<slug>` to prevent concurrent AI agents from seeing
each other's uncommitted changes:

```mermaid
flowchart TD
    ORCH["Dispatch Pipeline"] --> CHECK{"useWorktrees?"}
    CHECK -->|Yes| WT["createWorktree(cwd, file, branch)<br/>Per-issue isolated directory"]
    CHECK -->|No| SERIAL["Serial mode: createAndSwitchBranch()"]
    WT --> BOOT["Boot per-worktree provider"]
    BOOT --> EXEC["Execute tasks in isolated worktree"]
    EXEC --> PUSH["Push branch & create PR"]
    PUSH --> RM["removeWorktree()<br/>Three-phase cascade: normal → force → prune"]
    RM --> CLEAN["Cleanup provider"]
```

Worktree management includes:

- **Branch reuse fallback**: `createWorktree` tries `git worktree add -b <branch>`;
  if the branch exists (from a prior interrupted run), it falls back to
  `git worktree add <branch>` without `-b`.
- **Cleanup registration**: Each worktree registers a `removeWorktree` handler
  via the [cleanup registry](shared-types/cleanup.md) so abnormal termination
  still cleans up.
- **Feature branch workflow**: `--feature` creates a single branch, processes
  issues serially, and merges each issue's working branch via `git merge --no-ff`.
  Conflicts abort the merge and mark tasks failed.
- **Branch validation**: All branch names pass through
  [`isValidBranchName()`](git-and-worktree/branch-validation.md) to enforce
  git refname rules and prevent command injection (rejecting `$`, backticks,
  semicolons, and other shell metacharacters).

See [worktree management](git-and-worktree/worktree-management.md) and
[dispatch pipeline](cli-orchestration/dispatch-pipeline.md).

### Timeout and retry

Dispatch applies deadlines and retries at the orchestration boundary rather than
inside the agents themselves. The two primary timeout surfaces are planning and
spec generation:

| Setting | CLI flag | Config key | Default |
|---------|----------|------------|---------|
| Planning timeout | `--plan-timeout` | `planTimeout` | 30 minutes |
| Planning retries | `--plan-retries` | `planRetries` | falls back to `--retries` (default 3) |
| Spec-generation timeout | `--spec-timeout` | `specTimeout` | 10 minutes |
| Spec warn-phase timeout | `--spec-warn-timeout` | `specWarnTimeout` | 10 minutes |
| Spec kill-phase timeout | `--spec-kill-timeout` | `specKillTimeout` | 10 minutes |
| Spec-generation retries | `--retries` | `retries` | 3 |

Planning retries timed-out attempts up to `maxPlanAttempts`. Spec generation
uses the same boundary pattern in `runSpecPipeline()`: the pipeline converts
`(specTimeout ?? 10) * 60_000` once, then wraps each
`specAgent.generate(...)` attempt as `withRetry(() => withTimeout(...), retries)`.

Architecturally, that means spec deadlines are per item and per attempt.
`TimeoutError` enters the normal retry flow, exhausted retries fail only that
item, concurrent batches continue, and successful items still preserve partial
progress in the final summary.

The two-phase timebox model layers a **warn phase** (`--spec-warn-timeout`) and a **kill phase** (`--spec-kill-timeout`) around each spec-generation attempt. When the warn phase fires, a nudge message is sent to the agent via the optional `send()` method; when the kill phase fires, the attempt is aborted with a `TimeoutError`.

Provider-local safeguards complement these deadlines rather than replacing them:
Copilot adds its own idle wait timeout, while OpenCode surfaces `session.error`
events and stream disconnects during prompt execution. Overall planning/spec
deadlines still belong to the orchestrator. See
[provider timeouts](provider-system/overview.md#prompt-timeouts-and-cancellation).

In interactive dispatch runs, exhausting those retries no longer always means an
immediate terminal failure: the task can enter a paused recovery state for a
manual rerun, while verbose or non-TTY contexts still fail predictably without
waiting for input.

### External tool dependencies

Dispatch depends on external CLI tools at runtime. The
[prerequisite checker](prereqs-and-safety/prereqs.md) (`src/helpers/prereqs.ts`)
validates tool availability at startup before any pipeline logic runs:

| Tool | Required when | Pre-flight check | Failure mode |
|------|--------------|------------------|-------------|
| `git` | Always | `git --version` | `checkPrereqs()` reports failure → `process.exit(1)` |
| Node.js >= 20.12.0 | Always | Semver comparison | `checkPrereqs()` reports failure → `process.exit(1)` |
| OpenCode CLI or server | `--provider opencode` | None (detected in config wizard only) | `bootProvider()` throws |
| Copilot CLI | `--provider copilot` | None (detected in config wizard only) | `client.start()` throws |
| Claude CLI | `--provider claude` | None (detected in config wizard only) | Boot fails |
| Codex CLI | `--provider codex` | None (detected in config wizard only) | Boot fails |

Provider binary availability is probed separately by
[`checkProviderInstalled()`](provider-system/binary-detection.md) during
the interactive configuration wizard (`dispatch config`), where green/red dots
indicate installation status. However, provider pre-flight checks do **not** run
during pipeline execution — a missing provider binary causes a boot-time failure.

Subprocess `execFile` calls generally have no timeout. The
`getBranchDiff` helper uses a 10 MB `maxBuffer`; exceeding it kills the
child process. See [datasource integrations](datasource-system/integrations.md)
and [prerequisites & safety](prereqs-and-safety/overview.md).

### On-disk storage

All state is file-based — no external databases are used. The `.dispatch/`
directory at the project root contains all Dispatch-managed artifacts:

| Location | Purpose | Lifecycle |
|----------|---------|-----------|
| `{CWD}/.dispatch/config.json` | Project-local persistent configuration | Manual via `dispatch config` or by deleting the file |
| `.dispatch/dispatch.db` | SQLite database for MCP server state and run state | Created on first MCP use; persists across runs |
| `.dispatch/specs/` | Generated spec files; markdown datasource storage | Managed by datasource lifecycle |
| `.dispatch/specs/archive/` | Closed specs (markdown datasource) | Manual recovery via file move |
| `.dispatch/worktrees/` | Git worktrees for per-issue isolation | Created/removed per dispatch; gitignored automatically |
| `.dispatch/logs/issue-{id}.log` | Per-issue structured logs (verbose mode) | Overwritten per run; not rotated |
| `.dispatch/tmp/` | Temp spec/commit files during AI generation (UUID-named) | Cleaned per-spec; may accumulate on crash |
| `.dispatch/run-state.json` | Per-run task status persistence | Written atomically (temp-then-rename); future resume support |
| `/tmp/dispatch-*` | Temp directories for datasource-fetched issues | Cleaned on completion; orphaned on crash |
| `~/.dispatch/auth.json` | Cached OAuth tokens (mode 0o600) | Written by device-code auth flow; no expiration management |

The `.dispatch/worktrees/` entry is automatically added to `.gitignore` at the
start of every orchestrator run via
[`ensureGitignoreEntry()`](git-and-worktree/gitignore-helper.md). Whether
`.dispatch/` itself is committed depends on the project's `.gitignore`
configuration.

### Shared data model

Three core data structures flow through the entire pipeline:

- **`Task` / `TaskFile`** (`src/parser.ts`): Extracted from markdown checkboxes,
  consumed by the orchestrator, planner, executor, TUI, and git modules. See
  [task parsing](task-parsing/overview.md) and [parser types](shared-types/parser.md).
- **`IssueDetails`** (`src/datasources/interface.ts`): Normalized work item
  representation consumed by all datasource operations. Fields include `number`,
  `title`, `body`, `labels`, `state`, `url`, `comments`, and
  `acceptanceCriteria`. See [datasource overview](datasource-system/overview.md#the-issuedetails-interface).
- **`AgentResult<T>`** (`src/agents/types.ts`): Generic discriminated union
  returned by all agents. Uses `success: true | false` as the discriminant with
  `never` types on mutually exclusive fields, providing compile-time safety at
  call sites. Error codes (`TIMEOUT`, `PROVIDER_ERROR`, `NO_RESPONSE`,
  `VALIDATION_FAILED`, `UNKNOWN`) drive retry decisions. See
  [agent framework](agent-system/overview.md).

The `(P)`/`(S)`/`(I)` prefix syntax on task text controls parallel, serial, and
isolated execution grouping via `groupTasksByMode()`. See
[markdown syntax](task-parsing/markdown-syntax.md).

## Cross-system patterns

Several architectural patterns recur across multiple subsystems. Understanding
these patterns provides a mental model for navigating any part of the codebase.

### Strategy-pattern registries

Three parallel registries (`providers/index.ts`, `agents/index.ts`,
`datasources/index.ts`) share the same structure: a `Record<Name, BootFn>` map
with a compile-time string literal union as key type, a `boot(name, opts)`
function, and a `NAMES` array for CLI validation. This means adding a new
provider, agent, or datasource follows an identical four-step process: create
the implementation, extend the union type, register in the map, and re-export
public types.

### Subprocess execution via `execFile`

Git operations and provider binary detection execute external processes via
Node.js `child_process.execFile` wrapped with `util.promisify`. On Windows,
`shell: true` is required for `.cmd`/`.bat` wrappers. Most calls have no
timeout; the `maxBuffer` default is 1 MB (Node.js) except where explicitly
raised (10 MB for `getBranchDiff` and test output capture). See
[datasource integrations](datasource-system/integrations.md).

### Cleanup registry pattern

The [cleanup registry](shared-types/cleanup.md) (`registerCleanup` /
`runCleanup`) is used by both provider lifecycle management and worktree
teardown to ensure resources are released on abnormal exit (SIGINT, SIGTERM).
Cleanup functions execute in FIFO registration order and errors are swallowed
to prevent cascading failures. Both the explicit cleanup path (orchestrator
success) and the signal-handler safety net may invoke `cleanup()` — all
registered functions must be idempotent.

### Retry and timeout wrapping

The `withTimeout(promise, ms, label)` utility wraps async operations with a
deadline, producing descriptive `TimeoutError` messages. The `withRetry(fn, n)`
utility retries transient failures. Both are used by the dispatch pipeline
(planner timeout + retry), spec pipeline (generation timeout + retry and
datasource fetch timeout), and the test runner (test execution timeout). The
pattern is consistent: the pipeline wraps the agent call, not the agent itself.
For spec generation specifically, the orchestration order is
`withRetry(() => withTimeout(specAgent.generate(...)))`, so timeouts become
retryable per-item failures instead of batch-wide aborts.

### `AsyncLocalStorage` context scoping

The [file logger](shared-types/file-logger.md) uses Node.js
`AsyncLocalStorage<FileLogger>` to scope per-issue log files across async
boundaries without threading a logger parameter through every function.
Each pipeline creates a `FileLogger` instance and wraps its processing body
in `fileLoggerStorage.run()`. All downstream code — agents, providers,
helpers — automatically picks up the correct log file via
`fileLoggerStorage.getStore()`. This pattern enables parallel issue processing
where each concurrent issue writes to its own log file.

## Key design decisions

### SDK-based datasources with CLI-free authentication

The GitHub and Azure DevOps datasources use platform SDKs (`@octokit/rest`,
`azure-devops-node-api`) with OAuth device-code flows rather than shelling out
to CLI tools. This provides better programmatic control, type-safe API access,
and eliminates the runtime dependency on `gh` and `az` CLI binaries for data
operations. Git operations still shell out to `git` via `child_process.execFile`.
See [datasource overview](datasource-system/overview.md#why-it-exists).

### Two-phase planner-then-executor

The optional planning phase uses a read-only AI session to explore the codebase
before the executor acts, producing higher-quality results. Read-only
enforcement is prompt-based (not tool-restricted) — a deliberate trade-off for
simplicity. See [planner agent](agent-system/planner-agent.md).

### Spec generation stays high-level

The spec agent intentionally avoids code-level details because the downstream
planner re-explores the codebase with individual task context. This prevents
duplication and keeps specs resilient to codebase changes between generation
and execution. See [spec generation](spec-generation/overview.md).

### Compile-time type unions

`ProviderName`, `DatasourceName`, and `AgentName` are string literal union types
rather than runtime-discovered plugins. This provides TypeScript exhaustiveness
checking at the cost of requiring a code change to add new backends — acceptable
for a system with two providers and three datasources. See
[provider types](shared-types/provider.md).

### Session-per-task isolation

Each task gets an isolated provider session. Sessions share the filesystem but
not conversation context, preventing context rot while allowing tasks to operate
on the same codebase. See
[session isolation](provider-system/overview.md#session-isolation-model).

### Markdown as the source of truth

Plain markdown files with GitHub-style checkboxes serve as the intermediate
format between specs and execution. This makes task files human-readable,
version-controllable, and editable. The parser normalizes CRLF to LF and always
writes LF line endings. See [task parsing](task-parsing/overview.md).

### Automatic conventional commit inference

After each task completes, `git.ts` stages all changes (`git add -A`) and
creates a conventional commit. The commit type (`feat`, `fix`, `docs`,
`refactor`, etc.) is inferred from the task text via regex patterns. See
[git operations](planning-and-dispatch/git.md).

### Three-tier configuration precedence

CLI flags override config file values (`{CWD}/.dispatch/config.json`), which
override hardcoded defaults. An interactive wizard (`dispatch config`) guides
first-time setup with sequential prompts (provider, model, datasource). See
[configuration](cli-orchestration/configuration.md).

### MCP server

Dispatch exposes its full orchestration capability to external AI agents via a
[Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server,
invoked with `dispatch mcp`. The server supports two transport modes: stdio
(default, for local tool integration) and HTTP (for remote/multi-client use on
port 9110).

```mermaid
flowchart TD
    AI["External AI Agent<br/>(e.g. Claude, Copilot)"] -->|"MCP tool call"| MCP["MCP Server<br/>src/mcp/server.ts"]
    MCP -->|"stdio"| STDIO["StdioServerTransport"]
    MCP -->|"http"| HTTP["StreamableHTTPServerTransport<br/>port 9110"]
    MCP --> TOOLS["16 Registered Tools"]
    TOOLS --> SPEC_T["Spec tools<br/>generate, list, get"]
    TOOLS --> DISP_T["Dispatch tools<br/>run, status"]
    TOOLS --> MON_T["Monitor tools<br/>progress, logs"]
    TOOLS --> REC_T["Recovery tools<br/>retry, cancel"]
    TOOLS --> CONF_T["Config tools<br/>get, set"]
    DISP_T -->|"fork"| WORKER["dispatch-worker.ts<br/>Child process via IPC"]
    WORKER --> PIPELINE["Dispatch/Spec Pipeline"]
```

Pipeline execution from MCP tool invocations runs in a **forked child process**
(`src/mcp/dispatch-worker.ts`) with an IPC message protocol, isolating pipeline
state from the MCP server process. State persistence uses a shared SQLite
database (`.dispatch/dispatch.db`) with separate table domains for MCP server
state (runs, tasks, spec_runs) and orchestrator resume state
(run_state, run_state_tasks).

See [MCP server overview](mcp-server/overview.md),
[MCP tools](mcp-tools/overview.md), and
[state management](mcp-server/state-management.md).

### Provider failover pool

The `ProviderPool` class wraps multiple AI providers behind the standard
`ProviderInstance` interface, providing transparent failover when a provider
is rate-limited. The pool uses lazy boot (providers are started on first use),
session-to-provider remapping (so sessions survive failover), and 60-second
cooldown timers after throttle detection.

The `isThrottleError()` heuristic in `src/providers/errors.ts` classifies
error messages from all four provider SDKs to trigger failover. This pairs with
`withRetry()` as a safety net — retry handles transient errors within a single
provider while the pool handles provider-level exhaustion.

See [pool and failover](provider-system/pool-and-failover.md) and
[error classification](provider-system/error-classification.md).

## Infrastructure

### Runtime requirements

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Node.js | >= 20.12.0 | Runtime (ESM-only, `"type": "module"`) |
| Git | Any | Auto-detection, conventional commits, branch lifecycle |
| OpenCode, Copilot, Claude, or Codex runtime | Varies | AI agent backend (at least one required) |

For Windows-specific setup, prerequisites, and known limitations, see the
[Windows guide](windows.md).

### Dependencies

| Package | Purpose |
|---------|---------|
| `@opencode-ai/sdk` | OpenCode AI agent SDK |
| `@github/copilot-sdk` | GitHub Copilot agent SDK (devDependency, optional-loaded) |
| `@anthropic-ai/claude-agent-sdk` | Claude AI agent SDK |
| `@openai/codex` | Codex AI agent SDK |
| `@octokit/rest` | GitHub REST API client (datasource) |
| `@octokit/auth-oauth-device` | GitHub OAuth device-code flow |
| `@azure/identity` | Azure AD authentication (DeviceCodeCredential) |
| `azure-devops-node-api` | Azure DevOps REST API client (datasource) |
| `@modelcontextprotocol/sdk` | MCP server framework |
| `better-sqlite3` | SQLite database for MCP state and run state |
| `commander` | CLI argument parsing |
| `@inquirer/prompts` | Interactive configuration wizard |
| `chalk` | Terminal color styling (ESM-only) |
| `glob` | File pattern matching |
| `zod` | Schema validation (MCP tool inputs) |

### Build and test

| Command | Purpose |
|---------|---------|
| `npm run build` | Build with tsup |
| `npm test` | Run tests with Vitest (`vitest run`) |
| `npm run test:watch` | Watch mode tests |

The project uses [Vitest](https://vitest.dev/) v4 with ~8,174 lines of test
code across 20+ test files covering configuration, task parsing, formatting,
spec generation, slugification, timeout, all four provider backends, the
planner/executor agents, orchestrator routing, the dispatch pipeline (including
integration tests), branch validation,
gitignore management, worktree management, datasource helpers, and the cleanup
registry. Tests use real filesystem I/O (temp directories via `mkdtemp()`)
rather than mocks for file operations, Vitest `vi.mock()` for module-level
dependency isolation, and fake timers for timeout-related tests. Coverage
thresholds are enforced at 85% lines, 80% branches, 85% functions. See
[testing overview](testing/overview.md).

### Deprecated compatibility layer

The `IssueFetcher` interface and `src/issue-fetchers/` modules are deprecated
shims that delegate to the [datasource](datasource-system/overview.md) layer.
No code outside the deprecated layer imports from these paths. All exports are
marked `@deprecated` and slated for removal. See
[deprecated compatibility](deprecated-compat/overview.md) for migration
guidance and removal safety assessment.

## Component index

### Agent framework

- [Agent system](agent-system/overview.md) — Registry, types, boot lifecycle,
  and extensibility guide
  - [Commit agent](agent-system/commit-agent.md)
  - [Planner agent](agent-system/planner-agent.md)
  - [Executor agent](agent-system/executor-agent.md)
  - [Spec agent](agent-system/spec-agent.md)
  - [Pipeline flow](agent-system/pipeline-flow.md)

### Core pipelines

- [CLI & orchestration](cli-orchestration/overview.md) — Entry point, argument
  parsing, pipeline routing, TUI
  - [CLI reference](cli-orchestration/cli.md)
  - [Configuration](cli-orchestration/configuration.md)
  - [Authentication](cli-orchestration/authentication.md)
  - [Orchestrator](cli-orchestration/orchestrator.md)
  - [Dispatch pipeline](cli-orchestration/dispatch-pipeline.md)
  - [MCP subcommand](cli-orchestration/mcp-subcommand.md)
  - [Terminal UI](cli-orchestration/tui.md)
  - [Integrations](cli-orchestration/integrations.md)
- [Spec generation](spec-generation/overview.md) — Issue-to-spec pipeline
  - [Spec agent](agent-system/spec-agent.md)
  - [Integrations](spec-generation/integrations.md)
- [Planning & dispatch](planning-and-dispatch/overview.md) — Task execution
  engine
  - [Planner agent](agent-system/planner-agent.md)
  - [Executor agent](agent-system/executor-agent.md)
  - [Dispatcher](planning-and-dispatch/dispatcher.md)
  - [Agent types](planning-and-dispatch/agent-types.md)
  - [Git operations](planning-and-dispatch/git.md)
  - [Task context & lifecycle](planning-and-dispatch/task-context-and-lifecycle.md)
  - [Integrations](planning-and-dispatch/integrations.md)

### MCP server & tools

- [MCP server](mcp-server/overview.md) — MCP server architecture, transports,
  and session management
  - [Server transports](mcp-server/server-transports.md)
  - [State management](mcp-server/state-management.md)
  - [Dispatch worker](mcp-server/dispatch-worker.md)
  - [Operations guide](mcp-server/operations-guide.md)
- [MCP tools](mcp-tools/overview.md) — 16 registered tools across 5 groups
  - [Spec tools](mcp-tools/spec-tools.md)
  - [Dispatch tools](mcp-tools/dispatch-tools.md)
  - [Monitor tools](mcp-tools/monitor-tools.md)
  - [Recovery tools](mcp-tools/recovery-tools.md)
  - [Config tools](mcp-tools/config-tools.md)
  - [Config resolution](mcp-tools/config-resolution.md)
  - [Fork-run IPC](mcp-tools/fork-run-ipc.md)

### Dispatch pipeline (detailed)

- [Dispatch pipeline](dispatch-pipeline/pipeline-lifecycle.md) — Full pipeline
  lifecycle and phase details
  - [Worktree lifecycle](dispatch-pipeline/worktree-lifecycle.md)
  - [Commit & PR generation](dispatch-pipeline/commit-and-pr-generation.md)
  - [Feature branch mode](dispatch-pipeline/feature-branch-mode.md)
  - [Task recovery](dispatch-pipeline/task-recovery.md)
  - [Troubleshooting](dispatch-pipeline/troubleshooting.md)
  - [Integrations](dispatch-pipeline/integrations.md)

### Orchestrator internals

- [Orchestrator](orchestrator/overview.md) — Runner coordination and pipeline
  routing internals
  - [Spec pipeline](orchestrator/spec-pipeline.md)
  - [Integrations](orchestrator/integrations.md)

### Extensible backends

- [Datasource system](datasource-system/overview.md) — GitHub, Azure DevOps,
  markdown implementations
  - [GitHub datasource](datasource-system/github-datasource.md)
  - [Azure DevOps datasource](datasource-system/azdevops-datasource.md)
  - [Markdown datasource](datasource-system/markdown-datasource.md)
  - [Datasource helpers](datasource-system/datasource-helpers.md)
  - [Integrations](datasource-system/integrations.md)
  - [Testing](datasource-system/testing.md)
- [Provider system](provider-system/overview.md) — OpenCode, Copilot, Claude,
  and Codex AI runtime backends
  - [OpenCode backend](provider-system/opencode-backend.md)
  - [Copilot backend](provider-system/copilot-backend.md)
  - [Adding a provider](provider-system/adding-a-provider.md)
  - [Pool and failover](provider-system/pool-and-failover.md)
  - [Error classification](provider-system/error-classification.md)
  - [Binary detection](provider-system/binary-detection.md)
  - [Progress reporting](provider-system/progress-reporting.md)
  - [Integrations](provider-system/integrations.md)
- [Provider implementations](provider-implementations/overview.md) — Detailed
  implementation docs for provider backends
  - [Claude backend](provider-implementations/claude-backend.md)
  - [Codex backend](provider-implementations/codex-backend.md)
  - [Authentication & security](provider-implementations/authentication-and-security.md)

### Data layer

- [Task parsing & markdown](task-parsing/overview.md) — Checkbox extraction,
  context filtering, completion marking
  - [Markdown syntax](task-parsing/markdown-syntax.md)
  - [API reference](task-parsing/api-reference.md)
  - [Architecture & concurrency](task-parsing/architecture-and-concurrency.md)
  - [Testing guide](task-parsing/testing-guide.md)

### Shared infrastructure

- [Shared types & interfaces](shared-types/overview.md) — Foundational
  contracts every module depends on
  - [Cleanup registry](shared-types/cleanup.md)
  - [File logger](shared-types/file-logger.md)
  - [Format utilities](shared-types/format.md)
  - [Logger](shared-types/logger.md)
  - [Parser types](shared-types/parser.md)
  - [Provider interface](shared-types/provider.md)
  - [Integrations](shared-types/integrations.md)
- [Shared utilities](shared-utilities/overview.md) — Slugify, timeout, errors,
  guards, concurrency, retry
  - [Concurrency](shared-utilities/concurrency.md)
  - [Retry](shared-utilities/retry.md)
  - [Slugify](shared-utilities/slugify.md)
  - [Timeout](shared-utilities/timeout.md)
  - [Errors](shared-utilities/errors.md)
  - [Guards](shared-utilities/guards.md)
  - [Environment](shared-utilities/environment.md)
  - [Testing](shared-utilities/testing.md)

### Git & worktree management

- [Git & worktree helpers](git-and-worktree/overview.md) — Worktree isolation,
  branch validation, gitignore management, run-state persistence
  - [Branch validation](git-and-worktree/branch-validation.md)
  - [Worktree management](git-and-worktree/worktree-management.md)
  - [Gitignore helper](git-and-worktree/gitignore-helper.md)
  - [Run state](git-and-worktree/run-state.md)
  - [Authentication](git-and-worktree/authentication.md)
  - [Integrations](git-and-worktree/integrations.md)
  - [Testing](git-and-worktree/testing.md)

### Prerequisites & safety

- [Prerequisites & safety](prereqs-and-safety/overview.md) — Pre-flight
  validation, batch confirmation, provider detection
  - [Prerequisite checker](prereqs-and-safety/prereqs.md)
  - [Batch confirmation](prereqs-and-safety/confirm-large-batch.md)
  - [Provider detection](provider-system/binary-detection.md)
  - [Integrations](prereqs-and-safety/integrations.md)

### Testing

- [Testing overview](testing/overview.md) — Vitest framework, strategy,
  coverage map
  - [Config tests](testing/config-tests.md)
  - [Format tests](testing/format-tests.md)
  - [Parser tests](testing/parser-tests.md)
  - [Spec generator tests](testing/spec-generator-tests.md)
  - [Spec agent tests](testing/spec-agent-tests.md)
  - [Spec pipeline tests](testing/spec-pipeline-tests.md)
  - [Provider tests](testing/provider-tests.md)
  - [Planner & executor tests](testing/planner-executor-tests.md)
  - [Commit agent tests](testing/commit-agent-tests.md)
  - [Runner tests](testing/runner-tests.md)
  - [Dispatch pipeline tests](testing/dispatch-pipeline-tests.md)
  - [Datasource tests](testing/datasource-tests.md)
  - [Datasource helpers tests](testing/datasource-helpers-tests.md)
  - [Datasource URL parsing tests](testing/datasource-url-parsing-tests.md)
  - [GitHub datasource tests](testing/github-datasource-tests.md)
  - [Azure DevOps datasource tests](testing/azdevops-datasource-tests.md)
  - [Markdown datasource tests](testing/md-datasource-tests.md)
  - [Auth tests](testing/auth-tests.md)
  - [Database tests](testing/database-tests.md)
  - [MCP state tests](testing/mcp-state-tests.md)
  - [MCP tools tests](testing/mcp-tools-tests.md)
  - [Concurrency tests](testing/concurrency-tests.md)
  - [Run state tests](testing/run-state-tests.md)
  - [Worktree tests](testing/worktree-tests.md)
  - [TUI tests](testing/tui-tests.md)
  - [Manager tests](testing/manager-tests.md)
  - [Helpers & utilities tests](testing/helpers-utilities-tests.md)
  - [Environment, errors & prereqs tests](testing/environment-errors-prereqs-tests.md)
  - [Integration & E2E tests](testing/tests-integration-e2e.md)
  - [Test fixtures](testing/test-fixtures.md)

### Deprecated

- [Deprecated compatibility layer](deprecated-compat/overview.md) —
  `IssueFetcher` shims delegating to datasource system
- [Issue fetching (legacy)](deprecated-compat/overview.md) — Superseded by the
  datasource system
  - [GitHub fetcher](issue-fetching/github-fetcher.md) (deprecated)
  - [Azure DevOps fetcher](issue-fetching/azdevops-fetcher.md) (deprecated)
  - [Adding a fetcher](issue-fetching/adding-a-fetcher.md) (deprecated)
