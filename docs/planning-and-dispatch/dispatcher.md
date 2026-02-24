# Dispatcher

The dispatcher (`src/dispatcher.ts`) sends individual tasks to an AI agent
provider in isolated sessions. It is the execution phase of the pipeline,
responsible for constructing the prompt, invoking the provider, and returning
a structured result.

## What it does

The dispatcher receives a [`Task`](../task-parsing/api-reference.md#task) object and an optional execution plan (produced
by the [planner](./planner.md)), constructs an appropriate prompt, creates a
fresh [provider session](../provider-system/provider-overview.md#session-isolation-model), sends the prompt, and returns a `DispatchResult`
indicating success or failure.

## Why it exists

The dispatcher exists to enforce **context isolation**: each task gets its own
session so that conversation history from one task cannot influence another. It
also serves as the boundary between the Dispatch pipeline logic and the
[provider abstraction](../provider-system/provider-overview.md), keeping prompt construction separate from provider
protocol details.

## How it works

### Session isolation

Every call to `dispatchTask()` begins by calling `instance.createSession()`,
which returns an opaque session identifier. This session is used for exactly one
`prompt()` call and is never reused. See
[Provider session isolation](../provider-system/provider-overview.md#session-isolation-model)
for how each backend implements session boundaries.

**What guarantees does `createSession()` offer?**

Session isolation is implemented by the concrete provider backends:

- **OpenCode** (`src/providers/opencode.ts`): Calls `client.session.create()`
  on the OpenCode SDK, which creates a brand-new server-side session with its
  own conversation history, tool state, and context window. Each session ID maps
  to an independent conversation on the OpenCode server.

- **Copilot** (`src/providers/copilot.ts`): Calls `client.createSession()` on
  the Copilot SDK, which returns a new `CopilotSession` object tracked in a
  local `Map`. Each session is an independent interaction with the Copilot
  backend.

In both cases, the provider SDK manages the session boundary. There is no
shared mutable state between sessions at the Dispatch application level.
The guarantee is: **one session = one task = one conversation**. Context from
task A's session cannot leak into task B's session because they are separate
server-side objects.

### Prompt construction

The dispatcher builds one of two prompt variants depending on whether a plan
is available:

#### Simple prompt (`buildPrompt`)

Used when `--no-plan` is active or when no plan is provided. Contains:

- Working directory path
- Source file path and line number
- [Task](../task-parsing/api-reference.md#task) text
- Constraints: complete only this task, make minimal changes, do not commit

#### Planned prompt (`buildPlannedPrompt`)

Used when the [planner](./planner.md) has produced an execution plan. Contains
everything in the simple prompt, plus:

- The full plan text in an "Execution Plan" section
- An "Executor Constraints" section instructing the agent to follow the plan
  precisely

The plan text from `planTask()` is embedded verbatim -- there is no truncation
or validation of plan size before it reaches the executor. See
[Maximum prompt size](#maximum-prompt-size) for implications.

### Success verification

**How does the system verify the agent actually completed the task?**

It does not verify task completion at the content level. When `dispatchTask`
returns `{ success: true }`, it means only that:

1. `createSession()` did not throw
2. `instance.prompt()` returned a non-null string

The dispatcher does **not** inspect the agent's response content. It does not
check whether the agent said "Task complete," whether files were actually
modified, or whether the changes are correct. The `success: true` result
indicates the agent responded, not that the task was correctly implemented.

**Why this design?** Verifying task correctness would require understanding the
task semantics, running tests, or diffing expected outcomes -- all of which are
beyond the scope of a single dispatch call. The current design treats the AI
agent as a best-effort executor. If verification is needed, it should be added
at the orchestrator level (e.g., running tests after each task) rather than
inside the dispatcher.

After a successful dispatch, the [orchestrator](../cli-orchestration/orchestrator.md) (`src/orchestrator.ts:144-146`)
calls [`markTaskComplete()`](../task-parsing/api-reference.md#marktaskcomplete) and [`commitTask()`](./git.md#the-committask-function) unconditionally, trusting the
agent's response as an indication of completion.

### Error handling

All errors thrown during session creation or prompting are caught and returned
as `{ success: false, error: message }` in the `DispatchResult`. The error
does not propagate -- the [orchestrator](../cli-orchestration/orchestrator.md) receives a structured result and marks
the task as failed in the [TUI](../cli-orchestration/tui.md).

If the provider's `prompt()` call returns `null` (indicating no response was
generated), this is treated as a failure with the message "No response from
agent."

## Timeout and cancellation

**What happens if the provider's `prompt()` call times out or hangs
indefinitely?**

The dispatcher itself has **no timeout or cancellation mechanism**. The
`await instance.prompt(sessionId, prompt)` call will block indefinitely if the
provider does not respond.

Timeout behavior depends entirely on the provider backend:

- **OpenCode**: The `@opencode-ai/sdk` HTTP client may have default request
  timeouts, but these are not configured by Dispatch. A hung OpenCode server
  will cause the dispatch to hang. See [OpenCode prompt timeouts](../provider-system/provider-overview.md#prompt-timeouts-and-cancellation).

- **Copilot**: The `session.sendAndWait()` call blocks until the Copilot
  backend responds. There is no explicit timeout in the Copilot provider
  implementation. See [Copilot prompt timeouts](../provider-system/provider-overview.md#prompt-timeouts-and-cancellation).

**Mitigation**: If a task hangs, the only recourse is to kill the Dispatch
process (Ctrl+C / SIGINT). There is no per-task timeout configuration.
This is a known limitation. To add timeout support, wrap the `prompt()` call
with `Promise.race()` against a timer, or use the `AbortSignal` option
supported by Node.js `fetch` if the provider SDK exposes it.

## Maximum prompt size

**Could the planner's output combined with the task file context exceed the
provider's context window?**

Yes. There is no size validation or truncation at any point in the prompt
construction chain:

1. [`buildTaskContext()`](../task-parsing/api-reference.md#buildtaskcontext) can produce arbitrarily large output if the markdown
   file is large
2. The planner agent's response (the execution plan) has no size limit
3. `buildPlannedPrompt()` concatenates the plan verbatim into the prompt
4. The combined prompt is sent directly to `instance.prompt()`

The practical limits depend on the provider:

- **OpenCode**: Context window is determined by the underlying model configured
  in the OpenCode server (e.g., Claude models typically support 100K-200K
  tokens).
- **Copilot**: Context window depends on the GitHub Copilot backend model.

If the prompt exceeds the provider's context window, the behavior is
provider-specific -- it may truncate, return an error, or produce degraded
output. Dispatch does not detect or handle this condition.

**Mitigation**: Keep task files focused and concise. If planner output is
consistently too large, consider adding a size check in `dispatchTask()` before
calling `prompt()`, or configuring the planner prompt to request concise output.

## Interfaces

### `DispatchResult`

Returned by `dispatchTask()`:

| Field | Type | Description |
|-------|------|-------------|
| `task` | [`Task`](../task-parsing/api-reference.md#task) | The task that was dispatched |
| `success` | `boolean` | Whether the agent produced a non-null response |
| `error` | `string?` | Error message if `success` is `false` |

## Related documentation

- [Pipeline Overview](./overview.md) -- Full pipeline flow and state machine
- [Planner Agent](./planner.md) -- How plans are generated
- [Git Operations](./git.md) -- What happens after successful dispatch
- [Task Context & Lifecycle](./task-context-and-lifecycle.md) -- How tasks are
  parsed and marked complete
- [Provider Abstraction](../provider-system/provider-overview.md) -- The `ProviderInstance`
  interface and backend implementations
- [Orchestrator](../cli-orchestration/orchestrator.md) -- How the orchestrator
  coordinates dispatch within the batch loop
