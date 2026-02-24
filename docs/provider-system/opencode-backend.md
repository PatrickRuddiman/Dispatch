# OpenCode Backend

The OpenCode provider wraps the
[`@opencode-ai/sdk`](https://opencode.ai/docs/sdk/) to conform to the
[`ProviderInstance`](../shared-types/provider.md#providerinstance-interface) interface, enabling dispatch-tasks to use
[OpenCode](https://opencode.ai) as its AI agent runtime.

## Why use OpenCode

OpenCode is an open-source AI coding agent available as a terminal UI, desktop
app, or IDE extension. When used as a dispatch backend, it provides:

- Broad model support (Anthropic, OpenAI, and other LLM providers configured via
  OpenCode's provider system)
- Local server mode with an HTTP API (OpenAPI 3.1 spec)
- Session-based conversation isolation with multi-part responses

## Prerequisites

1. **Install the OpenCode CLI** using one of these methods:

    ```sh
    # Install script (recommended)
    curl -fsSL https://opencode.ai/install | bash

    # npm
    npm install -g opencode-ai

    # Homebrew (macOS/Linux)
    brew install anomalyco/tap/opencode
    ```

2. **Configure an LLM provider** by running `opencode`, executing the `/connect`
   command, and following the prompts. Alternatively, set API keys for your
   preferred provider in your environment. See the
   [OpenCode providers docs](https://opencode.ai/docs/providers/) for details.

3. **Verify installation**:

    ```sh
    opencode --version
    ```

## How the provider works

The boot function in `src/providers/opencode.ts:19-66` supports two modes:

### Spawn a local server (default)

When no `--server-url` is provided, the provider calls `createOpencode()` from
the SDK, which:

1. Starts an OpenCode HTTP server on `127.0.0.1:4096` (the defaults, configurable
   via the `hostname` and `port` options to `createOpencode()`).
2. Returns an object with `{ client, server }` -- the client is pre-connected to
   the spawned server.
3. The `server.close()` handle is stored for cleanup.

The SDK's `createOpencode()` has a default startup timeout of 5000ms. If the
OpenCode binary is not found or the server fails to bind, the promise rejects
and the dispatch run aborts (see
[error recovery](./provider-overview.md#error-recovery-on-boot-failure)).

### Connect to an existing server

When `--server-url` is provided (e.g., `--server-url http://localhost:4096`), the
provider calls `createOpencodeClient({ baseUrl: opts.url })` instead. This
creates a client that connects to an already-running OpenCode server without
spawning a new one.

This mode is useful when:

- You already have `opencode serve` running in another terminal.
- You want to share a single OpenCode server across multiple dispatch runs.
- You are running OpenCode on a remote machine.

The distinction between `createOpencode()` (spawn + connect) and
`createOpencodeClient()` (connect only) is a design choice in the
`@opencode-ai/sdk`. The Copilot SDK uses a single `CopilotClient` class that
handles both cases via an optional `cliUrl` option. The OpenCode SDK separates
these concerns into distinct functions because the spawned server requires
lifecycle management (the `server` handle), while connecting to an existing
server does not.

## Network endpoint

When `createOpencode()` spawns a local server, it binds to:

- **Hostname**: `127.0.0.1` (localhost only, not exposed to the network)
- **Port**: `4096` (default)

These can be configured via options passed to `createOpencode()`:

```ts
const oc = await createOpencode({ hostname: "127.0.0.1", port: 4096 });
```

The dispatch provider does not currently expose these as CLI options -- it uses
the SDK defaults. If you need a different port, start the server manually with
`opencode serve --port <number>` and use `--server-url`.

## Session management

Each call to `createSession()` (`src/providers/opencode.ts:34-39`) invokes
`client.session.create()`, which creates a new session on the OpenCode server.
The SDK returns a `Session` object with an `id` field that is used as the opaque
session identifier.

Sessions created via the SDK are managed server-side by the OpenCode process.
There is no client-side session map (unlike the [Copilot provider](./copilot-backend.md#session-management)). The OpenCode
server tracks all sessions and their message histories internally.

## Response format

The OpenCode SDK returns prompt responses as multi-part arrays of `Part` objects.
Each part has a `type` field -- the provider filters for parts where
`type === "text"` and concatenates their `.text` fields with newlines
(`src/providers/opencode.ts:57-60`).

The multi-part design exists because OpenCode responses can include non-text
content (tool call results, images, structured output). The dispatch provider
only uses the text content, discarding other part types.

If the response contains no text parts, `prompt()` returns `null`.

## Cleanup behavior

The `cleanup()` method (`src/providers/opencode.ts:63-65`) calls `stopServer?.()`
which invokes `oc.server.close()` on the spawned server. When connected to an
existing server (via `--server-url`), `stopServer` is `undefined` and cleanup is
a no-op -- the external server continues running.

## Troubleshooting

### Connection failures

**Symptom**: `bootProvider` throws an error like "ECONNREFUSED" or the startup
timeout expires.

**Diagnosis**:

1. Verify the OpenCode CLI is installed and on PATH: `which opencode`
2. If using `--server-url`, verify the server is running:
   `curl http://localhost:4096/global/health`
3. Check if port 4096 is already in use: `lsof -i :4096`

**Resolution**:

- Install OpenCode if missing (see [Prerequisites](#prerequisites)).
- If the port is in use by another process, either stop that process or start
  OpenCode on a different port with `opencode serve --port <other-port>` and use
  `--server-url http://localhost:<other-port>`.

### Server crash mid-session

If the OpenCode server process crashes while a session is active, all in-flight
`client.session.prompt()` calls will fail with connection errors. The
`@opencode-ai/sdk` does **not** provide automatic recovery or reconnection. The
dispatch task that was in progress will fail with an error, and the [orchestrator](../cli-orchestration/orchestrator.md)
will record it as a failed task.

**To recover**: Restart the dispatch run. The [orchestrator](../cli-orchestration/orchestrator.md) will re-parse the task
files and only dispatch unchecked (incomplete) tasks.

### Monitoring sessions

To inspect active sessions on a running OpenCode server, use the server's HTTP
API:

```sh
# List all sessions
curl http://localhost:4096/session

# Get session details
curl http://localhost:4096/session/<session-id>

# Check server health
curl http://localhost:4096/global/health
```

The OpenCode server also exposes a Server-Sent Events stream at
`GET /global/event` for real-time session activity monitoring. See the
[OpenCode server docs](https://opencode.ai/docs/server/) for the full API
reference.

## External references

- [OpenCode SDK reference](https://opencode.ai/docs/sdk/) -- full SDK API
  documentation including all session and prompt methods
- [OpenCode server reference](https://opencode.ai/docs/server/) -- server HTTP
  API, authentication, and configuration
- [OpenCode troubleshooting](https://opencode.ai/docs/troubleshooting/) --
  general troubleshooting guide

## Related documentation

- [Provider Overview](./provider-overview.md) -- how the provider abstraction
  layer works
- [GitHub Copilot Backend](./copilot-backend.md) -- the alternative provider
  backend
- [Adding a New Provider](./adding-a-provider.md) -- guide for implementing new
  backends
- [Provider Interface](../shared-types/provider.md) -- `ProviderInstance` type
  definition and lifecycle contract
- [Dispatcher](../planning-and-dispatch/dispatcher.md) -- how the dispatcher
  creates sessions and sends prompts
- [Planner](../planning-and-dispatch/planner.md) -- how the planner creates
  sessions for read-only exploration
- [CLI Options](../cli-orchestration/cli.md) -- `--provider opencode` and
  `--server-url` flags
