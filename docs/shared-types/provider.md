# Provider Interface

The provider module (`src/provider.ts`) defines the `ProviderName`,
`ProviderBootOptions`, and `ProviderInstance` types that abstract the AI agent
runtime. This abstraction enables the orchestrator to interact with OpenCode,
GitHub Copilot, Claude, Codex, or any future backend through a uniform
lifecycle contract.

## What it defines

The module exports three types and no runtime code:

| Export | Kind | Description |
|--------|------|-------------|
| `ProviderName` | Type (string literal union) | `"opencode" \| "copilot" \| "claude" \| "codex"` |
| `ProviderBootOptions` | Interface | Options passed when booting a provider |
| `ProviderInstance` | Interface | The lifecycle contract for a booted AI agent |

## Why it exists

Dispatch supports multiple AI agent backends. Without a shared interface, the
[orchestrator](../cli-orchestration/orchestrator.md), [dispatcher](../planning-and-dispatch/dispatcher.md), and [planner](../planning-and-dispatch/planner.md) would each need provider-specific branches.
The `ProviderInstance` interface acts as a **strategy pattern** boundary: the
orchestrator calls `createSession()`, `prompt()`, and [`cleanup()`](./cleanup.md) without
knowing whether the underlying agent is OpenCode, Copilot, or something else.

## Provider lifecycle

For the full provider lifecycle (boot → session → prompt → cleanup), see
[Provider Abstraction Layer](../provider-system/overview.md#lifecycle-boot-session-prompt-cleanup).

## ProviderBootOptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | No | Connect to an already-running server instead of spawning one |
| `cwd` | `string` | No | Working directory for the agent |

### What the `url` field enables

The [`url` option](../cli-orchestration/cli.md) allows providers to connect to a **pre-existing agent server**
rather than spawning a new one. This enables several operational modes:

- **Shared development servers:** Multiple Dispatch runs can share a single
  OpenCode or Copilot server, avoiding repeated startup costs.
- **Remote servers:** The agent server can run on a different machine, enabling
  distributed setups where the Dispatch CLI runs locally but the AI agent runs
  on a GPU-equipped server.
- **Pre-warmed servers:** In CI environments, a long-lived agent server can be
  started once and reused across builds.

**How each provider uses `url`:**

- **OpenCode** (`src/providers/opencode.ts:23-24`): When `url` is provided,
  creates a client via `createOpencodeClient({ baseUrl: url })` instead of
  calling `createOpencode()` which spawns a new server.
- **Copilot** (`src/providers/copilot.ts:20-22`): When `url` is provided,
  passes it as `{ cliUrl: url }` to the `CopilotClient` constructor.

## ProviderInstance interface

### `name: string` (readonly)

Human-readable provider identifier. Used in TUI display and logging. Examples:
`"opencode"`, `"copilot"`.

### `createSession(): Promise<string>`

Creates a new isolated session for a single task. Returns an opaque session
identifier string.

**Session isolation:** How sessions are isolated depends on the backend:

- **OpenCode** (`src/providers/opencode.ts:34-40`): Calls the [OpenCode SDK's](../provider-system/opencode-backend.md)
  `session.create()` API, which creates a new conversation context on the
  OpenCode server. Each session is a separate API-level entity.
- **Copilot** (`src/providers/copilot.ts:32-36`): Calls [`client.createSession()`](../provider-system/copilot-backend.md#session-management)
  which creates a new Copilot CLI session. The session object is stored in a
  local `Map` for later prompt routing. Each session maps to a separate
  conversation on the Copilot backend.

Both implementations create **server-side session state** — these are not merely
namespaced API calls but distinct session entities with their own conversation
history.

### `prompt(sessionId: string, text: string): Promise<string | null>`

Sends a prompt to an existing session and waits for the agent to finish. Returns
the agent's text response, or `null` if no response was produced.

The interface defines no timeout or retry contract. For details on timeout
behavior, crash recovery, and how `null` responses are handled, see
[Provider Abstraction Layer -- Prompt timeouts and cancellation](../provider-system/overview.md#prompt-timeouts-and-cancellation).

### `cleanup(): Promise<void>`

Tears down the provider -- stops servers, releases resources via the
[cleanup registry](./cleanup.md). Documented as safe
to call multiple times (idempotent). For details on cleanup behavior and
in-flight session handling, see
[Provider Abstraction Layer -- Cleanup and in-flight sessions](../provider-system/overview.md#cleanup-and-in-flight-sessions).

## Why ProviderName is a string literal union

`ProviderName` is a compile-time string literal union rather than an enum or
runtime registry key. For the full rationale and trade-offs, see
[Provider Abstraction Layer](../provider-system/overview.md#why-providername-is-a-compile-time-union).

## Adding a new provider backend

For a complete step-by-step guide to implementing and registering a new backend,
see [Adding a New Provider](../provider-system/adding-a-provider.md).

## Source reference

- `src/provider.ts` -- Type definitions (52 lines)
- `src/providers/index.ts` -- Registry (42 lines)
- `src/providers/opencode.ts` -- OpenCode implementation (67 lines)
- `src/providers/copilot.ts` -- Copilot implementation (62 lines)

## Related documentation

- [Overview](./overview.md) -- Shared Interfaces & Utilities layer
- [Cleanup Registry](./cleanup.md) -- Process-level cleanup used by `cleanup()` implementations
- [Integrations Reference](./integrations.md) -- External dependencies of the shared types layer
- [Provider Abstraction & Backends](../provider-system/overview.md) -- Concrete implementations
- [Adding a Provider](../provider-system/adding-a-provider.md) -- Step-by-step
  guide for implementing the `ProviderInstance` interface
- [OpenCode Backend](../provider-system/opencode-backend.md) -- OpenCode-specific setup and behavior
- [Copilot Backend](../provider-system/copilot-backend.md) -- Copilot-specific setup and authentication
- [Planning & Dispatch Pipeline](../planning-and-dispatch/overview.md) -- How the provider is consumed
- [Dispatcher](../planning-and-dispatch/dispatcher.md) -- Concurrent task dispatch using `ProviderInstance`
- [Planner](../planning-and-dispatch/planner.md) -- Plan generation using `ProviderInstance.prompt()`
- [CLI & Orchestration](../cli-orchestration/overview.md) -- Provider boot and cleanup lifecycle
- [Timeout Utility](../shared-utilities/timeout.md) -- Deadline enforcement for provider prompt calls
- [Configuration System](../cli-orchestration/configuration.md) -- `--provider`
  flag persistence and three-tier merge logic
- [Provider Tests](../testing/provider-tests.md) -- Unit test coverage for
  OpenCode and Copilot provider implementations
- [Spec Generation](../spec-generation/overview.md) -- How the spec pipeline
  boots and uses providers
