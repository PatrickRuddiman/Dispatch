# Planner Agent

The planner agent (`src/planner.ts`) runs a read-only AI session that explores
the codebase and produces a detailed execution plan for a task. The plan is
then passed to the [dispatcher](./dispatcher.md) as context-rich instructions
for the executor agent.

## What it does

The planner receives a [`Task`](../task-parsing/api-reference.md#task) and optional filtered file context, creates an
isolated [provider session](../provider-system/provider-overview.md#session-isolation-model), sends a planning prompt, and returns the agent's
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

The `--no-plan` CLI flag skips the planning phase entirely, sending tasks
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
fresh session via `instance.createSession()` for each task. The planning session
is completely separate from the execution session -- the planner's conversation
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
`ProviderInstance` interface (`src/provider.ts`) defines only `createSession()`
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

## Interfaces

### `PlanResult`

Returned by `planTask()`:

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | The execution plan (system prompt for the executor) |
| `success` | `boolean` | Whether planning succeeded |
| `error` | `string?` | Error message if `success` is `false` |

An empty or whitespace-only plan is treated as a failure with the message
"Planner returned empty plan."

## Error handling

All errors from `createSession()` or `prompt()` are caught and returned as a
failed `PlanResult`. The error does not propagate. The orchestrator
(`src/orchestrator.ts:129-135`) detects a failed plan and marks the task as
failed without proceeding to the execution phase.

This means a planning failure is a hard stop for that task -- there is no retry
or fallback to unplanned execution.

## Related documentation

- [Pipeline Overview](./overview.md) -- Full pipeline flow and state machine
- [Dispatcher](./dispatcher.md) -- How plans are consumed by the executor
- [Task Context & Lifecycle](./task-context-and-lifecycle.md) -- How
  `buildTaskContext()` produces filtered context
- [Provider Abstraction](../provider-system/provider-overview.md) -- The
  `ProviderInstance` interface and session isolation model
- [Orchestrator](../cli-orchestration/orchestrator.md) -- How the orchestrator
  calls `planTask()` and handles plan failures
- [CLI Options](../cli-orchestration/cli.md) -- The `--no-plan` flag and other
  CLI arguments
- [Architecture & Concurrency](../task-parsing/architecture-and-concurrency.md) --
  File I/O safety and concurrency analysis relevant to context filtering
