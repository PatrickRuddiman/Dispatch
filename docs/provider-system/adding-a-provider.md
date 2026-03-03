# Adding a New Provider Backend

This guide walks through the complete process of adding a new AI agent backend to
dispatch. The provider system uses a strategy pattern that makes this
straightforward -- you implement an interface, export a boot function, and
register it. See the [Provider Overview](./provider-overview.md) for the
architectural context.

## Checklist

As documented in `src/provider.ts:27-29` and `src/providers/index.ts:2-8`
(see also [Provider Interface](../shared-types/provider.md)):

1. Create `src/providers/<name>.ts` with an async `boot()` function that returns
   a `ProviderInstance`.
2. Add the name to the `ProviderName` union type in `src/provider.ts`.
3. Import and register the boot function in `src/providers/index.ts`.

Each step is detailed below.

## Step 1: Implement the provider module

Create a new file at `src/providers/<name>.ts`. The module must export an async
`boot` function that accepts optional [`ProviderBootOptions`](../shared-types/provider.md#providerbootoptions) and returns a
[`ProviderInstance`](../shared-types/provider.md#providerinstance-interface).

### The interface contract

From `src/provider.ts:31-52`, your provider must implement:

| Member | Type | Contract |
|--------|------|----------|
| `name` | `readonly string` | Human-readable identifier (e.g., `"claude-code"`) |
| `createSession()` | `() => Promise<string>` | Create an isolated session; return an opaque session ID |
| `prompt(sessionId, text)` | `(string, string) => Promise<string \| null>` | Send a prompt, wait for the response; return text or `null` |
| `cleanup()` | `() => Promise<void>` | Release all resources; safe to call multiple times |

### The boot options

From `src/provider.ts:16-21`:

| Option | Type | Purpose |
|--------|------|---------|
| `url` | `string?` | Connect to an already-running server instead of spawning one |
| `cwd` | `string?` | Working directory for the agent |

Your provider should handle both the "spawn a server" and "connect to existing
server" cases when the underlying SDK supports it. If your SDK does not support
remote connections, ignore the `url` option or throw a clear error.

### Template

```ts
// src/providers/example.ts

import type { ProviderInstance, ProviderBootOptions } from "../provider.js";

/**
 * Boot an Example provider instance.
 */
export async function boot(
  opts?: ProviderBootOptions
): Promise<ProviderInstance> {
  // 1. Initialize your SDK client
  //    - If opts?.url is provided, connect to an existing server
  //    - Otherwise, spawn a local server

  // 2. Return the ProviderInstance implementation
  return {
    name: "example",

    async createSession(): Promise<string> {
      // Create a session in your SDK and return an opaque ID
      throw new Error("Not implemented");
    },

    async prompt(sessionId: string, text: string): Promise<string | null> {
      // Send the prompt text to the session and wait for a response
      // Return the response text, or null if no response
      throw new Error("Not implemented");
    },

    async cleanup(): Promise<void> {
      // Stop servers, destroy sessions, release resources
      // Must be safe to call multiple times
    },
  };
}
```

### Design considerations

Based on patterns in the existing providers:

- **Session tracking**: If your SDK returns session objects that must be retained
  for subsequent calls (like Copilot's `CopilotSession`), maintain an in-memory
  `Map<string, YourSessionType>`. If sessions are server-managed and referenced
  by ID (like OpenCode), you can skip the map.

- **Response normalization**: Your SDK may return responses in a structured format
  (multi-part arrays, event objects, etc.). Extract the text content and return a
  plain string. Return `null` if no text content is available.

- **Error handling**: Let unexpected errors propagate naturally. The [dispatcher](../planning-and-dispatch/dispatcher.md)
  wraps `createSession()` and `prompt()` calls in try/catch blocks
  (`src/dispatcher.ts:28-42`), so unhandled errors from your provider will be
  caught and recorded as failed tasks rather than crashing the process.

- **Cleanup idempotency**: Guard against double-cleanup by using optional
  chaining (`stopServer?.()`) or by tracking whether cleanup has already run.
  Swallow errors from destroy operations during cleanup (as the Copilot provider
  does with `.catch(() => {})`). The [cleanup registry](../shared-types/cleanup.md)
  will call your provider's `cleanup()` on process exit (SIGINT, SIGTERM, or
   unhandled error).

## Step 2: Add to the ProviderName union

Edit `src/provider.ts:11` to add your provider name to the union type:

```ts
// Before
export type ProviderName = "opencode" | "copilot" | "claude" | "codex";

// After
export type ProviderName = "opencode" | "copilot" | "claude" | "codex" | "example";
```

This ensures TypeScript validates the provider name throughout the codebase --
in the [CLI argument parser](../cli-orchestration/cli.md), the [orchestrator](../cli-orchestration/orchestrator.md) options, and the registry map.

## Step 3: Register in the provider registry

Edit `src/providers/index.ts` to import your boot function and add it to the
`PROVIDERS` map:

```ts
import { boot as bootExample } from "./example.js";

const PROVIDERS: Record<ProviderName, BootFn> = {
  opencode: bootOpencode,
  copilot: bootCopilot,
  example: bootExample,  // Add your provider here
};
```

After this change:

- `PROVIDER_NAMES` automatically includes `"example"`.
- The CLI's `--provider` flag accepts `"example"` as a valid value.
- `bootProvider("example", opts)` routes to your `boot()` function.

## Step 4: Add the SDK dependency

If your provider wraps an external SDK, add it to `package.json`:

```sh
npm install @example/agent-sdk
```

## Step 5: Test

1. **Unit test**: Verify your provider implements the interface correctly. Test
   the boot, session creation, prompt, and cleanup lifecycle.

2. **Integration test**: Run a dispatch with your provider (see the
   [CLI Options Reference](../cli-orchestration/cli.md#options-reference) for
   all available flags):

    ```sh
    dispatch "tasks/**/*.md" --provider example --dry-run
    dispatch "tasks/**/*.md" --provider example
    ```

3. **Verify cleanup**: Ensure no orphaned server processes remain after the
   dispatch run completes or fails.

## What happens automatically

Once you complete the three registration steps, the following work without any
additional changes:

- **CLI help text**: `--provider` options list updates automatically because it
  reads from `PROVIDER_NAMES`.
- **CLI validation**: The argument parser rejects unknown provider names using
  `PROVIDER_NAMES.includes()` (see [CLI Options](../cli-orchestration/cli.md)).
- **Orchestrator**: `bootProvider()` routes to your boot function (see [Orchestrator](../cli-orchestration/orchestrator.md)).
- **Planner and Dispatcher**: These modules accept any `ProviderInstance` and
  call `createSession()` and `prompt()` -- they are completely agnostic to the
  backend (see [Planner](../planning-and-dispatch/planner.md) and [Dispatcher](../planning-and-dispatch/dispatcher.md)).

## Why not a plugin system?

The current design uses compile-time registration (union types and a static map)
rather than runtime plugin discovery. This means adding a provider requires a
code change and recompilation. The reasons for this choice are discussed in the
[provider overview](./provider-overview.md#why-providername-is-a-compile-time-union).

If runtime extensibility becomes necessary (e.g., third-party providers loaded
from npm packages), the registry could be extended with a `registerProvider()`
function that mutates the `PROVIDERS` map at runtime. The `ProviderName` type
would then need to become `string`, losing compile-time validation but gaining
runtime flexibility.

## Related documentation

- [Provider Overview](./provider-overview.md) -- architecture and design
  decisions
- [OpenCode Backend](./opencode-backend.md) -- reference implementation using
  `@opencode-ai/sdk`
- [GitHub Copilot Backend](./copilot-backend.md) -- reference implementation
  using `@github/copilot-sdk`
- [Provider Interface](../shared-types/provider.md) -- `ProviderInstance`,
  `ProviderName`, and `ProviderBootOptions` type definitions
- [Cleanup Registry](../shared-types/cleanup.md) -- How provider cleanup
  functions are registered and invoked on process exit
- [Dispatcher](../planning-and-dispatch/dispatcher.md) -- How the dispatcher
  consumes `ProviderInstance`
- [Spec Generation](../spec-generation/overview.md) -- The `--spec` pipeline
  that also boots and uses providers
- [CLI Options](../cli-orchestration/cli.md) -- The `--provider` flag and
  argument validation
- [Configuration](../cli-orchestration/configuration.md) -- How the `--provider`
  flag interacts with persistent config defaults
- [Testing Overview](../testing/overview.md) -- Test coverage (note: provider
  backends are not unit tested)
