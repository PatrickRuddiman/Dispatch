# Planner Agent

The planner agent (`src/agents/planner.ts`) runs a read-only AI session that
explores the codebase and produces a detailed execution plan for a task. The
plan is then passed to the [dispatcher](./dispatcher.md) as context-rich
instructions for the executor agent.

## What it does

The planner receives a [`Task`](../task-parsing/api-reference.md#task), optional filtered file context, an optional
working directory override, and an optional `worktreeRoot` path for
[worktree isolation](#worktree-isolation). It creates an
isolated [provider session](../provider-system/overview.md#session-isolation-model), sends a planning prompt, and returns the agent's
response as a `PlanResult`. The plan text becomes the executor agent's primary
instructions.

## Why it exists

### The two-phase architecture

The planner exists to solve a fundamental problem with AI-driven code changes:
**an agent that writes code needs context about the codebase, but gathering that
context and executing changes in a single pass often leads to poor results**.

The two-phase planner-then-executor pattern separates concerns:

1. **Planner** (read-only): Explores the codebase, reads relevant files,
   searches for symbols, and reasons about the task. Produces a detailed,
   step-by-step execution plan with specific file paths, code patterns, and
   implementation guidance.

2. **Executor** (write): Receives the plan verbatim and follows it to make
   precise edits. The executor does not need to explore -- it has a blueprint.

This separation improves quality because:

- The planner can take its time exploring without the pressure to produce code
- The executor receives pre-digested context rather than raw codebase data
- Failed plans can be detected before any files are modified

### When to use `--no-plan`

The [`--no-plan`](../cli-orchestration/cli.md) CLI flag skips the planning phase entirely, sending tasks
directly to the executor with a simple prompt. Use `--no-plan` when:

- Tasks are simple and self-explanatory (e.g., "add a comment to function X")
- You want faster execution and are willing to trade plan quality
- You are debugging the executor and want to isolate its behavior
- The provider has limited context window and you want to avoid doubling
  token usage (planning + execution each consume a full session)

Avoid `--no-plan` when:

- Tasks require understanding multiple files or complex dependencies
- Tasks reference architectural patterns that the agent needs to discover
- The markdown file contains implementation guidance in non-task prose that
  the planner would incorporate into its plan

## How it works

### Session isolation

Like the [dispatcher](./dispatcher.md#session-isolation), the planner creates a
fresh session via `provider.createSession()` for each task. The planning session
is completely separate from the execution session — the planner's conversation
history does not carry over to the executor. The plan text is the only channel
of communication between the two phases.

### File context filtering

When the [orchestrator](../cli-orchestration/orchestrator.md) calls `planTask()`, it passes `fileContext` -- a filtered
view of the markdown file produced by [`buildTaskContext()`](../task-parsing/api-reference.md#buildtaskcontext) in `src/parser.ts`.
This filtered context:

- **Keeps** all non-task lines (headings, prose, notes, blank lines, checked
  tasks)
- **Keeps** the specific unchecked task line being planned
- **Removes** all other unchecked `[ ]` task lines

This filtering exists to prevent the planner from being confused by sibling
tasks that belong to different agents or execution batches.

**How does the planner know about task dependencies if sibling tasks are
removed?**

It does not. The filtering deliberately hides sibling unchecked tasks from the
planner because showing them would risk the planner (or downstream executor)
attempting to work on multiple tasks simultaneously. If tasks have dependencies
on each other, this must be managed externally:

- Order dependent tasks sequentially in separate batch runs
- Express dependencies as prose in the markdown file (prose lines are preserved
  in the filtered context)
- Use checked `[x]` tasks as documentation of completed prerequisites (checked
  tasks are preserved)

The design rationale (documented in `src/parser.ts:36-44`) is that preventing
cross-task confusion is more valuable than preserving inter-task visibility.

### Planner prompt structure

The `buildPlannerPrompt()` function assembles a prompt with these sections:

1. **Role**: "You are a planning agent" -- establishes the agent's identity
2. **Task metadata**: Working directory, source file, task text with line number
3. **Task File Contents** (when `fileContext` is provided): The filtered markdown
   embedded in a fenced code block, with instructions to review non-task prose
   for implementation details
4. **Instructions**: A five-step process:
    1. Explore the codebase (read files, search symbols)
    2. Review task file contents for implementation details
    3. Identify files to create or modify
    4. Research the implementation (patterns, imports, types, APIs)
    5. **DO NOT make any changes** -- planning only
5. **Output Format**: Instructions to produce a system prompt for the executor
   agent, including context, files to modify, step-by-step implementation, and
   constraints

### Read-only enforcement

**What actually prevents the planner agent from making changes to the
filesystem?**

**Nothing at the provider level.** The planner's read-only behavior is enforced
solely through prompt instructions:

> "DO NOT make any changes -- you are only planning, not executing."

The provider backends ([OpenCode](../provider-system/opencode-backend.md), [Copilot](../provider-system/copilot-backend.md)) do not restrict the planner session's
tool access or filesystem permissions. The planner agent has the same
capabilities as the executor agent. If the AI model ignores the prompt
instruction, it could make filesystem changes during the planning phase.

**Why prompt-only enforcement?**

Neither the OpenCode SDK nor the Copilot SDK expose a mechanism to create
sessions with restricted tool access (e.g., read-only filesystem access). The
[`ProviderInstance`](../shared-types/provider.md#providerinstance-interface) interface (`src/providers/interface.ts`) defines only `createSession()`
and `prompt()` -- there is no parameter for capability restrictions.

Adding provider-level enforcement would require:

1. Extending the `ProviderInstance` interface with a session options parameter
   (e.g., `createSession({ readOnly: true })`)
2. Implementing tool/permission scoping in each provider backend
3. Verifying that the underlying SDKs support such restrictions

Until the provider SDKs support capability restrictions, prompt-based
enforcement is the only available mechanism. In practice, modern AI models
follow these instructions reliably, but it is not a hard guarantee.

### Plan validation

**If the planner produces a very long or poorly formatted plan, does the
executor have any validation or truncation mechanism?**

No. The plan text returned by `planTask()` is passed directly to
`buildPlannedPrompt()` in `src/dispatcher.ts:30` with no size check, format
validation, or truncation. The combined prompt (task metadata + plan text) is
sent to the provider as-is.

If the plan is excessively long, it may exceed the provider's context window.
If it is poorly formatted, the executor may misinterpret the instructions.
Neither condition is detected or handled.

**Mitigation strategies**:

- The planner prompt explicitly requests a structured output format (context,
  files, steps, constraints), which encourages concise output
- If plan quality is a recurring issue, add a size check in `dispatchTask()`
  before calling `prompt()`, or add a post-processing step that validates the
  plan structure
- Consider configuring the planner prompt to set explicit length constraints
  (e.g., "limit your response to 2000 words")

### Worktree isolation

When the optional `worktreeRoot` parameter is passed to `plan()`
(`src/agents/planner.ts:47`), the `buildPlannerPrompt()` function appends a
"Worktree Isolation" section (`src/agents/planner.ts:127-141`) that instructs
the planner agent to confine all file operations within the specified worktree
directory.

The isolation instructions tell the agent:

- It is operating inside a git worktree
- It must **not** read, write, or execute commands outside the worktree root
- It must **not** reference or modify files in the main repository or other
  worktrees
- All relative paths must resolve within the worktree root

**When is `worktreeRoot` provided?** The [orchestrator](../cli-orchestration/orchestrator.md)
passes `worktreeRoot` when tasks are dispatched into isolated git worktrees
(created for `(I)` mode tasks). The `cwdOverride` parameter
(`src/agents/planner.ts:66`) is also used in conjunction to set the working
directory to the worktree path instead of the boot-time `cwd`.

**Enforcement is prompt-only**, consistent with the
[read-only enforcement](#read-only-enforcement) and the
[dispatcher's worktree isolation](./dispatcher.md#worktree-isolation). The
provider backends do not support filesystem sandboxing.

### File logger integration

Both the planner and executor agents write structured log entries to per-issue
log files via `fileLoggerStorage.getStore()` — a Node.js
[`AsyncLocalStorage<FileLogger>`](../shared-types/file-logger.md)
instance exported from `src/helpers/file-logger.ts`.

The `AsyncLocalStorage` propagation model works as follows: the dispatch
pipeline calls `fileLoggerStorage.run(logger, callback)` at the start of
each issue's processing, which binds a `FileLogger` instance to the async
context. All code executing within that callback — including nested `await`
calls into the planner and executor — can retrieve the logger via
`fileLoggerStorage.getStore()` without any explicit parameter threading.

The planner logs these events:

| Method | When | Content |
|--------|------|---------|
| `prompt("planner", ...)` | Before provider call | The full planner prompt |
| `response("planner", ...)` | After provider responds | The plan text (if non-null) |
| `agentEvent("planner", "completed", ...)` | On success | Elapsed time in ms |
| `error(...)` | On exception | Error message with stack trace |

Log files are written to `{CWD}/.dispatch/logs/issue-{id}.log` in plain text
format with ISO 8601 timestamps. Prompts and responses are stored verbatim
(delimited by `─` separators), enabling post-mortem replay. To correlate
planner and executor log entries for the same task, look for sequential
`[AGENT] [planner] completed` and `[AGENT] [executor] started` entries within
the same log file.

## Interfaces

### Return type: `AgentResult<PlannerData>`

The `plan()` method returns
[`AgentResult<PlannerData>`](./agent-types.md#agentresultt) — a discriminated
union on `success`. When `success` is `true`, `data.prompt` contains the
execution plan text. When `success` is `false`, `data` is `null` and `error`
contains a human-readable message.

| Field | Type (success) | Type (failure) | Description |
|-------|---------------|----------------|-------------|
| `success` | `true` | `false` | Discriminant |
| `data` | `PlannerData` | `null` | Payload |
| `data.prompt` | `string` | — | The system prompt for the executor |
| `error` | `never` | `string?` | Error message |
| `durationMs` | `number?` | `number?` | Wall-clock elapsed time |

An empty or whitespace-only plan is treated as a failure with the message
"Planner returned empty plan."

### `PlannerAgent`

The booted planner agent interface:

| Method | Signature | Description |
|--------|-----------|-------------|
| `plan` | `(task: Task, fileContext?: string, cwd?: string, worktreeRoot?: string) => Promise<AgentResult<PlannerData>>` | Plan a single task |
| `cleanup` | `() => Promise<void>` | No-op — provider lifecycle is external |
| `name` | `string` | Always `"planner"` |

## Error handling

All errors from `createSession()` or `prompt()` are caught and returned as a
failed `AgentResult`. The error does not propagate. The orchestrator detects a
failed plan and marks the task as failed without proceeding to the execution
phase.

This means a planning failure is a hard stop for that task — there is no
fallback to unplanned execution. However, the orchestrator may retry the
planner up to `--plan-retries` times, falling back to `--retries` and then the
shared default of 3 on timeout errors only. Non-timeout planner failures still
fail immediately. See
[timeout and retry](../cli-orchestration/orchestrator.md#the-filetimeout)
in the orchestrator documentation.

## Related documentation

- [Pipeline Overview](./overview.md) -- Full pipeline flow and state machine
- [Dispatcher](./dispatcher.md) -- How plans are consumed by the executor
- [Task Context & Lifecycle](./task-context-and-lifecycle.md) -- How
  `buildTaskContext()` produces filtered context
- [Provider Abstraction](../provider-system/overview.md) -- The
  `ProviderInstance` interface and session isolation model
- [Orchestrator](../cli-orchestration/orchestrator.md) -- How the orchestrator
  calls `planTask()` and handles plan failures
- [CLI Options](../cli-orchestration/cli.md) -- The `--no-plan` flag and other
  CLI arguments
- [Markdown Syntax Reference](../task-parsing/markdown-syntax.md) -- Accepted
  checkbox formats consumed by the planner's context
- [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md) --
  File I/O safety and concurrency analysis relevant to context filtering
- [Timeout Utility](../shared-utilities/timeout.md) -- Plan timeout mechanism
  wrapping `planTask()` calls in the orchestrator
- [Git Worktree Helpers](../git-and-worktree/overview.md) -- Worktree
  isolation model that determines when `worktreeRoot` is passed
- [Agent Types](./agent-types.md) -- `AgentResult<T>`, `AgentErrorCode`, and
  `PlannerData` type definitions
- [Spec Agent](../spec-generation/spec-agent.md) -- The spec generation agent
  that shares the two-phase (read-only exploration then write) architecture
- [Testing Overview](../testing/overview.md) -- Project-wide test suite
- [Planner & Executor Tests](../testing/planner-executor-tests.md) -- The
  planner test suite with 20 tests covering boot, planning, context, worktree
  isolation, and error handling
- [File Logger](../shared-types/file-logger.md) -- Per-issue structured
  logging via `AsyncLocalStorage` that the planner uses for prompt/response logging
- [Executor Agent](./executor.md) -- The downstream executor that receives
  the planner's output as its primary instructions
