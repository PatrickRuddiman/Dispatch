# GitHub Copilot Backend

The Copilot provider wraps the
[`@github/copilot-sdk`](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started)
to conform to the [`ProviderInstance`](../shared-types/provider.md#providerinstance-interface) interface, enabling dispatch to use
GitHub Copilot as its AI agent runtime.

## Why use Copilot

GitHub Copilot integrates with your existing GitHub authentication and
subscription. If your team already uses Copilot, this provider lets dispatch
leverage that access without setting up a separate LLM provider.

## Prerequisites

1. **An active GitHub Copilot subscription** (Free, Pro, Pro+, Business, or
   Enterprise).

2. **Install the Copilot CLI**:

    ```sh
    # npm (all platforms, requires Node.js 22+)
    npm install -g @github/copilot

    # Homebrew (macOS/Linux)
    brew install copilot-cli

    # WinGet (Windows)
    winget install GitHub.Copilot

    # Install script (macOS/Linux)
    curl -fsSL https://gh.io/copilot-install | bash
    ```

3. **Authenticate** by launching the Copilot CLI and following the `/login`
   prompt, or by setting a token environment variable (see
   [Authentication](#authentication) below).

4. **Verify installation**:

    ```sh
    copilot --version
    ```

The `copilot` binary must be on your `PATH` for the SDK to discover it. If it is
installed in a non-standard location, set the `COPILOT_CLI_PATH` environment
variable to the full path of the `copilot` executable.

## Authentication

The Copilot provider supports multiple authentication methods, checked in the
following precedence order (as documented in `src/providers/copilot.ts:8-10`):

| Priority | Method | Description |
|----------|--------|-------------|
| 1 | Logged-in CLI user | The default. Authenticate via `copilot /login` (uses device flow or browser-based OAuth). |
| 2 | `COPILOT_GITHUB_TOKEN` | Environment variable with a GitHub personal access token. |
| 3 | `GH_TOKEN` | Standard GitHub CLI token environment variable. |
| 4 | `GITHUB_TOKEN` | Commonly used in CI environments. |

When using a personal access token, create a
[fine-grained token](https://github.com/settings/personal-access-tokens/new)
with the **Copilot Requests** permission enabled.

### Bring Your Own Key (BYOK)

The `@github/copilot-sdk` also supports a Bring Your Own Key mode, where you
supply your own API key for a supported LLM provider instead of routing through
GitHub's Copilot backend. This is configured at the SDK/CLI level -- see the
[Copilot SDK documentation](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started)
for BYOK setup. The dispatch provider does not add any BYOK-specific logic; it
passes through whatever authentication the `CopilotClient` resolves.

### Rotating tokens

Token rotation depends on the authentication method:

- **CLI login**: The Copilot CLI manages token refresh automatically through
  GitHub's OAuth flow. No manual rotation is needed.
- **Environment variables**: Replace the token value in your environment. There
  is no graceful rotation mechanism in the SDK -- if you change the token while
  a dispatch run is in progress, active sessions continue using the old token.
  New sessions will use the updated value.

## How the provider works

The boot function in `src/providers/copilot.ts:20-33` creates a `CopilotClient`
and calls `client.start()` to launch (or connect to) a Copilot CLI server.

### Architecture: SDK to CLI via JSON-RPC

The `@github/copilot-sdk` does not communicate directly with GitHub's API. The
architecture is:

```
dispatch → CopilotClient (SDK) → JSON-RPC → Copilot CLI (server mode) → GitHub API
```

When `client.start()` is called:

1. The SDK discovers the `copilot` binary (or uses `COPILOT_CLI_PATH`).
2. It spawns the Copilot CLI in **server mode** as a child process.
3. Communication between the SDK and the CLI server uses JSON-RPC over the
   process's stdio or a local socket.
4. The CLI server handles authentication, model routing, and API communication
   with GitHub's backend.

This means `client.start()` allocates **system resources**: a child process for
the Copilot CLI server. The corresponding `client.stop()` terminates this child
process. This is why cleanup calls `client.stop()` -- without it, the CLI server
process would be orphaned.

### Connection modes

- **Default (no URL)**: `new CopilotClient()` discovers and starts the Copilot
  CLI automatically.
- **Explicit URL**: When `--server-url` is provided (or persisted via the
  [Configuration System](../cli-orchestration/configuration.md#the-serverurl-config-option)),
  the client is constructed with `{ cliUrl: opts.url }`, connecting to an
  already-running Copilot CLI server at that address.

Unlike the [OpenCode provider](./opencode-backend.md) (which uses separate `createOpencode()` vs
`createOpencodeClient()` functions), the Copilot SDK uses a single
`CopilotClient` class that handles both cases through the optional `cliUrl`
constructor option.

### Synchronous prompt model

The Copilot provider uses a **synchronous blocking** prompt model. When
`session.sendAndWait({ prompt: text })` is called, it blocks until the Copilot
backend produces a complete response. There is no SSE streaming or event-based
coordination -- the entire request-response cycle happens within a single call.

This contrasts with the [OpenCode provider](./opencode-backend.md#asynchronous-prompt-model),
which uses an async `promptAsync` + SSE pattern to avoid HTTP timeout issues.
The Copilot SDK's `sendAndWait()` handles timeouts internally via the JSON-RPC
layer, so the HTTP timeout problem that motivated the OpenCode async approach
does not apply here.

## Session management

The Copilot provider maintains an in-memory `Map<string, CopilotSession>` at
`src/providers/copilot.ts:36` to track live sessions. This client-side map is
necessary because the `CopilotClient.createSession()` returns a `CopilotSession`
object that must be retained for subsequent `sendAndWait()` calls -- unlike the
OpenCode SDK where sessions are server-managed and referenced by ID.

When `createSession()` is called:

1. `client.createSession()` is invoked.
2. The returned `CopilotSession` is stored in the map keyed by `session.sessionId`.
3. The `sessionId` string is returned to the caller.

When `prompt()` is called:

1. The session is looked up in the map. If not found, an error is thrown.
2. `session.sendAndWait({ prompt: text })` is called, which blocks until the
   agent produces a response.
3. The response event is examined. If `event` is null or `event.data?.content` is
   undefined, `null` is returned.

## Handling malformed responses

The `prompt()` implementation uses defensive null-checking at
`src/providers/copilot.ts:65-69`:

```ts
if (!event) return null;
const result = event.data?.content ?? null;
```

If `sendAndWait()` returns an event with missing or malformed `data`, the
optional chaining (`event.data?.content`) safely evaluates to `undefined`, and
the nullish coalescing (`?? null`) converts it to `null`. This prevents the
provider from throwing on unexpected SDK behavior and instead signals "no
response" to the [orchestrator](../cli-orchestration/orchestrator.md), which records the task as failed with "No response
from agent" (`src/dispatcher.ts:39`). See the [Dispatcher](../planning-and-dispatch/dispatcher.md) for details on how
failed responses are handled.

Note: this null-checking path handles both truly null events (no response) and
events where `data.content` is an empty string. An empty string is falsy in
JavaScript but will pass through `?? null` because nullish coalescing only
triggers on `null` or `undefined`, not on `""`. So an empty-string response
would be returned as `""` (truthy for the dispatcher's `response === null`
check), which would be treated as a successful dispatch.

## Cleanup behavior

The `cleanup()` method (`src/providers/copilot.ts:78-88`):

1. Iterates all sessions in the map and calls `session.destroy()` on each,
   swallowing any errors with `.catch(() => {})`.
2. Waits for all destroy operations with `Promise.all()`.
3. Clears the session map.
4. Calls `client.stop()` to shut down the Copilot CLI server process, also
   swallowing errors.

The error swallowing is intentional -- during cleanup, some sessions may have
already been destroyed (e.g., by the server shutting down), and the provider
should not fail on double-destroy attempts.

### Missing idempotency guard

Unlike the [OpenCode provider](./opencode-backend.md#idempotency-guard), the
Copilot provider does **not** have a `cleaned` boolean flag to prevent
double-cleanup. If `cleanup()` is called twice:

1. The second call iterates an empty session map (cleared on the first call) --
   this is harmless.
2. `client.stop()` is called a second time. Whether this causes an error depends
   on the SDK's internal behavior; the `.catch(() => {})` swallows any error
   regardless.

In practice, this is not a bug because the error swallowing makes double-cleanup
safe. However, it is a minor inconsistency with the OpenCode provider's
defensive style. See the
[provider overview](./provider-overview.md#cleanup-idempotency-comparison) for
a side-by-side comparison.

## Rate limits and quotas

GitHub Copilot applies rate limits to ensure fair access across all users. The
rate limits are temporary and apply per-user. If dispatch encounters a rate
limit during a prompt call, the `sendAndWait()` promise will reject with an error
that propagates as a failed task.

**Key points from the
[Copilot rate limits documentation](https://docs.github.com/en/copilot/concepts/rate-limits)**:

- Rate limits are temporary. Waiting and retrying usually resolves the issue.
- Preview models may have stricter limits.
- High concurrency ([`--concurrency > 1`](../cli-orchestration/cli.md)) increases the likelihood of hitting
  limits. See the [concurrency model](../planning-and-dispatch/overview.md#concurrency-model) for details.

**Monitoring usage**: Copilot usage metrics are available through your GitHub
organization settings at `Settings > Copilot > Usage`. Individual usage can be
checked at `Settings > Copilot`.

There is no built-in retry mechanism in the dispatch provider for rate-limited
requests. If rate limiting is a concern, reduce the `--concurrency` value or
stagger dispatch runs.

## Troubleshooting

### Copilot CLI not found

**Symptom**: `bootProvider` throws an error indicating the `copilot` binary
cannot be found.

**Resolution**:

1. Verify installation: `which copilot` or `copilot --version`.
2. If installed in a non-standard location, set `COPILOT_CLI_PATH` to the full
   path.
3. Ensure `PATH` includes the directory containing the Copilot CLI binary.

### Authentication failures

**Symptom**: Session creation or prompts fail with authentication errors.

**Resolution**:

1. Run `copilot` interactively and use `/login` to re-authenticate.
2. If using a token, verify it has the **Copilot Requests** permission.
3. Check that `GH_TOKEN`/`GITHUB_TOKEN` is not set to a token that lacks Copilot
   permissions (these take precedence if `COPILOT_GITHUB_TOKEN` is not set).

### Server startup failures

**Symptom**: `client.start()` hangs or throws.

**Resolution**:

1. Check if another Copilot CLI server is already running on the expected port.
2. Try starting the Copilot CLI manually to see any error output.
3. If using `--server-url`, verify the server is reachable:
   `curl <server-url>/health` (actual health endpoint depends on the SDK
   version).

### COPILOT_CLI_PATH

The `COPILOT_CLI_PATH` environment variable overrides the default path where the
SDK looks for the `copilot` binary. Set this when:

- The Copilot CLI is installed in a custom location.
- You have multiple versions installed and need to specify which one to use.
- Your CI/CD environment does not have `copilot` on the standard `PATH`.

```sh
export COPILOT_CLI_PATH=/opt/copilot/bin/copilot
dispatch "tasks/**/*.md" --provider copilot
```

## External references

- [Copilot SDK quickstart](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started) --
  getting started with `@github/copilot-sdk`
- [Install Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) --
  installation methods for all platforms
- [Copilot rate limits](https://docs.github.com/en/copilot/concepts/rate-limits) --
  rate limiting policies and behavior
- [Copilot plans](https://github.com/features/copilot/plans) -- subscription
  tiers and features

## Related documentation

- [Provider Overview](./provider-overview.md) -- how the provider abstraction
  layer works
- [OpenCode Backend](./opencode-backend.md) -- the alternative provider backend
- [Adding a New Provider](./adding-a-provider.md) -- guide for implementing new
  backends
- [Provider Interface](../shared-types/provider.md) -- `ProviderInstance` type
  definition and lifecycle contract
- [Cleanup Registry](../shared-types/cleanup.md) -- Process-level cleanup for
  graceful shutdown and signal handling
- [Configuration System](../cli-orchestration/configuration.md) -- Persistent
  `--provider` and `--server-url` defaults, including the `serverUrl` config option
- [Dispatcher](../planning-and-dispatch/dispatcher.md) -- how the dispatcher
  creates sessions and sends prompts
- [Planner](../planning-and-dispatch/planner.md) -- how the planner creates
  sessions for read-only exploration
- [CLI Options](../cli-orchestration/cli.md) -- `--provider copilot` and
  `--server-url` flags
- [Testing Overview](../testing/overview.md) -- test suite structure (note:
  the Copilot provider is not currently unit-tested)
